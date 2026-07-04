/**
 * Generates exports/pitch-naia.html — the real pitch deck — from
 * docs/PITCH-DECK-OUTLINE.md, via the canva-writer tool (canvakit engine,
 * DSFR theme). One slide per outline section: title + bullets + a small
 * "speaker note" line.
 */
import { readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCanva } from "../mastra/tools/make-canva.tool.js";

interface OutlineSlide {
  title: string;
  bullets: string[];
  note?: string;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Minimal Markdown inline emphasis (`**bold**`, `*italic*`) → HTML. */
function mdInlineToHtml(s: string): string {
  return escapeHtml(s)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>");
}

/** Parses the `## Slide N — ...` / `**TITRE : ...**` / bullets / `**Note orateur :**` outline format. */
function parseOutline(md: string): OutlineSlide[] {
  const chunks = md.split(/\n-{3,}\n/g);
  const slides: OutlineSlide[] = [];

  for (const chunk of chunks) {
    if (!chunk.includes("## Slide")) continue;

    const titleMatch = chunk.match(/\*\*TITRE\s*:\s*([^\n*]+)\*\*/);
    const titleCapture = titleMatch?.[1];
    if (!titleCapture) continue;
    const title = titleCapture.trim();

    const bullets = chunk
      .split("\n")
      .filter((line) => line.trim().startsWith("- "))
      .map((line) => line.trim().replace(/^-\s+/, ""));

    const noteMatch = chunk.match(/\*\*Note orateur\s*:?\*\*\s*(.+)/);
    const noteCapture = noteMatch?.[1];
    const note = noteCapture ? noteCapture.trim() : undefined;

    slides.push({ title, bullets, note });
  }

  return slides;
}

async function main() {
  const outlinePath = join(fileURLToPath(new URL(".", import.meta.url)), "../../docs/PITCH-DECK-OUTLINE.md");
  const md = readFileSync(outlinePath, "utf-8");
  const outlineSlides = parseOutline(md);

  if (outlineSlides.length === 0) {
    throw new Error("gen-pitch-deck: no slides parsed from docs/PITCH-DECK-OUTLINE.md");
  }

  const slides = outlineSlides.map((slide) => ({
    title: slide.title,
    content: [
      `<ul>${slide.bullets.map((b) => `<li>${mdInlineToHtml(b)}</li>`).join("")}</ul>`,
      slide.note ? `<p class="speaker-note">Note orateur : ${mdInlineToHtml(slide.note)}</p>` : "",
    ].join(""),
  }));

  const result = await buildCanva({
    title: "Naia — Pitch Deck",
    template: "deck",
    slides,
  });

  // Fixed, predictable filename for the demo — rename in place (same dir).
  const finalPath = join(join(result.absPath, ".."), "pitch-naia.html");
  renameSync(result.absPath, finalPath);

  console.log(`engine: ${result.engine}`);
  console.log(`slides: ${slides.length}`);
  console.log(`path: ${finalPath}`);
}

main().catch((error) => {
  console.error("gen-pitch-deck FAILED:", error);
  process.exit(1);
});
