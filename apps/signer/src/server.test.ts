import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BundleManifest, type Attestation, type SignerPort } from '@affidavit/contracts';
import {
  IN_TOTO_PAYLOAD_TYPE,
  canonicalJson,
  manifestStatement,
  publicKeyId,
} from '@affidavit/evidence';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SignerClient, SignerUnavailableError } from './client.js';
import { SIGN_PATH, startSignerServer, type RunningSigner } from './server.js';

const MANIFEST = BundleManifest.parse({
  schemaVersion: 1,
  caseId: 'case-gate-001',
  createdAt: '2026-11-18T00:00:00.000Z',
  targetDigests: { vulnerable: `sha256:${'a'.repeat(64)}` },
  exhibits: [{ id: 'exhibit-witness-1', sha256: 'b'.repeat(64), path: 'exhibits/w.json' }],
  results: ['exhibit-witness-1'],
  verdictSha256: 'c'.repeat(64),
  toolVersions: { judge: '0.0.0' },
});

const PEM = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({
  type: 'spki',
  format: 'pem',
}) as string;

/** What cosign would return for `m`, with a made-up signature (structure only). */
function fakeAttestation(m: BundleManifest): Attestation {
  const statement = manifestStatement(m);
  const keyId = publicKeyId(PEM);
  return {
    schemaVersion: 1,
    statement,
    keyId,
    signature: JSON.stringify({
      mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
      verificationMaterial: {
        publicKey: { hint: Buffer.from(keyId.slice(7), 'hex').toString('base64') },
      },
      dsseEnvelope: {
        payload: Buffer.from(canonicalJson(statement)).toString('base64'),
        payloadType: IN_TOTO_PAYLOAD_TYPE,
        signatures: [{ sig: 'MEUCIQ' }],
      },
    }),
  };
}

class FakeSigner implements SignerPort {
  readonly seen: BundleManifest[] = [];
  constructor(private readonly behave: 'ok' | 'throw' | 'other-manifest' = 'ok') {}
  sign(m: BundleManifest): Promise<Attestation> {
    this.seen.push(m);
    if (this.behave === 'throw')
      return Promise.reject(new Error('/secret/path/cosign.key: bad password'));
    if (this.behave === 'other-manifest') {
      return Promise.resolve(fakeAttestation({ ...m, verdictSha256: 'd'.repeat(64) }));
    }
    return Promise.resolve(fakeAttestation(m));
  }
}

function raw(
  socketPath: string,
  opts: { method?: string; path?: string; type?: string; body?: string },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath,
        method: opts.method ?? 'POST',
        path: opts.path ?? SIGN_PATH,
        headers: { 'content-type': opts.type ?? 'application/json' },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.on('error', reject);
    req.end(opts.body ?? '');
  });
}

describe('signer service over a unix socket', () => {
  let dir = '';
  let socket = '';
  let running: RunningSigner | undefined;
  const errors: unknown[] = [];

  const start = async (signer: SignerPort, maxBodyBytes?: number) => {
    running = await startSignerServer({
      socketPath: socket,
      signer,
      onError: (e) => errors.push(e),
      ...(maxBodyBytes === undefined ? {} : { maxBodyBytes }),
    });
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'affidavit-signer-'));
    socket = join(dir, 'signer.sock');
    errors.length = 0;
  });
  afterEach(async () => {
    await running?.close();
    running = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  it('signs a manifest for a client and the socket is owner and group only', async () => {
    const signer = new FakeSigner();
    await start(signer);
    expect(statSync(socket).mode & 0o777).toBe(0o660);
    const att = await new SignerClient(socket).sign(MANIFEST);
    expect(att.statement.subject[0]?.name).toBe('affidavit/case-gate-001/manifest.json');
    expect(signer.seen).toEqual([MANIFEST]);
  });

  it('answers only POST application/json to the sign route, and only for a manifest', async () => {
    await start(new FakeSigner(), 4096);
    const cases: [Parameters<typeof raw>[1], number][] = [
      [{ path: '/v1/keys' }, 404],
      [{ method: 'GET' }, 405],
      [{ type: 'text/plain', body: '{}' }, 415],
      [{ body: 'not json' }, 400],
      [{ body: JSON.stringify({ ...MANIFEST, caseId: undefined }) }, 400],
      [{ body: JSON.stringify({ statement: { _type: 'chosen by the caller' } }) }, 400],
      [{ body: 'x'.repeat(8192) }, 413],
    ];
    for (const [opts, status] of cases) {
      expect((await raw(socket, opts)).status, JSON.stringify(opts).slice(0, 60)).toBe(status);
    }
  });

  it('never tells the client why signing failed', async () => {
    await start(new FakeSigner('throw'));
    const r = await raw(socket, { body: JSON.stringify(MANIFEST) });
    expect(r).toEqual({ status: 500, body: JSON.stringify({ error: 'signing failed' }) });
    expect(errors).toHaveLength(1);
    await expect(new SignerClient(socket).sign(MANIFEST)).rejects.toThrow(
      'signer refused: signing failed',
    );
  });

  it('client refuses an attestation for a different manifest', async () => {
    await start(new FakeSigner('other-manifest'));
    await expect(new SignerClient(socket).sign(MANIFEST)).rejects.toThrow(
      'signer returned a bad attestation: statement does not match the manifest',
    );
  });

  it('client reports a signer that is not running', async () => {
    await expect(new SignerClient(join(dir, 'missing.sock')).sign(MANIFEST)).rejects.toBeInstanceOf(
      SignerUnavailableError,
    );
  });

  it('replaces a stale socket but never another file at the socket path', async () => {
    writeFileSync(socket, 'not a socket');
    await expect(
      startSignerServer({ socketPath: socket, signer: new FakeSigner() }),
    ).rejects.toThrow();
  });
});
