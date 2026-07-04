import type { PipelineResult } from "../pipeline/index.js";

/**
 * Where to push a certified answer. Supplied per-request by the caller — naia
 * keeps no contact book, so the channel/address ride along with the question.
 */
export interface NotifyTarget {
  channel: string;
  address: string;
}

/** Formats a certified PipelineResult into a compact, source-cited message body. */
function formatCertifiedMessage(question: string, result: PipelineResult): string {
  const sources = result.sources
    .map((s) => `• ${s.label}${s.ref ? ` (${s.ref})` : ""}${s.url ? ` — ${s.url}` : ""}`)
    .join("\n");

  return [
    `✅ Réponse certifiée par le Conseil des Mentors (confiance ${result.confidenceScore}/100)`,
    "",
    `Question : ${question}`,
    "",
    result.response,
    "",
    sources ? `Sources officielles :\n${sources}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Fire-and-forget push of a certified answer via agentpush. Silently no-ops
 * when the env is missing (demo/dev), the answer wasn't certified, or no target
 * was supplied. Never throws — dogfooding a notification must not break the
 * HTTP response, so all failures are swallowed to a warning.
 */
export async function notifyCertified(
  question: string,
  result: PipelineResult,
  target: NotifyTarget | undefined,
): Promise<void> {
  const baseUrl = process.env.AGENTPUSH_BASE_URL;
  const apiKey = process.env.AGENTPUSH_API_KEY;

  if (result.status !== "answered") return;
  if (!baseUrl || !apiKey) return;
  if (!target?.channel || !target?.address) return;

  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/tools/send_message`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        to: { channel: target.channel, address: target.address },
        content: { text: formatCertifiedMessage(question, result) },
      }),
    });

    if (!res.ok) {
      console.warn(`[agentpush] send_message failed: ${res.status} ${await res.text().catch(() => "")}`);
    }
  } catch (error) {
    console.warn(`[agentpush] send_message error: ${error instanceof Error ? error.message : String(error)}`);
  }
}
