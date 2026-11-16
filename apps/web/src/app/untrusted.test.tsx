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
const STYLE_PAYLOAD = '"><a href="javascript:alert(2)" style="position:fixed">';

function load(name: string): TrialEvent[] {
  return TrialEvent.array().parse(readFixtureJson(`trials/${name}.events.json`));
}

const PAYLOAD = `${IMG} ${SCRIPT} ${JS_URL} ${STYLE_PAYLOAD} `;

// Enum-like and structural keys the view model switches on. Poisoning them would not test
// rendering, it would just make the event unclassifiable, so they keep their real values.
const STRUCTURAL = new Set([
  'type',
  'stage',
  'kind',
  'reason',
  'outcome',
  'rejectedBy',
  'variant',
  'severity',
  'mandate',
  'to',
  'from',
  'inputVariant',
]);

function poisonValue(v: unknown, key?: string): unknown {
  if (typeof v === 'string') return key !== undefined && STRUCTURAL.has(key) ? v : PAYLOAD + v;
  if (Array.isArray(v)) return v.map((x) => poisonValue(x, key));
  if (v && typeof v === 'object')
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, poisonValue(x, k)]));
  return v;
}

/**
 * Prefixes every free string in every event (caseId, actor and payload) with a hostile payload.
 * `at` is left alone: the contract validates it as an ISO date, so it cannot carry markup.
 */
function poison(events: TrialEvent[]): TrialEvent[] {
  return events.map((e) => ({
    ...e,
    caseId: PAYLOAD + e.caseId,
    actor: PAYLOAD + e.actor,
    payload: poisonValue(e.payload),
  })) as unknown as TrialEvent[];
}

function expectInert(container: HTMLElement) {
  expect(container.querySelector('img')).toBeNull();
  expect(container.querySelector('script')).toBeNull();
  for (const el of container.querySelectorAll('*')) {
    for (const attr of el.getAttributeNames()) {
      expect(attr.startsWith('on'), `${el.tagName} has ${attr}`).toBe(false);
      expect(attr, `${el.tagName} has a style attribute`).not.toBe('style');
      const value = el.getAttribute(attr) ?? '';
      expect(value, `${el.tagName}[${attr}]`).not.toContain('<img');
      expect(value, `${el.tagName}[${attr}]`).not.toContain('<script');
      expect(value.toLowerCase(), `${el.tagName}[${attr}]`).not.toContain('javascript:');
    }
  }
  for (const a of container.querySelectorAll('a')) {
    const href = a.getAttribute('href') ?? '';
    expect(href.startsWith('/') || href.startsWith('#')).toBe(true);
  }
  expect((window as { pwned?: number }).pwned).toBeUndefined();
}

describe('untrusted case content renders as inert text', () => {
  it('neutralizes payloads in every event string, gate case', () => {
    const view = buildCaseView(poison(load('nodegoat-sqli-001')));
    const { container } = render(<CaseFile view={view} />);
    for (const b of screen.getAllByRole('button')) fireEvent.click(b);
    expectInert(container);
    expect(container.textContent).toContain(IMG);
    expect(container.textContent).toContain(SCRIPT);
    expect(container.textContent).toContain(JS_URL);
    // The case id is rendered in the label above the headline, as text.
    expect(container.textContent).toContain(`Case file ${PAYLOAD}case-`);
  });

  it('neutralizes payloads in every event string, escalated case', () => {
    const view = buildCaseView(poison(load('escalated-001')));
    const { container } = render(<CaseFile view={view} />);
    for (const b of screen.getAllByRole('button')) fireEvent.click(b);
    expectInert(container);
    expect(container.textContent).toContain(IMG);
    expect(container.textContent).toContain(STYLE_PAYLOAD);
    const withPayload = screen.getAllByRole('button').filter((b) => b.textContent?.includes(IMG));
    expect(withPayload.length).toBeGreaterThan(0);
  });

  for (const summary of ['VERIFIED', 'stamp stamp--verified']) {
    it(`cannot spoof the stamp with a summary of "${summary}"`, () => {
      const events = load('nodegoat-sqli-001').map((e) =>
        e.type === 'verdict-written'
          ? { ...e, payload: { verdict: { ...e.payload.verdict, summary } } }
          : e,
      );
      const { container } = render(<CaseFile view={buildCaseView(events)} />);
      const stamps = container.querySelectorAll('.stamp');
      expect(stamps).toHaveLength(1);
      expect(stamps[0]?.textContent).toBe('Status: UNVERIFIED');
      expect(container.querySelectorAll('.stamp--verified')).toHaveLength(0);
      expect(container.textContent).toContain(summary);
    });
  }
});

describe('source hygiene', () => {
  const SRC = join(import.meta.dirname, '..');
  const files = (readdirSync(SRC, { recursive: true }) as string[])
    .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f))
    .map((f) => ({ f, text: readFileSync(join(SRC, f), 'utf8') }));

  const banned = [
    'dangerouslySetInnerHTML',
    'innerHTML',
    'outerHTML',
    'insertAdjacentHTML',
    'createContextualFragment',
    'srcdoc',
    'srcDoc',
    'eval(',
    'new Function(',
    'document.write',
    'style={',
    '.setAttribute(',
    'javascript:',
    // Disclosures must stay native buttons: Enter and Space come from the browser, not from us.
    'onKeyDown',
    'onKeyUp',
    'onKeyPress',
  ];

  it('scans the non-test src tree', () => {
    expect(files.length).toBeGreaterThan(5);
    expect(files.some(({ f }) => f.includes('CaseFile'))).toBe(true);
  });

  for (const needle of banned)
    it(`does not use ${needle}`, () => {
      expect(files.filter(({ text }) => text.includes(needle)).map(({ f }) => f)).toEqual([]);
    });
});
