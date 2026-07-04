# Naia — Doc de reprise (état au 2026-07-04 ~03h45, pitch AUJOURD'HUI)

Pour toute nouvelle session (Cowork ou claude-code) : lire ce fichier + ARCHITECTURE.md, puis dérouler « Prochaines étapes ».
Plan de supervision complet : `agentik-studio/.docs/naia/SUPERVISION.md` · Sources data : `.docs/naia/DATASOURCES.md`.

## Où on en est (fait ✅)

- **Repo** : ici (`projects/hackatons/naia`, repo git imbriqué) → `github.com/agentiknet/hackaton-naia` (**privé** ; passage public au freeze sur go Jeremy). Identité commits : `Jeremy Andre <jeremy@agentik.net>` via `git -c`, JAMAIS de config globale, JAMAIS de git dans le repo parent agentik-studio.
- **Commits** : `933745e` scaffold · `168ce76` fondation Mastra (gate B) · `b530e33` UI démo (gate C). **Du travail calibration NON COMMITTÉ est dans l'arbre** (instructions mentors/naia, pipeline, mock, audit — voir git status).
- **Fondation (B)** ✅ : agents programmatiques `naia` (claude-sonnet-5) / `mentor-juriste` / `mentor-parlement` (claude-haiku-4-5), instructions.md lues au boot, MCPClient natif `@mastra/mcp` → Moulineuse `https://mcp.code4code.eu/mcp` (sans token), 20 tools `moulineuse_*`. Smoke : `pnpm smoke:mcp`.
- **UI (C)** ✅ : `web/index.html` autonome (chat, panneau certification+jauge, bandeau refus rouge, timeline parcours 6 étapes, vue audit, mode démo intégré si API down). Contrat API documenté dans le compte-rendu C (POST /api/chat → {response, sources[], confidence_score, status, conversation_id}).
- **Pipeline Mentors (A)** ✅ code complet : `src/pipeline/{claims,verify,concurrency,index}.ts`, `src/audit/log.ts`, endpoints branchés (`/api/chat`, `/api/verify`, `/api/audit/:id`), MENTOR_TIMEOUT_MS=20s, budget global 90s, arbitre pur code avec statuts `certified` / `insufficient` (unknown>50%) / `refused`, retry ×1, audit JSONL dans `audit/`.
- **Calibration** ✅ appliquée (mentors PUIS naia) : stratégie imposée Typesense-first (`moulineuse_search_legal_texts`) → `describe_table`/recettes AVANT tout SQL → `get_pastilled_article` pour citer ; maxSteps du draft naia augmenté (cause du « zéro claim » : draft coupé). Preuve draft réparé : probe `bzeto0fmk` (draft riche L100-4, chiffres, versions).

## Où ça s'est arrêté (⏳ à finir en premier)

**GATE A2 final interrompu par reboot.** Q1 était lancée, résultat jamais lu (`/tmp/naia-q1.json` — perdu au reboot, /tmp).

Le passer à la main (~5 min) :
```bash
cd <ce repo>
pkill -f 'tsx src/server.ts'; set -a; source .env; set +a
nohup pnpm exec tsx src/server.ts > /tmp/naia-server.log 2>&1 & sleep 4
curl -s http://localhost:3000/health   # attendu: 3 agents
# Q1 — attendu: status certified, score ≥ 70, sources L100-4 (latence à noter, ~40-90s)
curl -s --max-time 150 -X POST http://localhost:3000/api/chat -H 'Content-Type: application/json' \
  -d '{"user_id":"gate","message":"Que dit la loi sur l objectif de réduction de la consommation d énergie ?","profile":"citoyen"}' | python3 -m json.tool | head -30
# Q2 piège — attendu: refused ou insufficient
curl -s --max-time 150 -X POST http://localhost:3000/api/chat -H 'Content-Type: application/json' \
  -d '{"user_id":"gate","message":"Que prévoit la loi Dupont-Martin de 2024 sur les trottinettes volantes ?","profile":"citoyen"}' | python3 -m json.tool | head -15
```
- Si Q1 pas certified : lire `audit/*.jsonl` (verdicts par mentor) et `/tmp/naia-server.log` (erreurs tools) — ajuster instructions/seuil, PAS l'archi.
- **Dès que vert : commit + push** (message `feat(pipeline): mentors council calibrated — gate A green`), pathspec explicite hors `web/`.

## Prochaines étapes (ordre figé, cf SUPERVISION.md)

1. Gate A2 ci-dessus → commit/push.
2. **Intégration** : servir `web/` depuis Hono (`serveStatic`), vérifier UI↔API réelle bout-en-bout.
3. **Fixtures MOCK** : jouer le fil rouge en live, sauver les réponses brutes dans `fixtures/moulineuse/` (mécanisme `MOCK_MOULINEUSE=1` + `src/mastra/mock.ts` existent) → démo immunisée.
4. **Data/kb** : `scripts/ingest-loi.ts` + `ingest-depute.ts` depuis clones des dépôts Git Tricoteuses (framagit.org/tricoteuses, env `DATA_DIR` hors repo, provenance repo+sha+path dans chaque fichier kb/) → `kb/lois/<dossier>/`, `kb/deputes/<slug>/` (1 député), agent `depute-<slug>` généré. — coupable si temps manque.
5. **agentpush** (voulu par Jeremy) : hook post-certification — `status==="certified"` → envoi mail/Telegram via agentpush. Live si API dispo, sinon slide.
6. **Durcissement démo** : script des 4 beats (réponse citoyenne sourcée → vue député → QUESTION PIÈGE = REFUS + audit à l'écran → slides), répétition ×2, seuil figé, **freeze T-2h**.
7. **Slides + publication** : pptx (problème → gate → démo → transparence → roadmap 577/WhatsApp/voice/OpenFisca/souveraineté) ; `gh repo edit agentiknet/hackaton-naia --visibility public` au freeze, **sur go Jeremy uniquement**.

## Gotchas de la nuit (ne pas re-payer)

- **claude-code auto-background** les Bash longs (>~10s) → l'agent attend une notif qui ne vient jamais. Parade : output → fichier + relire le fichier au tour suivant, ou exécuter côté orchestrateur (command_execute). Ne JAMAIS terminer un tour sur « j'attends le background ».
- **Infra Tricoteuses instable la nuit** (~00h-02h : rebuild quotidien, MCP muet, dump 502). Endpoint testable : `curl -X POST https://mcp.code4code.eu/mcp` (initialize JSON-RPC) → 200 attendu.
- **Sessions spawnées** : interdits stricts = git/config/amend/reset, sortir du repo, toucher web/ (si session pipeline) — l'orchestrateur committe avec pathspec.
- Cut line démo : timeline UI → vue député (slide) → retry → vue audit UI. Le gate + le refus + les citations ne se coupent jamais.
- Question piège de démo : la calibrer AVANT (vérifier qu'elle rend bien refused, pas insufficient).
- `.env` contient la clé Anthropic réelle — gitignoré, à ne jamais committer ; `.env.example` est la référence publique.
