import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { anthropic } from "@ai-sdk/anthropic";
import { Agent } from "@mastra/core/agent";
import { listMoulineuseTools, pickMoulineuseTools } from "../../mcp.js";

const instructions = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "instructions.md"), "utf-8");

export const mentorParlementAgent = new Agent({
  id: "mentor-parlement",
  name: "mentor-parlement",
  instructions,
  model: anthropic("claude-haiku-4-5"),
  tools: async () => {
    const tools = await listMoulineuseTools();
    return pickMoulineuseTools(tools, ["query_sql", "list_parlement_items", "get_parlement_item"]);
  },
});
