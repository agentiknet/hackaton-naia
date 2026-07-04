import type { Agent } from "@mastra/core/agent";
import { z } from "zod";
import type { Claim, Verification } from "../mentors/types.js";

const verificationSchema = z.object({
  verdict: z.enum(["supported", "unsupported", "unknown"]),
  source: z
    .object({
      label: z.string().min(1),
      url: z.string().optional(),
      ref: z.string().optional(),
    })
    .optional(),
  quote: z.string().optional(),
});

export interface VerifyClaimOptions {
  abortSignal?: AbortSignal;
}

export async function verifyClaim(
  claim: Claim,
  mentor: Agent<any, any, any, any, any>,
  options?: VerifyClaimOptions,
): Promise<Verification> {
  const start = Date.now();

  const result = await mentor.generate(`Claim à vérifier :\n"${claim.text}"`, {
    // The mandated search strategy (search_recipes -> get_recipe ->
    // describe_table -> query_sql, possibly repeated) routinely takes 5+
    // tool calls before a verdict is reachable. The SDK's default of 5 steps
    // cuts that off mid-search, forcing a false "unknown" — give the mentor
    // enough room to actually exhaust the strategy.
    maxSteps: 12,
    structuredOutput: {
      schema: verificationSchema,
      // The mentor loop can exhaust its steps mid tool-call retry (e.g. a bad
      // search query) without ever settling on clean final text — in that case
      // fall back to "unknown" rather than let a crashed structuring pass
      // propagate, matching "unverifiable stays unknown, never a guess".
      errorStrategy: "fallback",
      fallbackValue: { verdict: "unknown" },
    },
    abortSignal: options?.abortSignal,
  });

  return {
    claim,
    mentor: mentor.id,
    verdict: result.object.verdict,
    source: result.object.source,
    quote: result.object.quote,
    durationMs: Date.now() - start,
  };
}
