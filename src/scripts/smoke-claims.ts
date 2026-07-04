import { extractClaims } from "../pipeline/claims.js";

const SAMPLES = [
  "L'article L100-4 du code de l'énergie fixe un objectif de réduction de la consommation énergétique finale de 50% en 2050 par rapport à 2012.",
  "Le Parlement a adopté ce texte en première lecture le 12 mars 2024.",
  "Cette loi crée une nouvelle taxe sur les logements vacants et abaisse simultanément le taux de TVA applicable aux travaux de rénovation énergétique.",
];

async function main() {
  for (const [i, sample] of SAMPLES.entries()) {
    console.log(`\n--- Sample ${i + 1} ---`);
    console.log(sample);
    const claims = await extractClaims(sample);
    console.log(`→ ${claims.length} claim(s):`);
    for (const claim of claims) {
      console.log(`  [${claim.id}] ${claim.text}`);
    }
  }
}

main().catch((error) => {
  console.error("smoke-claims FAILED:", error);
  process.exit(1);
});
