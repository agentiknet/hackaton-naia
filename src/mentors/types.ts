export interface Claim {
  id: string;
  text: string;
}

export type Verdict = "supported" | "unsupported" | "unknown";

export interface Source {
  title: string;
  url: string;
  excerpt?: string;
}

export interface Verification {
  claim: Claim;
  sources: Source[];
  verdict: Verdict;
  score: number;
}

export interface AuditEntry {
  conversationId: string;
  claims: Claim[];
  verifications: Verification[];
  finalResponse: string;
  confidenceScore: number;
  createdAt: string;
}
