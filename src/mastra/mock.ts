import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { MoulineuseTools } from "./mcp.js";

const FIXTURES_DIR = join(process.cwd(), "fixtures", "moulineuse");

export function isMockMode(): boolean {
  return process.env.MOCK_MOULINEUSE === "1";
}

function loadFixture(toolName: string): unknown | undefined {
  const path = join(FIXTURES_DIR, `${toolName}.json`);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf-8"));
}

/**
 * Demo safety net: if the live Moulineuse MCP is unavailable, mentors read
 * canned fixtures instead. A missing fixture returns "no data found" so the
 * mentor has nothing to cite and must render verdict "unknown" — it never
 * fabricates a supported verdict from an absent fixture.
 */
export function mockMoulineuseTools(toolNames: string[]): MoulineuseTools {
  const tools: MoulineuseTools = {};
  for (const name of toolNames) {
    const namespaced = `moulineuse_${name}`;
    const fixture = loadFixture(name);
    tools[namespaced] = createTool({
      id: namespaced,
      description: `[MOCK] ${name} — lit fixtures/moulineuse/${name}.json (mode MOCK_MOULINEUSE=1)`,
      inputSchema: z.record(z.string(), z.unknown()),
      outputSchema: z.unknown(),
      execute: async () =>
        fixture === undefined
          ? { mock: true, found: false, message: "Aucune fixture disponible pour cet outil." }
          : fixture,
    }) as MoulineuseTools[string];
  }
  return tools;
}
