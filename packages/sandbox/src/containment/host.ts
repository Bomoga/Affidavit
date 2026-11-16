import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HostHarness } from './suite.js';
import type { HostChecks, HostFixtures } from './types.js';

/** Environment variable the harness sets on the runner's own process, to catch env passthrough. */
export const CREDENTIAL_ENV = 'AFFIDAVIT_CONTAINMENT_CANARY';

export interface RealHostHarness extends HostHarness {
  close(): Promise<void>;
}

/**
 * Real host-side harness: a canary credential (file and env var), a fake evidence directory, and an
 * HTTP listener standing in for the orchestrator. `listenHost` should be an address a container
 * could route to if its network were open (the Docker bridge gateway), so a refused request means
 * the jail blocked it, not that nothing was listening.
 */
export async function createHostHarness(listenHost: string): Promise<RealHostHarness> {
  const root = await mkdtemp(join(tmpdir(), 'affidavit-containment-'));
  const credentialCanary = randomBytes(16).toString('hex');
  const evidenceCanary = randomBytes(16).toString('hex');
  const credentialPath = join(root, 'credential');
  const evidenceDir = join(root, 'evidence');
  await writeFile(credentialPath, credentialCanary, { mode: 0o600 });

  let requests = 0;
  const server: Server = createServer((_req, res) => {
    requests += 1;
    res.end('orchestrator');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, listenHost, resolve);
  });
  const { port } = server.address() as AddressInfo;
  const previousEnv = process.env[CREDENTIAL_ENV];
  process.env[CREDENTIAL_ENV] = credentialCanary;

  const fx: HostFixtures = {
    credentialCanary,
    credentialPath,
    evidenceCanary,
    evidenceDir,
    orchestratorUrl: `http://${listenHost}:${port}/`,
  };

  const evidenceSnapshot = async (): Promise<string> => {
    const names = (await readdir(evidenceDir)).sort();
    const contents = await Promise.all(names.map((n) => readFile(join(evidenceDir, n), 'utf8')));
    return JSON.stringify([names, contents]);
  };
  let expectedEvidence = '';

  return {
    fixtures: () => fx,
    async reset() {
      requests = 0;
      await rm(evidenceDir, { recursive: true, force: true });
      await mkdir(evidenceDir);
      await writeFile(join(evidenceDir, 'exhibit.bin'), evidenceCanary);
      expectedEvidence = await evidenceSnapshot();
    },
    async checks(): Promise<Omit<HostChecks, 'elapsedMs'>> {
      return {
        orchestratorRequests: requests,
        evidenceDirUnchanged: (await evidenceSnapshot()) === expectedEvidence,
      };
    },
    async close() {
      if (previousEnv === undefined) delete process.env[CREDENTIAL_ENV];
      else process.env[CREDENTIAL_ENV] = previousEnv;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    },
  };
}
