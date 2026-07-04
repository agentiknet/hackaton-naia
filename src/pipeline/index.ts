import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Agent } from "@mastra/core/agent";
import { appendSummary, appendVerifications, readAudit } from "../audit/log.js";
import { mentorJuristeAgent } from "../mastra/agents/mentor-juriste/index.js";
import { mentorParlementAgent } from "../mastra/agents/mentor-parlement/index.js";
import { naiaAgent } from "../mastra/agents/naia/index.js";
import type { Claim, Profile, Source, Verification } from "../mentors/types.js";
import { extractClaims } from "./claims.js";
import { createLimiter, withTimeout } from "./concurrency.js";
import { verifyClaim } from "./verify.js";

const MENTOR_TIMEOUT_MS = 20_000;
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
): Promise<{ claims: Claim[]; verifications: Verification[]; summaries: ClaimSummary[]; confidenceScore: number }> {
  const claims = await extractClaims(draft);
  const deadline = Date.now() + PIPELINE_BUDGET_MS;
  const limit = createLimiter(MENTOR_CONCURRENCY);

  const tasks = claims.flatMap((claim) =>
    MENTORS.map((mentor) => limit(() => verifyClaimWithinBudget(claim, mentor, deadline))),
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

function loadDemoFixture(question: string): PipelineResult | undefined {
  const path = demoFixturePath(question);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf-8")) as PipelineResult;
}

function saveDemoFixture(question: string, result: PipelineResult): void {
  mkdirSync(DEMO_FIXTURES_DIR, { recursive: true });
  writeFileSync(demoFixturePath(question), JSON.stringify(result, null, 2), "utf-8");
}

/** Replaying a fixture must still leave a readable audit trail behind its own
 * (fixed) conversationId — but only write it once, so replaying the same
 * fixture repeatedly doesn't pile up duplicate verification lines. */
async function ensureDemoAudit(question: string, profile: Profile, fixture: PipelineResult): Promise<void> {
  if (await readAudit(fixture.conversationId)) return;
  await appendVerifications(fixture.conversationId, 1, fixture.verifications);
  await appendSummary(fixture.conversationId, {
    question,
    profile,
    status: fixture.status,
    confidenceScore: fixture.confidenceScore,
    response: fixture.response,
  });
}

export async function runPipeline(
  question: string,
  profile: Profile,
  conversationId: string = randomUUID(),
): Promise<PipelineResult> {
  if (isDemoReplayEnabled()) {
    const fixture = loadDemoFixture(question);
    if (fixture) {
      await ensureDemoAudit(question, profile, fixture);
      return fixture;
    }
  }

  const threshold = confidenceThreshold();

  const draftResult = await naiaAgent.generate(buildNaiaPrompt(question, profile), { maxSteps: NAIA_MAX_STEPS });
  let draft = draftResult.text;

  let { claims, verifications, summaries, confidenceScore } = await verifyDraft(draft, 1, conversationId);
  let status = resolveStatus(confidenceScore, unknownRatio(summaries), threshold);

  if (status !== "answered") {
    const retryResult = await naiaAgent.generate(buildRetryPrompt(question, profile, draft, summaries), {
      maxSteps: NAIA_MAX_STEPS,
    });
    draft = retryResult.text;
    ({ claims, verifications, summaries, confidenceScore } = await verifyDraft(draft, 2, conversationId));
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

/** Load the fixture for this exact intent; failing that (phrasing/apostrophe
 * variance), fall back to the single canonical drafting fixture on disk. The
 * drafting demo has one scenario, so any reasonable phrasing should replay it
 * deterministically rather than fall through to an unstable live call. */
function loadDraftFixture(intent: string): DraftResult | undefined {
  const exact = draftFixturePath(intent);
  if (existsSync(exact)) return JSON.parse(readFileSync(exact, "utf-8")) as DraftResult;

  if (!existsSync(DRAFT_FIXTURES_DIR)) return undefined;
  const [first] = readdirSync(DRAFT_FIXTURES_DIR).filter((f) => f.endsWith(".json")).sort();
  if (!first) return undefined;
  return JSON.parse(readFileSync(join(DRAFT_FIXTURES_DIR, first), "utf-8")) as DraftResult;
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

  const draftGen = await naiaAgent.generate(buildDraftPrompt(intent, baseText), { maxSteps: NAIA_MAX_STEPS });
  const draft = draftGen.text;

  const { claims, verifications, summaries, confidenceScore } = await verifyDraft(draft, 1, conversationId);
  const status = resolveStatus(confidenceScore, unknownRatio(summaries), threshold);

  // Council suggestions run regardless of verdict — even a draft that can't be
  // certified benefits from concrete legistic feedback the député can act on.
  const suggestionsGen = await mentorJuristeAgent.generate(buildSuggestionsPrompt(intent, draft), {
    maxSteps: NAIA_MAX_STEPS,
  });
  const suggestions = parseSuggestions(suggestionsGen.text);

  const sources = collectSources(summaries);
  const refusalReason = status === "answered" ? undefined : buildRefusalReason(summaries);

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
