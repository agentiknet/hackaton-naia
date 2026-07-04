import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Agent } from "@mastra/core/agent";
import { appendSummary, appendVerifications, readAudit, resetAudit } from "../audit/log.js";
import { mentorJuristeAgent } from "../mastra/agents/mentor-juriste/index.js";
import { mentorParlementAgent } from "../mastra/agents/mentor-parlement/index.js";
import { naiaAgent } from "../mastra/agents/naia/index.js";
import type { Claim, Profile, Source, Verification } from "../mentors/types.js";
import { extractClaims } from "./claims.js";
import { createLimiter, withTimeout } from "./concurrency.js";
import { verifyClaim } from "./verify.js";

// Was 20s: live Moulineuse calls (search_recipes in particular) routinely ran
// past that under load, aborting mid-search and forcing a false "unknown".
const MENTOR_TIMEOUT_MS = 40_000;
const MENTOR_CONCURRENCY = 6;
// Same rationale as the mentors' maxSteps (see pipeline/verify.ts): the mandated
// search_recipes -> get_recipe -> describe_table -> query_sql strategy routinely
// exceeds the SDK's default of 5 steps before naia can produce sourced text.
const NAIA_MAX_STEPS = 12;
// Ceiling on the whole verification phase (both attempts): once it elapses,
// claims that haven't started yet are marked "unknown" instead of run — a
// slow or unreachable source degrades the answer, it never hangs the request.
const PIPELINE_BUDGET_MS = 90_000;

const MENTORS: Agent<any, any, any, any, any>[] = [mentorJuristeAgent, mentorParlementAgent];

export type PipelineStatus = "answered" | "insufficient" | "refused";

export interface PipelineResult {
  conversationId: string;
  response: string;
  sources: Source[];
  confidenceScore: number;
  status: PipelineStatus;
  /** Human-readable justification when status !== "answered" (why it wasn't
   * certified: contradiction, missing sources, or no verifiable claim). */
  refusalReason?: string;
  claims: Claim[];
  verifications: Verification[];
}

type ClaimVerdict = "supported" | "unsupported" | "unknown";

interface ClaimSummary {
  claim: Claim;
  verifications: Verification[];
  verdict: ClaimVerdict;
  claimScore: number;
}

function confidenceThreshold(): number {
  return Number(process.env.CONFIDENCE_THRESHOLD ?? 70);
}

/**
 * Pure-code arbiter: a claim is "unsupported" if any mentor contradicted it
 * (contradiction always wins). Otherwise it's "supported" if at least one
 * mentor found a sourced "supported" verdict. A mentor returning "unknown"
 * (out of its domain, or no source found) simply doesn't vote — it's
 * excluded from the consensus denominator so it can never drag a claim that
 * another mentor did verify, nor tip it into "unsupported".
 */
function summarizeClaim(claim: Claim, verifications: Verification[]): ClaimSummary {
  const decisive = verifications.filter((v) => v.verdict !== "unknown");
  const hasUnsupported = decisive.some((v) => v.verdict === "unsupported");
  const supportedCount = decisive.filter((v) => v.verdict === "supported" && v.source).length;

  if (hasUnsupported) {
    return { claim, verifications, verdict: "unsupported", claimScore: 0 };
  }
  if (supportedCount >= 1) {
    return { claim, verifications, verdict: "supported", claimScore: supportedCount / decisive.length };
  }
  return { claim, verifications, verdict: "unknown", claimScore: 0 };
}

/**
 * Score = supported / (supported + unsupported), weighted per-claim by
 * mentor consensus. Claims stuck on "unknown" (sources unreachable, out of
 * domain) are excluded entirely from both sides of the ratio — they must
 * never count as a strike against the claim the way "unsupported" does.
 */
function computeConfidence(summaries: ClaimSummary[]): number {
  const decisive = summaries.filter((s) => s.verdict !== "unknown");
  if (decisive.length === 0) return 0;
  const total = decisive.reduce((sum, s) => sum + s.claimScore, 0);
  return Math.round((total / decisive.length) * 100);
}

function unknownRatio(summaries: ClaimSummary[]): number {
  if (summaries.length === 0) return 0;
  return summaries.filter((s) => s.verdict === "unknown").length / summaries.length;
}

/**
 * More than half the claims stuck on "unknown" means the Conseil couldn't
 * reach a verdict on most of the answer — that's a source-availability
 * problem, not a contradiction, so it gets its own status distinct from a
 * refusal.
 */
function resolveStatus(confidenceScore: number, unknownFraction: number, threshold: number): PipelineStatus {
  if (unknownFraction > 0.5) return "insufficient";
  return confidenceScore >= threshold ? "answered" : "refused";
}

function collectSources(summaries: ClaimSummary[]): Source[] {
  const sources: Source[] = [];
  const seen = new Set<string>();
  for (const summary of summaries) {
    if (summary.verdict !== "supported") continue;
    for (const v of summary.verifications) {
      if (v.verdict !== "supported" || !v.source) continue;
      const key = `${v.source.label}|${v.source.ref ?? ""}|${v.source.url ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      sources.push(v.source);
    }
  }
  return sources;
}

/** Profile-specific framing: the two audiences want opposite things from the
 * same certified facts. A citizen wants to *understand* the law (plain-language
 * explanation); a député/collaborateur wants to *work* the law (technical
 * précis + a sourced drafting aid — amendment or exposé des motifs). The
 * certification rule (every claim sourced) is identical for both. */
function profileFraming(profile: Profile): string {
  if (profile === "depute") {
    return [
      "Destinataire : député ou collaborateur parlementaire (usage professionnel).",
      "Réponds de façon technique et dense : références précises (article, texte, dossier, scrutin, dates, état VIGUEUR/ABROGÉ).",
      "Quand la question appelle un travail législatif (amendement, rédaction, analyse), tu peux proposer une rédaction structurée",
      "(dispositif + exposé sommaire) — mais chaque élément factuel qui la fonde doit rester sourcé et vérifiable.",
    ].join("\n");
  }
  return [
    "Destinataire : citoyen qui s'informe.",
    "Explique en langage clair et pédagogique, sans jargon inutile : ce que dit la loi, ce que ça change concrètement.",
    "Garde chaque affirmation factuelle sourcée (article, texte, date) : la pédagogie ne dispense jamais de la référence.",
  ].join("\n");
}

function buildNaiaPrompt(question: string, profile: Profile): string {
  return `${profileFraming(profile)}\n\nQuestion : ${question}`;
}

function buildRetryPrompt(question: string, profile: Profile, draft: string, summaries: ClaimSummary[]): string {
  const feedback = summaries
    .map((s) => {
      const verdicts = s.verifications
        .map((v) => `${v.mentor}: ${v.verdict}${v.source ? ` (source: ${v.source.label})` : ""}`)
        .join("; ");
      return `- Claim : "${s.claim.text}" → ${verdicts}`;
    })
    .join("\n");

  return [
    profileFraming(profile),
    "",
    `Question : ${question}`,
    "",
    "Ta première réponse était :",
    '"""',
    draft,
    '"""',
    "",
    "Le Conseil des Mentors a vérifié chaque affirmation avec ce résultat :",
    feedback,
    "",
    'Reformule ta réponse : conserve uniquement les affirmations "supported", retire ou nuance',
    'les affirmations "unsupported" ou "unknown". Si tu ne peux pas répondre de façon certifiée',
    "sur un point, dis-le explicitement plutôt que de deviner.",
  ].join("\n");
}

const OFFICIAL_SOURCES_HINT =
  "Vous pouvez consulter directement les sources officielles (Assemblée nationale, Sénat, Légifrance).";

/** One-line, machine-friendly reason for a non-certified answer — surfaced in
 * the API response (`refusal_reason`) so the UI can explain the *why*, not just
 * the *what*. Distinguishes contradiction, missing sources, and "no verifiable
 * claim extracted" (the empty-summaries case). */
function buildRefusalReason(summaries: ClaimSummary[]): string {
  const contradicted = summaries.filter((s) => s.verdict === "unsupported").length;
  const unverifiable = summaries.filter((s) => s.verdict === "unknown").length;

  if (summaries.length === 0) {
    return "Aucune affirmation factuelle vérifiable n'a pu être extraite de cette question (opinion, projection ou hypothèse hors du champ des sources officielles).";
  }
  const parts: string[] = [];
  if (contradicted > 0) {
    parts.push(`${contradicted} affirmation(s) contredite(s) par les sources officielles`);
  }
  if (unverifiable > 0) {
    parts.push(`${unverifiable} affirmation(s) sans source vérifiable (LEGI, JORF, dossiers parlementaires, scrutins)`);
  }
  return parts.length > 0
    ? `${parts.join(" ; ")}. Le score de confiance est resté sous le seuil requis.`
    : "Le score de confiance est resté sous le seuil requis pour une certification.";
}

function buildRefusalMessage(summaries: ClaimSummary[]): string {
  const contradicted = summaries.filter((s) => s.verdict === "unsupported");
  const unverifiable = summaries.filter((s) => s.verdict === "unknown");

  if (summaries.length === 0) {
    return [
      "Je ne peux pas répondre de façon certifiée à cette question.",
      "Elle n'appelle aucune affirmation factuelle que je puisse vérifier contre les sources officielles (elle relève d'une opinion, d'une projection ou d'une hypothèse).",
      "Reformulez-la autour d'un texte, d'un article ou d'un scrutin précis, et je vérifierai chaque affirmation avant de répondre.",
    ].join("\n");
  }

  const blocks: string[] = [
    "Je ne peux pas certifier cette réponse avec suffisamment de confiance pour vous la transmettre.",
  ];
  if (contradicted.length > 0) {
    blocks.push(
      "Affirmations contredites par les sources officielles :",
      ...contradicted.map((s) => `- « ${s.claim.text} »`),
    );
  }
  if (unverifiable.length > 0) {
    blocks.push(
      "Affirmations pour lesquelles aucune source n'a pu être trouvée :",
      ...unverifiable.map((s) => `- « ${s.claim.text} »`),
    );
  }
  blocks.push(`Reformulez votre question ou consultez les sources. ${OFFICIAL_SOURCES_HINT}`);
  return blocks.join("\n");
}

function buildInsufficientMessage(summaries: ClaimSummary[]): string {
  const unresolved = summaries.filter((s) => s.verdict === "unknown");
  const lines = unresolved.map((s) => `- « ${s.claim.text} »`);
  return [
    "Les sources nécessaires pour vérifier cette réponse sont partiellement indisponibles : je ne peux pas la certifier.",
    "Le Conseil des Mentors n'a pas pu trouver de source pour la majorité des affirmations suivantes :",
    ...lines,
    `Réessayez plus tard. ${OFFICIAL_SOURCES_HINT}`,
  ].join("\n");
}

/** Wraps a single mentor verification with the shared pipeline deadline: if the budget is
 * already spent, skip the call entirely; otherwise cap the per-claim timeout to whatever
 * budget remains. Either way a claim degrades to "unknown", it never throws or hangs. */
function verifyClaimWithinBudget(claim: Claim, mentor: Agent<any, any, any, any, any>, deadline: number) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    return Promise.resolve<Verification>({
      claim,
      mentor: mentor.id,
      verdict: "unknown",
      durationMs: 0,
      error: "budget global du pipeline dépassé",
    });
  }

  const timeoutMs = Math.min(MENTOR_TIMEOUT_MS, remaining);
  return withTimeout((signal) => verifyClaim(claim, mentor, { abortSignal: signal }), timeoutMs).catch(
    (error): Verification => ({
      claim,
      mentor: mentor.id,
      verdict: "unknown",
      durationMs: timeoutMs,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
}

async function verifyDraft(
  draft: string,
  attempt: number,
  conversationId: string,
  emit?: StreamEmit,
): Promise<{ claims: Claim[]; verifications: Verification[]; summaries: ClaimSummary[]; confidenceScore: number }> {
  const claims = await extractClaims(draft);
  await emit?.({
    type: "stage",
    key: "extract",
    label: "Extraction des affirmations factuelles à vérifier",
    count: claims.length,
  });
  await emit?.({
    type: "stage",
    key: "verify",
    label: "Le Conseil des Mentors vérifie chaque affirmation contre les sources officielles",
  });

  const deadline = Date.now() + PIPELINE_BUDGET_MS;
  const limit = createLimiter(MENTOR_CONCURRENCY);

  const tasks = claims.flatMap((claim) =>
    MENTORS.map((mentor) =>
      limit(async () => {
        const verification = await verifyClaimWithinBudget(claim, mentor, deadline);
        // Live progress: each verdict reaches the UI the moment it lands.
        await emit?.({ type: "verification", verification });
        return verification;
      }),
    ),
  );

  const verifications = await Promise.all(tasks);
  await appendVerifications(conversationId, attempt, verifications);

  const summaries = claims.map((claim) =>
    summarizeClaim(
      claim,
      verifications.filter((v) => v.claim.id === claim.id),
    ),
  );

  return { claims, verifications, summaries, confidenceScore: computeConfidence(summaries) };
}

const DEMO_FIXTURES_DIR = join(process.cwd(), "fixtures", "demo");

/** Normalizes a question into a stable fixture filename: lowercase, no
 * accents, non-alphanumeric runs collapsed to a single "-", trimmed. */
function slugifyQuestion(question: string): string {
  return question
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function demoFixturePath(question: string): string {
  return join(DEMO_FIXTURES_DIR, `${slugifyQuestion(question)}.json`);
}

function isDemoReplayEnabled(): boolean {
  return process.env.DEMO_REPLAY === "1" || process.env.MOCK_MOULINEUSE === "1";
}

function isDemoCaptureEnabled(): boolean {
  return process.env.CAPTURE_DEMO === "1";
}

/** Slug tokens that carry no topical signal — dropped before overlap scoring. */
const SLUG_STOPWORDS = new Set([
  "de", "la", "le", "les", "des", "du", "un", "une", "et", "en", "a", "au", "aux",
  "que", "qui", "quoi", "dit", "sur", "est", "quel", "quelle", "quels", "quelles",
  "pour", "dans", "par", "loi", "l", "d",
]);

function significantSlugTokens(slug: string): Set<string> {
  return new Set(slug.split("-").filter((t) => t.length > 1 && !SLUG_STOPWORDS.has(t)));
}

/** lowercase + accent-fold, for keyword substring matching. */
function foldText(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

type DemoFixture = PipelineResult & { matchKeywords?: string[] };

/** Replay a captured fixture. Matching, in order of confidence:
 *  1. exact question slug;
 *  2. keyword hit — the question contains one of a fixture's `matchKeywords`
 *     (accent-insensitive substring). This is explicit and predictable, so a
 *     short real question ("loi euthanasie légale ?") reliably replays its
 *     fixture while an unrelated topic never does;
 *  3. topical token overlap (>=3 significant tokens) as a last resort.
 * A trap / out-of-scope question matches none and returns undefined, so the
 * caller can serve a fast honest refusal instead of a certified wrong answer. */
function loadDemoFixture(question: string): DemoFixture | undefined {
  const exact = demoFixturePath(question);
  if (existsSync(exact)) return JSON.parse(readFileSync(exact, "utf-8")) as DemoFixture;
  if (!existsSync(DEMO_FIXTURES_DIR)) return undefined;

  const files = readdirSync(DEMO_FIXTURES_DIR).filter((f) => f.endsWith(".json"));
  const parsed = files.map((f) => JSON.parse(readFileSync(join(DEMO_FIXTURES_DIR, f), "utf-8")) as DemoFixture);

  // 2. keyword hit
  const foldedQuestion = foldText(question);
  for (const fixture of parsed) {
    if (fixture.matchKeywords?.some((kw) => foldedQuestion.includes(foldText(kw)))) return fixture;
  }

  // 3. token-overlap fallback
  const qTokens = significantSlugTokens(slugifyQuestion(question));
  if (qTokens.size === 0) return undefined;
  let best: { fixture: DemoFixture; overlap: number } | undefined;
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const fixture = parsed[i];
    if (!file || !fixture) continue;
    const fTokens = significantSlugTokens(file.replace(/\.json$/, ""));
    let overlap = 0;
    for (const t of qTokens) if (fTokens.has(t)) overlap++;
    if (!best || overlap > best.overlap) best = { fixture, overlap };
  }
  return best && best.overlap >= 3 ? best.fixture : undefined;
}

/** Fast, honest result when a demo question matches no fixture — instead of
 * falling through to a slow (~1-2 min) live LLM call in a demo, Naia says it
 * has no indexed official source for this question and refuses. */
function buildDemoMissResult(conversationId: string): PipelineResult {
  return {
    conversationId,
    response: [
      "Je n'ai pas de source officielle indexée pour cette question dans le périmètre de cette démonstration.",
      "Par principe, je préfère ne rien affirmer plutôt que de risquer une information non vérifiée.",
      "Reformulez autour d'un texte, d'un article ou d'un scrutin précis — par exemple l'énergie (article L. 100-4) ou la fin de vie (loi Claeys-Leonetti) — et je vérifierai chaque affirmation avant de répondre.",
    ].join("\n"),
    sources: [],
    confidenceScore: 0,
    status: "refused",
    refusalReason: "Aucune source officielle indexée pour cette question dans le périmètre de la démonstration.",
    claims: [],
    verifications: [],
  };
}

function saveDemoFixture(question: string, result: PipelineResult): void {
  mkdirSync(DEMO_FIXTURES_DIR, { recursive: true });
  writeFileSync(demoFixturePath(question), JSON.stringify(result, null, 2), "utf-8");
}

/** Replaying a fixture must still leave a readable audit trail behind its own
 * (fixed) conversationId — but only write it once, so replaying the same
 * fixture repeatedly doesn't pile up duplicate verification lines. */
async function ensureDemoAudit(question: string, profile: Profile, fixture: PipelineResult): Promise<void> {
  const existing = await readAudit(fixture.conversationId);
  // A matching trail (same verification count) means this fixture was already
  // recorded — skip, so replays stay idempotent. Anything else (missing, or a
  // stale/foreign trail left over from a prior live run under the same id) is
  // reset and rewritten from the fixture, the single source of truth.
  if (existing && existing.verifications.length === fixture.verifications.length) return;
  if (existing) await resetAudit(fixture.conversationId);
  await appendVerifications(fixture.conversationId, 1, fixture.verifications);
  await appendSummary(fixture.conversationId, {
    question,
    profile,
    status: fixture.status,
    confidenceScore: fixture.confidenceScore,
    response: fixture.response,
  });
}

/** Human-readable one-liners for Naia's tool calls, streamed as "thought"
 * lines while the draft phase works — the 60-90s of silence becomes a
 * visible research trail (which recipe, which search, which SQL). */
const TRACE_LABELS: Record<string, string> = {
  search_recipes: "Recherche de la méthode",
  get_recipe: "Lecture de la recette",
  search_legal_texts: "Recherche plein texte LEGI/JORF",
  get_pastilled_article: "Lecture de l'article pastillé",
  describe_table: "Inspection du schéma",
  query_sql: "Requête SQL sur les données parlementaires",
  query_typesense: "Recherche Typesense",
  list_parlement_items: "Parcours des documents parlementaires",
  get_parlement_item: "Lecture d'un document parlementaire",
};

function describeToolCall(toolName: string, args: unknown): string {
  const name = toolName.replace(/^moulineuse_/, "");
  const label = TRACE_LABELS[name] ?? name;
  const a = (args ?? {}) as Record<string, unknown>;
  const detail = [a.query, a.id, a.q, a.sql]
    .find((v): v is string => typeof v === "string" && v.length > 0);
  const trimmed = detail ? ` — « ${detail.slice(0, 70)}${detail.length > 70 ? "…" : ""} »` : "";
  return `${label}${trimmed}`;
}

/** onStepFinish handler that streams each tool call of a generate() loop as a
 * trace event. Defensive: a malformed step must never break the pipeline. */
function stepTracer(emit?: StreamEmit) {
  if (!emit) return undefined;
  return async (step: { toolCalls?: Array<{ payload?: { toolName?: string; args?: unknown } }> }) => {
    try {
      for (const call of step.toolCalls ?? []) {
        const toolName = call?.payload?.toolName;
        if (!toolName) continue;
        await emit({ type: "trace", label: describeToolCall(toolName, call.payload?.args) });
      }
    } catch {
      // tracing is best-effort
    }
  };
}

export async function runPipeline(
  question: string,
  profile: Profile,
  conversationId: string = randomUUID(),
  emit?: StreamEmit,
): Promise<PipelineResult> {
  // Demo mode (replay), outside a capture run: only fixtures answer. Anything
  // unmatched returns an instant honest refusal rather than a ~2-min live call.
  if (isDemoReplayEnabled() && !isDemoCaptureEnabled()) {
    const fixture = loadDemoFixture(question);
    if (fixture) {
      await ensureDemoAudit(question, profile, fixture);
      return fixture;
    }
    return buildDemoMissResult(conversationId);
  }

  const threshold = confidenceThreshold();

  const draftResult = await naiaAgent.generate(buildNaiaPrompt(question, profile), {
    maxSteps: NAIA_MAX_STEPS,
    onStepFinish: stepTracer(emit),
  });
  let draft = draftResult.text;

  let { claims, verifications, summaries, confidenceScore } = await verifyDraft(draft, 1, conversationId, emit);
  let status = resolveStatus(confidenceScore, unknownRatio(summaries), threshold);

  if (status !== "answered") {
    // Surface the retry instead of a silent 1-2 min re-run: the UI resets its
    // steps and shows the Conseil demanding a rewrite (attempt 2/2).
    await emit?.({ type: "stage", key: "retry", label: "Le Conseil demande une reformulation (tentative 2/2)" });
    const retryResult = await naiaAgent.generate(buildRetryPrompt(question, profile, draft, summaries), {
      maxSteps: NAIA_MAX_STEPS,
      onStepFinish: stepTracer(emit),
    });
    draft = retryResult.text;
    ({ claims, verifications, summaries, confidenceScore } = await verifyDraft(draft, 2, conversationId, emit));
    status = resolveStatus(confidenceScore, unknownRatio(summaries), threshold);
  }

  const sources = collectSources(summaries);
  const response =
    status === "answered" ? draft : status === "insufficient" ? buildInsufficientMessage(summaries) : buildRefusalMessage(summaries);
  const refusalReason = status === "answered" ? undefined : buildRefusalReason(summaries);

  await appendSummary(conversationId, { question, profile, status, confidenceScore, response });

  const result: PipelineResult = { conversationId, response, sources, confidenceScore, status, refusalReason, claims, verifications };

  if (isDemoCaptureEnabled() && status === "answered") {
    saveDemoFixture(question, result);
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Streaming pipeline — emits staged progress so the UI can show the pipeline
// working (draft → extract → per-claim verification → certification) instead of
// a silent 1-2 min spinner.
// ─────────────────────────────────────────────────────────────────────────────

export type StreamEvent =
  | { type: "stage"; key: string; label: string; count?: number }
  | { type: "trace"; label: string }
  | { type: "verification"; verification: Verification }
  | { type: "done"; result: PipelineResult | DraftResult };

type StreamEmit = (event: StreamEvent) => void | Promise<void>;

const streamSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function runPipelineStreaming(
  question: string,
  profile: Profile,
  conversationId: string,
  emit: StreamEmit,
): Promise<PipelineResult> {
  if (isDemoReplayEnabled() && !isDemoCaptureEnabled()) {
    const fixture = loadDemoFixture(question);
    if (fixture) {
      await streamReplay(fixture, question, profile, emit);
      return fixture;
    }
    const miss = buildDemoMissResult(conversationId);
    await streamMiss(miss, emit);
    return miss;
  }

  // Live path: emit flows through the real pipeline — stages, per-claim
  // verifications and the retry are streamed as they actually happen.
  await emit({ type: "stage", key: "draft", label: "Naia rédige une réponse à partir des sources officielles…" });
  const result = await runPipeline(question, profile, conversationId, emit);
  await emit({ type: "stage", key: "certify", label: "Arbitrage et certification…" });
  await emit({ type: "done", result });
  return result;
}

/** Paces a replayed fixture into watchable stages: draft, extract, each
 * verification one by one (so the Conseil visibly fills up), then certification. */
async function streamReplay(fixture: DemoFixture, question: string, profile: Profile, emit: StreamEmit): Promise<void> {
  await emit({ type: "stage", key: "draft", label: "Naia rédige une réponse à partir des sources officielles…" });
  await streamSleep(650);

  const verifs = fixture.verifications ?? [];
  const claimCount = fixture.claims?.length ?? new Set(verifs.map((v) => v.claim.id)).size;
  await emit({ type: "stage", key: "extract", label: "Extraction des affirmations factuelles à vérifier", count: claimCount });
  await streamSleep(550);

  await emit({ type: "stage", key: "verify", label: "Le Conseil des Mentors vérifie chaque affirmation contre les sources officielles" });
  for (const v of verifs) {
    await streamSleep(300);
    await emit({ type: "verification", verification: v });
  }

  await streamSleep(400);
  await emit({ type: "stage", key: "certify", label: "Arbitrage pur-code et certification…" });
  await streamSleep(500);

  await ensureDemoAudit(question, profile, fixture);
  await emit({ type: "done", result: fixture });
}

/** Fast honest miss: a couple of stages then a refusal — never a long wait. */
async function streamMiss(miss: PipelineResult, emit: StreamEmit): Promise<void> {
  await emit({ type: "stage", key: "draft", label: "Recherche d'une source officielle indexée…" });
  await streamSleep(600);
  await emit({ type: "stage", key: "extract", label: "Aucune source officielle indexée pour cette question", count: 0 });
  await streamSleep(500);
  await emit({ type: "done", result: miss });
}

// ─────────────────────────────────────────────────────────────────────────────
// Drafting workspace ("Atelier de rédaction législative")
//
// Same trust contract as the Q&A pipeline — Naia drafts, the Conseil verifies
// every factual anchor against official sources — but the deliverable is a
// legislative text (dispositif + exposé sommaire) and the Conseil additionally
// returns concrete drafting *suggestions* (coherence, abrogated/conflicting
// references, normative clarity). This is the "production de la loi" surface.
// ─────────────────────────────────────────────────────────────────────────────

export interface DraftResult {
  conversationId: string;
  intent: string;
  draft: string;
  sources: Source[];
  confidenceScore: number;
  status: PipelineStatus;
  refusalReason?: string;
  suggestions: string[];
  claims: Claim[];
  verifications: Verification[];
}

const DRAFT_FIXTURES_DIR = join(process.cwd(), "fixtures", "demo-draft");

function draftFixturePath(intent: string): string {
  return join(DRAFT_FIXTURES_DIR, `${slugifyQuestion(intent)}.json`);
}

type DraftFixture = DraftResult & { matchKeywords?: string[] };

/** Load the fixture for this exact intent; failing that, match on the
 * fixtures' `matchKeywords` (accent-insensitive substring, same contract as
 * the chat fixtures); failing that, fall back to the first fixture on disk so
 * a free-typed intent still replays a deterministic scenario in demo mode. */
function loadDraftFixture(intent: string): DraftFixture | undefined {
  const exact = draftFixturePath(intent);
  if (existsSync(exact)) return JSON.parse(readFileSync(exact, "utf-8")) as DraftFixture;

  if (!existsSync(DRAFT_FIXTURES_DIR)) return undefined;
  const files = readdirSync(DRAFT_FIXTURES_DIR).filter((f) => f.endsWith(".json")).sort();
  if (files.length === 0) return undefined;
  const parsed = files.map((f) => JSON.parse(readFileSync(join(DRAFT_FIXTURES_DIR, f), "utf-8")) as DraftFixture);

  const folded = foldText(intent);
  for (const fixture of parsed) {
    if (fixture.matchKeywords?.some((kw) => folded.includes(foldText(kw)))) return fixture;
  }
  return parsed[0];
}

function saveDraftFixture(intent: string, result: DraftResult): void {
  mkdirSync(DRAFT_FIXTURES_DIR, { recursive: true });
  writeFileSync(draftFixturePath(intent), JSON.stringify(result, null, 2), "utf-8");
}

function buildDraftPrompt(intent: string, baseText?: string): string {
  return [
    profileFraming("depute"),
    "",
    "Tâche : RÉDIGER un texte législatif (article de loi ou amendement) à partir de l'intention ci-dessous.",
    `Intention : ${intent}`,
    baseText ? `\nTexte de base à amender :\n"""\n${baseText}\n"""` : "",
    "",
    "RÈGLE ABSOLUE : produis TOUJOURS un premier jet complet, même si l'intention est brève,",
    "vague ou mal orthographiée. Interprète-la de façon raisonnable, choisis le véhicule juridique",
    "le plus plausible (code, loi existante) via tes outils, et note explicitement tes hypothèses",
    "d'interprétation dans l'exposé sommaire. Ne demande JAMAIS de précisions, ne renvoie JAMAIS",
    "une réponse vide : un premier jet imparfait que le Conseil peut vérifier vaut toujours mieux",
    "que pas de texte.",
    "",
    "Produis exactement deux sections en Markdown :",
    "## Dispositif",
    "La rédaction normative précise (article, alinéas numérotés). Formulation juridique, impérative.",
    "## Exposé sommaire",
    "La justification, avec les références légales EXACTES des textes/articles existants visés ou modifiés,",
    "vérifiées via tes outils (numéro d'article, texte, état VIGUEUR/ABROGÉ, date). N'invente aucun numéro d'article.",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Feedback loop for the drafting workspace — mirrors buildRetryPrompt but the
 * deliverable stays a legislative text (dispositif + exposé sommaire). */
function buildDraftRetryPrompt(intent: string, draft: string, summaries: ClaimSummary[]): string {
  const feedback = summaries
    .map((s) => {
      const verdicts = s.verifications
        .map((v) => `${v.mentor}: ${v.verdict}${v.source ? ` (source: ${v.source.label})` : ""}`)
        .join("; ");
      return `- Référence : "${s.claim.text}" → ${verdicts}`;
    })
    .join("\n");

  return [
    profileFraming("depute"),
    "",
    `Intention : ${intent}`,
    "",
    "Ton premier projet de rédaction était :",
    '"""',
    draft,
    '"""',
    "",
    "Le Conseil des Mentors a vérifié chaque référence avec ce résultat :",
    feedback,
    "",
    "Reformule le texte législatif (mêmes deux sections ## Dispositif / ## Exposé sommaire) :",
    'conserve les références "supported", corrige ou retire les références "unsupported",',
    'remplace les références "unknown" par des références que tu peux vérifier via tes outils.',
    "Produis TOUJOURS un texte complet, jamais une réponse vide.",
  ].join("\n");
}

function buildSuggestionsPrompt(intent: string, draft: string): string {
  return [
    "Tu es juriste-légiste. Examine ce projet de rédaction législative destiné à un député.",
    `Intention visée : ${intent}`,
    "Projet de texte :",
    '"""',
    draft,
    '"""',
    "",
    "Donne des SUGGESTIONS concrètes d'amélioration : cohérence juridique, références à des articles",
    "abrogés ou en conflit, clarté et précision normative, risques de constitutionnalité ou d'irrecevabilité.",
    "Réponds UNIQUEMENT par une liste à puces, une suggestion par ligne commençant par « - ».",
    "Si un point est solide, ne le mentionne pas. Sois bref et opérationnel.",
  ].join("\n");
}

/** Splits the reviewer's bulleted text into individual suggestions, tolerating
 * "-", "*" or "•" bullets and dropping empty lines. */
function parseSuggestions(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[-*•]\s*/, "").trim())
    .filter((line) => line.length > 0);
}

export async function runDraft(
  intent: string,
  baseText?: string,
  conversationId: string = randomUUID(),
  emit?: StreamEmit,
): Promise<DraftResult> {
  if (isDemoReplayEnabled()) {
    const fixture = loadDraftFixture(intent);
    if (fixture) {
      // Reuse the same audit trail scheme so the drafting run is inspectable too.
      if (!(await readAudit(fixture.conversationId))) {
        await appendVerifications(fixture.conversationId, 1, fixture.verifications);
        await appendSummary(fixture.conversationId, {
          question: intent,
          profile: "depute",
          status: fixture.status,
          confidenceScore: fixture.confidenceScore,
          response: fixture.draft,
        });
      }
      return fixture;
    }
  }

  const threshold = confidenceThreshold();

  const draftGen = await naiaAgent.generate(buildDraftPrompt(intent, baseText), {
    maxSteps: NAIA_MAX_STEPS,
    onStepFinish: stepTracer(emit),
  });
  let draft = draftGen.text;

  // Empty-draft guard: the model occasionally answers with nothing (or a
  // clarification request stripped to nothing). One firm re-ask; if still
  // empty, fail fast with an actionable reason — never send an empty text
  // to the mentors, their feedback on "" is useless noise.
  if (!draft.trim()) {
    // The usual cause: a vague intent sends the model wandering through tools
    // until maxSteps runs out without ever writing. The re-ask therefore CUTS
    // tools entirely — write the first draft from general knowledge, and let
    // the Conseil do its job: verifying is the mentors' role, not the drafter's.
    const reAsk = await naiaAgent.generate(
      `${buildDraftPrompt(intent, baseText)}\n\nTa tentative précédente s'est épuisée en recherches sans produire de texte. Cette fois : NE fais AUCUNE recherche, rédige immédiatement le premier jet complet (## Dispositif + ## Exposé sommaire) à partir de tes connaissances. Signale dans l'exposé sommaire les références à faire vérifier par le Conseil.`,
      { maxSteps: 2, toolChoice: "none", onStepFinish: stepTracer(emit) },
    );
    draft = reAsk.text;
  }
  if (!draft.trim()) {
    const refusalReason =
      "Naia n'a pas réussi à produire une rédaction pour cette intention. Reformulez-la en une phrase d'objectif (même brève), par exemple : « renforcer la coopération commerciale avec l'Asie via les accords bilatéraux ».";
    await appendSummary(conversationId, { question: intent, profile: "depute", status: "refused", confidenceScore: 0, response: "" });
    return {
      conversationId, intent, draft: "", sources: [], confidenceScore: 0,
      status: "refused", refusalReason, suggestions: [], claims: [], verifications: [],
    };
  }

  let { claims, verifications, summaries, confidenceScore } = await verifyDraft(draft, 1, conversationId, emit);
  let status = resolveStatus(confidenceScore, unknownRatio(summaries), threshold);

  // Same trust loop as the Q&A pipeline: a first draft that fails
  // certification gets one rewrite informed by the mentors' verdicts.
  if (status !== "answered") {
    await emit?.({ type: "stage", key: "retry", label: "Le Conseil demande une reformulation (tentative 2/2)" });
    const retryGen = await naiaAgent.generate(buildDraftRetryPrompt(intent, draft, summaries), {
      maxSteps: NAIA_MAX_STEPS,
      onStepFinish: stepTracer(emit),
    });
    if (retryGen.text.trim()) {
      draft = retryGen.text;
      ({ claims, verifications, summaries, confidenceScore } = await verifyDraft(draft, 2, conversationId, emit));
      status = resolveStatus(confidenceScore, unknownRatio(summaries), threshold);
    }
  }

  // Council suggestions run regardless of verdict — even a draft that can't be
  // certified benefits from concrete legistic feedback the député can act on.
  await emit?.({ type: "stage", key: "suggest", label: "Le Conseil formule ses suggestions légistiques…" });
  const suggestionsGen = await mentorJuristeAgent.generate(buildSuggestionsPrompt(intent, draft), {
    maxSteps: NAIA_MAX_STEPS,
    onStepFinish: stepTracer(emit),
  });
  const suggestions = parseSuggestions(suggestionsGen.text);

  const sources = collectSources(summaries);
  // Draft-specific wording for the empty-claims case: the claims come from the
  // produced text, not from the user's "question".
  const refusalReason = status === "answered"
    ? undefined
    : summaries.length === 0
      ? "La rédaction produite ne contient aucune référence légale vérifiable : le Conseil ne peut pas la certifier. Précisez l'intention (texte ou code visé) pour ancrer la rédaction dans le droit existant."
      : buildRefusalReason(summaries);

  await appendSummary(conversationId, {
    question: intent,
    profile: "depute",
    status,
    confidenceScore,
    response: draft,
  });

  const result: DraftResult = {
    conversationId,
    intent,
    draft,
    sources,
    confidenceScore,
    status,
    refusalReason,
    suggestions,
    claims,
    verifications,
  };

  if (isDemoCaptureEnabled()) {
    saveDraftFixture(intent, result);
  }

  return result;
}

/** Streaming variant of runDraft — same event grammar as the chat stream
 * (stage / trace / verification / done) so the drafting workspace can show
 * the pipeline working instead of a mute button. */
export async function runDraftStreaming(
  intent: string,
  baseText: string | undefined,
  conversationId: string,
  emit: StreamEmit,
): Promise<DraftResult> {
  // Demo replay: pace the fixture into watchable stages, exactly like the
  // chat's streamReplay — the drafting demo must feel like the live pipeline.
  if (isDemoReplayEnabled() && !isDemoCaptureEnabled()) {
    const fixture = loadDraftFixture(intent);
    if (fixture) {
      await emit({ type: "stage", key: "draft", label: "Naia rédige le dispositif et l'exposé sommaire…" });
      await streamSleep(900);
      const verifs = fixture.verifications ?? [];
      const claimCount = fixture.claims?.length ?? new Set(verifs.map((v) => v.claim.id)).size;
      await emit({ type: "stage", key: "extract", label: "Extraction des références à vérifier", count: claimCount });
      await streamSleep(500);
      await emit({ type: "stage", key: "verify", label: "Le Conseil des Mentors vérifie chaque référence" });
      for (const v of verifs) {
        await streamSleep(300);
        await emit({ type: "verification", verification: v });
      }
      await streamSleep(400);
      await emit({ type: "stage", key: "suggest", label: "Le Conseil formule ses suggestions légistiques…" });
      await streamSleep(600);
      await emit({ type: "stage", key: "certify", label: "Arbitrage et certification…" });
      await streamSleep(400);
      const result = await runDraft(intent, baseText, conversationId); // returns the fixture + writes the audit trail
      await emit({ type: "done", result });
      return result;
    }
  }

  await emit({ type: "stage", key: "draft", label: "Naia rédige le dispositif et l'exposé sommaire…" });
  const result = await runDraft(intent, baseText, conversationId, emit);
  await emit({ type: "stage", key: "certify", label: "Arbitrage et certification…" });
  await emit({ type: "done", result });
  return result;
}
