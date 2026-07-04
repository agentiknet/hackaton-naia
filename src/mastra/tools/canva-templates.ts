/**
 * Canvakit templates — Naia's DSFR theme (Bleu France #000091 / Rouge
 * Marianne #E1000F), inline CSS, no external CDN/fonts. Consumed by
 * `render()` from `@canvakit/core` (frontmatter + Mustache body).
 *
 * `sections`/`slides` are pre-shaped by the caller (make-canva.tool.ts)
 * before being passed as `variables` — `slides[].index`/`total` are
 * computed there since Mustache has no loop-counter of its own.
 */

const STYLE = `
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

export const NAIA_DOCUMENT_TEMPLATE = `---
template: true
name: naia-document
version: 1.0.0
description: Document Naia — page unique, thème DSFR (Bleu France / Rouge Marianne).
medium: document
variables:
  title: "Sans titre"
  subtitle: ""
  sections: []
---
<!doctype html>
<html lang="fr">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{{title}}</title>
    <style>
      ${STYLE}
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
        <h1>{{title}}</h1>
        {{#subtitle}}<p class="subtitle">{{subtitle}}</p>{{/subtitle}}
      </header>
      {{#sections}}
      <section class="section">
        {{#heading}}<h2>{{heading}}</h2>{{/heading}}
        <div class="section-body">{{{html}}}</div>
      </section>
      {{/sections}}
      <footer class="doc-foot">Document généré par Naia — assistante IA parlementaire.</footer>
    </main>
  </body>
</html>
`;

export const NAIA_DECK_TEMPLATE = `---
template: true
name: naia-deck
version: 1.0.0
description: Deck Naia — diapositives 16:9, thème DSFR (Bleu France / Rouge Marianne).
medium: presentation
variables:
  title: "Sans titre"
  slides: []
---
<!doctype html>
<html lang="fr">
  <head>
    <meta charset="utf-8" />
    <title>{{title}}</title>
    <style>
      ${STYLE}
      .slide {
        width: 1280px;
        height: 720px;
        margin: 0 auto;
        padding: 72px 88px;
        display: flex;
        flex-direction: column;
        justify-content: center;
        gap: 1.25rem;
        border-bottom: 1px solid var(--color-border);
      }
      .slide:last-child { border-bottom: none; }
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
      .slide-body .speaker-note {
        margin-top: 1rem;
        padding-top: 0.75rem;
        border-top: 1px solid var(--color-border);
        font-size: 0.85rem;
        font-style: italic;
        color: var(--color-ink-muted);
      }
      /* Print-ready: browsers' "Save as PDF" / window.print() paginate one
         slide per page, honouring the 16:9 @page geometry. */
      @media print {
        @page { size: 1280px 720px; margin: 0; }
        .slide {
          page-break-after: always;
          break-after: page;
        }
        .slide:last-child {
          page-break-after: auto;
          break-after: auto;
        }
      }
    </style>
  </head>
  <body>
    {{#slides}}
    <section class="slide">
      <div class="slide-eyebrow">
        <span>Naia — Assemblée nationale</span>
        <span class="slide-count">{{index}} / {{total}}</span>
      </div>
      <h2>{{title}}</h2>
      <div class="slide-body">{{{content}}}</div>
    </section>
    {{/slides}}
  </body>
</html>
`;
