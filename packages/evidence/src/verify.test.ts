import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Attestation, BundleManifest } from '@affidavit/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import {
  IN_TOTO_PAYLOAD_TYPE,
  VERDICT_PREDICATE_TYPE,
  manifestStatement,
  publicKeyId,
} from './attestation.js';
import { buildBundle, MANIFEST_PATH } from './bundle.js';
import { canonicalJson } from './canonical.js';
import { readTar, writeTar } from './tar.js';
import { bundleInput } from './test-helpers.js';
import { verifyMain } from './verify-main.js';
import { VERIFY_EXIT, verifyBundleFiles, verifyPublic } from './verify.js';

const dir = mkdtempSync(join(tmpdir(), 'affidavit-verify-test-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const write = (name: string, data: string | Uint8Array): string => {
  const p = join(dir, name);
  writeFileSync(p, data);
  return p;
};

const pem = (): string =>
  generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({
    type: 'spki',
    format: 'pem',
  }) as string;

/** Stand-ins for cosign: one accepts every signature, one rejects every signature. */
const cosignOk = write('cosign-ok', '#!/bin/sh\nexit 0\n');
const cosignBad = write('cosign-bad', '#!/bin/sh\necho "Error: invalid signature" >&2\nexit 1\n');
chmodSync(cosignOk, 0o755);
chmodSync(cosignBad, 0o755);

/** An attestation shaped like cosign's output for `manifest`, with a made-up signature. */
function fakeAttestation(manifest: BundleManifest, publicKeyPem: string): Attestation {
  const statement = manifestStatement(manifest);
  const keyId = publicKeyId(publicKeyPem);
  const bundle = {
    mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
    verificationMaterial: {
      publicKey: { hint: Buffer.from(keyId.slice(7), 'hex').toString('base64') },
    },
    dsseEnvelope: {
      payload: Buffer.from(canonicalJson(statement)).toString('base64'),
      payloadType: IN_TOTO_PAYLOAD_TYPE,
      signatures: [{ sig: 'MEUCIQ' }],
    },
  };
  return { schemaVersion: 1, statement, signature: JSON.stringify(bundle), keyId };
}

async function rewrite(bytes: Uint8Array, name: string, data: Uint8Array): Promise<Uint8Array> {
  const files = await readTar(bytes);
  files.set(name, data);
  return writeTar([...files].map(([n, b]) => ({ name: n, bytes: b })));
}

describe('verifyPublic', () => {
  it('verifies an intact bundle and reports the signed verdict', async () => {
    const { bytes, sha256, manifest } = await buildBundle(bundleInput());
    const key = pem();
    const att = JSON.stringify(fakeAttestation(manifest, key));
    const r = await verifyPublic(bytes, att, [pem(), key], {
      expectedSha256: sha256,
      cosignPath: cosignOk,
    });
    expect(r).toMatchObject({
      ok: true,
      bundleSha256: sha256,
      caseId: manifest.caseId,
      keyId: publicKeyId(key),
      exhibits: manifest.exhibits.length,
    });
  });

  it('fails on a tampered exhibit and names it, before any signature check', async () => {
    const { bytes, manifest } = await buildBundle(bundleInput());
    const key = pem();
    const files = await readTar(bytes);
    const w = new Uint8Array(files.get('exhibits/exhibit-witness-001.json')!);
    w[5] = (w[5] ?? 0) ^ 1;
    const tampered = await rewrite(bytes, 'exhibits/exhibit-witness-001.json', w);
    const r = await verifyPublic(tampered, JSON.stringify(fakeAttestation(manifest, key)), [key], {
      cosignPath: cosignOk,
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/^bundle integrity \(exhibit-witness-001\)/);
  });

  it('fails when the bundle is not the one the verdict names', async () => {
    const { bytes, manifest } = await buildBundle(bundleInput());
    const key = pem();
    const att = JSON.stringify(fakeAttestation(manifest, key));
    const other = await verifyPublic(bytes, att, [key], {
      expectedSha256: 'f'.repeat(64),
      cosignPath: cosignOk,
    });
    expect(!other.ok && other.reason).toMatch(/expected digest/);
    const bad = await verifyPublic(bytes, att, [key], {
      expectedSha256: 'xyz',
      cosignPath: cosignOk,
    });
    expect(!bad.ok && bad.reason).toMatch(/64 lowercase hex/);
  });

  it('refuses a manifest.json that is not canonical, even when it parses to the signed manifest', async () => {
    const { bytes, manifest } = await buildBundle(bundleInput());
    const key = pem();
    // An extra field the schema drops: it would ride along unsigned.
    const padded = { ...JSON.parse(canonicalJson(manifest)), note: 'unsigned' } as object;
    const altered = await rewrite(bytes, MANIFEST_PATH, Buffer.from(JSON.stringify(padded)));
    const r = await verifyPublic(altered, JSON.stringify(fakeAttestation(manifest, key)), [key], {
      cosignPath: cosignOk,
    });
    expect(!r.ok && r.reason).toBe('manifest.json is not the canonical form of its manifest');
  });

  it('refuses an attestation for another bundle, a bad file, or an unknown key', async () => {
    const { bytes, manifest } = await buildBundle(bundleInput());
    const otherManifest = (await buildBundle(bundleInput({ createdAt: '2026-01-01T00:00:00Z' })))
      .manifest;
    const key = pem();
    const opts = { cosignPath: cosignOk };
    const reason = async (att: string, keys = [key]) => {
      const r = await verifyPublic(bytes, att, keys, opts);
      return r.ok ? 'ok' : r.reason;
    };
    expect(await reason(JSON.stringify(fakeAttestation(otherManifest, key)))).toMatch(
      /statement does not match the manifest/,
    );
    expect(await reason('not json')).toBe('the attestation file is not JSON');
    expect(await reason('{"schemaVersion":1}')).toBe('the attestation file is not an attestation');
    const att = JSON.stringify(fakeAttestation(manifest, key));
    expect(await reason(att, [pem()])).toMatch(/which is none of the given keys/);
    expect(await reason(att, [])).toBe('no public key given');
    expect(await reason(att, ['-----BEGIN PUBLIC KEY-----\nnope\n'])).toBe(
      'public key 1 is not a PEM public key',
    );
  });

  it('refuses a signature by a revoked key, even when that key is passed', async () => {
    const { bytes, manifest } = await buildBundle(bundleInput());
    const oldKey = pem();
    const newKey = pem();
    const att = JSON.stringify(fakeAttestation(manifest, oldKey));
    const opts = { cosignPath: cosignOk, revokedKeyIds: [publicKeyId(oldKey)] };
    const r = await verifyPublic(bytes, att, [newKey, oldKey], opts);
    expect(!r.ok && r.reason).toBe(`signed by key ${publicKeyId(oldKey)}, which is revoked`);
    // Revoking another key leaves this one verifying.
    const fresh = JSON.stringify(fakeAttestation(manifest, newKey));
    expect((await verifyPublic(bytes, fresh, [newKey, oldKey], opts)).ok).toBe(true);
    const bad = await verifyPublic(bytes, fresh, [newKey], { ...opts, revokedKeyIds: ['k1'] });
    expect(!bad.ok && bad.reason).toMatch(/revoked key id "k1" is not sha256:<64 hex>/);
  });

  it('fails when cosign rejects the signature, and says cosign is missing rather than passing', async () => {
    const { bytes, manifest } = await buildBundle(bundleInput());
    const key = pem();
    const att = JSON.stringify(fakeAttestation(manifest, key));
    const r = await verifyPublic(bytes, att, [key], { cosignPath: cosignBad });
    expect(!r.ok && r.reason).toBe('signature: cosign: invalid signature');
    await expect(
      verifyPublic(bytes, att, [key], { cosignPath: join(dir, 'no-such-cosign') }),
    ).rejects.toThrow(/cosign is not installed/);
  });
});

describe('verifyBundleFiles and the verify command', () => {
  it('prints the verdict and exits 0 when verified, 1 when not', async () => {
    const { bytes, manifest, sha256 } = await buildBundle(bundleInput());
    const key = pem();
    const bundle = write('ok.tar', bytes);
    const att = write('ok.att.json', JSON.stringify(fakeAttestation(manifest, key)));
    const pub = write('ok.pub', key);
    const lines: string[] = [];
    const out = (l: string) => lines.push(l);
    const ok = await verifyMain(
      [bundle, att, '--key', pub, '--expect-sha256', sha256, '--cosign', cosignOk],
      out,
    );
    expect(ok).toBe(VERIFY_EXIT.VERIFIED);
    expect(lines[0]).toBe(`bundle sha256:${sha256}`);
    expect(lines.at(-1)).toBe('VERIFIED');
    expect(lines).toContain(`signed by ${publicKeyId(key)}`);

    lines.length = 0;
    const bad = await verifyMain([bundle, att, '--key', pub, '--cosign', cosignBad], out);
    expect(bad).toBe(VERIFY_EXIT.FAILED);
    expect(lines.at(-1)).toBe('NOT VERIFIED: signature: cosign: invalid signature');

    lines.length = 0;
    const revoked = await verifyMain(
      [bundle, att, '--key', pub, '--revoked', publicKeyId(key), '--cosign', cosignOk],
      out,
    );
    expect(revoked).toBe(VERIFY_EXIT.FAILED);
    expect(lines.at(-1)).toMatch(/which is revoked$/);
  });

  it('exits 2 on bad usage or unreadable files, and 3 without cosign', async () => {
    const { bytes, manifest } = await buildBundle(bundleInput());
    const key = pem();
    const bundle = write('u.tar', bytes);
    const att = write('u.att.json', JSON.stringify(fakeAttestation(manifest, key)));
    const pub = write('u.pub', key);
    const lines: string[] = [];
    const out = (l: string) => lines.push(l);
    expect(await verifyMain([bundle, att], out)).toBe(VERIFY_EXIT.USAGE);
    expect(await verifyMain([bundle, '--key', pub], out)).toBe(VERIFY_EXIT.USAGE);
    expect(await verifyMain([bundle, att, '--key', pub, '--bogus'], out)).toBe(VERIFY_EXIT.USAGE);
    expect(await verifyMain([bundle, att, '--key', pub, '--revoked', 'old'], out)).toBe(
      VERIFY_EXIT.USAGE,
    );
    expect(await verifyMain([bundle, att, '--key', join(dir, 'missing.pub')], out)).toBe(
      VERIFY_EXIT.USAGE,
    );
    expect(await verifyMain([dir, att, '--key', pub], out)).toBe(VERIFY_EXIT.USAGE);
    expect(
      await verifyBundleFiles({
        bundlePath: bundle,
        attestationPath: att,
        publicKeyPaths: [pub],
        cosignPath: join(dir, 'no-such-cosign'),
        out,
      }),
    ).toBe(VERIFY_EXIT.NO_COSIGN);
    expect(lines.at(-1)).toMatch(/cosign is not installed/);
  });
});

/** Runs wherever cosign is installed (the sandbox host); skipped elsewhere, as in CI today. */
const hasCosign = (() => {
  try {
    execFileSync('cosign', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.runIf(hasCosign)('with real cosign signatures', { timeout: 120_000 }, () => {
  /** Signs `manifest` exactly as apps/signer does: offline, no log, the statement it builds. */
  function sign(manifest: BundleManifest, name: string): { att: Attestation; pub: string } {
    const kd = mkdtempSync(join(dir, `${name}-`));
    const env = { PATH: process.env.PATH ?? '', HOME: kd, COSIGN_PASSWORD: 'test-only' };
    execFileSync('cosign', ['generate-key-pair'], { cwd: kd, env, stdio: 'ignore' });
    const statement = manifestStatement(manifest);
    writeFileSync(join(kd, 'statement.json'), canonicalJson(statement));
    writeFileSync(
      join(kd, 'config.json'),
      JSON.stringify({ mediaType: 'application/vnd.dev.sigstore.signingconfig.v0.2+json' }),
    );
    execFileSync(
      'cosign',
      [
        'attest-blob',
        '--key',
        join(kd, 'cosign.key'),
        '--statement',
        join(kd, 'statement.json'),
        '--signing-config',
        join(kd, 'config.json'),
        '--bundle',
        join(kd, 'att.sigstore.json'),
      ],
      { env, stdio: 'ignore' },
    );
    const pub = readFileSync(join(kd, 'cosign.pub'), 'utf8');
    return {
      pub,
      att: {
        schemaVersion: 1,
        statement,
        signature: readFileSync(join(kd, 'att.sigstore.json'), 'utf8'),
        keyId: publicKeyId(pub),
      },
    };
  }

  it('verifies a real signature from files alone, and catches a flipped signature byte', async () => {
    const { bytes, manifest, sha256 } = await buildBundle(bundleInput());
    const { att, pub } = sign(manifest, 'real');
    const older = sign(manifest, 'older').pub;
    expect(VERDICT_PREDICATE_TYPE).toBe(att.statement.predicateType);

    const lines: string[] = [];
    const code = await verifyMain(
      [
        write('real.tar', bytes),
        write('real.att.json', JSON.stringify(att)),
        '--key',
        write('older.pub', older),
        '--key',
        write('real.pub', pub),
        '--expect-sha256',
        sha256,
      ],
      (l) => lines.push(l),
    );
    expect(lines.at(-1)).toBe('VERIFIED');
    expect(code).toBe(VERIFY_EXIT.VERIFIED);

    const sigBundle = JSON.parse(att.signature) as {
      dsseEnvelope: { signatures: { sig: string }[] };
    };
    const sig = Buffer.from(sigBundle.dsseEnvelope.signatures[0]!.sig, 'base64');
    sig[sig.length - 1] = (sig[sig.length - 1] ?? 0) ^ 1;
    sigBundle.dsseEnvelope.signatures[0]!.sig = sig.toString('base64');
    const flipped = { ...att, signature: JSON.stringify(sigBundle) };
    const r = await verifyPublic(bytes, JSON.stringify(flipped), [pub]);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/^signature: cosign:/);
  });
});
