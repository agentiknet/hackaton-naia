# Naia

**Naia certifie/contrôle, zéro hallucination.**

Naia est un assistant IA parlementaire gouverné, conçu pour le hackathon de
l'Assemblée Nationale 2026. Chaque réponse est validée par un **Conseil des
Mentors** — une vérification claim par claim contre les sources officielles
(Assemblée Nationale, Sénat, Légifrance) — avant d'être envoyée à
l'utilisateur.

## Pourquoi

Les assistants IA génériques hallucinent des références législatives, des
numéros d'articles ou des positions de vote. Pour un usage parlementaire —
députés, collaborateurs, citoyens — une erreur factuelle a un coût politique
et démocratique. Naia inverse la priorité : la fiabilité prime sur la
fluidité. Rien n'est envoyé sans être rattaché à une source vérifiable.

## Architecture (5 couches)

```
┌─────────────────────────────────────────────┐
│ 1. Interface                                 │  UI député / citoyen
├─────────────────────────────────────────────┤
│ 2. Agent                                     │  orchestration, formulation
├─────────────────────────────────────────────┤
│ 3. Conseil des Mentors                       │  vérification claim par claim
├─────────────────────────────────────────────┤
│ 4. Données (MCP Moulineuse)                  │  AN / Sénat / Légifrance
├─────────────────────────────────────────────┤
│ 5. Citations                                 │  traçabilité source → réponse
└─────────────────────────────────────────────┘
```

1. **Interface** — point d'entrée pour deux profils : `depute` et `citoyen`.
2. **Agent** — reçoit la question, interroge les données, formule une réponse
   candidate.
3. **Conseil des Mentors** — décompose la réponse candidate en claims
   atomiques et vérifie chacun contre les sources officielles. Une claim non
   supportée bloque ou reformule la réponse.
4. **Données** — serveur MCP Moulineuse (tricoteuses.fr), exposant les données
   parlementaires et légales via des tools (`query_sql`, `search_legal_texts`,
   `get_pastilled_article`, `list_parlement_items`, ...).
5. **Citations** — chaque affirmation envoyée porte sa source, consultable
   dans un audit trail.

## Démarrage

```bash
pnpm install
cp .env.example .env.local   # renseigner les variables
pnpm dev
```

## Variables d'environnement

Voir `.env.example` :

- `MCP_MOULINEUSE_URL` — URL du serveur MCP Moulineuse
- `MCP_MOULINEUSE_TOKEN` — jeton d'authentification
- `ANTHROPIC_API_KEY` — clé API pour l'agent
- `PORT` — port HTTP local (défaut `3000`)

## API

- `POST /api/chat` — `{ user_id, message, profile: "depute" | "citoyen" }` →
  `{ response, sources, confidence_score }`
- `GET /api/audit/:conversationId` — trace d'audit d'une conversation
- `POST /api/verify` — vérification manuelle d'une claim
- `GET /health` — health check

## Licence

Apache-2.0 — voir [LICENSE](./LICENSE).
