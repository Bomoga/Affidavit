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

function isSkipped(el: Element): boolean {
  return el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true';
}

/** Text a user can perceive inside a node; hidden and aria-hidden subtrees contribute nothing. */
function textOf(node: Node): string {
  if (node.nodeType === 3) return node.textContent ?? '';
  if (node.nodeType !== 1) return '';
  const el = node as Element;
  if (isSkipped(el)) return '';
  if (el.tagName === 'IMG') return el.getAttribute('alt') ?? '';
  return [...el.childNodes].map(textOf).join('');
}

const FORM_CONTROL = new Set(['INPUT', 'SELECT', 'TEXTAREA']);

function accessibleName(el: Element, doc: Document): string {
  const label = el.getAttribute('aria-label')?.trim();
  if (label) return label;
  const by = el.getAttribute('aria-labelledby');
  if (by) {
    const text = by
      .split(/\s+/)
      .map((id) => {
        const target = doc.getElementById(id);
        return target ? textOf(target).trim() : '';
      })
      .join(' ')
      .trim();
    if (text) return text;
  }
  if (FORM_CONTROL.has(el.tagName)) {
    const parts: string[] = [];
    if (el.id)
      for (const l of doc.querySelectorAll('label'))
        if (l.getAttribute('for') === el.id) parts.push(textOf(l));
    const wrap = el.closest('label');
    if (wrap) parts.push(textOf(wrap));
    const text = parts.join(' ').trim();
    if (text) return text;
  } else {
    const own = textOf(el).trim();
    if (own) return own;
  }
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
  for (const h of root.querySelectorAll('h1, h2, h3, h4, h5, h6'))
    if (!accessibleName(h, doc))
      out.push('<' + h.tagName.toLowerCase() + '> has no accessible name');
  if (levels.filter((l) => l === 1).length !== 1) out.push('expected exactly one h1');
  for (const el of root.querySelectorAll('[style]'))
    out.push('style attribute on <' + el.tagName.toLowerCase() + '>');
  for (const el of root.querySelectorAll(
    '[onclick]:not(a[href], button, input, select, textarea, summary)',
  ))
    out.push('onclick on non-interactive <' + el.tagName.toLowerCase() + '>');
  let prev = 0;
  for (const l of levels) {
    if (l > prev + 1) out.push(`heading level skipped: h${prev} to h${l}`);
    prev = l;
  }

  // Interactive elements: names, tab order, aria wiring.
  for (const el of root.querySelectorAll(INTERACTIVE)) {
    if (isHidden(el)) continue;
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

const NAMED_COLORS =
  'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen';
const LITERAL_COLOR = new RegExp(
  '#[0-9a-f]{3,8}\\b|\\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\\(|(?<![\\w-])(?:' +
    NAMED_COLORS.split(' ').join('|') +
    ')(?![\\w-])',
  'i',
);
// Properties whose values are names or identifiers, not colors.
const NON_COLOR_PROP =
  /^(font(-family)?|content|animation(-name)?|transition(-property)?|will-change|grid-.*)$/;

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
    // Quoted strings and urls are not colors.
    const value = part
      .slice(i + 1)
      .replace(/"[^"]*"|'[^']*'|url\([^)]*\)/g, '')
      .replace(/var\(--[a-z0-9-]+\)/gi, 'var');
    const isTokenDefinition = /^--color-[a-z0-9-]+$/.test(prop);
    if (!isTokenDefinition && !NON_COLOR_PROP.test(prop) && LITERAL_COLOR.test(value))
      out.push('literal color in "' + selector + '" (' + prop + '); colors must come from tokens');
    for (const m of part.matchAll(/var\(--color-([a-z0-9-]+)\)/g)) {
      const name = m[1];
      if (!name || !(name in TOKENS.color)) continue;
      const t = name as Token;
      if (prop === 'color') r.fg.push(t);
      else if (prop.startsWith('background')) r.bg.push(t);
      else if (/^(border|outline|column-rule)/.test(prop)) r.border.push(t);
    }
  }
  return r;
}

function checkCss(css: string, out: string[]): void {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const grounds = [TOKENS.color.bg, TOKENS.color.surface];
  for (const m of stripped.matchAll(/--color-([a-z0-9-]+)/g))
    if (!(m[1] && m[1] in TOKENS.color)) out.push('unknown color token --color-' + (m[1] ?? ''));
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
