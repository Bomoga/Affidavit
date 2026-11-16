import { toCssVariables } from '../design/tokens.js';

// Every color comes from a design token, so the contrast pairs are checkable in tests
// (a11y/check.ts reads this string). Green is reserved for the VERIFIED stamp, links and focus.
const RULES = `
*, *::before, *::after { box-sizing: border-box; }
html { color-scheme: dark; }
body {
  margin: 0;
  background: var(--color-bg);
  color: var(--color-text);
  font-family: var(--font-body);
  font-size: 1rem;
  line-height: 1.55;
}
a { color: var(--color-accent); text-underline-offset: 0.2em; }
:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }
main:focus { outline: none; }
.skip-link {
  position: absolute;
  left: 1rem;
  top: -4rem;
  padding: 0.5rem 0.75rem;
  background: var(--color-surface);
  color: var(--color-text);
  border: 1px solid var(--color-accent);
}
.skip-link:focus { top: 1rem; }
.site-header, .site-footer, main {
  max-width: 62rem;
  margin: 0 auto;
  padding: 1rem;
}
.site-header {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  border-bottom: 1px solid var(--color-muted);
}
.brand, .label, .mono, th, .stamp, .meta {
  font-family: var(--font-mono);
}
.brand { margin: 0; letter-spacing: 0.08em; text-transform: uppercase; color: var(--color-text); }
.label { margin: 0; font-size: 0.8125rem; letter-spacing: 0.06em; text-transform: uppercase; color: var(--color-muted); }
.muted { color: var(--color-muted); }
h1 { font-size: 1.75rem; line-height: 1.25; margin: 0.25rem 0 1rem; }
h2 { font-size: 1.125rem; margin: 2rem 0 0.75rem; }
h3 { font-size: 1rem; margin: 0; }
.stamp {
  display: inline-block;
  margin: 0 0 1rem;
  padding: 0.25rem 0.75rem;
  border: var(--stamp-border-width) solid var(--color-muted);
  color: var(--color-muted);
  letter-spacing: 0.14em;
  font-size: 0.875rem;
  animation: stamp-in 240ms ease-out;
}
.stamp--verified { border-color: var(--color-accent); color: var(--color-accent); }
.stamp--warn { border-color: var(--color-warn); color: var(--color-warn); }
@keyframes stamp-in {
  from { opacity: 0; transform: scale(1.08); }
  to { opacity: 1; transform: none; }
}
.panel {
  background: var(--color-surface);
  color: var(--color-text);
  border: 1px solid var(--color-muted);
  padding: 1rem;
  margin: 1rem 0;
}
.panel--review { border-color: var(--color-warn); }
.panel--review h2 { margin-top: 0; color: var(--color-warn); }
.panel ul, .panel p { margin: 0.5rem 0; }
.case-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.75rem; }
.case-list li { background: var(--color-surface); color: var(--color-text); border: 1px solid var(--color-muted); padding: 1rem; }
.case-list .stamp { margin: 0.5rem 0 0; }
.disclosure { background: var(--color-surface); color: var(--color-text); border: 1px solid var(--color-muted); margin: 0.5rem 0; }
.disclosure > h2, .disclosure > h3 { margin: 0; }
.disclosure button {
  all: unset;
  display: block;
  width: 100%;
  box-sizing: border-box;
  padding: 0.75rem 1rem;
  cursor: pointer;
  color: var(--color-text);
  font-family: var(--font-mono);
  font-size: 0.9375rem;
}
.disclosure button:focus-visible { outline: 2px solid var(--color-focus); outline-offset: -2px; }
.disclosure button:hover { text-decoration: underline; }
.disclosure .panel-body { padding: 0 1rem 1rem; }
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}
.hash { overflow-wrap: anywhere; }
table { width: 100%; border-collapse: collapse; font-size: 0.875rem; }
caption { text-align: left; padding: 0.5rem 0; color: var(--color-muted); }
th, td { text-align: left; vertical-align: top; padding: 0.375rem 0.5rem; border-top: 1px solid var(--color-muted); }
th { color: var(--color-muted); font-weight: 600; }
.table-wrap { overflow-x: auto; }
.docket { list-style: none; margin: 0; padding: 0; }
.docket li { padding: 0.375rem 0; border-top: 1px solid var(--color-muted); animation: docket-in 240ms ease-out; }
@keyframes docket-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
.docket-detail { margin: 0.25rem 0 0.25rem 1rem; }
.inline-disclosure > button {
  all: unset;
  cursor: pointer;
  color: var(--color-accent);
  font-family: var(--font-mono);
  font-size: 0.875rem;
  text-decoration: underline;
  text-underline-offset: 0.2em;
}
.inline-disclosure > button:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }
.connection { margin: 0 0 1rem; font-family: var(--font-mono); font-size: 0.875rem; color: var(--color-text); }
.connection--live { color: var(--color-accent); }
.connection--reconnecting, .connection--disconnected { color: var(--color-warn); }
.connection button {
  margin-left: 0.75rem;
  background: var(--color-surface);
  color: var(--color-text);
  border: 1px solid var(--color-muted);
  padding: 0.25rem 0.75rem;
  font-family: var(--font-mono);
  cursor: pointer;
}
.site-footer { color: var(--color-muted); font-size: 0.875rem; border-top: 1px solid var(--color-muted); margin-top: 3rem; }
`;

export const APP_CSS = `${toCssVariables()}\n${RULES}`;
