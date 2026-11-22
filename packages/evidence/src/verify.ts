import { createPublicKey } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { Attestation, type Verdict } from '@affidavit/contracts';
import { publicKeyId, verifyAttestation } from './attestation.js';
import { MANIFEST_PATH, openBundle, type OpenedBundle } from './bundle.js';
import { canonicalBytes, sha256Hex, SHA256_HEX } from './canonical.js';
import { BundleIntegrityError } from './errors.js';
import { DEFAULT_TAR_LIMITS, readTar } from './tar.js';

/**
 * Public verification (L2-12): checks a verdict's evidence bundle and its signed attestation with
 * nothing but the two files, the published public key(s) and cosign. No database, store, signer,
 * sandbox or network is used, so anyone holding a bundle can check it without access to our
 * systems. See docs/lanes/lane2/attestation.md, "Public verification".
 */

/** Exit codes of `verifyBundleFiles` (and `pnpm --filter @affidavit/evidence verify`). */
export const VERIFY_EXIT = {
  /** The bundle is intact and its manifest carries a valid signature from one of the keys. */
  VERIFIED: 0,
  /** Tampered or incomplete bundle, bad attestation, unknown key or bad signature. */
  FAILED: 1,
  /** Bad arguments or unreadable input files. */
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

/**
 * Control, line-separator and bidirectional-override characters, escaped before a failure reason
 * is returned: a reason can quote the manifest's exhibit ids, tar entry names or the attestation's
 * key id, all read from the untrusted files before any signature check, and printing them raw
 * would let a crafted bundle add lines (a fake `VERIFIED`) or move the cursor with ANSI escapes.
 */
const UNPRINTABLE =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

/** `s` with every unprintable character written as a `\uXXXX` escape, so it stays on one line. */
export function printable(s: string): string {
  return s.replace(UNPRINTABLE, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** Largest attestation file read; a real one is a few KiB plus the manifest. */
export const MAX_ATTESTATION_BYTES = 16 * 1024 * 1024;
/** Largest public key file read. */
export const MAX_PUBLIC_KEY_BYTES = 64 * 1024;

/**
 * Verifies `bundleBytes` against `attestationText` and the published public keys, in this order,
 * stopping at the first failure:
 *
 * 1. With `expectedSha256` (the verdict's `bundleSha256`), the bundle hashes to it.
 * 2. `openBundle`: every file is listed in the manifest and hashes to its digest, the verdict
 *    hashes to `verdictSha256`, and the case file, manifest and verdict agree.
 * 3. `manifest.json` is byte for byte the canonical form of the manifest that parsed, so no field
 *    the schema would drop can ride along unsigned.
 * 4. The attestation parses, and its `keyId` is one of the given keys (key rotation: every
 *    published key may be passed, the attestation names which one signed).
 * 5. `verifyAttestation`: the statement is the one built from this manifest, and cosign verifies
 *    the signature offline with that key.
 *
 * Never throws for bad input; throws `CosignMissingError` only when cosign cannot be run.
 */
export async function verifyPublic(
  bundleBytes: Uint8Array,
  attestationText: string,
  publicKeyPems: readonly string[],
  opts: { expectedSha256?: string; cosignPath?: string } = {},
): Promise<PublicVerification> {
  const bundleSha256 = sha256Hex(bundleBytes);
  const fail = (reason: string): PublicVerification => ({
    ok: false,
    bundleSha256,
    reason: printable(reason),
  });

  if (opts.expectedSha256 !== undefined && !SHA256_HEX.test(opts.expectedSha256)) {
    return fail('the expected bundle digest is not 64 lowercase hex characters');
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

  const keys = new Map<string, string>();
  for (const [i, pem] of publicKeyPems.entries()) {
    try {
      createPublicKey(pem);
    } catch {
      return fail(`public key ${i + 1} is not a PEM public key`);
    }
    keys.set(publicKeyId(pem), pem);
  }
  if (keys.size === 0) return fail('no public key given');
  const pem = keys.get(attestation.keyId);
  if (pem === undefined) {
    return fail(`signed by key ${attestation.keyId}, which is none of the given keys`);
  }

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
 * Plain-text lines for a result. Values of a verified result come from a bundle that passed every
 * check; a failure's reason is already `printable`, and is escaped again here in case a caller
 * built the result itself.
 */
export function renderVerification(v: PublicVerification): string[] {
  const lines = [`bundle sha256:${v.bundleSha256}`];
  if (!v.ok) {
    lines.push(`NOT VERIFIED: ${printable(v.reason)}`);
    return lines;
  }
  lines.push(
    `case ${v.caseId}`,
    `verdict ${v.outcome}${v.severity === undefined ? '' : ` (severity ${v.severity})`}`,
    `exhibits ${v.exhibits}, every one matching its signed digest`,
    `signed by ${v.keyId}`,
    'VERIFIED',
  );
  return lines;
}

export interface VerifyFilesInput {
  bundlePath: string;
  attestationPath: string;
  publicKeyPaths: readonly string[];
  expectedSha256?: string;
  cosignPath?: string;
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
 * Reads the bundle, attestation and key files, verifies them (`verifyPublic`), prints the
 * result, and returns an exit code from `VERIFY_EXIT`.
 */
export async function verifyBundleFiles(input: VerifyFilesInput): Promise<number> {
  const out = input.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  if (input.publicKeyPaths.length === 0) {
    out('at least one --key <public key file> is required');
    return VERIFY_EXIT.USAGE;
  }
  const bundle = await readCapped(input.bundlePath, DEFAULT_TAR_LIMITS.maxTotalBytes, 'bundle');
  const attestation = await readCapped(input.attestationPath, MAX_ATTESTATION_BYTES, 'attestation');
  const keys: Uint8Array[] = [];
  for (const p of input.publicKeyPaths) {
    const k = await readCapped(p, MAX_PUBLIC_KEY_BYTES, 'public key');
    if (typeof k === 'string') {
      out(k);
      return VERIFY_EXIT.USAGE;
    }
    keys.push(k);
  }
  for (const r of [bundle, attestation]) {
    if (typeof r === 'string') {
      out(r);
      return VERIFY_EXIT.USAGE;
    }
  }
  const text = (b: Uint8Array) => Buffer.from(b).toString('utf8');
  let result: PublicVerification;
  try {
    result = await verifyPublic(
      bundle as Uint8Array,
      text(attestation as Uint8Array),
      keys.map(text),
      {
        ...(input.expectedSha256 === undefined ? {} : { expectedSha256: input.expectedSha256 }),
        ...(input.cosignPath === undefined ? {} : { cosignPath: input.cosignPath }),
      },
    );
  } catch (err) {
    if (!(err instanceof CosignMissingError)) throw err;
    out('cosign is not installed; the signature cannot be checked without it');
    return VERIFY_EXIT.NO_COSIGN;
  }
  for (const l of renderVerification(result)) out(l);
  return result.ok ? VERIFY_EXIT.VERIFIED : VERIFY_EXIT.FAILED;
}
