import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BundleManifest } from '@affidavit/contracts';
import {
  MANIFEST_PATH,
  buildBundle,
  readTar,
  sha256Hex,
  verifyAttestation,
} from '@affidavit/evidence';
// Lane 2 test helpers: the gate case's bundle (fixtures/casefiles/nodegoat-sqli-001.json).
import { bundleInput } from '../../../packages/evidence/src/test-helpers.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SignerClient } from './client.js';
import { CosignSigner } from './cosign.js';
import { loadConfig } from './main.js';
import { startSignerServer } from './server.js';

/** Runs wherever cosign is installed (the sandbox host); skipped elsewhere, as in CI today. */
const hasCosign = (() => {
  try {
    execFileSync('cosign', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const MANIFEST = BundleManifest.parse({
  schemaVersion: 1,
  caseId: 'case-gate-001',
  createdAt: '2026-11-18T00:00:00.000Z',
  targetDigests: { vulnerable: `sha256:${'a'.repeat(64)}`, safe: `sha256:${'e'.repeat(64)}` },
  exhibits: [{ id: 'exhibit-witness-1', sha256: 'b'.repeat(64), path: 'exhibits/w.json' }],
  results: ['exhibit-witness-1'],
  verdictSha256: 'c'.repeat(64),
  toolVersions: { judge: '0.0.0' },
});

/** A throwaway key pair, as `cosign generate-key-pair` makes it (encrypted private key). */
function keyPair(dir: string, password: string): { key: string; pub: string } {
  execFileSync('cosign', ['generate-key-pair'], {
    cwd: dir,
    env: { PATH: process.env.PATH ?? '', HOME: dir, COSIGN_PASSWORD: password },
    stdio: 'ignore',
  });
  return { key: join(dir, 'cosign.key'), pub: readFileSync(join(dir, 'cosign.pub'), 'utf8') };
}

describe.runIf(hasCosign)('signing with cosign', { timeout: 120_000 }, () => {
  let root = '';
  let keys = { key: '', pub: '' };
  let otherPub = '';
  const PASSWORD = 'test-only-password';

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'affidavit-cosign-'));
    const a = join(root, 'a');
    const b = join(root, 'b');
    execFileSync('mkdir', ['-p', a, b]);
    keys = keyPair(a, PASSWORD);
    otherPub = keyPair(b, PASSWORD).pub;
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const signer = () =>
    new CosignSigner({ keyRef: keys.key, publicKeyPem: keys.pub, password: PASSWORD });

  it('signs the manifest as an in-toto statement that cosign verifies, offline and unlogged', async () => {
    const att = await signer().sign(MANIFEST);
    expect(att.statement.predicate).toMatchObject({ caseId: 'case-gate-001' });
    const bundle = JSON.parse(att.signature) as {
      verificationMaterial: { tlogEntries?: unknown[] };
    };
    expect(bundle.verificationMaterial.tlogEntries ?? []).toEqual([]);
    expect(await verifyAttestation(att, MANIFEST, keys.pub)).toEqual({ ok: true });
  });

  it('signs the gate verdict bundle manifest, and the subject is its manifest.json bytes', async () => {
    const bundle = await buildBundle(bundleInput());
    const att = await signer().sign(bundle.manifest);
    const manifestBytes = (await readTar(bundle.bytes)).get(MANIFEST_PATH);
    expect(att.statement.subject[0]?.digest.sha256).toBe(
      sha256Hex(manifestBytes ?? new Uint8Array()),
    );
    expect(await verifyAttestation(att, bundle.manifest, keys.pub)).toEqual({ ok: true });
  });

  it('does not verify for an altered manifest, another key, or an altered signature', async () => {
    const att = await signer().sign(MANIFEST);
    const altered = { ...MANIFEST, verdictSha256: 'd'.repeat(64) };
    expect(await verifyAttestation(att, altered, keys.pub)).toEqual({
      ok: false,
      reason: 'statement does not match the manifest',
    });
    expect(await verifyAttestation(att, MANIFEST, otherPub)).toEqual({
      ok: false,
      reason: 'signed with a different key',
    });
    // Same structure, one byte of the DSSE signature flipped: only cosign can catch this.
    const b = JSON.parse(att.signature) as { dsseEnvelope: { signatures: { sig: string }[] } };
    const sig = Buffer.from(b.dsseEnvelope.signatures[0]?.sig ?? '', 'base64');
    sig[sig.length - 1] = (sig[sig.length - 1] ?? 0) ^ 0xff;
    b.dsseEnvelope.signatures[0] = { sig: sig.toString('base64') };
    const r = await verifyAttestation({ ...att, signature: JSON.stringify(b) }, MANIFEST, keys.pub);
    expect(r.ok).toBe(false);
  });

  it('fails to sign with a wrong password, without leaking it', async () => {
    const bad = new CosignSigner({ keyRef: keys.key, publicKeyPem: keys.pub, password: 'wrong' });
    const err = await bad.sign(MANIFEST).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain('wrong');
  });

  it('signs through the service: the client gets an attestation that verifies', async () => {
    const socketPath = join(root, 'signer.sock');
    const running = await startSignerServer({ socketPath, signer: signer() });
    try {
      const att = await new SignerClient(socketPath).sign(MANIFEST);
      expect(await verifyAttestation(att, MANIFEST, keys.pub)).toEqual({ ok: true });
    } finally {
      await running.close();
    }
  });

  it('refuses to start with a key or password file that group or others can read', async () => {
    const pubPath = join(root, 'a', 'cosign.pub');
    const passwordFile = join(root, 'a', 'password');
    writeFileSync(passwordFile, `${PASSWORD}\n`, { mode: 0o600 });
    const env = {
      AFFIDAVIT_SIGNER_SOCKET: join(root, 's.sock'),
      AFFIDAVIT_SIGNER_KEY: keys.key,
      AFFIDAVIT_SIGNER_PUBLIC_KEY: pubPath,
      AFFIDAVIT_SIGNER_PASSWORD_FILE: passwordFile,
    };
    chmodSync(keys.key, 0o600);
    expect((await loadConfig(env)).signer.keyId).toMatch(/^sha256:[0-9a-f]{64}$/);
    chmodSync(keys.key, 0o640);
    await expect(loadConfig(env)).rejects.toThrow('the signing key is readable by group or others');
    chmodSync(keys.key, 0o600);
    chmodSync(passwordFile, 0o644);
    await expect(loadConfig(env)).rejects.toThrow('the key password file is readable');
  });
});
