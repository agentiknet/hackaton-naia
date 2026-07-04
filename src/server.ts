import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { stream } from "hono/streaming";
import { readAudit } from "./audit/log.js";
import { mastra } from "./mastra/index.js";
import { mentorJuristeAgent } from "./mastra/agents/mentor-juriste/index.js";
import { mentorParlementAgent } from "./mastra/agents/mentor-parlement/index.js";
import type { Profile } from "./mentors/types.js";
import { notifyCertified } from "./notify/agentpush.js";
import { buildAnswerPdf, buildDraftPdf } from "./export/pdf.js";
import type { AnswerExportPayload, DraftExportPayload } from "./export/pdf.js";
import { extractClaims } from "./pipeline/claims.js";
import { runDraft, runDraftStreaming, runPipeline, runPipelineStreaming } from "./pipeline/index.js";
import { verifyClaim } from "./pipeline/verify.js";

const app = new Hono();

interface ChatRequestBody {
  user_id: string;
  message: string;
  profile: Profile;
  // Optional push target: naia keeps no contact book, so the caller supplies
  // where a certified answer should be delivered (agentpush). Omit to skip.
  channel?: string;
  address?: string;
}

interface VerifyRequestBody {
  text: string;
}

interface DraftRequestBody {
  intent: string;
  base_text?: string;
}

app.get("/health", (c) => {
  const agents = Object.keys(mastra.listAgents());
  return c.json({ status: "ok", agents });
});

app.post("/api/chat", async (c) => {
  const body = await c.req.json<ChatRequestBody>();
  const conversationId = randomUUID();

  const result = await runPipeline(body.message, body.profile, conversationId);

  // Dogfood: push the certified answer out-of-band (Telegram/mail) without
  // blocking the HTTP response. No-ops unless certified + env + target present.
  const target = body.channel && body.address ? { channel: body.channel, address: body.address } : undefined;
  void notifyCertified(body.message, result, target);

  return c.json({
    conversation_id: result.conversationId,
    response: result.response,
    sources: result.sources,
    confidence_score: result.confidenceScore,
    status: result.status,
    refusal_reason: result.refusalReason,
    // Optional parcours data (attached to demo fixtures): lets the UI show
    // the real legislative timeline of the text under discussion.
    timeline: (result as PipelineResultWithTimeline).timeline,
    timeline_title: (result as PipelineResultWithTimeline).timelineTitle,
  });
});

/** Fixtures may carry an optional real-world legislative timeline. */
type PipelineResultWithTimeline = Awaited<ReturnType<typeof runPipeline>> & {
  timeline?: Array<{ label: string; date: string; status: string }>;
  timelineTitle?: string;
};

// Streaming chat: emits newline-delimited JSON events (stage / verification /
// done) so the UI can show the pipeline working live instead of a silent wait.
app.post("/api/chat/stream", async (c) => {
  const body = await c.req.json<ChatRequestBody>();
  const conversationId = randomUUID();

  c.header("Content-Type", "application/x-ndjson; charset=utf-8");
  c.header("Cache-Control", "no-cache, no-transform");
  c.header("X-Accel-Buffering", "no");

  return stream(c, async (s) => {
    const emit = async (event: unknown) => {
      await s.write(`${JSON.stringify(event)}\n`);
    };
    const result = await runPipelineStreaming(body.message, body.profile, conversationId, emit);

    const target = body.channel && body.address ? { channel: body.channel, address: body.address } : undefined;
    void notifyCertified(body.message, result, target);
  });
});

app.post("/api/draft", async (c) => {
  const body = await c.req.json<DraftRequestBody>();
  const conversationId = randomUUID();

  const result = await runDraft(body.intent, body.base_text, conversationId);

  return c.json({
    conversation_id: result.conversationId,
    intent: result.intent,
    draft: result.draft,
    sources: result.sources,
    confidence_score: result.confidenceScore,
    status: result.status,
    refusal_reason: result.refusalReason,
    suggestions: result.suggestions,
  });
});

// Streaming draft: same NDJSON event grammar as /api/chat/stream.
app.post("/api/draft/stream", async (c) => {
  const body = await c.req.json<DraftRequestBody>();
  const conversationId = randomUUID();

  c.header("Content-Type", "application/x-ndjson; charset=utf-8");
  c.header("Cache-Control", "no-cache, no-transform");
  c.header("X-Accel-Buffering", "no");

  return stream(c, async (s) => {
    const emit = async (event: unknown) => {
      await s.write(`${JSON.stringify(event)}\n`);
    };
    await runDraftStreaming(body.intent, body.base_text, conversationId, emit);
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

// PDF export: the front already holds the certified answer/draft in memory
// (from the chat/draft response it just rendered) and posts it back as-is —
// no server-side lookup, the pipeline itself is untouched.
app.post("/api/export/answer", async (c) => {
  const body = await c.req.json<AnswerExportPayload>();
  const pdf = await buildAnswerPdf(body);
  return c.body(new Uint8Array(pdf), 200, {
    "Content-Type": "application/pdf",
    "Content-Disposition": 'attachment; filename="naia-reponse.pdf"',
  });
});

app.post("/api/export/draft", async (c) => {
  const body = await c.req.json<DraftExportPayload>();
  const pdf = await buildDraftPdf(body);
  return c.body(new Uint8Array(pdf), 200, {
    "Content-Type": "application/pdf",
    "Content-Disposition": 'attachment; filename="naia-redaction.pdf"',
  });
});

const EXPORTS_DIR = join(process.cwd(), "exports");
const EXPORT_FILENAME_RE = /^[a-zA-Z0-9._-]+\.html$/;

app.get("/exports/:file", async (c) => {
  const file = c.req.param("file");
  if (!EXPORT_FILENAME_RE.test(file)) {
    return c.json({ error: "invalid filename" }, 400);
  }

  try {
    const html = await readFile(join(EXPORTS_DIR, file), "utf-8");
    return c.html(html);
  } catch {
    return c.json({ error: "not found" }, 404);
  }
});

app.use("*", serveStatic({ root: "./web" }));

const port = Number(process.env.PORT ?? 3000);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`naia listening on http://localhost:${info.port}`);
});
