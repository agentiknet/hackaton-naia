# Naia — Pitch Deck (hackathon Assemblée nationale, 2026-07-04)

Format : 9 slides, une idée par slide. TITRE + bullets + note orateur.

---

## Slide 1 — Le problème

**TITRE : Une IA qui invente la loi n'a pas sa place au Parlement**

- Les IA génériques répondent toujours — même quand elles ne savent pas. En droit, une hallucination n'est pas un détail : c'est une désinformation citoyenne ou une erreur d'un élu.
- Le vrai risque n'est pas que l'IA se trompe. C'est qu'elle se trompe *avec assurance*, sans qu'on puisse le vérifier.
- Un usage parlementaire exige un niveau de preuve que le grand public n'exige pas ailleurs : chaque affirmation doit être traçable jusqu'à un texte officiel.
- Confiance et responsabilité ne sont pas des options UX : c'est la condition d'entrée.

**Note orateur :** « Aujourd'hui, une IA qui hallucine une loi, ce n'est pas un bug — c'est un problème de confiance démocratique. »

---

## Slide 2 — Naia en une phrase

**TITRE : Naia ne répond que ce qu'elle peut prouver**

- L'assistante parlementaire qui ne délivre une réponse que si elle est sourcée sur les textes officiels.
- Chaque affirmation est vérifiée avant envoi par un Conseil des Mentors — pas par l'agent lui-même.
- Deux profils d'usage dès aujourd'hui : citoyen et député.
- Le refus assumé fait partie du produit, pas de l'échec.

**Note orateur :** « Naia, c'est l'assistante parlementaire qui préfère dire "je ne sais pas" plutôt que d'inventer. »

---

## Slide 3 — Comment ça marche

**TITRE : Un Conseil des Mentors entre le brouillon et la réponse**

- Naia rédige un brouillon de réponse et identifie ses affirmations (claims) une par une.
- Un mentor-juriste vérifie chaque claim contre Légifrance/JORF ; un mentor-parlement vérifie contre les dossiers, amendements et scrutins de l'Assemblée/Sénat — via Moulineuse, notre passerelle MCP vers les données officielles.
- Le passage entre brouillon et réponse envoyée est un gate imposé par le code, pas laissé à la discrétion du modèle.
- Rien ne sort sans être passé par ce contrôle.

**Note orateur :** « Ce n'est pas l'IA qui se fait confiance à elle-même : c'est un conseil indépendant qui vérifie chaque phrase. »

---

## Slide 4 — Les 3 verdicts

**TITRE : L'honnêteté par défaut**

- **certified** : chaque affirmation est sourcée, score de confiance ≥ 70 → réponse envoyée avec citations.
- **insufficient** : les sources ne sont pas disponibles ou pas concluantes → Naia le dit, plutôt que de deviner.
- **refused** : le Conseil détecte une contradiction avec les textes officiels → Naia bloque la réponse.
- Trois issues possibles, jamais de quatrième voie où elle invente.

**Note orateur :** « Certified, insuffisant, ou refusé : ce sont les seules trois réponses possibles — jamais une quatrième où elle bluffe. »

---

## Slide 5 — Démo, 4 temps

**TITRE : La démo — 4 temps, en direct**

- **1. Réponse citoyenne sourcée** : une vraie question, une réponse certifiée citant l'article L.100-4 réel du code de l'énergie.
- **2. Vue député** : la même loi vue côté élu — votes, amendements, parcours législatif sourcés.
- **3. Question piège** : une loi qui n'existe pas → Naia **refuse**, audit affiché à l'écran en direct.
- **4. Filet de sécurité** : si le réseau lâche en plein pitch, bascule automatique en mode démo (fixtures) — la démo continue sans coupure.
- Ce mécanisme est fait main, pas un business-plan.

**Note orateur :** « Regardez : sur une question piège, elle refuse — et vous voyez l'audit qui le prouve, en direct. »

---

## Slide 6 — Transparence et auditabilité

**TITRE : Chaque décision est loggée, chaque affirmation est traçable**

- Chaque verdict des mentors est écrit dans un journal d'audit (JSONL) : claim, mentor, verdict, source, horodatage.
- On peut remonter, affirmation par affirmation, jusqu'à la source qui l'a validée ou invalidée.
- Ce n'est pas une boîte noire qui décide seule : c'est une chaîne de décision consultable après coup.
- Prêt pour une logique de conformité type AI Act — la traçabilité est intégrée dès la conception, pas ajoutée après.

**Note orateur :** « On ne vous demande pas de nous croire sur parole : chaque décision est écrite, datée, et sourcée. »

---

## Slide 7 — Pourquoi c'est crédible

**TITRE : C'est debout, en direct, sur de vraies sources**

- Ce que vous venez de voir tourne sur les vraies données Assemblée/Sénat/Légifrance, pas sur un jeu de données factice.
- Le pipeline (rédaction → extraction de claims → vérification parallèle → arbitrage) est du code qui tourne, pas un schéma en slide.
- Le refus sur la question piège n'est pas scripté dans une démo vidéo : c'est le Conseil des Mentors qui le décide, en direct.
- Construit et calibré en une session hackathon — la fondation tient.

**Note orateur :** « Ce n'est pas un mockup : c'est vivant, et ça tourne sur les vraies sources, là, maintenant. »

---

## Slide 8 — Roadmap

**TITRE : De la démo aux 577**

- **577 députés** : un agent par député, généré automatiquement depuis les données publiques de son mandat.
- **Canaux** : WhatsApp et voix, pour toucher les citoyens là où ils sont déjà.
- **OpenFisca** : simulation d'impact concret d'une loi sur un foyer ou un territoire.
- **Souveraineté** : modèles et hébergement France/UE — la confiance ne s'arrête pas au sourcing, elle inclut où tournent les données.

**Note orateur :** « La brique est là : demain, c'est un agent par député, sur WhatsApp, à la voix, avec un impact chiffré par foyer. »

---

## Slide 9 — Closing

**TITRE : La confiance, une fonctionnalité — pas une option**

- Une IA parlementaire ne se juge pas à ce qu'elle sait répondre, mais à ce qu'elle sait refuser.
- Naia est la première brique d'une IA publique qui rend des comptes, affirmation par affirmation.
- Le Conseil des Mentors, le gate, l'audit : ce n'est pas de la prudence en plus, c'est le produit.
- On construit la confiance comme fonctionnalité de base — pas comme un supplément qu'on ajoute si le temps le permet.

**Note orateur :** « La question n'est pas "est-ce que l'IA peut répondre ?" — c'est "est-ce qu'elle sait dire non". »
