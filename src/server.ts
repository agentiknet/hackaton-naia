import { randomUUID } from "node:crypto";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { readAudit } from "./audit/log.js";
import { mastra } from "./mastra/index.js";
import { mentorJuristeAgent } from "./mastra/agents/mentor-juriste/index.js";
import { mentorParlementAgent } from "./mastra/agents/mentor-parlement/index.js";
import type { Profile } from "./mentors/types.js";
import { extractClaims } from "./pipeline/claims.js";
import { runPipeline } from "./pipeline/index.js";
import { verifyClaim } from "./pipeline/verify.js";

const app = new Hono();

interface ChatRequestBody {
  user_id: string;
  message: string;
  profile: Profile;
}

interface VerifyRequestBody {
  text: string;
}

app.get("/health", (c) => {
  const agents = Object.keys(mastra.listAgents());
  return c.json({ status: "ok", agents });
});

app.post("/api/chat", async (c) => {
  const body = await c.req.json<ChatRequestBody>();
  const conversationId = randomUUID();

  const result = await runPipeline(body.message, body.profile, conversationId);

  return c.json({
    conversation_id: result.conversationId,
    response: result.response,
    sources: result.sources,
    confidence_score: result.confidenceScore,
    status: result.status,
  });
});

app.post("/api/verify", async (c) => {
  const body = await c.req.json<VerifyRequestBody>();
  const claims = await extractClaims(body.text);

  const verifications = await Promise.all(
    claims.flatMap((claim) => [
      verifyClaim(claim, mentorJuristeAgent),
      verifyClaim(claim, mentorParlementAgent),
    ]),
  );

  return c.json({ claims, verifications });
});

app.get("/api/audit/:conversationId", async (c) => {
  const conversationId = c.req.param("conversationId");
  const audit = await readAudit(conversationId);

  if (!audit) {
    return c.json({ error: "conversation not found" }, 404);
  }

  return c.json(audit);
});

app.use("*", serveStatic({ root: "./web" }));

const port = Number(process.env.PORT ?? 3000);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`naia listening on http://localhost:${info.port}`);
});
