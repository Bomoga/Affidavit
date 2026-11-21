import { z } from 'zod';
import {
  BundleManifest,
  CaseFile,
  ExhibitId,
  ExhibitResult,
  VerifyResult,
  Verdict,
} from '@affidavit/contracts';
import type { EvidenceStore, TargetVariant } from '@affidavit/contracts';
import { canonicalBytes, sha256Hex } from './canonical.js';
import { BundleIntegrityError, EvidenceCorruptError } from './errors.js';
import { DEFAULT_TAR_LIMITS, readTar, writeTar, type TarLimits } from './tar.js';

/** Version of the bundle layout below, recorded in `toolVersions` under `BUNDLE_FORMAT_KEY`. */
export const BUNDLE_FORMAT_VERSION = '1';
export const BUNDLE_FORMAT_KEY = 'affidavit-bundle';

export const MANIFEST_PATH = 'manifest.json';
export const CASEFILE_PATH = 'casefile.json';
export const VERDICT_PATH = 'verdict.json';
/** Manifest `exhibits` id of the case file entry. Not a valid minted exhibit id, so no clash. */
export const CASEFILE_ENTRY_ID = 'casefile';

/** Exhibit ids become file names, so they must be safe ones. Minted ids always are. */
const FILE_SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

/** Most egress entries one record may carry (50 per run, many runs for a patch). */
export const MAX_EGRESS_ENTRIES = 4096;

/**
 * One attempt to reach outside the jail during one run of the exhibit (L2-11), as the Judge's
 * `EgressRecorder` hands it over: what gVisor recorded, never the jailed command's name. A record,
 * not a rule: admissibility comes from `result.egressAttempts` and the trace check.
 */
export const EgressEntry = z.object({
  variant: z.enum(['vulnerable', 'safe', 'patched']),
  attempt: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  syscall: z.enum(['connect', 'sendto', 'sendmsg', 'sendmmsg']),
  family: z.enum(['ipv4', 'ipv6']),
  address: z.string().min(1).max(45),
  port: z.int().min(0).max(65535).nullable(),
  outcome: z.enum(['blocked', 'sent']),
  errno: z.int().min(1).nullable(),
  dns: z.boolean(),
});
export type EgressEntry = z.infer<typeof EgressEntry>;
const EgressLog = z.array(EgressEntry).max(MAX_EGRESS_ENTRIES).optional();

/**
 * One exhibit as the Judge saw it: what was submitted, exactly as submitted (it may be malformed,
 * and replay must reach the same rejection), and the result the Judge recorded. A counterexample
 * and a patch name the witness exhibit they ran against, so replay can call the Judge the same way.
 */
export const WitnessRecord = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('witness'),
  witness: z.json(),
  result: ExhibitResult,
  /** Absent in bundles built before L2-11 or without a recorder; `[]` means nothing tried. */
  egress: EgressLog,
});
export const CounterexampleRecord = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('counterexample'),
  witnessExhibitId: ExhibitId,
  counterexample: z.json(),
  result: ExhibitResult,
  /** Absent in bundles built before L2-11 or without a recorder; `[]` means nothing tried. */
  egress: EgressLog,
});
export const PatchRecord = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('patch'),
  witnessExhibitId: ExhibitId,
  counterexampleExhibitIds: z.array(ExhibitId),
  patch: z.json(),
  result: VerifyResult,
  /** Absent in bundles built before L2-11 or without a recorder; `[]` means nothing tried. */
  egress: EgressLog,
});
export const ExhibitRecord = z.discriminatedUnion('kind', [
  WitnessRecord,
  CounterexampleRecord,
  PatchRecord,
]);
export type WitnessRecord = z.infer<typeof WitnessRecord>;
export type CounterexampleRecord = z.infer<typeof CounterexampleRecord>;
export type PatchRecord = z.infer<typeof PatchRecord>;
export type ExhibitRecord = z.infer<typeof ExhibitRecord>;

/** The exhibit id a record is filed under: the id the Judge minted for its result. */
export function recordId(r: ExhibitRecord): ExhibitId {
  return r.kind === 'patch' ? r.result.patchExhibitId : r.result.exhibitId;
}

export interface BundleInput {
  caseFile: CaseFile;
  /**
   * The verdict the bundle backs. Its `bundleSha256` cannot be inside the bundle it names, so it
   * is dropped before hashing; `verdictSha256` covers every other field.
   */
  verdict: Verdict;
  exhibits: readonly ExhibitRecord[];
  /** Versions of the tools that produced the evidence (runner image, Judge, scanners). */
  toolVersions: Readonly<Record<string, string>>;
  createdAt: string;
}

export interface Bundle {
  manifest: BundleManifest;
  /** The tar. Its SHA-256 is the bundle's address and the value a verdict's `bundleSha256` takes. */
  bytes: Uint8Array;
  sha256: string;
}

/** A bundle that passed every integrity check, ready to replay. */
export interface OpenedBundle {
  manifest: BundleManifest;
  sha256: string;
  /** The case file with each variant's `imageDigest` set from the manifest's pinned digests. */
  caseFile: CaseFile;
  verdict: Verdict;
  /** Keyed by exhibit id, in manifest order. */
  exhibits: ReadonlyMap<string, ExhibitRecord>;
}

/** `sha256:<64 hex>`; contracts exports the schema but not a type for it. */
type ImageDigest = string;

const exhibitPath = (id: string) => `exhibits/${id}.json`;

function withoutBundleSha(v: Verdict): Verdict {
  const rest = { ...v };
  delete rest.bundleSha256;
  return rest;
}

/** The variants a case file pins, with the digest each one runs from. */
function pinnedDigests(cf: CaseFile): Partial<Record<TargetVariant, ImageDigest>> {
  const out: Partial<Record<TargetVariant, ImageDigest>> = {};
  if (cf.target.imageDigest === undefined) {
    throw new Error('the vulnerable target has no image digest; a bundle must pin every target');
  }
  out.vulnerable = cf.target.imageDigest;
  if (cf.safeVariant !== undefined) {
    if (cf.safeVariant.imageDigest === undefined) {
      throw new Error('the safe variant has no image digest; a bundle must pin every target');
    }
    out.safe = cf.safeVariant.imageDigest;
  }
  return out;
}

/**
 * An egress log must fit its record: no more entries than the result counted (a witness or
 * counterexample), and only variants that kind of exhibit runs on.
 */
function checkEgressLog(id: string, r: ExhibitRecord): void {
  if (r.egress === undefined) return;
  const allowed = r.kind === 'patch' ? ['vulnerable', 'patched'] : ['vulnerable', 'safe'];
  if (r.egress.some((e) => !allowed.includes(e.variant))) {
    throw new BundleIntegrityError(id, 'egress log names a variant this exhibit never runs on');
  }
  if (r.kind !== 'patch' && r.egress.length > r.result.egressAttempts) {
    throw new BundleIntegrityError(id, 'egress log lists more attempts than the result counted');
  }
}

/** Checks that every reference between records resolves to the right kind of record. */
function checkReferences(records: ReadonlyMap<string, ExhibitRecord>): void {
  const expectKind = (from: string, id: string, kind: ExhibitRecord['kind']) => {
    if (records.get(id)?.kind !== kind) {
      throw new BundleIntegrityError(
        from,
        `refers to ${id}, which is not a ${kind} in this bundle`,
      );
    }
  };
  for (const [id, r] of records) {
    checkEgressLog(id, r);
    if (r.kind === 'counterexample') expectKind(id, r.witnessExhibitId, 'witness');
    if (r.kind === 'patch') {
      expectKind(id, r.witnessExhibitId, 'witness');
      for (const c of r.counterexampleExhibitIds) expectKind(id, c, 'counterexample');
    }
  }
}

/**
 * Builds a deterministic bundle: the same evidence always gives the same bytes. Throws on input
 * that could not replay (an unpinned target, a verdict citing an exhibit that is not included,
 * a dangling reference), because a bundle that cannot be checked is worse than none.
 */
export async function buildBundle(input: BundleInput): Promise<Bundle> {
  const caseFile = CaseFile.parse(input.caseFile);
  const verdict = withoutBundleSha(Verdict.parse(input.verdict));
  if (verdict.caseId !== caseFile.id) throw new Error('the verdict belongs to another case');
  if (BUNDLE_FORMAT_KEY in input.toolVersions) {
    throw new Error(`toolVersions may not set ${BUNDLE_FORMAT_KEY}`);
  }

  const records = new Map<string, ExhibitRecord>();
  for (const raw of input.exhibits) {
    const r = ExhibitRecord.parse(raw);
    const id = recordId(r);
    if (!FILE_SAFE_ID.test(id) || id === CASEFILE_ENTRY_ID) {
      throw new Error(`exhibit id ${JSON.stringify(id)} cannot be filed in a bundle`);
    }
    if (records.has(id)) throw new Error(`exhibit ${id} is included twice`);
    records.set(id, r);
  }
  checkReferences(records);
  for (const id of verdict.exhibits) {
    if (!records.has(id)) throw new Error(`the verdict cites ${id}, which is not in the bundle`);
  }

  const files: { name: string; bytes: Uint8Array }[] = [];
  const entries: BundleManifest['exhibits'] = [];
  const caseBytes = canonicalBytes(caseFile);
  files.push({ name: CASEFILE_PATH, bytes: caseBytes });
  entries.push({
    id: CASEFILE_ENTRY_ID as ExhibitId,
    sha256: sha256Hex(caseBytes),
    path: CASEFILE_PATH,
  });
  for (const [id, r] of records) {
    const bytes = canonicalBytes(r);
    files.push({ name: exhibitPath(id), bytes });
    entries.push({ id: id as ExhibitId, sha256: sha256Hex(bytes), path: exhibitPath(id) });
  }
  const verdictBytes = canonicalBytes(verdict);
  files.push({ name: VERDICT_PATH, bytes: verdictBytes });

  const manifest = BundleManifest.parse({
    schemaVersion: 1,
    caseId: caseFile.id,
    createdAt: input.createdAt,
    targetDigests: pinnedDigests(caseFile),
    exhibits: entries,
    results: [...records.keys()],
    verdictSha256: sha256Hex(verdictBytes),
    toolVersions: { ...input.toolVersions, [BUNDLE_FORMAT_KEY]: BUNDLE_FORMAT_VERSION },
  });
  files.push({ name: MANIFEST_PATH, bytes: canonicalBytes(manifest) });

  const bytes = await writeTar(files);
  return { manifest, bytes, sha256: sha256Hex(bytes) };
}

function parseJson(id: string, bytes: Uint8Array): unknown {
  try {
    return JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown;
  } catch {
    throw new BundleIntegrityError(id, 'is not valid JSON');
  }
}

function parseAs<T>(id: string, schema: z.ZodType<T>, bytes: Uint8Array): T {
  const parsed = schema.safeParse(parseJson(id, bytes));
  if (!parsed.success) throw new BundleIntegrityError(id, 'does not match its schema');
  return parsed.data;
}

/**
 * Opens a bundle and checks it before anything runs. Every file listed in the manifest must be
 * present and hash to the manifest's digest; every file present must be listed; the verdict must
 * hash to `verdictSha256`; the case file must agree with the pinned digests; every result the
 * manifest lists must belong to an exhibit, and every exhibit must be listed. The first failure
 * throws `BundleIntegrityError` naming the exhibit.
 *
 * The manifest itself is covered by the bundle digest (`expectedSha256`) and, from L2-09, by the
 * signed attestation, not by anything inside the bundle.
 */
export async function openBundle(
  bytes: Uint8Array,
  opts: { expectedSha256?: string; limits?: Readonly<TarLimits> } = {},
): Promise<OpenedBundle> {
  const sha256 = sha256Hex(bytes);
  if (opts.expectedSha256 !== undefined && opts.expectedSha256 !== sha256) {
    throw new BundleIntegrityError(
      MANIFEST_PATH,
      'the bundle does not hash to the expected digest',
    );
  }
  const files = await readTar(bytes, opts.limits ?? DEFAULT_TAR_LIMITS);
  const manifestBytes = files.get(MANIFEST_PATH);
  if (manifestBytes === undefined) throw new BundleIntegrityError('manifest', 'is missing');
  const manifest = parseAs('manifest', BundleManifest, manifestBytes);
  if (manifest.toolVersions[BUNDLE_FORMAT_KEY] !== BUNDLE_FORMAT_VERSION) {
    throw new BundleIntegrityError('manifest', 'has an unknown bundle format version');
  }

  const unlisted = new Set(files.keys());
  unlisted.delete(MANIFEST_PATH);
  unlisted.delete(VERDICT_PATH);
  const seenIds = new Set<string>();
  const byId = new Map<string, Uint8Array>();
  for (const e of manifest.exhibits) {
    if (seenIds.has(e.id)) throw new BundleIntegrityError(e.id, 'is listed twice');
    seenIds.add(e.id);
    const expectedPath = e.id === CASEFILE_ENTRY_ID ? CASEFILE_PATH : exhibitPath(e.id);
    if (!FILE_SAFE_ID.test(e.id) || e.path !== expectedPath) {
      throw new BundleIntegrityError(e.id, 'is filed under the wrong path');
    }
    const content = files.get(e.path);
    if (content === undefined) throw new BundleIntegrityError(e.id, 'is missing from the bundle');
    if (sha256Hex(content) !== e.sha256) {
      throw new BundleIntegrityError(e.id, 'bytes do not match the manifest digest');
    }
    unlisted.delete(e.path);
    byId.set(e.id, content);
  }
  const extra = [...unlisted][0];
  if (extra !== undefined) {
    throw new BundleIntegrityError(undefined, `${extra} is in the bundle but not in the manifest`);
  }

  const verdictBytes = files.get(VERDICT_PATH);
  if (verdictBytes === undefined) throw new BundleIntegrityError('verdict', 'is missing');
  if (sha256Hex(verdictBytes) !== manifest.verdictSha256) {
    throw new BundleIntegrityError('verdict', 'bytes do not match the manifest digest');
  }
  const verdict = parseAs('verdict', Verdict, verdictBytes);

  const caseBytes = byId.get(CASEFILE_ENTRY_ID);
  if (caseBytes === undefined) throw new BundleIntegrityError(CASEFILE_ENTRY_ID, 'is missing');
  byId.delete(CASEFILE_ENTRY_ID);
  const caseFile = pinCaseFile(manifest, parseAs(CASEFILE_ENTRY_ID, CaseFile, caseBytes));
  if (manifest.caseId !== caseFile.id || verdict.caseId !== caseFile.id) {
    throw new BundleIntegrityError(
      CASEFILE_ENTRY_ID,
      'belongs to another case than the manifest or verdict',
    );
  }

  const exhibits = new Map<string, ExhibitRecord>();
  for (const [id, content] of byId) {
    const r = parseAs(id, ExhibitRecord, content);
    if (recordId(r) !== id)
      throw new BundleIntegrityError(id, 'holds the result of another exhibit');
    exhibits.set(id, r);
  }
  checkReferences(exhibits);
  const results = new Set<string>(manifest.results);
  if (results.size !== manifest.results.length) {
    throw new BundleIntegrityError('manifest', 'lists a result twice');
  }
  for (const id of results) {
    if (!exhibits.has(id)) throw new BundleIntegrityError(id, 'has a listed result but no exhibit');
  }
  for (const id of exhibits.keys()) {
    if (!results.has(id))
      throw new BundleIntegrityError(id, 'is not listed among the results to replay');
  }
  for (const id of verdict.exhibits) {
    if (!exhibits.has(id))
      throw new BundleIntegrityError(id, 'is cited by the verdict but not in the bundle');
  }
  return { manifest, sha256, caseFile, verdict, exhibits };
}

/** Sets each variant's image digest from the manifest; a case file that disagrees is tampered. */
function pinCaseFile(manifest: BundleManifest, cf: CaseFile): CaseFile {
  const pin = (variant: 'vulnerable' | 'safe', digest: ImageDigest | undefined) => {
    const pinned = manifest.targetDigests[variant];
    if (pinned === undefined) {
      throw new BundleIntegrityError('manifest', `does not pin the ${variant} target`);
    }
    if (digest !== undefined && digest !== pinned) {
      throw new BundleIntegrityError(
        CASEFILE_ENTRY_ID,
        `${variant} digest disagrees with the manifest`,
      );
    }
    return pinned;
  };
  if (manifest.targetDigests.patched !== undefined) {
    throw new BundleIntegrityError(
      'manifest',
      'pins a patched target, which is rebuilt, never pinned',
    );
  }
  if (cf.safeVariant === undefined && manifest.targetDigests.safe !== undefined) {
    throw new BundleIntegrityError('manifest', 'pins a safe variant the case file does not have');
  }
  return {
    ...cf,
    target: { ...cf.target, imageDigest: pin('vulnerable', cf.target.imageDigest) },
    ...(cf.safeVariant === undefined
      ? {}
      : {
          safeVariant: { ...cf.safeVariant, imageDigest: pin('safe', cf.safeVariant.imageDigest) },
        }),
  };
}

/**
 * Puts a bundle into a store: the tar under its digest, and each listed file under its own, so
 * exhibits are content-addressed individually as well. Throws if the store files anything under a
 * different digest than expected.
 */
export async function storeBundle(store: EvidenceStore, bundle: Bundle): Promise<string> {
  const files = await readTar(bundle.bytes);
  for (const [name, bytes] of files) {
    const want = sha256Hex(bytes);
    const got = await store.put(bytes);
    if (got !== want) throw new Error(`store filed ${name} under ${got}, expected ${want}`);
  }
  const got = await store.put(bundle.bytes);
  if (got !== bundle.sha256) throw new EvidenceCorruptError(bundle.sha256);
  return got;
}

/** Loads and opens a bundle by digest. Null when the store does not have it. */
export async function loadBundle(
  store: EvidenceStore,
  sha256: string,
): Promise<OpenedBundle | null> {
  const bytes = await store.get(sha256);
  if (bytes === null) return null;
  return openBundle(bytes, { expectedSha256: sha256 });
}
