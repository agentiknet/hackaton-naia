import { buildCanva } from "../mastra/tools/make-canva.tool.js";

async function main() {
  console.log("--- document ---");
  const doc = await buildCanva({
    title: "Objectif de réduction de la consommation d'énergie",
    subtitle: "Article L100-4 du code de l'énergie",
    template: "document",
    sections: [
      {
        heading: "Ce que dit le texte",
        html: "<p>L'article <strong>L100-4</strong> du code de l'énergie fixe un objectif de réduction de la consommation énergétique finale de <strong>50%</strong> en 2050 par rapport à 2012.</p>",
      },
      {
        heading: "Source",
        html: "<ul><li>Code de l'énergie, article L100-4</li><li>Version en vigueur</li></ul>",
      },
    ],
  });
  console.log(doc);
  console.log(`engine: ${doc.engine}`);

  console.log("\n--- deck ---");
  const deck = await buildCanva({
    title: "Parcours législatif d'un texte de loi",
    template: "deck",
    slides: [
      { title: "Dépôt", content: "<p>Le texte est déposé au Bureau de l'Assemblée nationale ou du Sénat.</p>" },
      { title: "Commission", content: "<p>Examen en commission, dépôt et discussion des amendements.</p>" },
      { title: "Séance publique", content: "<p>Discussion générale, examen des articles, vote solennel.</p>" },
      { title: "Promulgation", content: "<p>Une fois adopté par les deux chambres, le texte est promulgué et publié au JORF.</p>" },
    ],
  });
  console.log(deck);
  console.log(`engine: ${deck.engine}`);
}

main().catch((error) => {
  console.error("smoke-canva FAILED:", error);
  process.exit(1);
});
