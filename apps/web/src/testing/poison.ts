import type { TrialEvent } from '@affidavit/contracts';
import { expect } from 'vitest';

// Built from parts so the source hygiene scan (which bans that literal in app code) stays simple.
const JS = 'java' + 'script:';
export const IMG = '<img src=x onerror=alert(1)>';
export const SCRIPT = '<script>window.pwned=1</script>';
export const JS_URL = `${JS}alert(1)`;
export const STYLE_PAYLOAD = `"><a href="${JS}alert(2)" style="position:fixed">`;
export const PAYLOAD = `${IMG} ${SCRIPT} ${JS_URL} ${STYLE_PAYLOAD} `;

// Keys the contract constrains (enums, hashes) or the view switches on. Poisoning them would only
// make a streamed event fail schema parsing, which is a different test.
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
  'question',
  'vote',
  'actor',
  'stdoutSha256',
  'stderrSha256',
  'sha256',
  'bundleSha256',
  'model',
]);

function poisonValue(v: unknown, key?: string): unknown {
  if (typeof v === 'string') return key !== undefined && STRUCTURAL.has(key) ? v : PAYLOAD + v;
  if (Array.isArray(v)) return v.map((x) => poisonValue(x, key));
  if (v && typeof v === 'object')
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, poisonValue(x, k)]));
  return v;
}

/**
 * Prefixes the free strings in every event payload with a hostile payload. The case id is left
 * alone because a streamed event for another case is dropped by design.
 */
export function poisonPayloads(events: readonly TrialEvent[]): TrialEvent[] {
  return events.map((e) => ({ ...e, payload: poisonValue(e.payload) })) as unknown as TrialEvent[];
}

export function expectInert(container: HTMLElement): void {
  expect(container.querySelector('img')).toBeNull();
  expect(container.querySelector('script')).toBeNull();
  for (const el of container.querySelectorAll('*')) {
    for (const attr of el.getAttributeNames()) {
      expect(attr.startsWith('on'), `${el.tagName} has ${attr}`).toBe(false);
      expect(attr, `${el.tagName} has a style attribute`).not.toBe('style');
      const value = (el.getAttribute(attr) ?? '').toLowerCase();
      expect(value, `${el.tagName}[${attr}]`).not.toContain('<img');
      expect(value, `${el.tagName}[${attr}]`).not.toContain('<script');
      expect(value, `${el.tagName}[${attr}]`).not.toContain(JS);
    }
  }
  for (const a of container.querySelectorAll('a')) {
    const href = a.getAttribute('href') ?? '';
    expect(href.startsWith('/') || href.startsWith('#')).toBe(true);
  }
  expect((window as { pwned?: number }).pwned).toBeUndefined();
}
