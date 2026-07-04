import { MCPClient } from "@mastra/mcp";
import type { Tool } from "@mastra/core/tools";
import { withTimeoutRetry } from "../pipeline/concurrency.js";
import { isCaptureMode, isMockMode, mockMoulineuseTools, withCapture } from "./mock.js";

const SERVER_NAME = "moulineuse";

function resolveServerUrl(): string {
  const url = process.env.MCP_MOULINEUSE_URL;
  if (!url) {
    throw new Error("MCP_MOULINEUSE_URL is not set");
  }
  return url;
}

function resolveRequestInit(): RequestInit | undefined {
  const token = process.env.MCP_MOULINEUSE_TOKEN;
  return token ? { headers: { Authorization: `Bearer ${token}` } } : undefined;
}

export const moulineuseMcp = new MCPClient({
  id: SERVER_NAME,
  servers: {
    [SERVER_NAME]: {
      url: new URL(resolveServerUrl()),
      requestInit: resolveRequestInit(),
    },
  },
});

export type MoulineuseTools = Record<string, Tool<any, any, any, any>>;

export async function listMoulineuseTools(): Promise<MoulineuseTools> {
  return moulineuseMcp.listTools();
}

/** Picks a subset of Moulineuse tools by their unprefixed tool name (e.g. "query_sql"). */
export function pickMoulineuseTools(tools: MoulineuseTools, toolNames: string[]): MoulineuseTools {
  const picked: MoulineuseTools = {};
  for (const name of toolNames) {
    const namespaced = `${SERVER_NAME}_${name}`;
    const tool = tools[namespaced];
    if (!tool) {
      throw new Error(`Moulineuse tool not found: ${namespaced}`);
    }
    picked[namespaced] = tool;
  }
  return picked;
}

/** Hard cap on a tool result's serialized size. A single wide `query_sql` or a
 * long `search_legal_texts` hit was observed pushing the mentor's prompt past
 * 200k tokens on its own (claude-haiku-4-5's limit) — capping mechanically
 * rules that out regardless of what the model asks for. */
const TOOL_OUTPUT_CAP = 6000;

function truncateResult(result: unknown): unknown {
  const serialized = typeof result === "string" ? result : JSON.stringify(result);
  if (serialized.length <= TOOL_OUTPUT_CAP) return result;
  const omitted = serialized.length - TOOL_OUTPUT_CAP;
  return `${serialized.slice(0, TOOL_OUTPUT_CAP)}…[tronqué : ${omitted} caractères omis — affine ta requête SQL ou ta recherche]`;
}

/** Wraps a live tool so its result is truncated before it ever reaches the
 * model. Composes with withFailSoft: applied first (innermost), so a capped
 * result still flows through fail-soft's try/catch untouched, and a thrown
 * error is never itself subject to truncation. */
function withOutputCap(tool: MoulineuseTools[string]): MoulineuseTools[string] {
  const marked = tool as MoulineuseTools[string] & { __outputCap?: boolean };
  const original = marked.execute?.bind(marked);
  if (!original || marked.__outputCap) return marked;
  marked.__outputCap = true;
  marked.execute = async (inputData: unknown, context: unknown) => {
    const result = await original(inputData, context as never);
    return truncateResult(result);
  };
  return marked;
}

/** Tools tolerant enough that a slow single call is worth retrying once rather
 * than failing straight to "unknown" — the strict getters (get_recipe,
 * get_parlement_item, get_pastilled_article) are deliberately excluded: their
 * failures are almost always a bad/invented id, and retrying a bad id just
 * wastes the same 15s twice. */
const RETRYABLE_TOOL_NAMES = new Set(["search_recipes", "search_legal_texts", "query_sql"]);

// Kept well under MENTOR_TIMEOUT_MS (40s) so a single retried call can't alone
// exhaust a claim's whole budget: worst case here is 2 * 15s = 30s, leaving
// ~10s of headroom for the rest of that claim's tool calls.
const TOLERANT_TOOL_TIMEOUT_MS = 15_000;

/** Wraps a tolerant tool so one timeout gets a single retry before the model
 * ever sees a failure — a lone transient slowness (cold connection, busy
 * upstream) is common on Moulineuse's live path and shouldn't alone force a
 * claim to "unknown". Applied innermost, before withOutputCap/withFailSoft. */
function withToolRetry(name: string, tool: MoulineuseTools[string]): MoulineuseTools[string] {
  if (!RETRYABLE_TOOL_NAMES.has(name)) return tool;
  const marked = tool as MoulineuseTools[string] & { __toolRetry?: boolean };
  const original = marked.execute?.bind(marked);
  if (!original || marked.__toolRetry) return marked;
  marked.__toolRetry = true;
  marked.execute = (inputData: unknown, context: unknown) =>
    withTimeoutRetry(() => original(inputData, context as never), TOLERANT_TOOL_TIMEOUT_MS);
  return marked;
}

/** Tool-specific guidance returned to the model when a live call fails, so it
 * self-corrects instead of dumping a stack trace and burning its step budget.
 * The most common failure is an LLM-invented id passed straight to a getter. */
const FAILSOFT_HINTS: Record<string, string> = {
  get_recipe:
    "Identifiant de recette introuvable. N'invente jamais un id de recette : appelle d'abord search_recipes et réutilise EXACTEMENT l'id retourné dans ses résultats.",
  get_parlement_item:
    "Identifiant introuvable côté API Parlement. Utilise uniquement un id provenant du résultat d'un outil précédent (list_parlement_items, une recette, query_sql) — ne le reconstruis jamais toi-même.",
};

/** Wraps a live tool so a failed call returns a structured, actionable error to
 * the model instead of throwing: the agent rebounds (e.g. falls back to
 * search_recipes) and the pipeline degrades to "unknown" without log noise. */
function withFailSoft(name: string, tool: MoulineuseTools[string]): MoulineuseTools[string] {
  const marked = tool as MoulineuseTools[string] & { __failSoft?: boolean };
  const original = marked.execute?.bind(marked);
  if (!original || marked.__failSoft) return marked;
  marked.__failSoft = true;
  marked.execute = async (inputData: unknown, context: unknown) => {
    try {
      return await original(inputData, context as never);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        isError: true,
        error: message,
        hint: FAILSOFT_HINTS[name] ?? "L'appel a échoué. Réessaie avec d'autres paramètres ou un autre outil.",
      };
    }
  };
  return marked;
}

/**
 * Resolves the tools an agent should get for the given unprefixed tool names,
 * transparently switching to fixture-backed mocks when MOCK_MOULINEUSE=1 so
 * the demo survives a flaky/unavailable live MCP server. When
 * CAPTURE_MOULINEUSE=1, the live tools are used as normal but each call is
 * also recorded into fixtures/moulineuse/ for later replay.
 */
export async function resolveMentorTools(toolNames: string[]): Promise<MoulineuseTools> {
  if (isMockMode()) {
    return mockMoulineuseTools(toolNames);
  }
  const tools = await listMoulineuseTools();
  const picked = pickMoulineuseTools(tools, toolNames);
  for (const name of toolNames) {
    const tool = picked[`${SERVER_NAME}_${name}`];
    if (!tool) continue;
    // Retry innermost (retries the raw call on timeout), then cap the settled
    // result, then fail-soft outermost catches anything still throwing after
    // retries — so a capture run below always records the final, capped value.
    withToolRetry(name, tool);
    withOutputCap(tool);
    withFailSoft(name, tool);
  }
  if (isCaptureMode()) {
    for (const name of toolNames) {
      const tool = picked[`${SERVER_NAME}_${name}`];
      if (tool) withCapture(name, tool);
    }
  }
  return picked;
}
