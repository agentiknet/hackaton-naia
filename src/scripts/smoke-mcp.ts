import { listMoulineuseTools, moulineuseMcp } from "../mastra/mcp.js";

async function main() {
  console.log(`Connecting to Moulineuse MCP at ${process.env.MCP_MOULINEUSE_URL} ...`);

  const tools = await listMoulineuseTools();
  const names = Object.keys(tools).sort();

  if (names.length === 0) {
    throw new Error("Moulineuse MCP connected but returned zero tools");
  }

  console.log(`Connected. ${names.length} tool(s) available:`);
  for (const name of names) {
    console.log(`  - ${name}`);
  }
}

main()
  .then(() => moulineuseMcp.disconnect())
  .catch(async (error) => {
    console.error("smoke-mcp FAILED:", error);
    await moulineuseMcp.disconnect().catch(() => {});
    process.exit(1);
  });
