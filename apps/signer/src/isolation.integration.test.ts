import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Attestation, BundleManifest } from '@affidavit/contracts';
import { verifyAttestation } from '@affidavit/evidence';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * L2-09 done-when: "a test running as the API's identity cannot read the key material".
 * The signer runs as this user, with the key in a 0700 directory as a 0400 file. The API runs as
 * another uid that shares only the socket's group, and is given the key directory too (the worst
 * case: a mount it should never have). It must still fail to read the key, the password and the
 * directory, and must still get a signature that verifies. Docker only; sandbox host.
 */
const onSandboxHost = process.env.AFFIDAVIT_SANDBOX_HOST === '1';

/** Same pinned Node base as the Lane 2 images. */
const NODE_IMAGE =
  'node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a';
const API_UID = 10002;
const REPO = resolve(import.meta.dirname, '..', '..', '..');
const APP = join(REPO, 'apps', 'signer');
const TSX = join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs');

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

const docker = (args: string[]) => execFileSync('docker', args, { encoding: 'utf8' }).trim();

describe.runIf(onSandboxHost)('signing key isolation', { timeout: 300_000 }, () => {
  let root = '';
  let keys = '';
  let run = '';
  let cosign = '';
  let signerId = '';
  const uid = process.getuid?.() ?? 0;
  const gid = process.getgid?.() ?? 0;
  const name = `affidavit-signer-it-${process.pid}`;

  const common = (): string[] => [
    '--rm',
    '--network',
    'none',
    // SELinux would block these bind mounts (see sandbox-runner.md, label=disable decision).
    '--security-opt',
    'label=disable',
    '--security-opt',
    'no-new-privileges',
    '--cap-drop',
    'ALL',
    '--read-only',
    '--tmpfs',
    '/tmp',
    '-v',
    `${REPO}:${REPO}:ro`,
    '-v',
    `${keys}:${keys}:ro`,
    '-v',
    `${run}:${run}`,
    '-w',
    APP,
  ];

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'affidavit-isolation-'));
    chmodSync(root, 0o755);
    keys = join(root, 'keys');
    run = join(root, 'run');
    mkdirSync(keys, { mode: 0o700 });
    mkdirSync(run, { mode: 0o770 });
    chmodSync(run, 0o770);
    const password = 'isolation-test-password';
    execFileSync('cosign', ['generate-key-pair'], {
      cwd: keys,
      env: { PATH: process.env.PATH ?? '', HOME: keys, COSIGN_PASSWORD: password },
      stdio: 'ignore',
    });
    writeFileSync(join(keys, 'password'), password, { mode: 0o400 });
    chmodSync(join(keys, 'cosign.key'), 0o400);
    cosign = execFileSync('sh', ['-c', 'command -v cosign'], { encoding: 'utf8' }).trim();

    signerId = docker([
      'run',
      '--detach',
      '--name',
      name,
      ...common(),
      '--user',
      `${uid}:${gid}`,
      '-v',
      `${cosign}:/usr/local/bin/cosign:ro`,
      '-e',
      `AFFIDAVIT_SIGNER_SOCKET=${join(run, 'signer.sock')}`,
      '-e',
      `AFFIDAVIT_SIGNER_KEY=${join(keys, 'cosign.key')}`,
      '-e',
      `AFFIDAVIT_SIGNER_PUBLIC_KEY=${join(keys, 'cosign.pub')}`,
      '-e',
      `AFFIDAVIT_SIGNER_PASSWORD_FILE=${join(keys, 'password')}`,
      NODE_IMAGE,
      'node',
      TSX,
      'src/main.ts',
    ]);
    for (let i = 0; i < 120 && !existsSync(join(run, 'signer.sock')); i++) {
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!existsSync(join(run, 'signer.sock'))) {
      throw new Error(`signer did not start: ${docker(['logs', signerId])}`);
    }
  });

  afterAll(() => {
    try {
      if (signerId !== '') docker(['rm', '--force', signerId]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("the API's identity cannot read the key but gets a signature that verifies", async () => {
    const out = docker([
      'run',
      ...common(),
      '--user',
      `${API_UID}:${API_UID}`,
      '--group-add',
      String(gid),
      NODE_IMAGE,
      'node',
      TSX,
      'src/isolation-probe.ts',
      join(keys, 'cosign.key'),
      join(keys, 'password'),
      keys,
      join(run, 'signer.sock'),
      JSON.stringify(MANIFEST),
    ]);
    const probe = JSON.parse(out.split('\n').pop() ?? '') as {
      uid: number;
      key: string;
      password: string;
      keyDir: string;
      attestation: unknown;
    };
    expect(probe).toMatchObject({
      uid: API_UID,
      key: 'EACCES',
      password: 'EACCES',
      keyDir: 'EACCES',
    });
    const att = Attestation.parse(probe.attestation);
    const pub = readFileSync(join(keys, 'cosign.pub'), 'utf8');
    expect(await verifyAttestation(att, MANIFEST, pub)).toEqual({ ok: true });
  });
});
