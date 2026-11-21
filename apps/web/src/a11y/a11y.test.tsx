import { TrialEvent, type VerifyResult } from '@affidavit/contracts';
import { readFixtureJson } from '@affidavit/testing';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CaseFile } from '../app/CaseFile.js';
import { renderApp, settled } from '../app/testUtils.js';
import { APP_CSS } from '../app/styles.js';
import { buildCaseView } from '../model/caseView.js';
import { withVerify } from '../testing/verify.js';
import { checkAccessibility, tabOrder } from './check.js';

afterEach(cleanup);

function openEverything() {
  for (const b of screen.queryAllByRole('button')) fireEvent.click(b);
}

describe('accessibility check on the real views', () => {
  for (const path of ['/', '/cases/nodegoat-sqli-001', '/cases/escalated-001', '/cases/nope']) {
    it(`passes on ${path}, with every disclosure open`, async () => {
      const { container } = renderApp(path);
      await settled();
      openEverything();
      expect(checkAccessibility(container, APP_CSS)).toEqual([]);
    });
  }

  it('passes on a VERIFIED case', () => {
    const events = TrialEvent.array().parse(
      readFixtureJson('trials/nodegoat-sqli-001.events.json'),
    );
    const accepted: VerifyResult = {
      schemaVersion: 1,
      patchExhibitId: 'exhibit-patch-001' as VerifyResult['patchExhibitId'],
      familyFlipped: true,
      suitePassed: true,
      rescanClean: true,
      counterexamples: [],
    };
    // CaseFile alone has no landmarks, so wrap it the way the layout does.
    const { container } = render(
      <>
        <header>
          <nav aria-label="Primary">
            <a href="/">Home</a>
          </nav>
        </header>
        <main>
          <CaseFile view={buildCaseView(withVerify(events, [accepted]))} />
        </main>
        <footer>
          <p>Footer</p>
        </footer>
      </>,
    );
    openEverything();
    expect(checkAccessibility(container, APP_CSS)).toEqual([]);
  });
});

describe('keyboard navigation', () => {
  it('puts the skip link first and keeps tab order equal to reading order, with no positive tabindex', async () => {
    const { container } = renderApp('/cases/nodegoat-sqli-001');
    await settled();
    const order = tabOrder(container);
    expect(order[0]?.textContent).toBe('Skip to content');
    expect(order.some((el) => Number(el.getAttribute('tabindex')) > 0)).toBe(false);
    const buttons = order.filter((el) => el.tagName === 'BUTTON');
    expect(buttons.length).toBeGreaterThanOrEqual(3);
  });

  it('uses a native button for disclosures, so Enter and Space work, and toggles on click', async () => {
    renderApp('/cases/escalated-001');
    const b = await screen.findByRole('button', { name: /exhibit-witness-001/ });
    // jsdom does not turn Enter or Space into a click, so assert the guarantee we rely on:
    // a real <button type="button"> with no custom key handling (source hygiene bans onKeyDown).
    expect(b.tagName).toBe('BUTTON');
    expect(b.getAttribute('type')).toBe('button');
    expect(b.hasAttribute('tabindex')).toBe(false);
    b.focus();
    expect(document.activeElement).toBe(b);
    fireEvent.click(b);
    expect(b.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(b);
    fireEvent.click(b);
    expect(b.getAttribute('aria-expanded')).toBe('false');
  });
});

describe('checker catches real problems', () => {
  const good = (body: string) =>
    `<header><nav aria-label="N"><a href="/">Home</a></nav></header><main><h1>T</h1>${body}</main><footer><p>f</p></footer>`;
  const run = (html: string, css = APP_CSS) => {
    const div = document.createElement('div');
    div.append(document.createRange().createContextualFragment(html));
    document.body.append(div);
    const out = checkAccessibility(div, css);
    div.remove();
    return out;
  };

  it('accepts a clean page', () => {
    expect(run(good('<h2>A</h2><button type="button">Go</button>'))).toEqual([]);
  });

  it('flags missing names, skipped headings, positive tabindex, bad images and missing landmarks', () => {
    expect(run(good('<button type="button"></button>')).join()).toMatch(/no accessible name/);
    expect(run(good('<h3>Skipped</h3>')).join()).toMatch(/heading level skipped/);
    expect(run(good('<a href="/x" tabindex="3">x</a>')).join()).toMatch(/positive tabindex/);
    expect(run(good('<img src="/a.png">')).join()).toMatch(/img without alt/);
    expect(run('<h1>T</h1>').join()).toMatch(/main landmark/);
    expect(run(good('<h1>Two</h1>')).join()).toMatch(/exactly one h1/);
  });

  it('flags named colors, modern color functions, and colors on any property', () => {
    const decls = [
      'color: red',
      'background: White',
      'color: oklch(0.7 0.1 150)',
      'color: lab(50% 40 59)',
      'color: lch(50% 40 59)',
      'background: hwb(194 0% 0%)',
      'color: color(srgb 1 0 0)',
      'background: color-mix(in srgb, var(--color-bg), var(--color-text))',
      'box-shadow: 0 0 4px #000',
      'box-shadow: 0 0 4px black',
      'fill: #fff',
      'stroke: lime',
      'text-decoration-color: gold',
      'caret-color: hsl(1, 2%, 3%)',
      'accent-color: green',
      'border-block: 1px solid red',
      'border-inline-start-color: #123',
      'column-rule: 1px solid #abc',
      '--custom: #fff',
    ];
    for (const d of decls) expect(run(good(''), `.x { ${d}; }`).join(), d).toMatch(/literal color/);
  });

  it('accepts tokens, transparent, currentColor, inherit and none', () => {
    const decls = [
      'color: var(--color-text)',
      'background: transparent',
      'border-color: currentColor',
      'color: inherit',
      'box-shadow: none',
      'fill: currentColor',
      'font-family: Menlo, monospace',
    ];
    for (const d of decls) expect(run(good(''), `.x { ${d}; }`).join(), d).not.toMatch(/literal/);
  });

  it('flags unknown color tokens', () => {
    expect(run(good(''), '.x { color: var(--color-nope); }').join()).toMatch(/unknown color token/);
    expect(run(good(''), ':root { --color-extra: #fff; }').join()).toMatch(/unknown color token/);
  });

  it('computes names from visible content only', () => {
    expect(
      run(good('<button type="button"><span aria-hidden="true">x</span></button>')).join(),
    ).toMatch(/no accessible name/);
    expect(run(good('<button type="button"><span hidden>x</span></button>')).join()).toMatch(
      /no accessible name/,
    );
    expect(run(good('<button type="button" aria-hidden="true">x</button>')).join()).toEqual('');
  });

  it('resolves label for and wrapping labels on form controls', () => {
    expect(run(good('<label for="a">Name</label><input id="a" type="text" />'))).toEqual([]);
    expect(run(good('<label>Name <input type="text" /></label>'))).toEqual([]);
    expect(run(good('<select id="s"><option>1</option></select>')).join()).toMatch(
      /no accessible name/,
    );
    expect(run(good('<input type="text" />')).join()).toMatch(/no accessible name/);
  });

  it('flags empty headings, style attributes and onclick on non-interactive elements', () => {
    expect(run(good('<h2></h2>')).join()).toMatch(/<h2> has no accessible name/);
    expect(run(good('<h2><span aria-hidden="true">x</span></h2>')).join()).toMatch(
      /<h2> has no accessible name/,
    );
    expect(run(good('<p style="color:red">x</p>')).join()).toMatch(/style attribute/);
    expect(run(good('<div onclick="go()">x</div>')).join()).toMatch(/onclick on non-interactive/);
    expect(run(good('<button type="button" onclick="go()">x</button>')).join()).not.toMatch(
      /onclick/,
    );
  });

  it('flags literal colors in any color-bearing declaration', () => {
    const decls = [
      'color: #111; background: #000',
      'color: rgb(1, 2, 3)',
      'background-color: hsl(10, 10%, 10%)',
      'border: 1px solid #fff',
      'border-bottom-color: rgba(0,0,0,.5)',
      'outline: 2px solid #3ddc84',
    ];
    for (const d of decls) expect(run(good(''), `.x { ${d}; }`).join(), d).toMatch(/literal color/);
  });

  it('flags low-contrast CSS, missing focus style and missing reduced-motion handling', () => {
    expect(
      run(good(''), '.x { color: var(--color-bg); background: var(--color-surface); }').join(),
    ).toMatch(/contrast below AA/);
    const lowBorder = '.y { border-left: 1px solid var(--color-bg); background: var(--color-bg); }';
    expect(run(good(''), lowBorder).join()).toMatch(/non-text contrast/);
    const lowBorderColor = '.y { border-top-color: var(--color-surface); }';
    expect(run(good(''), lowBorderColor).join()).toMatch(/non-text contrast/);
    const noFocus = APP_CSS.replace(/:focus-visible\s*\{[^}]*\}/g, '');
    expect(run(good(''), noFocus).join()).toMatch(/focus-visible/);
    const noReduce = APP_CSS.replace(
      'prefers-reduced-motion: reduce',
      'prefers-color-scheme: dark',
    );
    expect(run(good(''), noReduce).join()).toMatch(/reduced-motion/);
  });
});

describe('static page shell', () => {
  const html = readFileSync(join(import.meta.dirname, '..', '..', 'index.html'), 'utf8');
  it('declares a language, a title and a viewport', () => {
    expect(html).toMatch(/<html lang="en">/);
    expect(html).toMatch(/<title>[^<]+<\/title>/);
    expect(html).toMatch(/name="viewport"/);
  });
});
