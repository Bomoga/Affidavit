import { ipv4ToInt } from './cidr.js';
import type { Mount } from './mounts.js';

/** The Docker runtime registered by the sandbox host setup: runsc with a syscall trace. */
export const AUDIT_RUNTIME = 'runsc-affidavit';
/** gVisor without the trace, for runs that need containment but no recording (Lane 1 tools). */
export const PLAIN_RUNTIME = 'runsc';
/** Where the audit runtime writes one trace file per container: `<container id>.boot.txt`. */
export const DEFAULT_TRACE_ROOT = '/var/lib/affidavit-runsc';
/** Label on every container the sandbox starts, so teardown can prove nothing is left. */
export const RUN_LABEL = 'affidavit.sandbox.run';

export interface Limits {
  memoryMb: number;
  pids: number;
  cpus: number;
  scratchMb: number;
}

export const DEFAULT_LIMITS: Readonly<Limits> = {
  memoryMb: 1024,
  pids: 256,
  cpus: 1,
  scratchMb: 64,
};

/** Name of a per-case network created by `createCaseNetwork`; nothing else can be joined. */
export const CASE_NETWORK = /^affidavit-net-[0-9a-f]{16}$/;
const HOST_ALIAS = /^[a-z][a-z0-9-]{0,62}$/;

/** A per-case internal network, and the names the jail may use for hosts on it. */
export interface JailNetwork {
  name: string;
  /** Host name to IPv4 address, written into the jail's /etc/hosts. */
  hosts?: Readonly<Record<string, string>>;
}

/** An unprivileged uid and gid inside the jail (nobody). */
export const JAIL_USER = '65534:65534';

export interface GvisorRunSpec {
  name: string;
  runId: string;
  image: string;
  command: readonly string[];
  /** Mounts already checked by `validateMounts`. */
  mounts: readonly Mount[];
  limits?: Readonly<Limits>;
  /** Keep stdin open (the containment suite feeds probe scripts on stdin). */
  stdin?: boolean;
  runtime?: string;
  /** Join this per-case network instead of `--network none`. */
  network?: JailNetwork;
  /** Largest file the jail may write (`RLIMIT_FSIZE`); caps a mounted result file. */
  maxFileBytes?: number;
}

function networkArgs(network: JailNetwork | undefined): string[] {
  if (network === undefined) return ['--network', 'none'];
  if (!CASE_NETWORK.test(network.name)) {
    throw new Error(`only a per-case network can be joined: ${network.name}`);
  }
  const hosts = Object.entries(network.hosts ?? {}).flatMap(([host, ip]) => {
    if (!HOST_ALIAS.test(host) || ipv4ToInt(ip) === null) {
      throw new Error(`bad host entry: ${host} ${ip}`);
    }
    return ['--add-host', `${host}:${ip}`];
  });
  // `--dns-search .` keeps the host's search domains (which can name a private network) out.
  return ['--network', network.name, '--dns-search', '.', ...hosts];
}

function fileSizeArgs(bytes: number | undefined): string[] {
  if (bytes === undefined) return [];
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error(`bad maxFileBytes: ${bytes}`);
  return ['--ulimit', `fsize=${bytes}:${bytes}`];
}

const isPinned = (image: string): boolean => /@sha256:[0-9a-f]{64}$/.test(image);

/**
 * Docker argv for one jailed run. Every flag here is a security control; tests pin each one.
 *
 * - gVisor runtime, so the process talks to gVisor's kernel, never the host's.
 * - `label=disable`: gVisor cannot run with an SELinux process label, so SELinux confinement of
 *   the container is replaced by gVisor's own sandbox. See docs/lanes/lane2/sandbox-runner.md.
 * - No network, or only a per-case internal network (see network.ts), read-only root, all capabilities dropped, no privilege gain, unprivileged user.
 * - Memory with swap equal to memory, so the limit cannot be stretched with swap (L2-01 finding).
 * - `/tmp` and `/dev/shm` are read-only tmpfs; `/scratch` is the only writable path.
 */
export function buildGvisorRunArgs(spec: GvisorRunSpec): string[] {
  if (!isPinned(spec.image))
    throw new Error(`image must be pinned by sha256 digest: ${spec.image}`);
  const l = spec.limits ?? DEFAULT_LIMITS;
  return [
    'run',
    '--name',
    spec.name,
    '--label',
    `${RUN_LABEL}=${spec.runId}`,
    ...(spec.stdin === true ? ['-i'] : []),
    '--runtime',
    spec.runtime ?? AUDIT_RUNTIME,
    '--security-opt',
    'label=disable',
    ...networkArgs(spec.network),
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--user',
    JAIL_USER,
    '--pids-limit',
    String(l.pids),
    '--memory',
    `${l.memoryMb}m`,
    '--memory-swap',
    `${l.memoryMb}m`,
    '--cpus',
    String(l.cpus),
    '--ulimit',
    'nofile=1024:1024',
    ...fileSizeArgs(spec.maxFileBytes),
    '--log-driver',
    'none',
    '--tmpfs',
    `/scratch:rw,size=${l.scratchMb}m,mode=1777`,
    '--mount',
    'type=tmpfs,destination=/tmp,readonly',
    '--mount',
    'type=tmpfs,destination=/dev/shm,readonly',
    '--env',
    'HOME=/scratch',
    '--env',
    'TMPDIR=/scratch',
    ...spec.mounts.flatMap((m) => [
      '--mount',
      `type=bind,source=${m.hostPath},destination=${m.containerPath}${m.readOnly ? ',readonly' : ''}`,
    ]),
    spec.image,
    ...spec.command,
  ];
}
