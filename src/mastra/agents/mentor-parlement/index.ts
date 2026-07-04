import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { anthropic } from "@ai-sdk/anthropic";
import { Agent } from "@mastra/core/agent";
import { resolveMentorTools } from "../../mcp.js";

const instructions = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "instructions.md"), "utf-8");

export const mentorParlementAgent = new Agent({
  id: "mentor-parlement",
  name: "mentor-parlement",
  instructions,
  model: anthropic("claude-sonnet-5"),
  tools: () =>
    resolveMentorTools([
      "search_recipes",
      "get_recipe",
      "list_parlement_items",
      "get_parlement_item",
      "describe_table",
      "query_sql",
    ]),
});
