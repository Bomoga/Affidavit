import type { ExternalStub } from '@affidavit/contracts';
import { PROBE_IMAGE } from '../containment/probes.js';
import { tmpfsPathProblem } from '../gvisor/args.js';
import { runJailed } from '../gvisor/runner.js';
import { startJailedService, type CaseNetwork, type RunningService } from '../gvisor/network.js';
import { imageVolumes, pinImage } from './images.js';
import { recipeProblem, type BootRecipe } from './recipe.js';

/** Configuration, not measurements. */
const SERVICE_TMP_MB = 64;
const VOLUME_TMPFS_MB = 512;
const DIAGNOSIS_MAX_MS = 60_000;

/**
 * Local fakes for external services the target needs to boot (`ExternalStub`). They answer
 * anything with an empty success, on the service's usual port, inside the case network. HTTPS is
 * not stubbed: the target would not trust a stub's certificate.
 */
const STUB_SCRIPT = `
const kind = process.argv[1];
if (kind === 'smtp') {
  require('net').createServer((s) => {
    s.write('220 stub ESMTP\\r\\n');
    let data = false;
    s.on('data', (b) => {
      for (const line of b.toString().split('\\r\\n').filter(Boolean)) {
        if (data) { if (line === '.') { data = false; s.write('250 OK\\r\\n'); } continue; }
        const v = line.slice(0, 4).toUpperCase();
        if (v === 'DATA') { data = true; s.write('354 go\\r\\n'); }
        else if (v === 'QUIT') { s.end('221 bye\\r\\n'); }
        else s.write('250 OK\\r\\n');
      }
    });
    s.on('error', () => {});
  }).listen(25);
} else {
  require('http').createServer((req, res) => {
    req.resume();
    res.setHeader('content-type', kind === 's3' ? 'application/xml' : 'application/json');
    res.end(kind === 's3' ? '<?xml version="1.0"?><ok/>' : '{}');
  }).listen(80);
}
`;

const HEALTH_SCRIPT = `
const [url, ms] = [process.argv[1], Number(process.argv[2])];
const deadline = Date.now() + ms;
(async () => {
  for (;;) {
    try {
      const r = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
      if (r.status >= 200 && r.status < 400) { console.log('healthy ' + r.status); process.exit(0); }
    } catch {}
    if (Date.now() > deadline) { console.log('unhealthy'); process.exit(1); }
    await new Promise((r) => setTimeout(r, 500));
  }
})();
`;

export type BootOutcome =
  | {
      status: 'healthy';
      /** Base URL the witness uses, with `target` as the host name. */
      url: string;
      /** Host names for the witness's /etc/hosts. */
      hosts: Record<string, string>;
      services: RunningService[];
      /** Pinned sidecar images, by service name, for the evidence bundle. */
      sidecarImages: Record<string, string>;
    }
  /** The target cannot boot without something the MVP will not grant (real egress, for one). */
  | { status: 'unsupported'; reason: string }
  | { status: 'failed'; reason: string };

/**
 * Boots a built target (see build.ts) on a case network: stubs, then sidecars, then the seed
 * script, then the target, then waits on the health route from a probe on the same network.
 * When the target never becomes healthy, it is run once more under the syscall trace; if it tried
 * to reach anything outside the case network it is `unsupported`, otherwise `failed`.
 *
 * Every container joins the case network, so `removeCaseNetwork` tears all of it down.
 */
export async function bootTarget(
  net: CaseNetwork,
  imageId: string,
  recipe: BootRecipe,
): Promise<BootOutcome> {
  // The recipe is plain data and may not have come from deriveRecipe: check it again, so a bad
  // alias, env key or working directory is an outcome, not an exception mid-boot.
  const problem = recipeProblem(recipe);
  if (problem !== null) return { status: 'unsupported', reason: problem };
  // Docker or the jail can still throw (a pull, a start, a teardown check). That is an outcome
  // too: whatever was started is on the case network, which the caller removes.
  try {
    return await boot(net, imageId, recipe);
  } catch (err) {
    return { status: 'failed', reason: `boot error: ${(err as Error).message.slice(0, 800)}` };
  }
}

async function boot(net: CaseNetwork, imageId: string, recipe: BootRecipe): Promise<BootOutcome> {
  const services: RunningService[] = [];
  const hosts: Record<string, string> = {};
  const sidecarImages: Record<string, string> = {};

  for (const stub of recipe.stubs) {
    services.push(await startStub(net, stub));
    hosts[stub.hostAlias] = (services.at(-1) as RunningService).ip;
  }

  for (const sc of recipe.sidecars) {
    let image: string;
    try {
      image = await pinImage(sc.image);
    } catch (err) {
      return {
        status: 'unsupported',
        reason: `sidecar ${sc.name}: ${(err as Error).message.slice(0, 300)}`,
      };
    }
    sidecarImages[sc.name] = image;
    let volumes: string[];
    try {
      volumes = await imageVolumes(image);
    } catch (err) {
      return {
        status: 'unsupported',
        reason: `sidecar ${sc.name}: ${(err as Error).message.slice(0, 300)}`,
      };
    }
    // The image is untrusted: a VOLUME the jail cannot put a tmpfs over (`/tmp`, `/etc`, ...)
    // makes the sidecar unsupported rather than an exception while its flags are built.
    const badVolume = volumes.map(tmpfsPathProblem).find((p) => p !== null);
    if (badVolume !== undefined) {
      return { status: 'unsupported', reason: `sidecar ${sc.name}: image volume ${badVolume}` };
    }
    const svc = await startJailedService(net, {
      image,
      command: sc.command ?? [],
      alias: sc.name,
      env: sc.env,
      hosts: { ...hosts },
      tmpfs: volumes.map((path) => ({ path, sizeMb: VOLUME_TMPFS_MB })),
      writableTmpMb: SERVICE_TMP_MB,
    });
    services.push(svc);
    hosts[sc.name] = svc.ip;
  }

  const targetRun = {
    image: imageId,
    mounts: [],
    env: recipe.env,
    workdir: recipe.workdir,
    writableTmpMb: SERVICE_TMP_MB,
  };

  // The seed is a script from the target's own repository, run with the target's image on the
  // case network before the target starts. It is untrusted code under the same jail as the
  // target (gVisor, no route out, no host path); accepting it at all is a lead decision pending
  // sign-off (boot-recipes.md, "Seeding").
  if (recipe.seedScript !== undefined) {
    const seed = await runJailed(
      {
        ...targetRun,
        command: ['node', recipe.seedScript],
        network: { net, hosts },
        timeoutMs: recipe.healthTimeoutMs,
      },
      { trace: false },
    );
    if (seed.exitCode !== 0) {
      return { status: 'failed', reason: `seed script failed: ${seed.stderr.slice(-800)}` };
    }
  }

  const target = await startJailedService(net, {
    ...targetRun,
    command: recipe.command,
    alias: 'target',
    hosts: { ...hosts },
  });
  services.push(target);
  const url = `http://target:${recipe.port}`;

  const health = await runJailed(
    {
      image: PROBE_IMAGE,
      command: [
        'node',
        '-e',
        HEALTH_SCRIPT,
        `${url}${recipe.healthRoute}`,
        String(recipe.healthTimeoutMs),
      ],
      mounts: [],
      network: { net, hosts: { target: target.ip } },
      timeoutMs: recipe.healthTimeoutMs + 15_000,
    },
    { trace: false },
  );
  if (health.exitCode === 0) {
    return {
      status: 'healthy',
      url,
      hosts: { ...hosts, target: target.ip },
      services,
      sidecarImages,
    };
  }

  const diagnosis = await runJailed(
    {
      ...targetRun,
      command: recipe.command,
      network: { net, hosts },
      timeoutMs: Math.min(recipe.healthTimeoutMs, DIAGNOSIS_MAX_MS),
    },
    { trace: true },
  );
  // Inside gVisor names resolve only through /etc/hosts, so a target that looks up an outside
  // name fails before any connect the trace could count. A failed lookup in its own output is
  // read as the same need. The output is untrusted, but it can only move a target that never
  // booted from `failed` to `unsupported`.
  const lookupFailed = /\b(EAI_AGAIN|ENOTFOUND|getaddrinfo)\b/.test(
    diagnosis.stderr + diagnosis.stdout,
  );
  if (diagnosis.trace.egressAttempts > 0 || lookupFailed) {
    return {
      status: 'unsupported',
      reason:
        diagnosis.trace.egressAttempts > 0
          ? `needs real egress to boot (${diagnosis.trace.egressAttempts} connection attempts outside the case network)`
          : 'needs real egress to boot (looked up a name outside the case network)',
    };
  }
  return {
    status: 'failed',
    reason: `not healthy at ${recipe.healthRoute} within ${recipe.healthTimeoutMs} ms: ${diagnosis.stderr.slice(-800)}`,
  };
}

async function startStub(net: CaseNetwork, stub: ExternalStub): Promise<RunningService> {
  return startJailedService(net, {
    image: PROBE_IMAGE,
    command: ['node', '-e', STUB_SCRIPT, stub.kind],
    alias: stub.hostAlias,
    readiness: [
      'node',
      '-e',
      `require('net').connect(${stub.kind === 'smtp' ? 25 : 80}, '127.0.0.1').on('connect', () => process.exit(0)).on('error', () => process.exit(1))`,
    ],
    readinessTimeoutMs: 30_000,
  });
}
