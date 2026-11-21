import { readFile, stat } from 'node:fs/promises';
import type {
  Exhibit,
  ExhibitResult,
  JudgePort,
  PatchExhibit,
  TargetVariant,
  VerifyResult,
  Witness,
} from '@affidavit/contracts';
import { openBundle, type ExhibitRecord, type OpenedBundle } from './bundle.js';
import { canonicalJson, sha256Hex } from './canonical.js';
import { BundleIntegrityError } from './errors.js';
import { DEFAULT_TAR_LIMITS } from './tar.js';

/** One field whose replayed value differs from the recorded one. */
export interface FieldDifference {
  field: string;
  recorded: unknown;
  replayed: unknown;
}

export type ExhibitReplay =
  | { exhibitId: string; kind: ExhibitRecord['kind']; status: 'match' }
  | {
      exhibitId: string;
      kind: ExhibitRecord['kind'];
      status: 'mismatch';
      differences: FieldDifference[];
    }
  /** The Judge threw (infrastructure failure). The outcome is unknown, so replay fails. */
  | { exhibitId: string; kind: ExhibitRecord['kind']; status: 'error'; message: string };

export type ReplayReport =
  | {
      ok: false;
      bundleSha256: string;
      integrity: { ok: false; exhibitId?: string; reason: string };
    }
  | {
      ok: boolean;
      bundleSha256: string;
      caseId: string;
      integrity: { ok: true };
      exhibits: ExhibitReplay[];
    };

/**
 * The fields that make up an admissibility outcome. Durations, run timings and output digests
 * are not compared: they differ between machines without the outcome changing.
 */
function exhibitOutcome(r: ExhibitResult): Record<string, unknown> {
  return {
    exhibitId: r.exhibitId,
    admissible: r.admissible,
    rejectedBy: r.rejectedBy ?? null,
    passed: r.passed,
    vulnPass: r.vulnPass,
    safeVariantFail: r.safeVariantFail ?? null,
    familyResults: r.familyResults ?? null,
    runs: r.runs.map((run) => ({ variant: run.variant, attempt: run.attempt, passed: run.passed })),
  };
}

function verifyOutcome(r: VerifyResult): Record<string, unknown> {
  return {
    patchExhibitId: r.patchExhibitId,
    familyFlipped: r.familyFlipped,
    suitePassed: r.suitePassed,
    rescanClean: r.rescanClean,
    rejectedBy: r.rejectedBy ?? null,
    counterexamples: r.counterexamples,
  };
}

function compare(
  recorded: Record<string, unknown>,
  replayed: Record<string, unknown>,
): FieldDifference[] {
  const out: FieldDifference[] = [];
  for (const field of Object.keys(recorded)) {
    if (canonicalJson(recorded[field]) !== canonicalJson(replayed[field])) {
      out.push({ field, recorded: recorded[field], replayed: replayed[field] });
    }
  }
  return out;
}

/** Variants a witness is replayed on: what the Judge would run anyway (it adds `safe` itself). */
function variantsFor(b: OpenedBundle): TargetVariant[] {
  return b.caseFile.safeVariant === undefined ? ['vulnerable'] : ['vulnerable', 'safe'];
}

async function replayOne(
  b: OpenedBundle,
  judge: JudgePort,
  id: string,
  r: ExhibitRecord,
): Promise<ExhibitReplay> {
  const witnessOf = (wid: string) => {
    const w = b.exhibits.get(wid);
    // openBundle already checked every reference, so this is a programming error.
    if (w?.kind !== 'witness') throw new Error(`no witness ${wid}`);
    return w.witness as unknown as Witness;
  };
  try {
    let differences: FieldDifference[];
    if (r.kind === 'witness') {
      const res = await judge.runWitness(
        b.caseFile,
        r.witness as unknown as Witness,
        variantsFor(b),
      );
      differences = compare(exhibitOutcome(r.result), exhibitOutcome(res));
    } else if (r.kind === 'counterexample') {
      const res = await judge.runCounterexample(
        b.caseFile,
        witnessOf(r.witnessExhibitId),
        r.counterexample as unknown as Exhibit,
      );
      differences = compare(exhibitOutcome(r.result), exhibitOutcome(res));
    } else {
      const counterexamples = r.counterexampleExhibitIds.map((cid) => {
        const c = b.exhibits.get(cid);
        if (c?.kind !== 'counterexample') throw new Error(`no counterexample ${cid}`);
        return c.counterexample as unknown as Exhibit;
      });
      const res = await judge.verifyPatch(
        b.caseFile,
        r.patch as unknown as PatchExhibit,
        witnessOf(r.witnessExhibitId),
        counterexamples,
      );
      differences = compare(verifyOutcome(r.result), verifyOutcome(res));
    }
    return differences.length === 0
      ? { exhibitId: id, kind: r.kind, status: 'match' }
      : { exhibitId: id, kind: r.kind, status: 'mismatch', differences };
  } catch (err) {
    return { exhibitId: id, kind: r.kind, status: 'error', message: (err as Error).message };
  }
}

export interface ReplayOptions {
  /**
   * A Judge whose executor boots targets from the case file's pinned `imageDigest` values. Replay
   * hands it the case file with the manifest's digests already set.
   */
  judge: JudgePort;
  /** When given, the bundle bytes must hash to this before anything else is read. */
  expectedSha256?: string;
}

/**
 * Checks a bundle's integrity, then reruns every exhibit through the Judge, one at a time in
 * manifest order, and compares the admissibility outcome with the recorded one. `ok` only when
 * integrity holds and every exhibit matches. Never throws on a bad bundle; the report says why.
 */
export async function replay(bytes: Uint8Array, opts: ReplayOptions): Promise<ReplayReport> {
  const checked = await checkIntegrity(bytes, opts.expectedSha256);
  if (!checked.ok) return checked.report;
  const b = checked.bundle;
  const exhibits: ExhibitReplay[] = [];
  for (const id of b.manifest.results) {
    const r = b.exhibits.get(id);
    if (r === undefined) throw new Error(`no exhibit ${id}`);
    exhibits.push(await replayOne(b, opts.judge, id, r));
  }
  return {
    ok: exhibits.every((e) => e.status === 'match'),
    bundleSha256: b.sha256,
    caseId: b.caseFile.id,
    integrity: { ok: true },
    exhibits,
  };
}

/** Opens the bundle; a failed check becomes a report instead of an exception. */
export async function checkIntegrity(
  bytes: Uint8Array,
  expectedSha256?: string,
): Promise<
  | { ok: true; bundle: OpenedBundle }
  | { ok: false; report: Extract<ReplayReport, { integrity: { ok: false } }> }
> {
  try {
    const bundle = await openBundle(bytes, expectedSha256 === undefined ? {} : { expectedSha256 });
    return { ok: true, bundle };
  } catch (err) {
    if (!(err instanceof BundleIntegrityError)) throw err;
    return {
      ok: false,
      report: {
        ok: false,
        bundleSha256: sha256Hex(bytes),
        integrity: {
          ok: false,
          ...(err.exhibitId === undefined ? {} : { exhibitId: err.exhibitId }),
          reason: err.reason,
        },
      },
    };
  }
}

/** Exit codes of `replayBundle`. */
export const REPLAY_EXIT = {
  /** Integrity holds and every exhibit replayed to the recorded outcome. */
  MATCH: 0,
  /** Tampered bundle, a different outcome, or a Judge failure. */
  FAILED: 1,
  /** Integrity holds, but nothing was rerun because no sandbox Judge was given. */
  NOT_RERUN: 2,
} as const;

export interface ReplayBundleOptions {
  /** Without a Judge only integrity is checked, and the exit code is `NOT_RERUN`, never success. */
  judge?: JudgePort;
  out?: (line: string) => void;
}

/** Plain-text lines for a report. */
export function renderReport(report: ReplayReport): string[] {
  const lines = [`bundle sha256:${report.bundleSha256}`];
  if (!report.integrity.ok) {
    const who =
      report.integrity.exhibitId === undefined ? '' : ` (exhibit ${report.integrity.exhibitId})`;
    lines.push(`integrity: FAILED${who}: ${report.integrity.reason}`);
    return lines;
  }
  lines.push('integrity: ok');
  if ('exhibits' in report) {
    for (const e of report.exhibits) {
      if (e.status === 'match') lines.push(`  ${e.exhibitId} (${e.kind}): same outcome`);
      else if (e.status === 'error') lines.push(`  ${e.exhibitId} (${e.kind}): ERROR ${e.message}`);
      else {
        const fields = e.differences
          .map(
            (d) =>
              `${d.field} recorded ${canonicalJson(d.recorded)} replayed ${canonicalJson(d.replayed)}`,
          )
          .join('; ');
        lines.push(`  ${e.exhibitId} (${e.kind}): DIFFERENT ${fields}`);
      }
    }
    lines.push(report.ok ? 'replay: same outcomes' : 'replay: FAILED');
  }
  return lines;
}

/**
 * Entry point for `affidavit replay <bundle>` (apps/cli). Reads the bundle file, checks it, and
 * reruns it when a Judge is given. Returns an exit code from `REPLAY_EXIT`.
 */
export async function replayBundle(path: string, opts: ReplayBundleOptions = {}): Promise<number> {
  const out = opts.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  const st = await stat(path);
  if (!st.isFile() || st.size > DEFAULT_TAR_LIMITS.maxTotalBytes) {
    out(`${path} is not a bundle file within the size limit`);
    return REPLAY_EXIT.FAILED;
  }
  const bytes = new Uint8Array(await readFile(path));
  if (opts.judge === undefined) {
    const checked = await checkIntegrity(bytes);
    if (!checked.ok) {
      for (const l of renderReport(checked.report)) out(l);
      return REPLAY_EXIT.FAILED;
    }
    for (const l of renderReport({
      ok: true,
      bundleSha256: checked.bundle.sha256,
      caseId: checked.bundle.caseFile.id,
      integrity: { ok: true },
      exhibits: [],
    }).slice(0, 2)) {
      out(l);
    }
    out(
      `not rerun: ${checked.bundle.exhibits.size} exhibit(s) need a sandbox host Judge to replay`,
    );
    return REPLAY_EXIT.NOT_RERUN;
  }
  const report = await replay(bytes, { judge: opts.judge });
  for (const l of renderReport(report)) out(l);
  return report.ok ? REPLAY_EXIT.MATCH : REPLAY_EXIT.FAILED;
}
