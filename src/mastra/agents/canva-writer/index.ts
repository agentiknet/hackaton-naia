import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { anthropic } from "@ai-sdk/anthropic";
import { Agent } from "@mastra/core/agent";
import { makeCanvaTool } from "../../tools/make-canva.tool.js";

const instructions = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "instructions.md"), "utf-8");

export const canvaWriterAgent = new Agent({
  id: "canva-writer",
  name: "canva-writer",
  instructions,
  model: anthropic("claude-haiku-4-5"),
  tools: () => ({ make_canva: makeCanvaTool }),
});
