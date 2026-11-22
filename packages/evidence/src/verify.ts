import { readFile, stat } from 'node:fs/promises';
import { Attestation, type Verdict } from '@affidavit/contracts';
import { publicKeyId, verifyAttestation } from './attestation.js';
import { MANIFEST_PATH, openBundle, type OpenedBundle } from './bundle.js';
import { canonicalBytes, sha256Hex, SHA256_HEX } from './canonical.js';
import { BundleIntegrityError } from './errors.js';
import {
  KEY_ID,
  MAX_KEYS_FILE_BYTES,
  parseKeysFile,
  publicKeyProblem,
  type PublishedKey,
} from './keys.js';
import { DEFAULT_TAR_LIMITS, readTar } from './tar.js';

/**
 * Public verification (L2-12): checks a verdict's evidence bundle and its signed attestation with
 * nothing but the two files, the published keys file and cosign. No database, store, signer,
 * sandbox or network is used, so anyone holding a bundle can check it without access to our
 * systems. See docs/lanes/lane2/attestation.md, "Public verification".
 */

/** Exit codes of `verifyBundleFiles` (and `pnpm --filter @affidavit/evidence verify`). */
export const VERIFY_EXIT = {
  /** The bundle is intact and its manifest carries a valid signature from one of the keys. */
  VERIFIED: 0,
  /** Tampered or incomplete bundle, bad attestation, unknown key or bad signature. */
  FAILED: 1,
  /** Bad arguments, or a missing, unreadable or malformed input file (the keys file included). */
  USAGE: 2,
  /** cosign is not installed, so the signature could not be checked at all. */
  NO_COSIGN: 3,
} as const;

export type PublicVerification =
  | {
      ok: true;
      bundleSha256: string;
      caseId: string;
      outcome: Verdict['outcome'];
      severity?: Verdict['severity'];
      /** Exhibits in the bundle, the case file included. */
      exhibits: number;
      keyId: string;
    }
  | { ok: false; bundleSha256: string; reason: string };

export class CosignMissingError extends Error {
  override name = 'CosignMissingError';
}

/** Largest attestation file read; a real one is a few KiB plus the manifest. */
export const MAX_ATTESTATION_BYTES = 16 * 1024 * 1024;

/**
 * Verifies `bundleBytes` against `attestationText` and the published keys (the entries of the
 * keys file, `parseKeysFile`), in this order,
 * stopping at the first failure:
 *
 * 1. With `expectedSha256` (the verdict's `bundleSha256`), the bundle hashes to it.
 * 2. `openBundle`: every file is listed in the manifest and hashes to its digest, the verdict
 *    hashes to `verdictSha256`, and the case file, manifest and verdict agree.
 * 3. `manifest.json` is byte for byte the canonical form of the manifest that parsed, so no field
 *    the schema would drop can ride along unsigned.
 * 4. The attestation parses, its `keyId` is one of the published keys, and that key is not
 *    revoked: neither `status: 'revoked'` in the keys file nor named in `revokedKeyIds` (an extra
 *    override). A revoked key is refused whatever its `revokedAt`: signatures carry no trusted
 *    timestamp, so one made after the key leaked cannot be told apart from an older one.
 * 5. `verifyAttestation`: the statement is the one built from this manifest, and cosign verifies
 *    the signature offline with that key.
 *
 * Never throws for bad input; throws `CosignMissingError` only when cosign cannot be run.
 */
export async function verifyPublic(
  bundleBytes: Uint8Array,
  attestationText: string,
  publishedKeys: readonly PublishedKey[],
  opts: { expectedSha256?: string; cosignPath?: string; revokedKeyIds?: readonly string[] } = {},
): Promise<PublicVerification> {
  const bundleSha256 = sha256Hex(bundleBytes);
  // Reasons can quote exhibit ids, tar entry names and key ids read before any signature check,
  // so they are escaped where they are made, and again when rendered.
  const fail = (reason: string): PublicVerification => ({
    ok: false,
    bundleSha256,
    reason: printable(reason),
  });

  if (opts.expectedSha256 !== undefined && !SHA256_HEX.test(opts.expectedSha256)) {
    return fail('the expected bundle digest is not 64 lowercase hex characters');
  }
  const revoked = new Set(opts.revokedKeyIds ?? []);
  for (const id of revoked) {
    if (!KEY_ID.test(id))
      return fail(`revoked key id ${JSON.stringify(id)} is not sha256:<64 hex>`);
  }
  let bundle: OpenedBundle;
  let manifestBytes: Uint8Array | undefined;
  try {
    bundle = await openBundle(
      bundleBytes,
      opts.expectedSha256 === undefined ? {} : { expectedSha256: opts.expectedSha256 },
    );
    manifestBytes = (await readTar(bundleBytes)).get(MANIFEST_PATH);
  } catch (err) {
    if (!(err instanceof BundleIntegrityError)) throw err;
    const who = err.exhibitId === undefined ? '' : ` (${err.exhibitId})`;
    return fail(`bundle integrity${who}: ${err.reason}`);
  }
  if (
    manifestBytes === undefined ||
    Buffer.compare(Buffer.from(manifestBytes), Buffer.from(canonicalBytes(bundle.manifest))) !== 0
  ) {
    return fail('manifest.json is not the canonical form of its manifest');
  }

  let attestationJson: unknown;
  try {
    attestationJson = JSON.parse(attestationText);
  } catch {
    return fail('the attestation file is not JSON');
  }
  const parsed = Attestation.safeParse(attestationJson);
  if (!parsed.success) return fail('the attestation file is not an attestation');
  const attestation = parsed.data;

  // Checked again here for callers that did not go through parseKeysFile.
  const keys = new Map<string, PublishedKey>();
  for (const [i, key] of publishedKeys.entries()) {
    const problem = publicKeyProblem(key.publicKey);
    if (problem !== undefined) return fail(`published key ${i + 1} ${problem}`);
    if (publicKeyId(key.publicKey) !== key.keyId) {
      return fail(`published key ${i + 1} has a keyId that is not its key's id`);
    }
    if (keys.has(key.keyId)) return fail(`published key ${i + 1} repeats ${key.keyId}`);
    keys.set(key.keyId, key);
  }
  if (keys.size === 0) return fail('no published key given');
  const key = keys.get(attestation.keyId);
  if (revoked.has(attestation.keyId)) {
    return fail(`signed by key ${attestation.keyId}, which is revoked`);
  }
  if (key === undefined) {
    // The attestation's keyId is any non-empty string until it matches a published key.
    const shown = KEY_ID.test(attestation.keyId)
      ? attestation.keyId
      : JSON.stringify(attestation.keyId);
    return fail(`signed by key ${shown}, which is none of the published keys`);
  }
  if (key.status !== 'active') {
    return fail(`signed by key ${attestation.keyId}, which is revoked`);
  }
  const pem = key.publicKey;

  let check: Awaited<ReturnType<typeof verifyAttestation>>;
  try {
    check = await verifyAttestation(
      attestation,
      bundle.manifest,
      pem,
      opts.cosignPath === undefined ? {} : { cosignPath: opts.cosignPath },
    );
  } catch (err) {
    if (err instanceof Error && err.message === 'cosign is not installed') {
      throw new CosignMissingError('cosign is not installed', { cause: err });
    }
    throw err;
  }
  if (!check.ok) return fail(`signature: ${check.reason}`);

  return {
    ok: true,
    bundleSha256,
    caseId: bundle.manifest.caseId,
    outcome: bundle.verdict.outcome,
    ...(bundle.verdict.severity === undefined ? {} : { severity: bundle.verdict.severity }),
    exhibits: bundle.manifest.exhibits.length,
    keyId: attestation.keyId,
  };
}

/**
 * `text` with every control, format (bidi controls such as U+202E and U+061C, zero-width
 * characters) and line or paragraph separator character written as a visible `\u{...}` escape,
 * so text from a bundle or attestation cannot add a line such as `VERIFIED` or reorder what a
 * terminal shows.
 */
export function printable(text: string): string {
  return text.replace(
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}؜]/gu,
    (c) => `\\u{${c.codePointAt(0)!.toString(16).padStart(4, '0')}}`,
  );
}

/**
 * Plain-text lines for a result. Every value that can come from the bundle or the attestation
 * goes through `printable`, even after every check passed.
 */
export function renderVerification(v: PublicVerification): string[] {
  const lines = [`bundle sha256:${v.bundleSha256}`];
  if (!v.ok) {
    lines.push(`NOT VERIFIED: ${printable(v.reason)}`);
    return lines;
  }
  lines.push(
    `case ${printable(v.caseId)}`,
    `verdict ${v.outcome}${v.severity === undefined ? '' : ` (severity ${v.severity})`}`,
    `exhibits ${v.exhibits}, every one matching its signed digest`,
    `signed by ${printable(v.keyId)}`,
    'VERIFIED',
  );
  return lines;
}

export interface VerifyFilesInput {
  bundlePath: string;
  attestationPath: string;
  /** The published keys file (docs/keys/README.md). Required: verification never runs without it. */
  keysPath: string | undefined;
  expectedSha256?: string;
  cosignPath?: string;
  revokedKeyIds?: readonly string[];
  out?: (line: string) => void;
}

async function readCapped(path: string, max: number, what: string): Promise<Uint8Array | string> {
  try {
    const st = await stat(path);
    if (!st.isFile()) return `${what} ${path} is not a regular file`;
    if (st.size > max) return `${what} ${path} is larger than ${max} bytes`;
    return new Uint8Array(await readFile(path));
  } catch {
    return `${what} ${path} cannot be read`;
  }
}

/**
 * Reads the bundle, attestation and keys files, verifies them (`verifyPublic`), prints the
 * result, and returns an exit code from `VERIFY_EXIT`.
 */
export async function verifyBundleFiles(input: VerifyFilesInput): Promise<number> {
  const out = input.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  if (input.keysPath === undefined) {
    out('--keys <keys file> is required (the published keys file, docs/keys/README.md)');
    return VERIFY_EXIT.USAGE;
  }
  const badRevoked = (input.revokedKeyIds ?? []).find((id) => !KEY_ID.test(id));
  if (badRevoked !== undefined) {
    out(`--revoked ${JSON.stringify(badRevoked)} is not a key id (sha256:<64 hex>)`);
    return VERIFY_EXIT.USAGE;
  }
  const bundle = await readCapped(input.bundlePath, DEFAULT_TAR_LIMITS.maxTotalBytes, 'bundle');
  const attestation = await readCapped(input.attestationPath, MAX_ATTESTATION_BYTES, 'attestation');
  const keysBytes = await readCapped(input.keysPath, MAX_KEYS_FILE_BYTES, 'keys file');
  for (const r of [keysBytes, bundle, attestation]) {
    if (typeof r === 'string') {
      out(r);
      return VERIFY_EXIT.USAGE;
    }
  }
  const text = (b: Uint8Array) => Buffer.from(b).toString('utf8');
  const keys = parseKeysFile(text(keysBytes as Uint8Array));
  if (!keys.ok) {
    out(`${input.keysPath}: ${keys.reason}`);
    return VERIFY_EXIT.USAGE;
  }
  let result: PublicVerification;
  try {
    result = await verifyPublic(bundle as Uint8Array, text(attestation as Uint8Array), keys.keys, {
      ...(input.expectedSha256 === undefined ? {} : { expectedSha256: input.expectedSha256 }),
      ...(input.cosignPath === undefined ? {} : { cosignPath: input.cosignPath }),
      ...(input.revokedKeyIds === undefined ? {} : { revokedKeyIds: input.revokedKeyIds }),
    });
  } catch (err) {
    if (!(err instanceof CosignMissingError)) throw err;
    out('cosign is not installed; the signature cannot be checked without it');
    return VERIFY_EXIT.NO_COSIGN;
  }
  for (const l of renderVerification(result)) out(l);
  return result.ok ? VERIFY_EXIT.VERIFIED : VERIFY_EXIT.FAILED;
}
