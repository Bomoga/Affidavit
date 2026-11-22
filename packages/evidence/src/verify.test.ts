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
import { parseKeysFile, type PublishedKey } from './keys.js';
import { canonicalJson } from './canonical.js';
import { readTar, writeTar } from './tar.js';
import { bundleInput } from './test-helpers.js';
import { verifyMain } from './verify-main.js';
import {
  printable,
  renderVerification,
  VERIFY_EXIT,
  verifyBundleFiles,
  verifyPublic,
  type PublicVerification,
} from './verify.js';

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

/** A keys file entry for `publicKey`. */
const entry = (
  publicKey: string,
  status: PublishedKey['status'] = 'active',
  extra: Partial<PublishedKey> = {},
): PublishedKey => ({ keyId: publicKeyId(publicKey), publicKey, status, ...extra });
const keysFile = (...keys: PublishedKey[]): string => JSON.stringify({ schemaVersion: 1, keys });

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
    const r = await verifyPublic(bytes, att, [entry(pem()), entry(key)], {
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
    const r = await verifyPublic(
      tampered,
      JSON.stringify(fakeAttestation(manifest, key)),
      [entry(key)],
      {
        cosignPath: cosignOk,
      },
    );
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/^bundle integrity \(exhibit-witness-001\)/);
  });

  it('fails when the bundle is not the one the verdict names', async () => {
    const { bytes, manifest } = await buildBundle(bundleInput());
    const key = pem();
    const att = JSON.stringify(fakeAttestation(manifest, key));
    const other = await verifyPublic(bytes, att, [entry(key)], {
      expectedSha256: 'f'.repeat(64),
      cosignPath: cosignOk,
    });
    expect(!other.ok && other.reason).toMatch(/expected digest/);
    const bad = await verifyPublic(bytes, att, [entry(key)], {
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
    const r = await verifyPublic(
      altered,
      JSON.stringify(fakeAttestation(manifest, key)),
      [entry(key)],
      {
        cosignPath: cosignOk,
      },
    );
    expect(!r.ok && r.reason).toBe('manifest.json is not the canonical form of its manifest');
  });

  it('refuses an attestation for another bundle, a bad file, or an unknown key', async () => {
    const { bytes, manifest } = await buildBundle(bundleInput());
    const otherManifest = (await buildBundle(bundleInput({ createdAt: '2026-01-01T00:00:00Z' })))
      .manifest;
    const key = pem();
    const opts = { cosignPath: cosignOk };
    const reason = async (att: string, keys = [entry(key)]) => {
      const r = await verifyPublic(bytes, att, keys, opts);
      return r.ok ? 'ok' : r.reason;
    };
    expect(await reason(JSON.stringify(fakeAttestation(otherManifest, key)))).toMatch(
      /statement does not match the manifest/,
    );
    expect(await reason('not json')).toBe('the attestation file is not JSON');
    expect(await reason('{"schemaVersion":1}')).toBe('the attestation file is not an attestation');
    const att = JSON.stringify(fakeAttestation(manifest, key));
    expect(await reason(att, [entry(pem())])).toMatch(/which is none of the published keys/);
    expect(await reason(att, [])).toBe('no published key given');
    const notPem = { ...entry(key), publicKey: '-----BEGIN PUBLIC KEY-----\nnope\n' };
    expect(await reason(att, [notPem])).toBe('published key 1 is not a PEM public key');
    const wrongId = { ...entry(key), keyId: publicKeyId(pem()) };
    expect(await reason(att, [wrongId])).toBe(
      "published key 1 has a keyId that is not its key's id",
    );
    // The same key id twice is refused, not last-wins (an active copy hiding a revoked one).
    expect(await reason(att, [entry(key, 'revoked'), entry(key)])).toBe(
      `published key 2 repeats ${publicKeyId(key)}`,
    );
  });

  it('refuses a signature by a key the keys file marks revoked, whatever its revokedAt', async () => {
    const { bytes, manifest } = await buildBundle(bundleInput());
    const oldKey = pem();
    const newKey = pem();
    const att = JSON.stringify(fakeAttestation(manifest, oldKey));
    const opts = { cosignPath: cosignOk };
    const revokedEntry = entry(oldKey, 'revoked', { revokedAt: '2099-01-01T00:00:00Z' });
    const r = await verifyPublic(bytes, att, [entry(newKey), revokedEntry], opts);
    expect(!r.ok && r.reason).toBe(`signed by key ${publicKeyId(oldKey)}, which is revoked`);
    // The same key, still active, verifies; revoking another key leaves this one verifying.
    expect((await verifyPublic(bytes, att, [entry(newKey), entry(oldKey)], opts)).ok).toBe(true);
    const fresh = JSON.stringify(fakeAttestation(manifest, newKey));
    expect((await verifyPublic(bytes, fresh, [entry(newKey), revokedEntry], opts)).ok).toBe(true);
  });

  it('refuses a key named by the revokedKeyIds override, even when the file says active', async () => {
    const { bytes, manifest } = await buildBundle(bundleInput());
    const oldKey = pem();
    const newKey = pem();
    const att = JSON.stringify(fakeAttestation(manifest, oldKey));
    const opts = { cosignPath: cosignOk, revokedKeyIds: [publicKeyId(oldKey)] };
    const keys = [entry(newKey), entry(oldKey)];
    const r = await verifyPublic(bytes, att, keys, opts);
    expect(!r.ok && r.reason).toBe(`signed by key ${publicKeyId(oldKey)}, which is revoked`);
    const fresh = JSON.stringify(fakeAttestation(manifest, newKey));
    expect((await verifyPublic(bytes, fresh, keys, opts)).ok).toBe(true);
    const bad = await verifyPublic(bytes, fresh, keys, { ...opts, revokedKeyIds: ['k1'] });
    expect(!bad.ok && bad.reason).toMatch(/revoked key id "k1" is not sha256:<64 hex>/);
  });

  it('fails when cosign rejects the signature, and says cosign is missing rather than passing', async () => {
    const { bytes, manifest } = await buildBundle(bundleInput());
    const key = pem();
    const att = JSON.stringify(fakeAttestation(manifest, key));
    const r = await verifyPublic(bytes, att, [entry(key)], { cosignPath: cosignBad });
    expect(!r.ok && r.reason).toBe('signature: cosign: invalid signature');
    await expect(
      verifyPublic(bytes, att, [entry(key)], { cosignPath: join(dir, 'no-such-cosign') }),
    ).rejects.toThrow(/cosign is not installed/);
  });
});

describe('parseKeysFile', () => {
  it('accepts a well formed file and refuses every malformed one', () => {
    const a = pem();
    const b = pem();
    const good = parseKeysFile(
      keysFile(
        entry(a, 'active', { validFrom: '2026-11-21T00:00:00Z' }),
        entry(b, 'revoked', { revokedAt: '2026-12-01T00:00:00Z' }),
      ),
    );
    expect(good.ok && good.keys.map((k) => k.status)).toEqual(['active', 'revoked']);
    const reason = (text: string) => {
      const r = parseKeysFile(text);
      return r.ok ? 'ok' : r.reason;
    };
    expect(reason('nope')).toBe('the keys file is not JSON');
    expect(reason('{"schemaVersion":1,"keys":[]}')).toMatch(/is not a keys file at keys/);
    expect(reason(JSON.stringify({ keys: [entry(a)] }))).toMatch(/is not a keys file/);
    expect(reason(keysFile({ ...entry(a), status: 'retired' as 'active' }))).toMatch(
      /is not a keys file at keys\.0\.status/,
    );
    expect(reason(keysFile({ ...entry(a), note: 'x' } as PublishedKey))).toMatch(
      /is not a keys file/,
    );
    expect(reason(keysFile(entry(a, 'active', { revokedAt: 'yesterday' })))).toMatch(
      /is not a keys file at keys\.0\.revokedAt/,
    );
    expect(reason(keysFile({ ...entry(a), keyId: publicKeyId(b) }))).toMatch(
      /keyId that is not its key's id at keys\.0/,
    );
    expect(reason(keysFile({ ...entry(a), publicKey: 'nope' }))).toMatch(
      /not a PEM public key at keys\.0/,
    );
    expect(reason(keysFile(entry(a), entry(a)))).toMatch(/twice/);
    expect(reason(keysFile(entry(a, 'active', { revokedAt: '2026-12-01T00:00:00Z' })))).toMatch(
      /revokedAt on a key that is not revoked/,
    );
    const dated = (extra: Partial<PublishedKey>) =>
      reason(keysFile(entry(a, 'revoked', { validFrom: '2026-11-21T00:00:00Z', ...extra })));
    expect(dated({ retiredAt: '2026-11-20T00:00:00Z' })).toMatch(/retiredAt before validFrom/);
    expect(dated({ revokedAt: '2026-11-20T00:00:00Z' })).toMatch(/revokedAt before validFrom/);
    expect(dated({ retiredAt: '2026-11-22T00:00:00Z', revokedAt: '2026-11-23T00:00:00Z' })).toBe(
      'ok',
    );
  });

  it('accepts only exactly one PEM public key block per key', () => {
    const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const pub = pair.publicKey.export({ type: 'spki', format: 'pem' }) as string;
    const priv = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    const reason = (publicKey: string, keyId = publicKeyId(pub)) => {
      const r = parseKeysFile(keysFile({ keyId, publicKey, status: 'active' }));
      return r.ok ? 'ok' : r.reason;
    };
    expect(reason(pub)).toBe('ok');
    expect(reason(pub.replace(/\n/g, '\r\n'))).toBe('ok');
    expect(reason(pub.trimEnd())).toBe('ok');
    // A private key derives the same public key and keyId; it must never be published.
    expect(publicKeyId(priv)).toBe(publicKeyId(pub));
    expect(reason(priv)).toBe(
      'the keys file has a publicKey that is a private key, not a public key at keys.0',
    );
    expect(reason(`${pub}${pem()}`)).toMatch(/is not exactly one PEM public key block at keys\.0/);
    expect(reason(`note: ours\n${pub}`)).toMatch(/is not exactly one PEM public key block/);
    expect(reason(`${pub}trailing text\n`)).toMatch(/is not exactly one PEM public key block/);
    const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 });
    const rsaPub = rsa.publicKey.export({ type: 'spki', format: 'pem' }) as string;
    expect(reason(rsaPub, publicKeyId(rsaPub))).toMatch(/is an RSA key under 2048 bits/);
  });

  it('refuses a member name repeated in one object, which JSON.parse would let the last one win', () => {
    const a = pem();
    const e = entry(a, 'revoked');
    const twice = JSON.stringify({ schemaVersion: 1, keys: [e] }).replace(
      '"status":"revoked"',
      '"status":"revoked","status":"active"',
    );
    expect(JSON.parse(twice)).toMatchObject({ keys: [{ status: 'active' }] });
    const r = parseKeysFile(twice);
    expect(!r.ok && r.reason).toBe('the keys file repeats the member "status"');
    // The same name in different objects is fine; a name spelled with an escape still counts.
    expect(parseKeysFile(keysFile(entry(a), entry(pem()))).ok).toBe(true);
    const escaped = twice.replace('"status":"active"', '"st\\u0061tus":"active"');
    expect(parseKeysFile(escaped)).toEqual({
      ok: false,
      reason: 'the keys file repeats the member "status"',
    });
    const top = `{"schemaVersion":1,"schemaVersion":1,"keys":${JSON.stringify([entry(a)])}}`;
    expect(parseKeysFile(top)).toEqual({
      ok: false,
      reason: 'the keys file repeats the member "schemaVersion"',
    });
  });
});

describe('what verify prints', () => {
  it('escapes control, bidi and separator characters, U+061C included', () => {
    expect(printable('a\nVERIFIED')).toBe('a\\u{000a}VERIFIED');
    expect(printable('x‮y؜z ​\u0007')).toBe('x\\u{202e}y\\u{061c}z\\u{2028}\\u{200b}\\u{0007}');
    expect(printable('plain case-1 sha256:ab')).toBe('plain case-1 sha256:ab');
    const result: PublicVerification = {
      ok: true,
      bundleSha256: 'a'.repeat(64),
      caseId: 'case\nVERIFIED‮',
      outcome: 'proven-unfixed',
      exhibits: 1,
      keyId: `sha256:${'b'.repeat(64)}`,
    };
    const lines = renderVerification(result);
    expect(lines).toContain('case case\\u{000a}VERIFIED\\u{202e}');
    expect(lines.filter((l) => l === 'VERIFIED')).toHaveLength(1);
    expect(renderVerification({ ok: false, bundleSha256: 'a', reason: 'x\nVERIFIED' })).toEqual([
      'bundle sha256:a',
      'NOT VERIFIED: x\\u{000a}VERIFIED',
    ]);
  });

  it('never echoes a keyId that is not a key id as it came, so it cannot add a VERIFIED line', async () => {
    const { bytes, manifest } = await buildBundle(bundleInput());
    const key = pem();
    const forged = { ...fakeAttestation(manifest, key), keyId: 'x\nVERIFIED' };
    const r = await verifyPublic(bytes, JSON.stringify(forged), [entry(key)], {
      cosignPath: cosignOk,
    });
    expect(!r.ok && r.reason).toBe(
      'signed by key "x\\nVERIFIED", which is none of the published keys',
    );
    const lines: string[] = [];
    const code = await verifyMain(
      [
        write('forged.tar', bytes),
        write('forged.att.json', JSON.stringify(forged)),
        '--keys',
        write('forged.keys.json', keysFile(entry(key))),
        '--cosign',
        cosignOk,
      ],
      (l) => lines.push(l),
    );
    expect(code).toBe(VERIFY_EXIT.FAILED);
    expect(lines.join('\n')).not.toMatch(/^VERIFIED$/m);
  });
});

describe('verifyBundleFiles and the verify command', () => {
  it('prints the verdict and exits 0 when verified, 1 when not or when the key is revoked', async () => {
    const { bytes, manifest, sha256 } = await buildBundle(bundleInput());
    const key = pem();
    const bundle = write('ok.tar', bytes);
    const att = write('ok.att.json', JSON.stringify(fakeAttestation(manifest, key)));
    const keys = write('ok.keys.json', keysFile(entry(pem()), entry(key)));
    const lines: string[] = [];
    const out = (l: string) => lines.push(l);
    const ok = await verifyMain(
      [bundle, att, '--keys', keys, '--expect-sha256', sha256, '--cosign', cosignOk],
      out,
    );
    expect(ok).toBe(VERIFY_EXIT.VERIFIED);
    expect(lines[0]).toBe(`bundle sha256:${sha256}`);
    expect(lines.at(-1)).toBe('VERIFIED');
    expect(lines).toContain(`signed by ${publicKeyId(key)}`);

    lines.length = 0;
    const bad = await verifyMain([bundle, att, '--keys', keys, '--cosign', cosignBad], out);
    expect(bad).toBe(VERIFY_EXIT.FAILED);
    expect(lines.at(-1)).toBe('NOT VERIFIED: signature: cosign: invalid signature');

    // Revoked in the keys file: refused with no --revoked flag at all.
    lines.length = 0;
    const revokedKeys = write(
      'revoked.keys.json',
      keysFile(entry(pem()), entry(key, 'revoked', { revokedAt: '2026-12-01T00:00:00Z' })),
    );
    const revoked = await verifyMain(
      [bundle, att, '--keys', revokedKeys, '--cosign', cosignOk],
      out,
    );
    expect(revoked).toBe(VERIFY_EXIT.FAILED);
    expect(lines.at(-1)).toBe(`NOT VERIFIED: signed by key ${publicKeyId(key)}, which is revoked`);

    // --revoked on top of a file that still says active.
    lines.length = 0;
    const override = await verifyMain(
      [bundle, att, '--keys', keys, '--revoked', publicKeyId(key), '--cosign', cosignOk],
      out,
    );
    expect(override).toBe(VERIFY_EXIT.FAILED);
    expect(lines.at(-1)).toMatch(/which is revoked$/);
  });

  it('escapes control characters from the untrusted manifest, so a crafted id cannot forge output', async () => {
    const { bytes, manifest } = await buildBundle(bundleInput());
    const key = pem();
    // An exhibit id that, printed raw, would end the line, clear it and print a fake success.
    const forged = 'x\nVERIFIED\u001b[2K\r\u2028\u202e';
    const crafted = {
      ...manifest,
      exhibits: manifest.exhibits.map((e, i) => (i === 0 ? { ...e, id: forged } : e)),
    };
    const altered = await rewrite(bytes, MANIFEST_PATH, Buffer.from(canonicalJson(crafted)));
    const r = await verifyPublic(
      altered,
      JSON.stringify(fakeAttestation(manifest, key)),
      [entry(key)],
      {
        cosignPath: cosignOk,
      },
    );
    expect(r.ok).toBe(false);
    const reason = !r.ok ? r.reason : '';
    expect(reason).toBe(
      'bundle integrity (x\\u{000a}VERIFIED\\u{001b}[2K\\u{000d}\\u{2028}\\u{202e}): is filed under the wrong path',
    );
    // eslint-disable-next-line no-control-regex
    expect(reason).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u202e]/);

    const lines: string[] = [];
    const code = await verifyMain(
      [
        write('forged-id.tar', altered),
        write('forged-id.att.json', JSON.stringify(fakeAttestation(manifest, key))),
        '--keys',
        write('forged-id.keys.json', keysFile(entry(key))),
        '--cosign',
        cosignOk,
      ],
      (l) => lines.push(l),
    );
    expect(code).toBe(VERIFY_EXIT.FAILED);
    expect(lines).toHaveLength(2);
    expect(lines.join('\n').split(/\r?\n|\r/)).toHaveLength(2);
    expect(lines).not.toContain('VERIFIED');
    expect(lines[1]).toMatch(/^NOT VERIFIED: bundle integrity/);
  });

  it('exits 2 without a readable, well formed keys file, on bad usage, and 3 without cosign', async () => {
    const { bytes, manifest } = await buildBundle(bundleInput());
    const key = pem();
    const bundle = write('u.tar', bytes);
    const att = write('u.att.json', JSON.stringify(fakeAttestation(manifest, key)));
    const keys = write('u.keys.json', keysFile(entry(key)));
    const pub = write('u.pub', key);
    const lines: string[] = [];
    const out = (l: string) => lines.push(l);
    // No keys file: never verified, whatever else is passed.
    expect(await verifyMain([bundle, att, '--cosign', cosignOk], out)).toBe(VERIFY_EXIT.USAGE);
    expect(lines[0]).toMatch(/--keys <keys file> is required/);
    // The old --key flag is gone, so a bare public key cannot skip the status list.
    expect(await verifyMain([bundle, att, '--key', pub, '--cosign', cosignOk], out)).toBe(
      VERIFY_EXIT.USAGE,
    );
    // Missing, unreadable (a directory), or malformed keys files.
    lines.length = 0;
    expect(await verifyMain([bundle, att, '--keys', join(dir, 'missing.json')], out)).toBe(
      VERIFY_EXIT.USAGE,
    );
    expect(lines.at(-1)).toMatch(/keys file .* cannot be read/);
    expect(await verifyMain([bundle, att, '--keys', dir], out)).toBe(VERIFY_EXIT.USAGE);
    // A bare PEM is not a keys file.
    lines.length = 0;
    expect(await verifyMain([bundle, att, '--keys', pub, '--cosign', cosignOk], out)).toBe(
      VERIFY_EXIT.USAGE,
    );
    expect(lines.at(-1)).toMatch(/the keys file is not JSON/);
    const empty = write('empty.keys.json', '{"schemaVersion":1,"keys":[]}');
    expect(await verifyMain([bundle, att, '--keys', empty, '--cosign', cosignOk], out)).toBe(
      VERIFY_EXIT.USAGE,
    );
    expect(await verifyMain([bundle, att], out)).toBe(VERIFY_EXIT.USAGE);
    expect(await verifyMain([bundle, '--keys', keys], out)).toBe(VERIFY_EXIT.USAGE);
    expect(await verifyMain([bundle, att, '--keys', keys, '--bogus'], out)).toBe(VERIFY_EXIT.USAGE);
    expect(await verifyMain([bundle, att, '--keys', keys, '--revoked', 'old'], out)).toBe(
      VERIFY_EXIT.USAGE,
    );
    expect(await verifyMain([dir, att, '--keys', keys], out)).toBe(VERIFY_EXIT.USAGE);
    expect(
      await verifyBundleFiles({
        bundlePath: bundle,
        attestationPath: att,
        keysPath: keys,
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
        '--keys',
        write('real.keys.json', keysFile(entry(older), entry(pub))),
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
    const r = await verifyPublic(bytes, JSON.stringify(flipped), [entry(pub)]);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/^signature: cosign:/);
  });
});
