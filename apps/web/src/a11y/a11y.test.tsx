import { TrialEvent, type VerifyResult } from '@affidavit/contracts';
import { readFixtureJson } from '@affidavit/testing';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CaseFile } from '../app/CaseFile.js';
import { renderApp } from '../app/testUtils.js';
import { APP_CSS } from '../app/styles.js';
import { buildCaseView } from '../model/caseView.js';
import { checkAccessibility, tabOrder } from './check.js';

afterEach(cleanup);

function openEverything() {
  for (const b of screen.queryAllByRole('button')) fireEvent.click(b);
}

describe('accessibility check on the real views', () => {
  for (const path of ['/', '/cases/nodegoat-sqli-001', '/cases/escalated-001', '/cases/nope']) {
    it(`passes on ${path}, with every disclosure open`, async () => {
      const { container } = renderApp(path);
      await screen.findByRole('heading', { level: 1 });
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
          <CaseFile view={buildCaseView(events, { verifyResults: [accepted] })} />
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
    await screen.findByRole('heading', { level: 1 });
    const order = tabOrder(container);
    expect(order[0]?.textContent).toBe('Skip to content');
    expect(order.some((el) => Number(el.getAttribute('tabindex')) > 0)).toBe(false);
    const buttons = order.filter((el) => el.tagName === 'BUTTON');
    expect(buttons.length).toBeGreaterThanOrEqual(3);
  });

  it('toggles a disclosure from a focused button and keeps focus on it', async () => {
    renderApp('/cases/escalated-001');
    const b = await screen.findByRole('button', { name: /exhibit-witness-001/ });
    b.focus();
    fireEvent.keyDown(b, { key: 'Enter' });
    fireEvent.click(b); // browsers turn Enter and Space on a button into this click
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

  it('flags low-contrast CSS, missing focus style and missing reduced-motion handling', () => {
    expect(
      run(good(''), '.x { color: var(--color-bg); background: var(--color-surface); }').join(),
    ).toMatch(/contrast below AA/);
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
