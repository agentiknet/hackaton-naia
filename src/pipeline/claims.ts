import { anthropic } from "@ai-sdk/anthropic";
import { Agent } from "@mastra/core/agent";
import { z } from "zod";
import type { Claim } from "../mentors/types.js";

const claimsSchema = z.object({
  claims: z
    .array(z.string().min(1))
    .describe("Affirmations factuelles atomiques, une par élément, texte brut sans numérotation."),
});

const claimExtractorAgent = new Agent({
  id: "claim-extractor",
  name: "claim-extractor",
  instructions: `Tu extrais les affirmations factuelles atomiques ("claims") d'un texte de réponse
produit par un assistant parlementaire. Une claim atomique porte une seule affirmation
vérifiable : une référence légale (article, texte, code), un fait chiffré, une date, un
résultat de vote, le contenu d'un amendement ou d'un dossier législatif.

Règles :
- Découpe toute phrase qui contient plusieurs affirmations distinctes en autant de claims.
- Ignore les formules de politesse, les transitions, les avis et les reformulations de la
  question posée : ce ne sont pas des claims.
- Ne fusionne jamais deux affirmations indépendantes portant sur des articles ou des faits
  différents, même si elles apparaissent dans la même phrase.
- Reformule chaque claim comme une phrase autonome et compréhensible hors contexte (sujet
  explicite, pas de pronom sans antécédent).
- S'il n'y a aucune affirmation factuelle vérifiable dans le texte, renvoie une liste vide.
- Regroupe ensuite : renvoie au maximum 6 claims au total. Si le texte contient plus de 6
  affirmations atomiques, fusionne en priorité les micro-affirmations qui portent sur le même
  article ou la même disposition (par exemple plusieurs chiffres ou échéances du même article de
  loi) en une seule claim plus riche qui les énumère toutes, plutôt que de les vérifier une par
  une. Ne fusionne jamais des affirmations qui portent sur des articles ou des sources
  différents : réduis leur nombre en retenant les 6 affirmations les plus substantielles pour la
  réponse plutôt que les détails secondaires.`,
  model: anthropic("claude-haiku-4-5"),
});

const MAX_CLAIMS = 6;

export async function extractClaims(draft: string): Promise<Claim[]> {
  const result = await claimExtractorAgent.generate(`Texte à analyser :\n"""\n${draft}\n"""`, {
    structuredOutput: { schema: claimsSchema },
  });

  // Backstop: the prompt asks for at most MAX_CLAIMS, but an LLM can still
  // overshoot — the pipeline's global time budget assumes a bounded claim
  // count, so enforce the cap in code rather than trust it's always honored.
  return result.object.claims.slice(0, MAX_CLAIMS).map((text, index) => ({
    id: `c${index + 1}`,
    text,
  }));
}
