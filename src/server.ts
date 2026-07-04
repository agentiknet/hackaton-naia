import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { mastra } from "./mastra/index.js";
import type { AuditEntry, Verification } from "./mentors/types.js";

const app = new Hono();

interface ChatRequestBody {
  user_id: string;
  message: string;
  profile: "depute" | "citoyen";
}

interface ChatResponseBody {
  response: string;
  sources: Verification["sources"];
  confidence_score: number;
}

app.get("/health", (c) => {
  const agents = Object.keys(mastra.listAgents());
  return c.json({ status: "ok", agents });
});

app.post("/api/chat", async (c) => {
  const _body = await c.req.json<ChatRequestBody>();

  const response: ChatResponseBody = {
    response: "",
    sources: [],
    confidence_score: 0,
  };

  return c.json(response);
});

app.get("/api/audit/:conversationId", (c) => {
  const conversationId = c.req.param("conversationId");

  const entry: AuditEntry = {
    conversationId,
    claims: [],
    verifications: [],
    finalResponse: "",
    confidenceScore: 0,
    createdAt: new Date().toISOString(),
  };

  return c.json(entry);
});

app.post("/api/verify", async (c) => {
  const _body = await c.req.json();

  const verification: Partial<Verification> = {
    verdict: "unknown",
    score: 0,
    sources: [],
  };

  return c.json(verification);
});

const port = Number(process.env.PORT ?? 3000);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`naia listening on http://localhost:${info.port}`);
});
