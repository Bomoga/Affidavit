import { execFile } from 'node:child_process';
import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  Attestation,
  BundleManifest,
  CaseFile,
  CaseFileSource,
  CaseId,
  EvidenceStore,
  SignerPort,
  TenantId,
  ToolRunnerPort,
} from '@affidavit/contracts';
import { sha256Hex } from './hash.js';

/** Serves case files from an in-memory list, normally loaded from fixtures/casefiles. */
export class FakeCaseFileSource implements CaseFileSource {
  private readonly queue: CaseFile[];

  constructor(private readonly all: readonly CaseFile[]) {
    this.queue = [...all];
  }

  next(tenantId: TenantId): Promise<CaseFile | null> {
    const i = this.queue.findIndex((c) => c.tenantId === tenantId);
    if (i < 0) return Promise.resolve(null);
    return Promise.resolve(this.queue.splice(i, 1)[0] ?? null);
  }

  get(caseId: CaseId): Promise<CaseFile | null> {
    return Promise.resolve(this.all.find((c) => c.id === caseId) ?? null);
  }
}

/** Content-addressed store in a temp directory. */
export class FakeEvidenceStore implements EvidenceStore {
  private dir: Promise<string> | undefined;

  private root(): Promise<string> {
    this.dir ??= mkdtemp(join(tmpdir(), 'affidavit-evidence-'));
    return this.dir;
  }

  async put(bytes: Uint8Array): Promise<string> {
    const sha = sha256Hex(bytes);
    await writeFile(join(await this.root(), sha), bytes);
    return sha;
  }

  async get(sha256: string): Promise<Uint8Array | null> {
    if (!/^[0-9a-f]{64}$/.test(sha256)) return null;
    try {
      return await readFile(join(await this.root(), sha256));
    } catch {
      return null;
    }
  }
}

/** Signs with a throwaway ed25519 key generated per instance. Never use for real verdicts. */
export class FakeSigner implements SignerPort {
  private readonly privateKey: KeyObject;
  readonly keyId = 'throwaway-test-key';

  constructor() {
    this.privateKey = generateKeyPairSync('ed25519').privateKey;
  }

  sign(manifest: BundleManifest): Promise<Attestation> {
    const digest = sha256Hex(JSON.stringify(manifest));
    const signature = cryptoSign(null, Buffer.from(digest, 'hex'), this.privateKey).toString(
      'base64',
    );
    return Promise.resolve({
      schemaVersion: 1,
      statement: {
        _type: 'https://in-toto.io/Statement/v1',
        subject: [{ name: `bundle:${manifest.caseId}`, digest: { sha256: digest } }],
        predicateType: 'https://affidavit.dev/verdict/v1',
        predicate: { caseId: manifest.caseId },
      },
      signature,
      keyId: this.keyId,
    });
  }
}

export interface Mount {
  hostPath: string;
  containerPath: string;
  readOnly: boolean;
}

/**
 * The docker arguments the Phase 1 tool runner uses. Pure so tests can assert the safety flags:
 * no network, read-only root, dropped capabilities, no privileged mode, no socket mounts.
 */
export function buildDockerRunArgs(
  image: string,
  args: readonly string[],
  mounts: readonly Mount[],
): string[] {
  for (const m of mounts) {
    if (/docker\.sock/.test(m.hostPath)) throw new Error('refusing to mount the Docker socket');
  }
  return [
    'run',
    '--rm',
    '--network',
    'none',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    '256',
    '--memory',
    '1g',
    ...mounts.flatMap((m) => ['-v', `${m.hostPath}:${m.containerPath}${m.readOnly ? ':ro' : ''}`]),
    image,
    ...args,
  ];
}

/** Plain local Docker, good enough for Phase 1 until Lane 2 hardens it. Needs a Docker daemon. */
export class LocalDockerToolRunner implements ToolRunnerPort {
  constructor(private readonly outputDir: string) {}

  run(
    image: string,
    args: readonly string[],
    mounts: readonly Mount[],
  ): Promise<{ exitCode: number; outputPath: string }> {
    const dockerArgs = buildDockerRunArgs(image, args, mounts);
    return new Promise((resolve) => {
      execFile('docker', dockerArgs, (error) => {
        const code = error && typeof error.code === 'number' ? error.code : error ? 1 : 0;
        resolve({ exitCode: code, outputPath: this.outputDir });
      });
    });
  }
}
