/**
 * PDF export — renders a certified answer or a certified draft as a styled
 * HTML document (Marianne charte: bleu #000091 / rouge #E1000F / blanc), then
 * converts it to PDF via a headless Chrome shell-out (no puppeteer dependency).
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { PipelineStatus } from "../pipeline/index.js";
import type { Claim, Source, Verdict, Verification } from "../mentors/types.js";

const execFileAsync = promisify(execFile);

const CHROME_PATH =
  process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export interface AnswerExportPayload {
  question: string;
  response: string;
  sources: Source[];
  claims: Claim[];
  verifications: Verification[];
  confidenceScore: number;
  status: PipelineStatus;
  refusalReason?: string;
}

export interface DraftExportPayload {
  intent: string;
  /** Full markdown produced by the drafting workspace ("## Dispositif" / "## Exposé sommaire"). */
  draft: string;
  sources: Source[];
  suggestions: string[];
  confidenceScore?: number;
  status?: PipelineStatus;
  refusalReason?: string;
}

async function htmlToPdf(html: string): Promise<Buffer> {
  const dir = join(tmpdir(), `naia-export-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  const htmlPath = join(dir, "doc.html");
  const pdfPath = join(dir, "doc.pdf");
  try {
    await writeFile(htmlPath, html, "utf-8");
    await execFileAsync(
      CHROME_PATH,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-pdf-header-footer",
        `--print-to-pdf=${pdfPath}`,
        `file://${htmlPath}`,
      ],
      { timeout: 30_000 },
    );
    return await readFile(pdfPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Minimal markdown → HTML: headings, bold, bullet lists, paragraphs. Escapes
 * first so no HTML from the model or the user ever reaches the PDF unescaped. */
function mdToHtml(md: string): string {
  const lines = escapeHtml(md).split(/\r?\n/);
  const out: string[] = [];
  let inList = false;
  const closeList = () => {
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
  };
  for (let line of lines) {
    line = line.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    const h = line.match(/^#{1,4}\s+(.*)$/);
    const li = line.match(/^\s*[-*]\s+(.*)$/);
    if (h) {
      closeList();
      out.push(`<h3 class="doc-h">${h[1]}</h3>`);
    } else if (li) {
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${li[1]}</li>`);
    } else if (line.trim() === "") {
      closeList();
    } else {
      closeList();
      out.push(`<p>${line}</p>`);
    }
  }
  closeList();
  return out.join("\n");
}

function formattedDate(): string {
  return new Intl.DateTimeFormat("fr-FR", { dateStyle: "long" }).format(new Date());
}

const MENTOR_LABELS: Record<string, string> = {
  "mentor-juriste": "Juriste",
  "mentor-parlement": "Parlement",
};

function mentorLabel(mentor: string): string {
  return MENTOR_LABELS[mentor] ?? mentor;
}

const VERDICT_LABELS: Record<Verdict, string> = {
  supported: "Confirmée",
  unsupported: "Réfutée",
  unknown: "Non vérifiée",
};

const STATUS_LABELS: Record<PipelineStatus, string> = {
  answered: "Certifiée",
  insufficient: "Sources insuffisantes",
  refused: "Refusée",
};

/** Combined verdict for one claim, same arbitration rule as the pipeline:
 * any refutation wins, then any confirmation, else unknown. */
function claimVerdict(claimId: string, verifications: Verification[]): Verdict {
  const own = verifications.filter((v) => v.claim.id === claimId);
  if (own.some((v) => v.verdict === "unsupported")) return "unsupported";
  if (own.some((v) => v.verdict === "supported")) return "supported";
  return "unknown";
}

function sourceLine(source?: Source): string {
  if (!source) return "";
  const parts = [source.label, source.ref].filter(Boolean).join(" — ");
  return source.url ? `${escapeHtml(parts)} (${escapeHtml(source.url)})` : escapeHtml(parts);
}

function documentShell(title: string, subtitle: string, bodyHtml: string): string {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<style>
  @page { size: A4; margin: 20mm 18mm; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body {
    font-family: -apple-system, "Segoe UI", "Helvetica Neue", Arial, sans-serif;
    color: #1a1a1a;
    font-size: 12.5px;
    line-height: 1.55;
  }
  .doc-header {
    background: #000091;
    color: #fff;
    padding: 18px 22px;
    border-radius: 4px;
    margin-bottom: 18px;
  }
  .doc-header .brand { font-size: 20px; font-weight: 700; letter-spacing: -0.3px; }
  .doc-header .brand span { opacity: .75; font-weight: 400; }
  .doc-header .date { font-size: 11px; opacity: .85; margin-top: 4px; }
  .doc-subtitle {
    font-size: 14px;
    font-weight: 600;
    color: #000091;
    border-left: 4px solid #e1000f;
    padding: 6px 12px;
    margin: 16px 0;
    background: #f6f6f6;
  }
  .doc-section { margin: 20px 0; }
  .doc-section h2 {
    font-size: 13px;
    font-weight: 700;
    color: #000091;
    text-transform: uppercase;
    letter-spacing: .4px;
    border-bottom: 1px solid #ddd;
    padding-bottom: 6px;
    margin-bottom: 10px;
  }
  .doc-h { font-size: 13px; font-weight: 700; color: #000091; margin: 12px 0 6px; }
  p { margin: 6px 0; }
  ul { margin: 6px 0 6px 20px; }
  li { margin: 3px 0; }
  .cert-banner {
    display: flex;
    align-items: center;
    gap: 18px;
    padding: 14px 18px;
    border-radius: 4px;
    border: 1px solid #ddd;
    background: #f6f6f6;
  }
  .cert-banner .score { font-size: 30px; font-weight: 800; color: #000091; }
  .cert-banner .score small { font-size: 13px; font-weight: 400; color: #666; }
  .cert-banner .status-label { font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: .4px; }
  .cert-banner .status-label.answered { color: #18753c; }
  .cert-banner .status-label.refused { color: #e1000f; }
  .cert-banner .status-label.insufficient { color: #000091; }
  .cert-counts { font-size: 11.5px; color: #444; margin-top: 4px; }
  .refusal-reason {
    margin-top: 10px;
    padding: 10px 12px;
    background: #fce8ea;
    border-left: 3px solid #e1000f;
    font-size: 12px;
  }
  .source-item {
    padding: 8px 10px;
    border: 1px solid #ddd;
    border-radius: 4px;
    margin-bottom: 6px;
    font-size: 11.5px;
  }
  .source-item .label { font-weight: 600; }
  .source-item .url { color: #000091; word-break: break-all; }
  .claim-block {
    padding: 10px 12px;
    border: 1px solid #ddd;
    border-radius: 4px;
    margin-bottom: 8px;
    page-break-inside: avoid;
  }
  .claim-block .claim-text { font-weight: 600; margin-bottom: 6px; }
  .claim-block .verdict-tag {
    display: inline-block;
    font-size: 10.5px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: .3px;
    padding: 1px 7px;
    border-radius: 3px;
    margin-left: 8px;
  }
  .verdict-tag.supported { background: #dae8e3; color: #18753c; }
  .verdict-tag.unsupported { background: #fce8ea; color: #e1000f; }
  .verdict-tag.unknown { background: #eee; color: #666; }
  .verif-row { font-size: 11.5px; color: #333; margin: 3px 0 3px 4px; }
  .suggestions-list { margin: 6px 0 6px 20px; }
  .empty-note { color: #999; font-size: 12px; font-style: italic; }
  .doc-footer { margin-top: 24px; font-size: 10px; color: #999; text-align: center; }
</style>
</head>
<body>
  <div class="doc-header">
    <div class="brand">Naia <span>— assistant parlementaire gouverné</span></div>
    <div class="date">${escapeHtml(formattedDate())}</div>
  </div>
  <div class="doc-subtitle">${escapeHtml(title)} : ${escapeHtml(subtitle)}</div>
  ${bodyHtml}
  <div class="doc-footer">Document généré par Naia — chaque affirmation certifiée est vérifiée contre les sources officielles (LEGI, JORF, dossiers parlementaires).</div>
</body>
</html>`;
}

function renderAnswerHtml(payload: AnswerExportPayload): string {
  const claims = payload.claims ?? [];
  const verifications = payload.verifications ?? [];
  const sources = payload.sources ?? [];

  const summaries = claims.map((claim) => ({
    claim,
    verdict: claimVerdict(claim.id, verifications),
    own: verifications.filter((v) => v.claim.id === claim.id),
  }));
  const confirmed = summaries.filter((s) => s.verdict === "supported").length;
  const refuted = summaries.filter((s) => s.verdict === "unsupported").length;
  const unverified = summaries.filter((s) => s.verdict === "unknown").length;

  const certBlock = `
    <div class="doc-section">
      <h2>Certification du Conseil</h2>
      <div class="cert-banner">
        <div class="score">${Math.round(payload.confidenceScore)}<small> / 100</small></div>
        <div>
          <div class="status-label ${payload.status}">${escapeHtml(STATUS_LABELS[payload.status] ?? payload.status)}</div>
          <div class="cert-counts">${confirmed} confirmée(s) · ${refuted} réfutée(s) · ${unverified} non vérifiée(s)</div>
        </div>
      </div>
      ${payload.refusalReason ? `<div class="refusal-reason">${escapeHtml(payload.refusalReason)}</div>` : ""}
    </div>`;

  const sourcesBlock = `
    <div class="doc-section">
      <h2>Sources &amp; citations</h2>
      ${
        sources.length === 0
          ? '<p class="empty-note">Aucune source citée.</p>'
          : sources
              .map(
                (s) => `<div class="source-item"><span class="label">${escapeHtml(s.label)}</span>${
                  s.ref ? ` — ${escapeHtml(s.ref)}` : ""
                }${s.url ? `<div class="url">${escapeHtml(s.url)}</div>` : ""}</div>`,
              )
              .join("")
      }
      ${
        summaries.length === 0
          ? ""
          : summaries
              .map(
                (s) => `
        <div class="claim-block">
          <div class="claim-text">« ${escapeHtml(s.claim.text)} »<span class="verdict-tag ${s.verdict}">${escapeHtml(VERDICT_LABELS[s.verdict])}</span></div>
          ${s.own
            .map(
              (v) =>
                `<div class="verif-row">${escapeHtml(mentorLabel(v.mentor))} : ${escapeHtml(VERDICT_LABELS[v.verdict])}${
                  v.source ? ` — ${sourceLine(v.source)}` : ""
                }</div>`,
            )
            .join("")}
        </div>`,
              )
              .join("")
      }
    </div>`;

  const body = `
    <div class="doc-section">
      <h2>Réponse</h2>
      ${mdToHtml(payload.response || "")}
    </div>
    ${certBlock}
    ${sourcesBlock}`;

  return documentShell("Réponse certifiée", payload.question, body);
}

/** The drafting workspace produces one markdown blob with two headed
 * sections ("## Dispositif", "## Exposé sommaire") — split it back out. */
function splitDraftSections(draft: string): { dispositif: string; expose: string } {
  const sections = new Map<string, string[]>();
  let current = "_intro";
  sections.set(current, []);
  for (const line of draft.split(/\r?\n/)) {
    const h = line.match(/^##\s+(.*)$/);
    if (h) {
      current = (h[1] ?? "").trim();
      sections.set(current, []);
    } else {
      sections.get(current)?.push(line);
    }
  }
  const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  let dispositif = "";
  let expose = "";
  for (const [key, lines] of sections) {
    const text = lines.join("\n").trim();
    if (fold(key).includes("dispositif")) dispositif = text;
    else if (fold(key).includes("expose") && fold(key).includes("sommaire")) expose = text;
  }
  // Fallback: unrecognized shape (e.g. hand-typed base text) — show it whole.
  if (!dispositif && !expose) dispositif = draft.trim();
  return { dispositif, expose };
}

function renderDraftHtml(payload: DraftExportPayload): string {
  const { dispositif, expose } = splitDraftSections(payload.draft || "");
  const sources = payload.sources ?? [];
  const suggestions = payload.suggestions ?? [];

  const certBlock =
    payload.status && payload.confidenceScore != null
      ? `
    <div class="doc-section">
      <h2>Certification du Conseil</h2>
      <div class="cert-banner">
        <div class="score">${Math.round(payload.confidenceScore)}<small> / 100</small></div>
        <div class="status-label ${payload.status}">${escapeHtml(STATUS_LABELS[payload.status] ?? payload.status)}</div>
      </div>
      ${payload.refusalReason ? `<div class="refusal-reason">${escapeHtml(payload.refusalReason)}</div>` : ""}
    </div>`
      : "";

  const body = `
    <div class="doc-section">
      <h2>Dispositif</h2>
      ${dispositif ? mdToHtml(dispositif) : '<p class="empty-note">Aucun dispositif produit.</p>'}
    </div>
    <div class="doc-section">
      <h2>Exposé sommaire</h2>
      ${expose ? mdToHtml(expose) : '<p class="empty-note">Aucun exposé sommaire produit.</p>'}
    </div>
    ${certBlock}
    <div class="doc-section">
      <h2>Sources citées</h2>
      ${
        sources.length === 0
          ? '<p class="empty-note">Aucune source citée.</p>'
          : sources
              .map(
                (s) => `<div class="source-item"><span class="label">${escapeHtml(s.label)}</span>${
                  s.ref ? ` — ${escapeHtml(s.ref)}` : ""
                }${s.url ? `<div class="url">${escapeHtml(s.url)}</div>` : ""}</div>`,
              )
              .join("")
      }
    </div>
    <div class="doc-section">
      <h2>Suggestions du Conseil</h2>
      ${
        suggestions.length === 0
          ? '<p class="empty-note">Aucune suggestion.</p>'
          : `<ul class="suggestions-list">${suggestions.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ul>`
      }
    </div>`;

  return documentShell("Proposition de rédaction certifiée", payload.intent, body);
}

export async function buildAnswerPdf(payload: AnswerExportPayload): Promise<Buffer> {
  return htmlToPdf(renderAnswerHtml(payload));
}

export async function buildDraftPdf(payload: DraftExportPayload): Promise<Buffer> {
  return htmlToPdf(renderDraftHtml(payload));
}
