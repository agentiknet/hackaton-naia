import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Claim, Profile, Verification } from "../mentors/types.js";

const AUDIT_DIR = join(process.cwd(), "audit");

export type PipelineStatus = "answered" | "insufficient" | "refused";

interface VerificationAuditLine {
  kind: "verification";
  ts: string;
  conversationId: string;
  attempt: number;
  claim: Claim;
  mentor: string;
  verdict: Verification["verdict"];
  source?: Verification["source"];
  quote?: string;
  durationMs: number;
  error?: string;
}

interface SummaryAuditLine {
  kind: "summary";
  ts: string;
  conversationId: string;
  question: string;
  profile: Profile;
  status: PipelineStatus;
  confidenceScore: number;
  response: string;
}

type AuditLine = VerificationAuditLine | SummaryAuditLine;

async function ensureAuditDir(): Promise<void> {
  await mkdir(AUDIT_DIR, { recursive: true });
}

function auditFilePath(conversationId: string): string {
  return join(AUDIT_DIR, `${conversationId}.jsonl`);
}

async function appendLines(conversationId: string, lines: AuditLine[]): Promise<void> {
  await ensureAuditDir();
  const body = lines.map((line) => `${JSON.stringify(line)}\n`).join("");
  await appendFile(auditFilePath(conversationId), body, "utf-8");
}

export async function appendVerifications(
  conversationId: string,
  attempt: number,
  verifications: Verification[],
): Promise<void> {
  const ts = new Date().toISOString();
  await appendLines(
    conversationId,
    verifications.map((v) => ({
      kind: "verification",
      ts,
      conversationId,
      attempt,
      claim: v.claim,
      mentor: v.mentor,
      verdict: v.verdict,
      source: v.source,
      quote: v.quote,
      durationMs: v.durationMs,
      error: v.error,
    })),
  );
}

export async function appendSummary(
  conversationId: string,
  summary: {
    question: string;
    profile: Profile;
    status: PipelineStatus;
    confidenceScore: number;
    response: string;
  },
): Promise<void> {
  await appendLines(conversationId, [
    {
      kind: "summary",
      ts: new Date().toISOString(),
      conversationId,
      ...summary,
    },
  ]);
}

export interface AuditTrail {
  conversationId: string;
  claims: Claim[];
  verifications: Verification[];
  finalResponse: string;
  confidenceScore: number;
  status?: PipelineStatus;
  createdAt: string;
}

export async function readAudit(conversationId: string): Promise<AuditTrail | undefined> {
  const path = auditFilePath(conversationId);
  if (!existsSync(path)) return undefined;

  const raw = await readFile(path, "utf-8");
  const lines: AuditLine[] = raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as AuditLine);

  const verificationLines = lines.filter((line): line is VerificationAuditLine => line.kind === "verification");
  const summaryLines = lines.filter((line): line is SummaryAuditLine => line.kind === "summary");
  const lastSummary = summaryLines.at(-1);

  const claimsById = new Map<string, Claim>();
  for (const line of verificationLines) claimsById.set(line.claim.id, line.claim);

  return {
    conversationId,
    claims: [...claimsById.values()],
    verifications: verificationLines.map((line) => ({
      claim: line.claim,
      mentor: line.mentor,
      verdict: line.verdict,
      source: line.source,
      quote: line.quote,
      durationMs: line.durationMs,
      error: line.error,
    })),
    finalResponse: lastSummary?.response ?? "",
    confidenceScore: lastSummary?.confidenceScore ?? 0,
    status: lastSummary?.status,
    createdAt: lines[0]?.ts ?? new Date().toISOString(),
  };
}
