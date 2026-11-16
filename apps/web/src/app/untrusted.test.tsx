import { TrialEvent } from '@affidavit/contracts';
import { readFixtureJson } from '@affidavit/testing';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCaseView } from '../model/caseView.js';
import { CaseFile } from './CaseFile.js';

afterEach(cleanup);

const IMG = '<img src=x onerror=alert(1)>';
const SCRIPT = '<script>window.pwned=1</script>';
const JS_URL = 'javascript:alert(1)';
const STYLE = '"><a href="javascript:alert(2)" style="position:fixed">';

function load(name: string): TrialEvent[] {
  return TrialEvent.array().parse(readFixtureJson(`trials/${name}.events.json`));
}

/** Replaces every free-text and id string the UI renders with a hostile payload. */
function poison(events: TrialEvent[]): TrialEvent[] {
  return events.map((e) => {
    switch (e.type) {
      case 'verdict-written':
        return {
          ...e,
          payload: { verdict: { ...e.payload.verdict, summary: `${IMG} ${SCRIPT} ${JS_URL}` } },
        };
      case 'escalated':
      case 'budget-exhausted':
        return {
          ...e,
          payload: { escalation: { ...e.payload.escalation, detail: `${IMG} ${STYLE}` } },
        };
      case 'exhibit-submitted':
        return {
          ...e,
          payload: { ...e.payload, exhibitId: `${IMG}${e.payload.exhibitId}` as never },
        };
      default:
        return e;
    }
  });
}

function expectInert(container: HTMLElement) {
  expect(container.querySelector('img')).toBeNull();
  expect(container.querySelector('script')).toBeNull();
  expect(container.querySelector('[onerror]')).toBeNull();
  expect(container.querySelector('[style]')).toBeNull();
  for (const a of container.querySelectorAll('a')) {
    const href = a.getAttribute('href') ?? '';
    expect(href.startsWith('/') || href.startsWith('#')).toBe(true);
  }
  expect((window as { pwned?: number }).pwned).toBeUndefined();
}

describe('untrusted case content renders as inert text', () => {
  it('neutralizes payloads in a verdict summary', () => {
    const view = buildCaseView(poison(load('nodegoat-sqli-001')));
    const { container } = render(<CaseFile view={view} />);
    for (const b of screen.getAllByRole('button')) fireEvent.click(b);
    expectInert(container);
    expect(container.textContent).toContain(IMG);
    expect(container.textContent).toContain(SCRIPT);
    expect(container.textContent).toContain(JS_URL);
  });

  it('neutralizes payloads in an escalation detail and in exhibit ids', () => {
    const view = buildCaseView(poison(load('escalated-001')));
    const { container } = render(<CaseFile view={view} />);
    for (const b of screen.getAllByRole('button')) fireEvent.click(b);
    expectInert(container);
    expect(container.textContent).toContain(IMG);
    expect(container.textContent).toContain(STYLE);
    expect(
      screen.getAllByRole('button', { name: new RegExp(IMG.replace(/[()]/g, '\\$&')) }).length,
    ).toBeGreaterThan(0);
  });
});

describe('source hygiene', () => {
  const SRC = join(import.meta.dirname, '..');
  const files = (readdirSync(SRC, { recursive: true }) as string[])
    .filter((f) => /\.(ts|tsx)$/.test(f))
    .map((f) => ({ f, text: readFileSync(join(SRC, f), 'utf8') }));

  // Needles are assembled so this file does not match itself.
  const banned = [
    'dangerously' + 'SetInnerHTML',
    '.inner' + 'HTML',
    'ev' + 'al(',
    'new Func' + 'tion(',
    'document.wri' + 'te',
  ];

  it('scans the whole src tree', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  for (const needle of banned)
    it(`does not use ${needle}`, () => {
      expect(files.filter(({ text }) => text.includes(needle)).map(({ f }) => f)).toEqual([]);
    });
});
