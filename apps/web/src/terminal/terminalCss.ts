// Styles for the trial terminal (L3-13). Appended to APP_CSS, which defines the tokens, the
// focus ring, `.sr-only` and the reduced-motion rule. Every selector is under `.term`, every
// color is a token (a11y/check.ts reads this string), and the layout never depends on color alone.
//
// Agent hues: Defense cyan, Prosecution violet, Remedy yellow, Judge amber, Juror off-white,
// Stenographer grey. `--term-hue` carries the hue to a bubble's border and tail.

/** Bubbles in a gutter beside the panel, overlapping its edge, tails pointing left into it. */
function sideNotes(selector: string): string {
  return `
  ${selector} { display: grid; grid-template-columns: minmax(0, 1fr) 14.5rem; align-items: start; }
  ${selector} > .term-box { align-self: stretch; }
  ${selector} .term-body { padding-right: 1rem; }
  ${selector} > .term-notes { margin: 1.875rem 0 0.5rem -0.5rem; }
  ${selector} .term-note-list { grid-template-columns: minmax(0, 1fr); }
  ${selector} .term-bubble { border-radius: 0.125rem 0.625rem 0.625rem 0.625rem; }
  ${selector} .term-bubble:nth-child(even) { margin-top: 0; margin-left: 0.5rem; }
  ${selector} .term-bubble::before {
    top: 0.5rem;
    left: -0.3125rem;
    border-top: 0;
    border-left: 1px solid var(--term-hue);
    border-bottom: 1px solid var(--term-hue);
  }
  ${selector} .term-earlier { margin-left: 0.875rem; }`;
}

export const TERMINAL_CSS = `
.term {
  --term-hue: var(--color-muted);
  margin-inline: calc(50% - min(50vw - 1rem, 56rem));
  font-family: var(--font-mono);
  font-size: 0.8125rem;
  line-height: 1.35;
  font-variant-numeric: tabular-nums;
  color: var(--color-text);
}
.term p, .term dl, .term dd, .term ul, .term ol, .term blockquote { margin: 0; padding: 0; }
.term ul, .term ol { list-style: none; }
.term h1, .term h2, .term h3, .term h4 { margin: 0; font-family: var(--font-mono); font-size: inherit; line-height: inherit; }
.term-dim { color: var(--color-muted); }
.term-num { text-align: right; }
.term-add { color: var(--color-term-pos); }
.term-del { color: var(--color-term-neg); }

/* Status line */
.term-status {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.125rem 1.25rem;
  padding: 0.25rem 0.5rem;
  background: var(--color-surface);
  border: 1px solid var(--color-muted);
  border-top: 2px solid var(--color-term-amber);
}
.term .term-title { font-size: 0.8125rem; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: var(--color-text); }
.term-brand { color: var(--color-term-amber); }
.term-status-fields { display: flex; flex-wrap: wrap; gap: 0.125rem 1.25rem; min-width: 0; }
.term-status-fields > div { display: flex; gap: 0.5rem; min-width: 0; }
.term-status-fields dt, .term-kv dt, .term-facts dt {
  color: var(--color-term-amber);
  font-size: 0.75rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.term-status-fields dd { overflow-wrap: anywhere; font-weight: 600; }
.term-stamp { font-weight: 700; letter-spacing: 0.08em; }
.term-stamp--plain { color: var(--color-text); }
.term-stamp--warn { color: var(--color-warn); }
.term-stamp--verified { color: var(--color-accent); }

/* Scrubber */
.term-scrub {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.25rem 0.75rem;
  padding: 0.25rem 0.5rem;
  background: var(--color-surface);
  border: 1px solid var(--color-muted);
  border-top: 0;
}
.term-scrub label { color: var(--color-term-amber); font-size: 0.75rem; letter-spacing: 0.08em; text-transform: uppercase; }
.term-scrub input[type="range"] { flex: 1 1 12rem; min-width: 8rem; margin: 0; accent-color: var(--color-term-amber); }
.term-scrub-pos { min-width: 13rem; }
.term-scrub-buttons { display: inline-flex; gap: 0.25rem; }
.term-scrub button {
  font: inherit;
  padding: 0.0625rem 0.5rem;
  background: var(--color-bg);
  color: var(--color-text);
  border: 1px solid var(--color-muted);
  cursor: pointer;
}
.term-scrub button:hover { border-color: var(--color-text); }
.term-scrub button:disabled { color: var(--color-muted); border-style: dotted; cursor: default; }

/* Grid of panels */
.term-grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: 0.5rem; margin-top: 0.5rem; align-items: stretch; }
.term-panel { display: flex; flex-direction: column; min-width: 0; }
.term-box { flex: 1 1 auto; min-width: 0; background: var(--color-bg); border: 1px solid var(--color-muted); }
.term-bar {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 0.75rem;
  padding: 0.125rem 0.5rem;
  background: var(--color-surface);
  border-bottom: 1px solid var(--color-muted);
}
.term .term-bar h2, .term .term-bar h3 { font-size: 0.75rem; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: var(--color-term-amber); }
.term-bar-meta { font-size: 0.75rem; text-align: right; color: var(--color-muted); }
.term-body { padding: 0.375rem 0.5rem; min-width: 0; }
.term-panel--noted .term-body { padding-bottom: 0.75rem; }
.term-scroll { position: relative; overflow-x: auto; max-width: 100%; }
.term-box { position: relative; overflow: hidden; }

/* Tables */
.term table { width: 100%; border-collapse: collapse; font-size: inherit; }
.term th, .term td {
  padding: 0.0625rem 0.375rem;
  border-top: 1px dotted var(--color-muted);
  text-align: left;
  vertical-align: top;
  font-weight: 400;
}
.term th.term-num, .term td.term-num { text-align: right; white-space: nowrap; }
.term thead th { border-top: 0; font-size: 0.75rem; letter-spacing: 0.06em; text-transform: uppercase; color: var(--color-muted); white-space: nowrap; }
.term tfoot th, .term tfoot td { font-weight: 700; }
.term tfoot tr:first-child th, .term tfoot tr:first-child td { border-top: 1px solid var(--color-muted); }
.term tfoot th { color: var(--color-term-amber); font-size: 0.75rem; letter-spacing: 0.08em; text-transform: uppercase; }

/* Shared cells and tags */
.term-res { font-weight: 700; letter-spacing: 0.04em; }
.term-res--pass { color: var(--color-term-pos); }
.term-res--fail { color: var(--color-term-neg); }
.term-state { font-weight: 700; letter-spacing: 0.06em; white-space: nowrap; }
.term-state--pos { color: var(--color-term-pos); }
.term-state--neg { color: var(--color-term-neg); }
.term-state--warn { color: var(--color-warn); }
.term-state--pending { color: var(--color-muted); }
.term-id { color: var(--color-term-cyan); overflow-wrap: anywhere; font-weight: 400; }
.term-ids { display: inline-flex; flex-wrap: wrap; gap: 0.125rem 0.375rem; }
.term-ids .term-id, .term-bubble .term-id { padding: 0 0.25rem; border: 1px dotted var(--color-muted); }
.term-chip {
  display: inline-block;
  padding: 0 0.3125rem;
  font-size: 0.75rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  white-space: nowrap;
  background: var(--color-muted);
  color: var(--color-bg);
}
.term-chip--defense { background: var(--color-term-cyan); color: var(--color-bg); }
.term-chip--prosecution { background: var(--color-term-violet); color: var(--color-bg); }
.term-chip--remedy { background: var(--color-term-yellow); color: var(--color-bg); }
.term-chip--judge { background: var(--color-term-amber); color: var(--color-bg); }
.term-chip--juror { background: var(--color-text); color: var(--color-bg); }
.term-chip--stenographer { background: var(--color-muted); color: var(--color-bg); }
.term-chip--unknown { background: var(--color-bg); color: var(--color-text); outline: 1px dotted var(--color-muted); }
.term-tone { display: inline-block; width: 1ch; margin-right: 0.375rem; font-weight: 700; }
.term-tone--pos { color: var(--color-term-pos); }
.term-tone--neg { color: var(--color-term-neg); }
.term-tone--warn { color: var(--color-warn); }
.term-tone--neutral { color: var(--color-muted); }
.term-reason { color: var(--color-term-neg); margin: 0.125rem 0; }

/* STAGES: segmented ticker */
.term-rail { display: grid; grid-template-columns: repeat(auto-fit, minmax(5.5rem, 1fr)); gap: 0.25rem 0; }
.term-rail-item {
  display: flex;
  flex-direction: column;
  min-width: 0;
  padding: 0.125rem 0.375rem;
  border-top: 2px solid var(--color-muted);
  border-left: 1px dotted var(--color-muted);
  color: var(--color-muted);
}
.term-rail-top { display: flex; gap: 0.375rem; font-size: 0.75rem; }
.term-rail-state { text-transform: uppercase; letter-spacing: 0.06em; }
.term-rail-name { font-weight: 700; letter-spacing: 0.01em; text-transform: uppercase; overflow-wrap: anywhere; }
.term-rail-meta { font-size: 0.75rem; }
.term-rail-item--done { border-top: 2px solid var(--color-text); color: var(--color-text); }
.term-rail-item--done .term-rail-top, .term-rail-item--done .term-rail-meta { color: var(--color-muted); }
.term-rail-item--active { background: var(--color-surface); border-top: 2px solid var(--color-term-amber); color: var(--color-term-amber); }

/* EVIDENCE */
.term-exhibit + .term-exhibit { margin-top: 0.375rem; padding-top: 0.375rem; border-top: 1px solid var(--color-muted); }
.term-exhibit-head, .term-round-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.125rem 0.625rem; margin-bottom: 0.125rem; }
.term-exhibit-head .term-id { font-weight: 700; }
.term-exhibit-head .term-state, .term-round-head .term-state { margin-left: auto; }
.term-kind { text-transform: uppercase; letter-spacing: 0.06em; font-size: 0.75rem; color: var(--color-muted); }
.term-exhibit-grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: 0.25rem 1rem; align-items: start; }
.term .term-matrix { width: auto; }
.term-exhibit-grid > .term-scroll { justify-self: start; }
.term .term-matrix th, .term .term-matrix td { padding: 0 0.3125rem; }
.term .term-matrix .term-matrix-variant { text-align: left; border-left: 1px dotted var(--color-muted); color: var(--color-text); }
.term .term-matrix .term-matrix-first, .term .term-matrix .term-norun { border-left: 1px dotted var(--color-muted); }
.term .term-matrix tbody th { color: var(--color-muted); }
.term-norun { text-align: center; color: var(--color-muted); }
.term-facts { display: flex; flex-wrap: wrap; gap: 0 1.25rem; }
.term-facts > div { display: flex; align-items: baseline; gap: 0.5rem; }
.term-kv > div { display: contents; }
.term-facts-line { margin-left: 0.5rem; }
.term-family { display: inline-flex; flex-wrap: wrap; gap: 1px; vertical-align: bottom; }
.term-cell { display: inline-block; min-width: 1.125rem; text-align: center; font-weight: 700; font-size: 0.75rem; }
.term-cell--pass { background: var(--color-term-add-bg); color: var(--color-term-pos); }
.term-cell--fail { background: var(--color-term-del-bg); color: var(--color-term-neg); }

/* VERIFY */
.term-round + .term-round { margin-top: 0.375rem; padding-top: 0.375rem; border-top: 1px solid var(--color-muted); }
.term .term-round-head h3, .term .term-round-head h4 { font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; }
.term-checks li { display: flex; gap: 0.625rem; border-top: 1px dotted var(--color-muted); padding: 0.0625rem 0; }
.term-check-sub { padding-left: 1rem; }
.term-void-note { color: var(--color-warn); margin: 0.125rem 0; }
.term-round--void .term-checks { color: var(--color-muted); }
.term-round--void .term-check-label, .term-round--void .term-res { text-decoration: line-through; }
.term-round--void .term-res--pass, .term-round--void .term-res--fail { color: var(--color-muted); }

/* DIFF */
.term-diff-files { display: flex; flex-wrap: wrap; gap: 0.125rem 0.75rem; margin-bottom: 0.25rem; }
.term-diff-path { overflow-wrap: anywhere; }
.term .term-diff { width: max-content; min-width: 100%; }
.term .term-diff th, .term .term-diff td { border-top: 0; padding: 0 0.375rem; white-space: pre; }
.term .term-diff thead th { border-bottom: 1px dotted var(--color-muted); }
.term .term-diff .term-diff-no { width: 1%; min-width: 2.75rem; text-align: right; color: var(--color-muted); border-right: 1px dotted var(--color-muted); }
.term .term-diff .term-diff-mark { width: 1%; font-weight: 700; text-align: center; }
.term-diff-file td { background: var(--color-surface); color: var(--color-text); font-weight: 700; }
.term-diff-hunk td { background: var(--color-surface); color: var(--color-term-cyan); }
.term-diff-line--add td { background: var(--color-term-add-bg); color: var(--color-text); }
.term-diff-line--del td { background: var(--color-term-del-bg); color: var(--color-text); }
.term .term-diff .term-diff-line--add .term-diff-mark { background: var(--color-term-add-bg); color: var(--color-term-pos); }
.term .term-diff .term-diff-line--del .term-diff-mark { background: var(--color-term-del-bg); color: var(--color-term-neg); }

/* ARGUMENTS */
.term .term-args td { width: 50%; padding-top: 0.125rem; padding-bottom: 0.125rem; }
.term .term-args td + td { border-left: 1px dotted var(--color-muted); }
.term-args-claim, .term-args-ruling { margin-left: 0.5rem; }
.term-args-quote { display: block; margin-top: 0.0625rem; padding-left: 0.5rem; border-left: 2px solid var(--color-muted); color: var(--color-muted); overflow-wrap: anywhere; }
.term-args-cites li { display: inline; margin-right: 0.75rem; }

/* JURY */
.term-sub { display: block; font-size: 0.75rem; color: var(--color-muted); }
.term-vote { font-weight: 700; text-transform: uppercase; }
.term .term-jury { min-width: 44rem; }
.term .term-jury .term-id { white-space: nowrap; }
.term .term-jury .term-ids { flex-direction: column; align-items: flex-start; }
.term-conf { white-space: nowrap; }
.term-conf-fill { color: var(--color-term-cyan); }
.term-conf-rest { color: var(--color-muted); }
.term-conf-n { margin-left: 0.375rem; }

/* TAPE */
.term-tape-scroll { height: 15rem; overflow-y: auto; }
.term .term-tape thead th { position: sticky; top: 0; background: var(--color-bg); color: var(--color-muted); }
.term .term-tape td { white-space: nowrap; }
.term .term-tape .term-tape-text { white-space: normal; width: 100%; overflow-wrap: anywhere; }
.term-actor { text-transform: uppercase; font-size: 0.75rem; letter-spacing: 0.04em; }
.term-actor--defense { color: var(--color-term-cyan); }
.term-actor--prosecution { color: var(--color-term-violet); }
.term-actor--remedy { color: var(--color-term-yellow); }
.term-actor--judge { color: var(--color-term-amber); }
.term-actor--juror { color: var(--color-text); }
.term-actor--stenographer, .term-actor--unknown { color: var(--color-muted); }

/* VERDICT */
.term-verdict-line { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: baseline; gap: 0.125rem 0.75rem; margin-bottom: 0.25rem; }
.term-outcome { font-size: 1rem; font-weight: 700; letter-spacing: 0.08em; }
.term-outcome--neutral { color: var(--color-text); }
.term-outcome--neg { color: var(--color-term-neg); }
.term-outcome--warn { color: var(--color-warn); }
.term-verdict-line .term-stamp { padding: 0 0.375rem; border: 1px solid var(--color-muted); }
.term-verdict-line .term-stamp--verified { border: 1px solid var(--color-accent); }
.term-verdict-line .term-stamp--warn { border: 1px solid var(--color-warn); }
.term-kv { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 0 0.625rem; margin-bottom: 0.25rem; }
.term-hash { overflow-wrap: anywhere; }

/* Bubbles: under the panel by default, overlapping its bottom edge, tails pointing up into it */
.term-notes { position: relative; z-index: 1; margin: -0.4375rem 0.5rem 0.25rem 1.25rem; }
.term-note-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(13rem, 1fr)); gap: 0.5rem 0.625rem; align-items: start; }
.term-bubble {
  position: relative;
  min-width: 0;
  padding: 0.3125rem 0.5rem 0.375rem;
  background: var(--color-surface);
  color: var(--color-text);
  border: 1px solid var(--term-hue);
  border-radius: 0.125rem 0.625rem 0.625rem 0.625rem;
  box-shadow: 0.1875rem 0.1875rem 0 var(--color-bg);
  animation: term-bubble-in 280ms ease-out;
}
.term-bubble::before {
  content: "";
  position: absolute;
  top: -0.3125rem;
  left: 0.75rem;
  width: 0.5rem;
  height: 0.5rem;
  background: var(--color-surface);
  border-top: 1px solid var(--term-hue);
  border-left: 1px solid var(--term-hue);
  transform: rotate(45deg);
}
.term-bubble:nth-child(even) { margin-top: 0.4375rem; }
.term-bubble--defense { --term-hue: var(--color-term-cyan); }
.term-bubble--prosecution { --term-hue: var(--color-term-violet); }
.term-bubble--remedy { --term-hue: var(--color-term-yellow); }
.term-bubble--judge { --term-hue: var(--color-term-amber); }
.term-bubble--juror { --term-hue: var(--color-text); }
.term-bubble--stenographer, .term-bubble--unknown { --term-hue: var(--color-muted); }
.term-bubble-head { display: flex; justify-content: space-between; align-items: baseline; gap: 0.5rem; }
.term-bubble-seq { font-size: 0.75rem; color: var(--color-muted); }
.term-bubble-title { margin-top: 0.1875rem; font-weight: 700; }
.term-bubble-body { font-family: var(--font-body); font-size: 0.8125rem; line-height: 1.4; }
.term-quote { margin-top: 0.25rem; padding: 0.125rem 0.375rem; background: var(--color-bg); border-left: 2px solid var(--term-hue); }
.term-quote-label { font-size: 0.75rem; letter-spacing: 0.08em; text-transform: uppercase; color: var(--color-muted); }
.term-quote-text { overflow-wrap: anywhere; font-style: italic; }
.term-bubble-cites { margin-top: 0.25rem; font-size: 0.75rem; }
.term-earlier { margin-top: 0.375rem; }
.term-earlier summary { display: inline-block; padding: 0 0.375rem; cursor: pointer; font-size: 0.75rem; background: var(--color-surface); color: var(--color-text); border: 1px dotted var(--color-muted); }
.term-earlier[open] summary { margin-bottom: 0.5rem; }
@keyframes term-bubble-in {
  from { opacity: 0; transform: translateY(0.375rem) scale(0.97); }
  to { opacity: 1; transform: none; }
}

@media (min-width: 60rem) {
  .term-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    grid-template-areas:
      "stages stages"
      "evidence verify"
      "diff diff"
      "arguments jury"
      "cost verdict"
      "tape tape";
  }
  .term-panel--stages { grid-area: stages; }
  .term-panel--evidence { grid-area: evidence; }
  .term-panel--verify { grid-area: verify; }
  .term-panel--diff { grid-area: diff; }
  .term-panel--arguments { grid-area: arguments; }
  .term-panel--jury { grid-area: jury; }
  .term-panel--cost { grid-area: cost; }
  .term-panel--tape { grid-area: tape; }
  .term-panel--verdict { grid-area: verdict; }
}

@media (min-width: 60rem) and (max-width: 91.99rem) {
${sideNotes('.term-panel--diff.term-panel--noted')}
}

@media (min-width: 92rem) {
  .term-grid {
    grid-template-columns: repeat(12, minmax(0, 1fr));
    grid-template-areas:
      "stages stages stages stages stages stages stages stages stages stages stages stages"
      "evidence evidence evidence evidence evidence evidence diff diff diff diff diff diff"
      "verify verify verify verify arguments arguments arguments arguments arguments arguments arguments arguments"
      "jury jury jury jury jury jury jury cost cost cost cost cost"
      "tape tape tape tape tape tape tape tape verdict verdict verdict verdict";
  }
${sideNotes('.term-panel--evidence.term-panel--noted')}
${sideNotes('.term-panel--diff.term-panel--noted')}
}
`;
