// Small in-repo accessibility check used by tests. It is not a replacement for axe-core
// (a dependency request is open); it covers the structural rules this UI relies on.

import { contrastRatio } from '../design/contrast.js';
import { TOKENS } from '../design/tokens.js';

const AA_TEXT = 4.5;
const AA_NON_TEXT = 3;

const INTERACTIVE =
  'a[href], button, summary, input, select, textarea, [role="button"], [role="link"], [tabindex]';

function isHidden(el: Element): boolean {
  return el.closest('[hidden], [aria-hidden="true"]') !== null;
}

function accessibleName(el: Element, doc: Document): string {
  const label = el.getAttribute('aria-label')?.trim();
  if (label) return label;
  const by = el.getAttribute('aria-labelledby');
  if (by) {
    const text = by
      .split(/\s+/)
      .map((id) => doc.getElementById(id)?.textContent?.trim() ?? '')
      .join(' ')
      .trim();
    if (text) return text;
  }
  const own = el.textContent?.trim();
  if (own) return own;
  const alt = el.querySelector('img[alt]')?.getAttribute('alt')?.trim();
  if (alt) return alt;
  return el.getAttribute('title')?.trim() ?? '';
}

/** Elements a keyboard user reaches with Tab, in order. Positive tabindex is rejected elsewhere. */
export function tabOrder(root: Element): Element[] {
  return [...root.querySelectorAll(INTERACTIVE)].filter((el) => {
    if (isHidden(el)) return false;
    if (el.hasAttribute('disabled')) return false;
    const ti = el.getAttribute('tabindex');
    return ti === null || Number(ti) >= 0;
  });
}

function checkStructure(root: Element, out: string[]): void {
  const doc = root.ownerDocument;

  // Landmarks.
  if (root.querySelectorAll('main, [role="main"]').length !== 1)
    out.push('expected exactly one main landmark');
  const banners = [...root.querySelectorAll('header, [role="banner"]')].filter(
    (h) => h.matches('[role="banner"]') || !h.closest('article, section, main, aside, nav'),
  );
  if (banners.length !== 1) out.push('expected exactly one banner landmark');
  const footers = [...root.querySelectorAll('footer')].filter(
    (f) => !f.closest('article, section, main, aside, nav'),
  );
  if (footers.length !== 1) out.push('expected exactly one contentinfo landmark');
  for (const nav of root.querySelectorAll('nav'))
    if (!accessibleName(nav, doc)) out.push('nav landmark has no accessible name');
  for (const s of root.querySelectorAll('section'))
    if (!s.hasAttribute('aria-label') && !s.hasAttribute('aria-labelledby'))
      out.push('section landmark has no accessible name');

  // Headings: one h1, no skipped levels.
  const levels = [...root.querySelectorAll('h1, h2, h3, h4, h5, h6')].map((h) =>
    Number(h.tagName.slice(1)),
  );
  if (levels.filter((l) => l === 1).length !== 1) out.push('expected exactly one h1');
  let prev = 0;
  for (const l of levels) {
    if (l > prev + 1) out.push(`heading level skipped: h${prev} to h${l}`);
    prev = l;
  }

  // Interactive elements: names, tab order, aria wiring.
  for (const el of root.querySelectorAll(INTERACTIVE)) {
    const tag = el.tagName.toLowerCase();
    const ti = el.getAttribute('tabindex');
    if (ti !== null && Number(ti) > 0) out.push(`positive tabindex on <${tag}>`);
    const focusableByTab = ti === null || Number(ti) >= 0;
    if (focusableByTab && !accessibleName(el, doc)) out.push(`<${tag}> has no accessible name`);
    if (el.hasAttribute('aria-expanded')) {
      const controls = el.getAttribute('aria-controls');
      if (!controls || !doc.getElementById(controls))
        out.push(`<${tag}> has aria-expanded but no valid aria-controls target`);
    }
  }
  for (const el of root.querySelectorAll('[aria-labelledby]'))
    for (const id of (el.getAttribute('aria-labelledby') ?? '').split(/\s+/))
      if (!doc.getElementById(id)) out.push(`aria-labelledby points at missing id ${id}`);

  // Duplicate ids.
  const seen = new Set<string>();
  for (const el of root.querySelectorAll('[id]')) {
    if (seen.has(el.id)) out.push(`duplicate id ${el.id}`);
    seen.add(el.id);
  }

  // Images and tables.
  for (const img of root.querySelectorAll('img'))
    if (!img.hasAttribute('alt')) out.push('img without alt');
  for (const t of root.querySelectorAll('table')) {
    if (!t.querySelector('caption') && !t.hasAttribute('aria-label'))
      out.push('table without caption');
    if (!t.querySelector('th')) out.push('table without header cells');
  }
}

type Token = keyof typeof TOKENS.color;

const COLOR_PROP =
  /^(color|background(-color)?|border(-(top|right|bottom|left))?(-color)?|outline(-color)?)$/;
const LITERAL_COLOR = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\(/i;

interface Decls {
  fg: Token[];
  bg: Token[];
  border: Token[];
}

function readDecls(selector: string, decl: string, out: string[]): Decls {
  const r: Decls = { fg: [], bg: [], border: [] };
  for (const part of decl.split(';')) {
    const i = part.indexOf(':');
    if (i < 0) continue;
    const prop = part.slice(0, i).trim().toLowerCase();
    const value = part.slice(i + 1);
    if (!COLOR_PROP.test(prop)) continue;
    if (LITERAL_COLOR.test(value))
      out.push('literal color in "' + selector + '" (' + prop + '); colors must come from tokens');
    for (const m of value.matchAll(/var\(--color-([a-z]+)\)/g)) {
      const name = m[1];
      if (!name || !(name in TOKENS.color)) continue;
      const t = name as Token;
      if (prop === 'color') r.fg.push(t);
      else if (prop.startsWith('background')) r.bg.push(t);
      else r.border.push(t);
    }
  }
  return r;
}

function checkCss(css: string, out: string[]): void {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const grounds = [TOKENS.color.bg, TOKENS.color.surface];
  for (const m of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = (m[1] ?? '').trim();
    const { fg, bg, border } = readDecls(selector, m[2] ?? '', out);
    const against = bg.length > 0 ? bg.map((t) => TOKENS.color[t]) : grounds;
    for (const f of fg)
      for (const g of against)
        if (contrastRatio(TOKENS.color[f], g) < AA_TEXT)
          out.push('text contrast below AA in "' + selector + '" (' + f + ')');
    for (const bd of border)
      for (const g of against)
        if (contrastRatio(TOKENS.color[bd], g) < AA_NON_TEXT)
          out.push('non-text contrast below 3:1 in "' + selector + '" (' + bd + ')');
  }
  if (!/:focus-visible\s*\{[^}]*outline\s*:/.test(stripped)) out.push('no :focus-visible outline');
  const reduced = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?\})\s*\}/.exec(
    stripped,
  );
  if (!reduced) out.push('no prefers-reduced-motion rule');
  else {
    const body = reduced[1] ?? '';
    if (!/animation-duration:\s*0\.01ms/.test(body)) out.push('reduced motion keeps animations');
    if (!/transition-duration:\s*0\.01ms/.test(body)) out.push('reduced motion keeps transitions');
  }
}

/** Returns a list of violations; empty means the checks pass. */
export function checkAccessibility(root: Element, css: string): string[] {
  const out: string[] = [];
  checkStructure(root, out);
  checkCss(css, out);
  return out;
}
