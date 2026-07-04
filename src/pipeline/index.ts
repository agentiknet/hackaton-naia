import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

function buildNaiaPrompt(question: string, profile: Profile): string {
  return `Profil de l'utilisateur : ${profile}\n\nQuestion : ${question}`;
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
    `Profil de l'utilisateur : ${profile}`,
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

function buildRefusalMessage(summaries: ClaimSummary[]): string {
  const problematic = summaries.filter((s) => s.verdict !== "supported");
  const lines = problematic.map((s) => `- « ${s.claim.text} »`);
  return [
    "Je ne peux pas certifier cette réponse avec suffisamment de confiance pour vous la transmettre.",
    "Les affirmations suivantes n'ont pas pu être confirmées par le Conseil des Mentors :",
    ...lines,
    "Reformulez votre question ou consultez directement les sources officielles (Assemblée nationale, Sénat, Légifrance).",
  ].join("\n");
}

function buildInsufficientMessage(summaries: ClaimSummary[]): string {
  const unresolved = summaries.filter((s) => s.verdict === "unknown");
  const lines = unresolved.map((s) => `- « ${s.claim.text} »`);
  return [
    "Les sources nécessaires pour vérifier cette réponse sont partiellement indisponibles : je ne peux pas la certifier.",
    "Le Conseil des Mentors n'a pas pu trouver de source pour la majorité des affirmations suivantes :",
    ...lines,
    "Réessayez plus tard ou consultez directement les sources officielles (Assemblée nationale, Sénat, Légifrance).",
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

  await appendSummary(conversationId, { question, profile, status, confidenceScore, response });

  const result: PipelineResult = { conversationId, response, sources, confidenceScore, status, claims, verifications };

  if (isDemoCaptureEnabled() && status === "answered") {
    saveDemoFixture(question, result);
  }

  return result;
}
