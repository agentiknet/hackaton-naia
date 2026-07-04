export interface Claim {
  id: string;
  text: string;
}

export type Verdict = "supported" | "unsupported" | "unknown";

export type Profile = "depute" | "citoyen";

export interface Source {
  label: string;
  url?: string;
  ref?: string;
}

export interface Verification {
  claim: Claim;
  mentor: string;
  verdict: Verdict;
  source?: Source;
  quote?: string;
  durationMs: number;
  error?: string;
}
