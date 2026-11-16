import { describe, expect, it } from 'vitest';
import { contrastRatio } from './contrast.js';
import { TOKENS, toCssVariables } from './tokens.js';

const AA_TEXT = 4.5;
const AA_NON_TEXT = 3;

describe('contrastRatio', () => {
  it('returns 21 for black on white and 1 for identical colors', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#123456', '#123456')).toBeCloseTo(1, 5);
  });

  it('is symmetric', () => {
    expect(contrastRatio('#0b0d0c', '#3ddc84')).toBeCloseTo(
      contrastRatio('#3ddc84', '#0b0d0c'),
      10,
    );
  });

  it('rejects malformed colors', () => {
    expect(() => contrastRatio('green', '#000000')).toThrow();
  });
});

describe('case-file palette meets WCAG AA', () => {
  const bgs = [TOKENS.color.bg, TOKENS.color.surface] as const;

  it('keeps primary text readable on every background', () => {
    for (const bg of bgs)
      expect(contrastRatio(TOKENS.color.text, bg)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it('keeps muted text readable on every background', () => {
    for (const bg of bgs)
      expect(contrastRatio(TOKENS.color.muted, bg)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it('keeps the green accent readable as text on every background', () => {
    for (const bg of bgs)
      expect(contrastRatio(TOKENS.color.accent, bg)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it('keeps the stamp outline and focus ring visible as non-text UI', () => {
    for (const bg of bgs) {
      expect(contrastRatio(TOKENS.color.accent, bg)).toBeGreaterThanOrEqual(AA_NON_TEXT);
      expect(contrastRatio(TOKENS.color.focus, bg)).toBeGreaterThanOrEqual(AA_NON_TEXT);
    }
  });

  it('keeps the escalation color readable as text', () => {
    for (const bg of bgs)
      expect(contrastRatio(TOKENS.color.warn, bg)).toBeGreaterThanOrEqual(AA_TEXT);
  });
});

describe('case-file aesthetic', () => {
  it('uses a near-black background and off-white type', () => {
    expect(contrastRatio(TOKENS.color.bg, '#000000')).toBeLessThan(1.3);
    expect(contrastRatio(TOKENS.color.text, '#ffffff')).toBeLessThan(1.3);
  });

  it('uses a monospace stack for labels', () => {
    expect(TOKENS.font.mono).toMatch(/monospace/);
  });

  it('exposes every token as a CSS custom property and honors reduced motion', () => {
    const css = toCssVariables();
    expect(css).toContain('--color-bg:');
    expect(css).toContain('--color-accent:');
    expect(css).toContain('--font-mono:');
    expect(css).toContain('prefers-reduced-motion: reduce');
  });
});
