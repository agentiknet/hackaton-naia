import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { MoulineuseTools } from "./mcp.js";

const FIXTURES_DIR = join(process.cwd(), "fixtures", "moulineuse");

export function isMockMode(): boolean {
  return process.env.MOCK_MOULINEUSE === "1";
}

export function isCaptureMode(): boolean {
  return process.env.CAPTURE_MOULINEUSE === "1";
}

/** Fixture files are a map of argsHash -> {args, response} so distinct calls
 * to the same tool (different queries, different article refs) each keep
 * their own recorded response instead of overwriting one another. */
type FixtureFile = Record<string, { args: unknown; response: unknown }>;

function fixturePath(toolName: string): string {
  return join(FIXTURES_DIR, `${toolName}.json`);
}

function hashArgs(args: unknown): string {
  return createHash("sha256").update(JSON.stringify(args ?? {})).digest("hex").slice(0, 16);
}

function loadFixtureFile(toolName: string): FixtureFile {
  const path = fixturePath(toolName);
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf-8"));
}

function saveFixtureEntry(toolName: string, args: unknown, response: unknown): void {
  mkdirSync(FIXTURES_DIR, { recursive: true });
  const file = loadFixtureFile(toolName);
  file[hashArgs(args)] = { args, response };
  writeFileSync(fixturePath(toolName), JSON.stringify(file, null, 2));
}

/**
 * Demo safety net: if the live Moulineuse MCP is unavailable, mentors read
 * canned fixtures instead, keyed by a hash of the call args so distinct
 * queries against the same tool each get their own recorded response. A
 * missing fixture entry returns "no data found" so the mentor has nothing to
 * cite and must render verdict "unknown" — it never fabricates a supported
 * verdict from an absent fixture.
 */
export function mockMoulineuseTools(toolNames: string[]): MoulineuseTools {
  const tools: MoulineuseTools = {};
  for (const name of toolNames) {
    const namespaced = `moulineuse_${name}`;
    tools[namespaced] = createTool({
      id: namespaced,
      description: `[MOCK] ${name} — lit fixtures/moulineuse/${name}.json (mode MOCK_MOULINEUSE=1)`,
      inputSchema: z.record(z.string(), z.unknown()),
      outputSchema: z.unknown(),
      execute: async (inputData: unknown) => {
        const entry = loadFixtureFile(name)[hashArgs(inputData)];
        return entry === undefined
          ? { mock: true, found: false, message: "Aucune fixture disponible pour cet outil." }
          : entry.response;
      },
    }) as MoulineuseTools[string];
  }
  return tools;
}

/**
 * Capture wrapper: runs the real tool against the live Moulineuse MCP, then
 * records {args, response} into fixtures/moulineuse/<tool>.json keyed by a
 * hash of the args, so mockMoulineuseTools can replay the exact same
 * response later without the live server. Mutates the tool in place (rather
 * than spreading into a new object) to preserve its prototype/markers.
 */
export function withCapture(name: string, tool: MoulineuseTools[string]): MoulineuseTools[string] {
  const original = tool.execute?.bind(tool);
  if (!original) return tool;
  tool.execute = async (inputData: unknown, context: unknown) => {
    const response = await original(inputData as never, context as never);
    saveFixtureEntry(name, inputData, response);
    return response;
  };
  return tool;
}
