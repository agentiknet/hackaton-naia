import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { anthropic } from "@ai-sdk/anthropic";
import { Agent } from "@mastra/core/agent";
import { listMoulineuseTools, pickMoulineuseTools } from "../../mcp.js";

const instructions = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "instructions.md"), "utf-8");

export const mentorJuristeAgent = new Agent({
  id: "mentor-juriste",
  name: "mentor-juriste",
  instructions,
  model: anthropic("claude-haiku-4-5"),
  tools: async () => {
    const tools = await listMoulineuseTools();
    return pickMoulineuseTools(tools, ["search_legal_texts", "get_pastilled_article"]);
  },
});
