import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from './manifest.js';
import { MatchBoundSyntaxError, maxMatchBytes } from './matchbound.js';
import { OVERLAP_BYTES } from './windows.js';
import { ANALYZED_GITLEAKS_CONFIG_SHA256, configSha256, GATES, PROOF_CAPS } from './windowproof.js';

const caps = { line: 100, ws: 10 };
const INF = Number.POSITIVE_INFINITY;

describe('maxMatchBytes', () => {
  it.each([
    ['abc', 3],
    ['a|bcd', 3],
    ['(?:ab){2,3}', 6],
    ['[a-z]{32}', 32],
    ['[a-z]+', 100], // one line at most
    ['.*', 100], // `.` does not match a newline
    ['a.*b.*c', 100], // still one line
    ['\\s+', 10], // a whitespace run
    ['[\\r\\n]{1,2}', 2],
    ['[ \\t]*x[ \\t]*', 21],
    ['a\\s*b', 12],
    ['(?s:.){0,200}', 800], // bounded, 4 bytes a character
    ['x(?s:.){0,10}?y', 42],
    ['\\b(?:a|b)\\b$', 1],
    ['é', 2],
    ['\\x{1F600}', 4],
    ['(?P<n>ab)c', 3],
    ['[^\\n]+', 100], // a negated class that excludes the newline stays on one line
    ['[[:alpha:]]+', 100],
  ])('%s is at most %d bytes', (pattern, bound) => {
    expect(maxMatchBytes(pattern, caps)).toBe(bound);
  });

  it.each([
    '[^"]+', // a negated class matches a newline
    '(?s).*', // dot-all, unbounded
    '(?s:.)+',
    '[\\s\\S]+',
    '[a-z\\n]{40,}',
    '\\W+',
    '\\D+',
    '\\p{L}+', // unknown to the analysis: assumed to match a newline
    '(?:a\\s)+', // a newline-capable group repeated without bound
  ])('%s has no bound', (pattern) => {
    expect(maxMatchBytes(pattern, caps)).toBe(INF);
  });

  it('a flag group applies to the rest of its group only', () => {
    expect(maxMatchBytes('(?:(?s).)a.', caps)).toBe(9); // 4 + 1 + 4, on one line or not
    expect(maxMatchBytes('(?:(?s).*)', caps)).toBe(INF);
    expect(maxMatchBytes('(?:(?s)x).*', caps)).toBe(100);
  });

  it.each(['(abc', 'abc)', '[abc', '\\', '*a', '\\8', '\\C', '(?#comment)', '[[:nope:]]'])(
    'throws on what it does not understand: %s',
    (pattern) => {
      expect(() => maxMatchBytes(pattern, caps)).toThrow(MatchBoundSyntaxError);
    },
  );
});

/** Rule id and regex of every rule in the vendored config, in file order. */
function vendoredRules(): { id: string; regex: string }[] {
  const text = readFileSync(join(repoRoot(), 'docker', 'tools', 'config', 'gitleaks.toml'), 'utf8');
  const rules: { id: string; regex: string }[] = [];
  let id = '';
  let regexLines = 0;
  for (const line of text.split(/\r?\n/)) {
    const m = /^id = "([^"]+)"$/.exec(line);
    if (m) id = m[1] as string;
    if (/^\s*regex\s*=/.test(line)) {
      regexLines++;
      const r = /^regex = '''(.*)'''$/.exec(line);
      if (r) rules.push({ id, regex: r[1] as string });
    }
  }
  // every rule regex is in the one form read here, so none is missed
  expect(rules.length).toBe(regexLines);
  return rules;
}

describe('the analyzed gitleaks config', () => {
  it('is the vendored file (update the constant only with this analysis)', () => {
    const text = readFileSync(
      join(repoRoot(), 'docker', 'tools', 'config', 'gitleaks.toml'),
      'utf8',
    );
    expect(configSha256(text)).toBe(ANALYZED_GITLEAKS_CONFIG_SHA256);
  });

  it('every rule match fits in the window overlap under the caps, or is gated by a word', () => {
    const rules = vendoredRules();
    expect(rules.length).toBeGreaterThan(200);
    const gated = new Map(GATES.flatMap((g) => g.rules.map((r) => [r, g] as const)));
    const unbounded: string[] = [];
    for (const rule of rules) {
      const bound = maxMatchBytes(rule.regex, PROOF_CAPS);
      if (bound <= OVERLAP_BYTES) continue;
      unbounded.push(rule.id);
      const gate = gated.get(rule.id);
      expect(gate, `${rule.id} can match ${bound} bytes and has no gate`).toBeDefined();
      // The regex starts with the gate's prefix, which spells the word, so no match exists in a
      // file without the word.
      expect(rule.regex.startsWith(gate?.prefix ?? '\0'), rule.id).toBe(true);
      const prefix = gate?.prefix ?? '';
      const spelled = gate?.caseInsensitive ? prefix.toLowerCase() : prefix;
      expect(
        spelled.includes(gate?.caseInsensitive ? gate.word.toLowerCase() : (gate?.word ?? '\0')),
      ).toBe(true);
    }
    // every gate is used: a stale gate would hide that a rule changed
    expect(unbounded.sort()).toEqual([...gated.keys()].sort());
  });

  it('the case-sensitive gates are case-sensitive in the regex (no flag before the word)', () => {
    for (const g of GATES.filter((x) => !x.caseInsensitive)) {
      expect(g.prefix.includes('(?')).toBe(false);
    }
  });

  it('a case-insensitive gate word has no letter Go folds to a non-ASCII character (k, s)', () => {
    for (const g of GATES.filter((x) => x.caseInsensitive)) {
      expect(/[ks]/i.test(g.word), g.word).toBe(false);
    }
  });

  it('lines this short keep every window cut on a line boundary', () => {
    // windows.ts aligns a cut to a line start when one lies within 20,000 bytes, and a window
    // end when the last newline is at least 70,000 bytes in (of 90,000)
    expect(PROOF_CAPS.line).toBeLessThan(20_000);
  });
});
