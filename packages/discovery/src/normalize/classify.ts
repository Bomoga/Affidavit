import type { VulnClass } from '@affidavit/contracts';

/** CWE numbers that map to the `injection` class (SQL, NoSQL, command and code injection). */
export const INJECTION_CWES: ReadonlySet<number> = new Set([
  74, 77, 78, 89, 90, 91, 94, 95, 564, 643, 917, 943,
]);

/** CWE numbers that map to the `idor` class (user-controlled key, missing object authorization). */
export const IDOR_CWES: ReadonlySet<number> = new Set([284, 285, 566, 639, 862, 863]);

// Matches "CWE-89", "CWE-89: title", "CWE_089" and "external/cwe/cwe-089", never a digit run that
// merely follows other text.
const CWE = /(?:^|\/)cwe[-_]0*(\d{1,5})(?!\d)/i;

/** The CWE number named by one tag or id string, or undefined. */
export function cweNumber(tag: string): number | undefined {
  const m = CWE.exec(tag.trim());
  return m?.[1] === undefined ? undefined : Number(m[1]);
}

/** Sorted, de-duplicated CWE numbers named by a list of tags. */
export function cweNumbers(tags: readonly string[]): number[] {
  const set = new Set<number>();
  for (const t of tags) {
    const n = cweNumber(t);
    if (n !== undefined) set.add(n);
  }
  return [...set].sort((a, b) => a - b);
}

/**
 * Maps CWE numbers to a vulnerability class. Injection wins when both appear, so the choice does
 * not depend on tag order. Undefined means the finding is outside the MVP classes.
 */
export function classOf(cwes: readonly number[]): VulnClass | undefined {
  if (cwes.some((n) => INJECTION_CWES.has(n))) return 'injection';
  if (cwes.some((n) => IDOR_CWES.has(n))) return 'idor';
  return undefined;
}
