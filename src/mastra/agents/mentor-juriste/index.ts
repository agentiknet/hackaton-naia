import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { anthropic } from "@ai-sdk/anthropic";
import { Agent } from "@mastra/core/agent";
import { resolveMentorTools } from "../../mcp.js";

const instructions = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "instructions.md"), "utf-8");

export const mentorJuristeAgent = new Agent({
  id: "mentor-juriste",
  name: "mentor-juriste",
  instructions,
  model: anthropic("claude-sonnet-5"),
  tools: () =>
    resolveMentorTools([
      "search_recipes",
      "get_recipe",
      "search_legal_texts",
      "describe_table",
      "query_sql",
      "get_pastilled_article",
    ]),
});
