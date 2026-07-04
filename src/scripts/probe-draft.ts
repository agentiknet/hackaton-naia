import { naiaAgent } from "../mastra/agents/naia/index.js";

async function main() {
  const result = await naiaAgent.generate(
    "Profil de l'utilisateur : citoyen\n\nQuestion : Que dit la loi sur l'objectif de réduction de la consommation d'énergie ?",
    { maxSteps: 12 },
  );
  console.log("=== DRAFT TEXT ===");
  console.log(result.text);
}

main().catch((error) => {
  console.error("FAILED:", error);
  process.exit(1);
});
