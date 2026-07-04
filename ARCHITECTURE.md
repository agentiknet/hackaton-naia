# Naia — Architecture (hackathon AN 2026, draft v1)

Positionnement : « Le parcours de la loi : vers une IA de confiance » → Naia traite le DÉFI (confiance).
Les autres simplifient/résument ; Naia **refuse de répondre quand elle ne peut pas prouver**.
Axe produit : la LOI est la colonne vertébrale, le DÉPUTÉ est la porte d'entrée (porte-parole factuel, pas un « clone » — il ne répond que depuis le documenté et refuse au-delà).

## Principes

1. **Gate déterministe** : le Conseil des Mentors n'est PAS un supervisor-agent (délégation à la discrétion du modèle) — c'est un workflow imposé par le code entre le draft et l'envoi.
2. **Transparence file-based, chargement programmatique** : chaque agent garde son dossier avec `instructions.md` lisible et versionné (« une IA de confiance est une IA qu'on peut lire »), mais les agents sont instanciés en code (`new Agent({...})`, instructions lues depuis le .md au boot). PAS de discovery `mastra dev` file-based (beta, usage nul dans l'org, couplée au bundler CLI). Le pitch transparence est intact, le risque beta disparaît.
3. **Trois étages de données** : (a) `kb/` versionnée construite par `scripts/ingest-*` depuis un **clone local des dépôts Git de données Tricoteuses** (framagit.org/tricoteuses, JSON nettoyé quotidien ; env `DATA_DIR`, provenance = repo+sha+path dans chaque fichier kb/) ; (b) les Mentors vérifient contre **Moulineuse live** (SQL canutes, Typesense, pastilles) ; (c) **fixtures/** snapshot pour le mode MOCK démo. Les dépôts bruts ne sont jamais vendorisés dans naia.
4. **Autonomie open source** : zéro dépendance Guilde/agentik-studio. Pas de Qdrant à l'échelle démo (retrieval fichiers dans le workspace de l'agent).

## Arborescence

```
naia/
├── src/
│   ├── server.ts                  # Hono : POST /api/chat, POST /api/verify, GET /api/audit/:id, GET /health
│   ├── pipeline.ts                # LE GATE (workflow) : draft → claims → mentors → arbitre → send/block + audit
│   └── mastra/
│       ├── index.ts
│       └── agents/
│           ├── naia/              # assistant principal (config.ts, instructions.md, tools/ = wrappers MCP Moulineuse)
│           ├── mentor-juriste/    # vérifie contre LEGI/JORF (search_legal_texts, get_pastilled_article)
│           ├── mentor-parlement/  # vérifie contre dossiers/amendements/scrutins (query_sql)
│           └── depute-<slug>/     # GÉNÉRÉ par script, commité (instructions.md persona + workspace/kb seed)
├── kb/                            # source de vérité versionnée
│   ├── lois/<dossier>/            # texte, parcours (timeline 6 étapes), amendements clés
│   └── deputes/<slug>/            # PROFILE.md, amendements.md, votes.md, interventions.md (uid + lien source)
├── scripts/
│   ├── ingest-depute.ts           # Moulineuse → kb/deputes/<slug>/ (idempotent par uid)
│   ├── ingest-loi.ts              # Moulineuse → kb/lois/<dossier>/
│   └── gen-depute-agent.ts        # kb/ → src/mastra/agents/depute-<slug>/
└── audit/                         # JSONL runtime (gitignoré)
```

## Pipeline (Conseil des Mentors)

```
[0] naia.generate(question, profil depute|citoyen) → draft + sources candidates
[1] extractClaims (LLM léger, structured output) → claims atomiques
[2] PAR CLAIM, EN PARALLÈLE :
      mentor-juriste   → verdict {supported|unsupported|unknown} + citation LEGI/JORF
      mentor-parlement → verdict + citation dossier/amendement/scrutin
[3] arbitre (PUR CODE, pas de LLM) : agrégation, score 0-100, seuil
      ≥ seuil → envoi avec citations pastillées [Source: …]
      < seuil → 1 retry reformulation, sinon refus assumé (« je ne peux pas certifier »)
[4] audit JSONL systématique : {claim, mentor, verdict, source, ts} — AI Act by design
```

Implémentation : fonction `pipeline.ts` typée, faite main — PAS `createWorkflow` (friction zod connue dans l'org, aucun `.parallel()` natif). Fan-out des mentors en `Promise.all` avec **timeout dur par appel MCP + cap de concurrence** (pattern `parallelThink` de `packages/council` d'agentik-studio — on copie la structure, pas la dépendance). Arbitre pur code façon `synthesizer.ts` (verdicts → table de seuils → décision). Le passage reste imposé par le code.

## Démo (1 loi fil rouge, ex. loi énergie)

1. Citoyen : « ça change quoi pour moi ? » → réponse certifiée + timeline parcours de la loi (données `dossiers_legislatifs`).
2. « Et mon député, il a voté quoi ? » → vue député sourcée (votes/amendements réels).
3. Question piège → REFUS + audit log à l'écran (le beat gagnant).
4. Slides : 577 députés générables, WhatsApp (agentpush), voice, OpenFisca.

## Décisions validées contre la stack (revue 2026-07-04, sess naia-arch-review)

- **Agents programmatiques** : `new Agent({...})` + `instructions.md` lu au boot. Pas de discovery file-based beta. `@mastra/core@1.48.0` = version confirmée partout dans l'org.
- **Pipeline fait main** : `pipeline.ts` typé, fan-out `Promise.all` + timeout dur/appel MCP + cap concurrence, arbitre pur code. Référence interne : `packages/council` (parallelThink/synthesizer) — structure copiée, zéro dépendance.
- **MCP client** : `MCPClient` natif de `@mastra/mcp` (retourne des MastraTool spreadables dans `tools`) — remplacer le wrapper @modelcontextprotocol/sdk du scaffold.
- **Extraction de claims** : `agent.generate(prompt, { structuredOutput: { schema } })` (zod). Éviter `experimental_output`/legacy.
- **Deps à ajouter** : `@mastra/core@1.48.0`, `@mastra/mcp`, `ai`, `@ai-sdk/anthropic`, `zod`.
- **Fallback démo** : snapshot local des réponses Moulineuse du scénario fil rouge (si le MCP live tousse pendant le pitch, la démo vit). Tâche #0 de la session build : faire booter un agent + MCPClient minimal AVANT tout le reste.
