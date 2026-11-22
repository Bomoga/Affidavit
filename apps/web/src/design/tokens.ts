// Case-file aesthetic: near-black ground, off-white type, one green accent,
// monospace labels. Every text pairing is checked against WCAG AA in tokens.test.ts.

export const TOKENS = {
  color: {
    bg: '#0b0d0c',
    surface: '#131615',
    text: '#e8e6e1',
    muted: '#9aa09b',
    accent: '#3ddc84',
    focus: '#3ddc84',
    warn: '#e0b04a',
    // Trial terminal (L3-13): data colors and one hue per agent. All are light enough to pass
    // AA as text on bg and surface; the two *-bg tokens are row grounds for diff lines.
    'term-amber': '#f5a623',
    'term-pos': '#5fd68a',
    'term-neg': '#ff7a6b',
    'term-cyan': '#62c6e8',
    'term-violet': '#b9a2f5',
    'term-yellow': '#e8d06a',
    'term-add-bg': '#10291b',
    'term-del-bg': '#321614',
  },
  font: {
    mono: "ui-monospace, 'SFMono-Regular', Menlo, Consolas, 'Liberation Mono', monospace",
    body: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  },
  stamp: {
    borderWidth: '1px',
  },
} as const;

/** CSS custom properties plus the reduced-motion rule every animated view must respect. */
export function toCssVariables(): string {
  const lines: string[] = [];
  for (const [name, value] of Object.entries(TOKENS.color))
    lines.push(`  --color-${name}: ${value};`);
  lines.push(`  --font-mono: ${TOKENS.font.mono};`);
  lines.push(`  --font-body: ${TOKENS.font.body};`);
  lines.push(`  --stamp-border-width: ${TOKENS.stamp.borderWidth};`);
  return [
    ':root {',
    ...lines,
    '}',
    '@media (prefers-reduced-motion: reduce) {',
    '  *, *::before, *::after {',
    '    animation-duration: 0.01ms !important;',
    '    animation-iteration-count: 1 !important;',
    '    transition-duration: 0.01ms !important;',
    '    scroll-behavior: auto !important;',
    '  }',
    '}',
  ].join('\n');
}
