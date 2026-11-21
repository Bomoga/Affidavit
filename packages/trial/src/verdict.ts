import { Verdict, type PromptId, type Severity, type StageCost } from '@affidavit/contracts';
import type { ExhibitId } from '@affidavit/contracts';

export type StructuredVerdict = Omit<Verdict, 'summary'>;
export type VerdictOutcome = Verdict['outcome'];

const EM_DASH = '—';
// A standalone number: not part of a word, a hex string, or an id.
const NUMBER = /(?<![\w.])\d+(?:\.\d+)?(?!\w)/g;
const EXHIBIT_PREFIX = /^exhibit-/;

export interface VerdictInput {
  caseId: Verdict['caseId'];
  outcome: VerdictOutcome;
  severity?: Severity;
  exhibits: readonly ExhibitId[];
  promptVersions: Partial<Record<PromptId, string>>;
  modelIds: Partial<Record<PromptId, string>>;
  cost: readonly StageCost[];
  ballots?: Verdict['ballots'];
  jurorCorrelation?: number;
  bundleSha256?: string;
}

/** Step one: the structured verdict. The summary is generated from this and never the reverse. */
export function buildVerdict(input: VerdictInput): StructuredVerdict {
  return {
    schemaVersion: 1,
    caseId: input.caseId,
    outcome: input.outcome,
    ...(input.severity === undefined ? {} : { severity: input.severity }),
    exhibits: [...input.exhibits],
    ballots: input.ballots ?? [],
    ...(input.jurorCorrelation === undefined ? {} : { jurorCorrelation: input.jurorCorrelation }),
    ...(input.bundleSha256 === undefined ? {} : { bundleSha256: input.bundleSha256 }),
    promptVersions: { ...input.promptVersions },
    modelIds: { ...input.modelIds },
    cost: input.cost.map((c) => ({ ...c })),
  };
}

/** Outcome from Judge-derived facts only. */
export function decideOutcome(facts: {
  patchAccepted: boolean;
  appealsExhausted?: boolean;
}): VerdictOutcome {
  if (facts.patchAccepted) return 'proven-fixed';
  return facts.appealsExhausted ? 'not-proven' : 'proven-unfixed';
}

const OUTCOME_TEXT: Record<VerdictOutcome, string> = {
  'proven-fixed':
    'A security weakness was proven with an exploit that can be replayed, and a fix was shown to stop it.',
  'proven-unfixed':
    'A security weakness was proven with an exploit that can be replayed. No fix has been proven yet.',
  'not-proven': 'The claim was not proven to the standard of evidence this system requires.',
  dismissed:
    'No admissible proof was found, and the finding was weak enough to close without human review.',
  escalated: 'This finding needs a human reviewer before anything is concluded.',
};

/**
 * The shortest decimal that round-trips to exactly `n` (what `String(n)` gives), written without
 * an exponent. `Number(plainDecimal(n)) === n` for every finite non-negative n, so the number the
 * summary prints is the number `checkSummary` finds in the verdict.
 */
export function plainDecimal(n: number): string {
  const s = String(n);
  const m = /^(\d+)(?:\.(\d+))?e([+-]\d+)$/.exec(s);
  if (!m) return s;
  const digits = `${m[1]}${m[2] ?? ''}`;
  const point = m[1]!.length + Number(m[3]);
  if (point <= 0) return `0.${'0'.repeat(-point)}${digits}`;
  if (point >= digits.length) return digits + '0'.repeat(point - digits.length);
  return `${digits.slice(0, point)}.${digits.slice(point)}`;
}

/**
 * Plain-language summary. Every number and exhibit id it prints is copied from the
 * structured verdict as given; nothing is counted, summed, or rounded here.
 */
export function renderSummary(v: StructuredVerdict): string {
  const lines = [`Case ${v.caseId}: ${OUTCOME_TEXT[v.outcome]}`];
  if (v.severity) lines.push(`Severity: ${v.severity}.`);
  if (v.exhibits.length > 0) lines.push(`Evidence cited: ${v.exhibits.join(', ')}.`);
  if (v.cost.length > 0) {
    const rows = v.cost.map((c) => `${c.stage} attempt ${c.attempt} $${plainDecimal(c.usd)}`);
    lines.push(`Recorded cost by stage: ${rows.join('; ')}.`);
  }
  return lines.join(' ');
}

/** Rule for generated text: no em dashes. */
export function lintGeneratedText(text: string): string[] {
  return text.includes(EM_DASH) ? ['generated text contains an em dash'] : [];
}

function allowedNumbers(v: StructuredVerdict): Set<number> {
  const out = new Set<number>();
  const walk = (value: unknown): void => {
    if (typeof value === 'number') out.add(value);
    else if (typeof value === 'string') {
      for (const m of value.matchAll(NUMBER)) out.add(Number(m[0]));
    } else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(v);
  return out;
}

/** Violations of the summary rules: unknown numbers, unknown exhibit ids, em dashes. */
export function checkSummary(v: Verdict): string[] {
  const { summary, ...structured } = v;
  const problems = lintGeneratedText(summary);

  const numbers = allowedNumbers(structured);
  for (const m of summary.matchAll(NUMBER)) {
    if (!numbers.has(Number(m[0]))) problems.push(`summary has number ${m[0]} not in the verdict`);
  }
  for (const id of exhibitIdsIn(summary, structured.exhibits)) {
    if (!structured.exhibits.includes(id as ExhibitId)) {
      problems.push(`summary has exhibit id ${id} not in the verdict`);
    }
  }
  return problems;
}

/** Id family of an exhibit id: everything up to its last separator, e.g. `exhibit-witness-`. */
function familyOf(id: string): string {
  const cut = Math.max(id.lastIndexOf('-'), id.lastIndexOf('_'));
  return cut > 0 ? id.slice(0, cut + 1) : id;
}

/**
 * Tokens in the summary that read as exhibit ids: anything starting `exhibit-`, plus anything in
 * the same id family as an id the verdict actually cites. Checked against the verdict's own list,
 * not a hard-coded pattern, so a near-miss of a real id is caught too.
 */
function exhibitIdsIn(summary: string, cited: readonly string[]): string[] {
  const families = new Set(cited.map(familyOf));
  const tokens = summary
    .split(/[\s,;()[\]]+/)
    .map((t) => t.replace(/[.:]+$/, ''))
    .filter((t) => t.length > 0);
  return tokens.filter(
    (t) => EXHIBIT_PREFIX.test(t) || [...families].some((f) => f !== t && t.startsWith(f)),
  );
}

/** Step two: attach the summary, refuse anything that breaks the rules, and validate the contract. */
export function finalizeVerdict(
  structured: StructuredVerdict,
  opts: { summaryOverride?: string } = {},
): Verdict {
  const verdict = Verdict.parse({
    ...structured,
    summary: opts.summaryOverride ?? renderSummary(structured),
  });
  const problems = checkSummary(verdict);
  if (problems.length > 0) throw new Error(`verdict summary rejected: ${problems.join('; ')}`);
  return verdict;
}
