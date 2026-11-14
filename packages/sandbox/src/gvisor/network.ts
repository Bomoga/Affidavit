import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { promisify } from 'node:util';
import { CASE_NETWORK, PLAIN_RUNTIME, RUN_LABEL, buildGvisorRunArgs, type Limits } from './args.js';
import { inCidr, ipv4ToInt, isIpv4Cidr } from './cidr.js';
import type { Mount } from './mounts.js';

const exec = promisify(execFile);

/**
 * A per-case network: the target and the witness share it, and nothing else is on it.
 *
 * - `--internal`: no route out of the network.
 * - `inhibit_ipv4`: the host bridge gets no IPv4 address. Without this, an internal network still
 *   reaches the host through the bridge gateway address (verified 2026-11-14: a witness on a
 *   plain `--internal` network reached a host listener on 172.18.0.1), and with it every host
 *   service that listens on all interfaces, including the orchestrator.
 */
export interface CaseNetwork {
  name: string;
  runId: string;
  /** IPv4 subnet; connects inside it are local traffic, not egress. */
  subnet: string;
}

/** Fails unless no host interface has an address inside `subnet`. */
export function assertHostNotOnSubnet(
  subnet: string,
  interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
): void {
  for (const [name, addrs] of Object.entries(interfaces)) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && inCidr(a.address, subnet)) {
        throw new Error(`host interface ${name} has ${a.address} inside case network ${subnet}`);
      }
    }
  }
}

export async function createCaseNetwork(): Promise<CaseNetwork> {
  const runId = randomBytes(8).toString('hex');
  const name = `affidavit-net-${runId}`;
  await exec('docker', [
    'network',
    'create',
    '--driver',
    'bridge',
    '--internal',
    '--opt',
    'com.docker.network.bridge.inhibit_ipv4=true',
    '--label',
    `${RUN_LABEL}=${runId}`,
    name,
  ]);
  try {
    const { stdout } = await exec('docker', [
      'network',
      'inspect',
      '--format',
      '{{.Internal}} {{range .IPAM.Config}}{{.Subnet}} {{end}}',
      name,
    ]);
    const [internal, ...subnets] = stdout.trim().split(/\s+/);
    const subnet = subnets.find(isIpv4Cidr);
    if (internal !== 'true' || subnet === undefined) {
      throw new Error(`network ${name} is not internal or has no IPv4 subnet: ${stdout.trim()}`);
    }
    assertHostNotOnSubnet(subnet);
    return { name, runId, subnet };
  } catch (err) {
    await exec('docker', ['network', 'rm', name]).catch(() => undefined);
    throw err;
  }
}

/** Removes the network and every container still labelled with its run id, then checks. */
export async function removeCaseNetwork(net: CaseNetwork): Promise<void> {
  const filter = `label=${RUN_LABEL}=${net.runId}`;
  const { stdout } = await exec('docker', ['ps', '--all', '--quiet', '--filter', filter]);
  const ids = stdout.split('\n').filter((l) => l !== '');
  if (ids.length > 0) await exec('docker', ['rm', '--force', ...ids]);
  await exec('docker', ['network', 'rm', net.name]).catch(() => undefined);
  const left = await exec('docker', ['network', 'ls', '--quiet', '--filter', filter]);
  if (left.stdout.trim() !== '') throw new Error(`network ${net.name} was left behind`);
}

export interface ServiceSpec {
  image: string;
  command: readonly string[];
  /** Name the witness uses for this service, written into its /etc/hosts. */
  alias: string;
  mounts?: readonly Mount[];
  limits?: Readonly<Limits>;
  /** Command run inside the service until it exits 0 (for example a health request). */
  readiness?: readonly string[];
  readinessTimeoutMs?: number;
}

export interface RunningService {
  name: string;
  alias: string;
  ip: string;
}

/**
 * Starts a long-running service (the target) in the jail on a case network. Same flags as a
 * witness, on gVisor without the trace. Booting real targets is L2-04; this is the minimum the
 * witness jail needs, and what its tests use for a stub target. Removed by `removeCaseNetwork`.
 */
export async function startJailedService(
  net: CaseNetwork,
  spec: ServiceSpec,
): Promise<RunningService> {
  if (!CASE_NETWORK.test(net.name)) throw new Error(`not a case network: ${net.name}`);
  const name = `affidavit-svc-${randomBytes(8).toString('hex')}`;
  const args = buildGvisorRunArgs({
    name,
    runId: net.runId,
    image: spec.image,
    command: spec.command,
    mounts: spec.mounts ?? [],
    limits: spec.limits,
    runtime: PLAIN_RUNTIME,
    network: { name: net.name },
  });
  await exec('docker', [args[0] ?? 'run', '--detach', ...args.slice(1)]);
  const { stdout } = await exec('docker', [
    'inspect',
    '--format',
    `{{(index .NetworkSettings.Networks "${net.name}").IPAddress}}`,
    name,
  ]);
  const ip = stdout.trim();
  if (ipv4ToInt(ip) === null || !inCidr(ip, net.subnet)) {
    throw new Error(`service ${name} has no address on ${net.name}: ${ip}`);
  }
  if (spec.readiness !== undefined) {
    await waitReady(name, spec.readiness, spec.readinessTimeoutMs ?? 60_000);
  }
  return { name, alias: spec.alias, ip };
}

async function waitReady(name: string, command: readonly string[], timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await exec('docker', ['exec', name, ...command], { timeout: 10_000 });
      return;
    } catch {
      if (Date.now() > deadline) throw new Error(`service ${name} not ready in ${timeoutMs} ms`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}
