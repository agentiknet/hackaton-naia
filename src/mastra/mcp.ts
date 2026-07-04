import { MCPClient } from "@mastra/mcp";
import type { Tool } from "@mastra/core/tools";
import { isMockMode, mockMoulineuseTools } from "./mock.js";

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

/**
 * Resolves the tools an agent should get for the given unprefixed tool names,
 * transparently switching to fixture-backed mocks when MOCK_MOULINEUSE=1 so
 * the demo survives a flaky/unavailable live MCP server.
 */
export async function resolveMentorTools(toolNames: string[]): Promise<MoulineuseTools> {
  if (isMockMode()) {
    return mockMoulineuseTools(toolNames);
  }
  const tools = await listMoulineuseTools();
  return pickMoulineuseTools(tools, toolNames);
}
