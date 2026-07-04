import { mentorJuristeAgent } from "../mastra/agents/mentor-juriste/index.js";
import { verifyClaim } from "../pipeline/verify.js";

const CLAIMS = [
  {
    id: "true-1",
    text: "L'article L100-4 du code de l'énergie fixe un objectif de réduction de la consommation énergétique finale de 50% en 2050 par rapport à 2012.",
  },
  {
    id: "false-1",
    text: "L'article L100-4 du code de l'énergie interdit la vente de véhicules thermiques neufs à partir de 2028.",
  },
];

async function main() {
  for (const claim of CLAIMS) {
    console.log(`\n--- Claim ${claim.id} ---`);
    console.log(claim.text);
    const verification = await verifyClaim(claim, mentorJuristeAgent);
    console.log(JSON.stringify(verification, null, 2));
  }
}

main().catch((error) => {
  console.error("smoke-verify FAILED:", error);
  process.exit(1);
});
