import { generateKeyPairSync } from 'node:crypto';
import type { Attestation, BundleManifest } from '@affidavit/contracts';
import { describe, expect, it } from 'vitest';
import {
  IN_TOTO_PAYLOAD_TYPE,
  VERDICT_PREDICATE_TYPE,
  attestationProblem,
  manifestStatement,
  publicKeyId,
  verifyAttestation,
} from './attestation.js';
import { buildBundle, MANIFEST_PATH } from './bundle.js';
import { canonicalJson, sha256Hex } from './canonical.js';
import { readTar } from './tar.js';
import { bundleInput } from './test-helpers.js';

const pem = (): string =>
  generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({
    type: 'spki',
    format: 'pem',
  }) as string;

/** A Sigstore bundle shaped like cosign's output for `statement`, with a made-up signature. */
function fakeAttestation(
  manifest: BundleManifest,
  publicKeyPem: string,
  over: { payload?: unknown; payloadType?: string; hint?: string; tlog?: unknown[] } = {},
): Attestation {
  const statement = manifestStatement(manifest);
  const keyId = publicKeyId(publicKeyPem);
  const bundle = {
    mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
    verificationMaterial: {
      publicKey: { hint: over.hint ?? Buffer.from(keyId.slice(7), 'hex').toString('base64') },
      ...(over.tlog === undefined ? {} : { tlogEntries: over.tlog }),
    },
    dsseEnvelope: {
      payload: Buffer.from(canonicalJson(over.payload ?? statement)).toString('base64'),
      payloadType: over.payloadType ?? IN_TOTO_PAYLOAD_TYPE,
      signatures: [{ sig: 'MEUCIQ' }],
    },
  };
  return { schemaVersion: 1, statement, signature: JSON.stringify(bundle), keyId };
}

describe('manifestStatement', () => {
  it('signs the exact manifest.json bytes of the bundle, with the manifest as predicate', async () => {
    const bundle = await buildBundle(bundleInput());
    const files = await readTar(bundle.bytes);
    const manifestBytes = files.get(MANIFEST_PATH);
    if (manifestBytes === undefined) throw new Error('no manifest in bundle');
    const s = manifestStatement(bundle.manifest);
    expect(s.subject).toEqual([
      {
        name: `affidavit/${bundle.manifest.caseId}/manifest.json`,
        digest: { sha256: sha256Hex(manifestBytes) },
      },
    ]);
    expect(s.predicateType).toBe(VERDICT_PREDICATE_TYPE);
    expect(s.predicate).toEqual(JSON.parse(canonicalJson(bundle.manifest)));
    expect(canonicalJson(manifestStatement(bundle.manifest))).toBe(canonicalJson(s));
  });

  it('refuses something that is not a manifest', () => {
    expect(() => manifestStatement({ caseId: 'x' } as unknown as BundleManifest)).toThrow();
  });
});

describe('attestationProblem', () => {
  it('accepts a bundle that carries the statement for this manifest', async () => {
    const { manifest } = await buildBundle(bundleInput());
    expect(attestationProblem(fakeAttestation(manifest, pem()), manifest)).toBeNull();
  });

  it('names what is wrong', async () => {
    const { manifest } = await buildBundle(bundleInput());
    const key = pem();
    const other = { ...manifest, verdictSha256: 'f'.repeat(64) };
    const att = fakeAttestation(manifest, key);
    const cases: [string, unknown, string][] = [
      ['not an attestation', { schemaVersion: 1 }, 'not an attestation'],
      ['for another manifest', att, 'statement does not match the manifest'],
      [
        'a signed payload that differs',
        fakeAttestation(manifest, key, { payload: manifestStatement(other) }),
        'signed payload does not match the statement',
      ],
      [
        'a payload that is not in-toto',
        fakeAttestation(manifest, key, { payloadType: 'text/plain' }),
        'DSSE payload is not an in-toto statement',
      ],
      [
        'another key',
        fakeAttestation(manifest, key, { hint: Buffer.alloc(32, 1).toString('base64') }),
        'bundle key hint does not match keyId',
      ],
      [
        'a public log entry',
        fakeAttestation(manifest, key, { tlog: [{ logIndex: '1' }] }),
        'bundle has transparency log entries; verdicts are never logged publicly',
      ],
      [
        'a signature that is not JSON',
        { ...att, signature: 'MEUCIQ' },
        'signature is not a JSON Sigstore bundle',
      ],
    ];
    for (const [name, a, why] of cases) {
      const target = name === 'for another manifest' ? other : manifest;
      expect(attestationProblem(a, target), name).toBe(why);
    }
  });
});

describe('verifyAttestation', () => {
  it('refuses an attestation signed with another key before running cosign', async () => {
    const { manifest } = await buildBundle(bundleInput());
    const att = fakeAttestation(manifest, pem());
    expect(await verifyAttestation(att, manifest, pem(), { cosignPath: '/nonexistent' })).toEqual({
      ok: false,
      reason: 'signed with a different key',
    });
  });
});
