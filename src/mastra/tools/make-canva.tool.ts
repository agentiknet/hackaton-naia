import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { NAIA_DECK_TEMPLATE, NAIA_DOCUMENT_TEMPLATE } from "./canva-templates.js";

const sectionSchema = z.object({
  heading: z.string().optional().describe("Titre de section (h2), optionnel."),
  html: z
    .string()
    .describe("Contenu HTML de la section (paragraphes, listes, tableaux, citations) — pas de markdown."),
});

const slideSchema = z.object({
  title: z.string().describe("Titre de la slide."),
  content: z.string().describe("Contenu HTML de la slide (paragraphes courts, listes)."),
});

export const inputSchema = z.object({
  title: z.string().describe("Titre du document ou du deck."),
  subtitle: z.string().optional().describe("Sous-titre optionnel (template document)."),
  template: z
    .enum(["document", "deck"])
    .default("document")
    .describe("`document` (page unique) ou `deck` (diapositives 16:9)."),
  sections: z
    .array(sectionSchema)
    .optional()
    .describe("Sections du document — requis (non vide) pour template=document."),
  slides: z
    .array(slideSchema)
    .optional()
    .describe("Slides du deck — requis (non vide) pour template=deck."),
});

export const outputSchema = z.object({
  url: z.string(),
  filename: z.string(),
  absPath: z.string(),
  engine: z.enum(["canvakit", "local"]),
});

export type MakeCanvaInput = z.infer<typeof inputSchema>;
export type MakeCanvaOutput = z.infer<typeof outputSchema>;

const EXPORTS_DIR = join(process.cwd(), "exports");

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .trim()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "canva"
  );
}

function validate(input: MakeCanvaInput): void {
  if (input.template === "deck") {
    if (!input.slides || input.slides.length === 0) {
      throw new Error("make_canva: `slides` est requis (non vide) pour template=deck.");
    }
  } else if (!input.sections || input.sections.length === 0) {
    throw new Error("make_canva: `sections` est requis (non vide) pour template=document.");
  }
}

async function writeExport(html: string, filename: string): Promise<{ url: string; filename: string; absPath: string }> {
  await mkdir(EXPORTS_DIR, { recursive: true });
  const absPath = join(EXPORTS_DIR, filename);
  await writeFile(absPath, html, "utf-8");
  return { url: `/exports/${filename}`, filename, absPath };
}

/**
 * Primary path: the real canvakit engine (`@canvakit/core` render +
 * `@canvakit/export` exportHtml), themed with Naia's own DSFR templates
 * (no `@canvakit/designkit` — that package pulls in `@agstudio/design-kit`,
 * a monorepo-only workspace package naia can't depend on).
 *
 * Dynamically imported (not a static top-level import) so a broken/missing
 * `file:` install degrades to the local fallback below instead of crashing
 * module load for every agent that touches this tool.
 */
async function buildCanvaViaCanvakit(input: MakeCanvaInput, name: string): Promise<MakeCanvaOutput | null> {
  try {
    const { render } = await import("@canvakit/core");
    const { exportHtml, noopFilesystem } = await import("@canvakit/export");

    const isDeck = input.template === "deck";
    const template = isDeck ? NAIA_DECK_TEMPLATE : NAIA_DOCUMENT_TEMPLATE;
    const variables = isDeck
      ? {
          title: input.title,
          slides: (input.slides ?? []).map((slide, i) => ({
            ...slide,
            index: i + 1,
            total: input.slides?.length ?? 0,
          })),
        }
      : {
          title: input.title,
          subtitle: input.subtitle ?? "",
          sections: input.sections ?? [],
        };

    const result = await render({ template, variables, filesystem: noopFilesystem });
    const failed = result.warnings.some((w) => w.startsWith("engine render failed:"));
    if (failed) {
      throw new Error(`canvakit render failed — ${result.warnings.join("; ")}`);
    }

    const artifact = await exportHtml(result.body, { format: "html", name });
    const written = await writeExport(artifact.bytes.toString("utf-8"), artifact.filename);
    return { ...written, engine: "canvakit" };
  } catch (err) {
    console.warn("[make_canva] canvakit render failed, falling back to local renderer:", err);
    return null;
  }
}

// --- Local fallback (no canvakit) --------------------------------------
//
// Same DSFR look, hand-rolled template-literal HTML instead of canvakit's
// Mustache engine. Kept as a safety net if the `file:` canvakit install is
// ever unavailable/broken at runtime.

const LOCAL_STYLE = `
  :root {
    --color-bg: #ffffff;
    --color-surface: #F5F5F7;
    --color-ink: #1F1F1F;
    --color-ink-muted: #5A5A5F;
    --color-primary: #000091;
    --color-accent: #E1000F;
    --color-border: #E1E1E6;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; }
  body {
    background: var(--color-bg);
    color: var(--color-ink);
    font-family: -apple-system, "Segoe UI", system-ui, sans-serif;
    line-height: 1.6;
  }
`;

function renderDocumentLocal(title: string, subtitle: string | undefined, sections: MakeCanvaInput["sections"]): string {
  const sectionsHtml = (sections ?? [])
    .map(
      (section) => `
      <section class="section">
        ${section.heading ? `<h2>${section.heading}</h2>` : ""}
        <div class="section-body">${section.html}</div>
      </section>`
    )
    .join("\n");

  return `<!doctype html>
<html lang="fr">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <style>
      ${LOCAL_STYLE}
      .sheet { max-width: 46rem; margin: 0 auto; padding: 3rem 2rem; }
      header.doc-head {
        border-bottom: 3px solid var(--color-primary);
        padding-bottom: 1.25rem;
        margin-bottom: 2rem;
      }
      .eyebrow {
        color: var(--color-accent);
        font-size: 0.75rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        margin: 0 0 0.5rem;
      }
      h1 {
        font-size: 2.2rem;
        font-weight: 700;
        line-height: 1.15;
        margin: 0 0 0.35rem;
        color: var(--color-primary);
      }
      .subtitle { color: var(--color-ink-muted); font-size: 1.05rem; margin: 0; }
      .section { margin-bottom: 1.75rem; }
      .section h2 {
        font-size: 1.3rem;
        font-weight: 700;
        color: var(--color-primary);
        margin: 0 0 0.6rem;
      }
      .section-body p { margin: 0 0 0.9rem; }
      .section-body ul, .section-body ol { margin: 0 0 0.9rem 1.25rem; }
      .section-body li { margin: 0.2rem 0; }
      .section-body a { color: var(--color-primary); }
      .section-body blockquote {
        border-left: 3px solid var(--color-accent);
        margin: 1rem 0;
        padding: 0.2rem 0 0.2rem 1rem;
        color: var(--color-ink-muted);
      }
      .section-body table { border-collapse: collapse; width: 100%; margin: 0.75rem 0; }
      .section-body th, .section-body td {
        border: 1px solid var(--color-border);
        padding: 0.5rem 0.7rem;
        text-align: left;
      }
      footer.doc-foot {
        margin-top: 2.5rem;
        padding-top: 1rem;
        border-top: 1px solid var(--color-border);
        color: var(--color-ink-muted);
        font-size: 0.75rem;
      }
    </style>
  </head>
  <body>
    <main class="sheet">
      <header class="doc-head">
        <p class="eyebrow">Naia — Assemblée nationale</p>
        <h1>${title}</h1>
        ${subtitle ? `<p class="subtitle">${subtitle}</p>` : ""}
      </header>
      ${sectionsHtml}
      <footer class="doc-foot">Document généré par Naia — assistante IA parlementaire.</footer>
    </main>
  </body>
</html>
`;
}

function renderDeckLocal(title: string, slides: MakeCanvaInput["slides"]): string {
  const list = slides ?? [];
  const slidesHtml = list
    .map(
      (slide, i) => `
      <section class="slide">
        <div class="slide-eyebrow">
          <span>Naia — Assemblée nationale</span>
          <span class="slide-count">${i + 1} / ${list.length}</span>
        </div>
        <h2>${slide.title}</h2>
        <div class="slide-body">${slide.content}</div>
      </section>`
    )
    .join("\n");

  return `<!doctype html>
<html lang="fr">
  <head>
    <meta charset="utf-8" />
    <title>${title}</title>
    <style>
      ${LOCAL_STYLE}
      @page { size: 1280px 720px; margin: 0; }
      .slide {
        width: 1280px;
        height: 720px;
        margin: 0 auto;
        padding: 72px 88px;
        page-break-after: always;
        display: flex;
        flex-direction: column;
        justify-content: center;
        gap: 1.25rem;
        border-bottom: 1px solid var(--color-border);
      }
      .slide:last-child { page-break-after: auto; border-bottom: none; }
      .slide-eyebrow {
        display: flex;
        justify-content: space-between;
        color: var(--color-accent);
        font-size: 0.75rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      .slide-count { color: var(--color-ink-muted); font-weight: 400; letter-spacing: normal; text-transform: none; }
      .slide h2 {
        font-size: 2.8rem;
        font-weight: 700;
        line-height: 1.1;
        margin: 0;
        color: var(--color-primary);
      }
      .slide-body { font-size: 1.35rem; color: var(--color-ink); }
      .slide-body p { margin: 0 0 0.75rem; }
      .slide-body ul, .slide-body ol { margin: 0 0 0.75rem 1.5rem; }
      .slide-body li { margin: 0.3rem 0; }
      .slide-body strong { color: var(--color-accent); }
    </style>
  </head>
  <body>
    ${slidesHtml}
  </body>
</html>
`;
}

async function buildCanvaLocal(input: MakeCanvaInput, filename: string): Promise<MakeCanvaOutput> {
  const isDeck = input.template === "deck";
  const html = isDeck
    ? renderDeckLocal(input.title, input.slides)
    : renderDocumentLocal(input.title, input.subtitle, input.sections);
  const written = await writeExport(html, filename);
  return { ...written, engine: "local" };
}

/** Core entry point — shared by the Mastra tool and smoke tests. */
export async function buildCanva(input: MakeCanvaInput): Promise<MakeCanvaOutput> {
  validate(input);

  const name = `${slugify(input.title)}-${randomUUID().slice(0, 8)}`;

  const viaCanvakit = await buildCanvaViaCanvakit(input, name);
  if (viaCanvakit) return viaCanvakit;

  return buildCanvaLocal(input, `${name}.html`);
}

export const makeCanvaTool = createTool({
  id: "make_canva",
  description:
    "Génère un document ou un deck de présentation HTML sobre aux couleurs de Naia/Assemblée nationale (thème DSFR) et l'écrit dans exports/. `document` = page unique à partir de sections HTML ; `deck` = diapositives 16:9 à partir d'une liste de slides. Retourne le lien local (`url`) à partager — aucune pièce jointe automatique.",
  inputSchema,
  outputSchema,
  execute: async (input) => buildCanva(input),
});
