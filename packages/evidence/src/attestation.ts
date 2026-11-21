import { execFile } from 'node:child_process';
import { createPublicKey } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  Attestation,
  BundleManifest,
  InTotoStatement,
  type Attestation as AttestationT,
} from '@affidavit/contracts';
import { canonicalBytes, canonicalJson, sha256Hex } from './canonical.js';

const exec = promisify(execFile);

/**
 * The predicate type of a verdict attestation. It names this format's documentation, so a
 * verifier can look up what the predicate holds.
 */
export const VERDICT_PREDICATE_TYPE =
  'https://github.com/Bomoga/Affidavit/blob/main/docs/lanes/lane2/attestation.md#verdict-manifest-v1';

/** DSSE payload type cosign uses for in-toto statements. */
export const IN_TOTO_PAYLOAD_TYPE = 'application/vnd.in-toto+json';

/** The subject name of a manifest: the path it has inside the case's bundle. */
export const manifestSubjectName = (manifest: BundleManifest): string =>
  `affidavit/${manifest.caseId}/manifest.json`;

/**
 * The in-toto statement a verdict attestation signs. The subject is the SHA-256 of the
 * manifest's canonical JSON (the exact bytes of `manifest.json` in the bundle), and the
 * predicate is the manifest itself, so the statement alone shows which verdict, exhibits and
 * target images were signed.
 */
export function manifestStatement(manifest: BundleManifest): InTotoStatement {
  const m = BundleManifest.parse(manifest);
  return InTotoStatement.parse({
    _type: 'https://in-toto.io/Statement/v1',
    subject: [{ name: manifestSubjectName(m), digest: { sha256: sha256Hex(canonicalBytes(m)) } }],
    predicateType: VERDICT_PREDICATE_TYPE,
    predicate: JSON.parse(canonicalJson(m)) as Record<string, never>,
  });
}

/**
 * Key id of a public key: `sha256:` and the hex SHA-256 of its DER SubjectPublicKeyInfo. Cosign
 * puts the same digest (base64) in a bundle's `publicKey.hint`.
 */
export function publicKeyId(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return `sha256:${sha256Hex(new Uint8Array(der))}`;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Structural checks on an attestation for `manifest`, without any key: the statement is exactly
 * the one `manifestStatement` builds, and `signature` is a Sigstore bundle whose DSSE envelope
 * carries that same statement as an in-toto payload, with the key hint `keyId` names and no
 * transparency log entry (verdicts are private and never go to a public log). Null when it
 * holds, else why not. The signature itself is checked by `verifyAttestation`.
 */
export function attestationProblem(attestation: unknown, manifest: BundleManifest): string | null {
  const parsed = Attestation.safeParse(attestation);
  if (!parsed.success) return 'not an attestation';
  const a = parsed.data;
  const expected = manifestStatement(manifest);
  if (canonicalJson(a.statement) !== canonicalJson(expected)) {
    return 'statement does not match the manifest';
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(a.keyId)) return 'keyId is not a sha256 key digest';
  let bundle: unknown;
  try {
    bundle = JSON.parse(a.signature);
  } catch {
    return 'signature is not a JSON Sigstore bundle';
  }
  if (!isObj(bundle) || !isObj(bundle.dsseEnvelope) || !isObj(bundle.verificationMaterial)) {
    return 'signature is not a Sigstore bundle with a DSSE envelope';
  }
  const env = bundle.dsseEnvelope;
  if (env.payloadType !== IN_TOTO_PAYLOAD_TYPE) return 'DSSE payload is not an in-toto statement';
  if (typeof env.payload !== 'string') return 'DSSE payload is missing';
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(env.payload, 'base64').toString('utf8'));
  } catch {
    return 'DSSE payload is not JSON';
  }
  if (canonicalJson(payload) !== canonicalJson(expected)) {
    return 'signed payload does not match the statement';
  }
  const vm = bundle.verificationMaterial;
  const hint = isObj(vm.publicKey) ? vm.publicKey.hint : undefined;
  const hex = typeof hint === 'string' ? Buffer.from(hint, 'base64').toString('hex') : '';
  if (`sha256:${hex}` !== a.keyId) return 'bundle key hint does not match keyId';
  const tlog = vm.tlogEntries;
  if (tlog !== undefined && !(Array.isArray(tlog) && tlog.length === 0)) {
    return 'bundle has transparency log entries; verdicts are never logged publicly';
  }
  return null;
}

export type AttestationCheck = { ok: true } | { ok: false; reason: string };

/**
 * Verifies `attestation` for `manifest` against a public key: the structural checks above, then
 * `cosign verify-blob-attestation` over the manifest's canonical bytes, offline, with the
 * transparency log check off (nothing is ever uploaded to one). Needs `cosign` on PATH (or
 * `cosignPath`). Never throws for a bad attestation; throws only when cosign cannot be run.
 */
export async function verifyAttestation(
  attestation: AttestationT,
  manifest: BundleManifest,
  publicKeyPem: string,
  opts: { cosignPath?: string } = {},
): Promise<AttestationCheck> {
  const problem = attestationProblem(attestation, manifest);
  if (problem !== null) return { ok: false, reason: problem };
  if (publicKeyId(publicKeyPem) !== attestation.keyId) {
    return { ok: false, reason: 'signed with a different key' };
  }
  const dir = await mkdtemp(join(tmpdir(), 'affidavit-verify-'));
  try {
    const blob = join(dir, 'manifest.json');
    const bundle = join(dir, 'attestation.sigstore.json');
    const key = join(dir, 'key.pub');
    await writeFile(blob, canonicalBytes(BundleManifest.parse(manifest)));
    await writeFile(bundle, attestation.signature);
    await writeFile(key, publicKeyPem);
    try {
      await exec(
        opts.cosignPath ?? 'cosign',
        [
          'verify-blob-attestation',
          '--key',
          key,
          '--bundle',
          bundle,
          '--type',
          VERDICT_PREDICATE_TYPE,
          '--insecure-ignore-tlog',
          blob,
        ],
        { env: { PATH: process.env.PATH ?? '', HOME: dir }, timeout: 60_000 },
      );
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { code?: unknown; stderr?: string };
      if (e.code === 'ENOENT') throw new Error('cosign is not installed', { cause: err });
      const msg = (e.stderr ?? '').split('\n').find((l) => l.startsWith('Error:')) ?? 'failed';
      return { ok: false, reason: `cosign: ${msg.replace(/^Error:\s*/, '')}` };
    }
    return { ok: true };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
