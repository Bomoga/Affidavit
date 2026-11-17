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
  /**
   * `uid:gid` to run as. Default `JAIL_USER` (nobody). Lane 1 tools run as the host user that owns
   * the case workspace, so they can read `/src` and write `/out`; root (uid or gid 0) is refused.
   */
  user?: string;
  /**
   * Make `/tmp` a writable tmpfs of this many MiB and point `TMPDIR` at it, for tools that need
   * a temp directory at `/tmp` (Lane 1 scanners); `XDG_CACHE_HOME` is `/tmp` too. Default: `/tmp` is a read-only tmpfs and
   * `TMPDIR=/scratch`, as for witnesses. tmpfs lives in the sandbox's memory, so it counts against
   * the memory limit and never touches the host disk.
   */
  writableTmpMb?: number;
}

/** Largest writable `/tmp` a run may ask for. */
export const MAX_WRITABLE_TMP_MB = 4096;

/** Checks a jail `uid:gid`; throws on anything else or on root. */
export function userArg(user: string | undefined): string {
  if (user === undefined) return JAIL_USER;
  const m = /^([0-9]{1,10}):([0-9]{1,10})$/.exec(user);
  if (m === null) throw new Error(`user must be uid:gid: ${user}`);
  if (Number(m[1]) === 0 || Number(m[2]) === 0) throw new Error('refusing to run the jail as root');
  return user;
}

function tmpArgs(writableTmpMb: number | undefined): string[] {
  if (writableTmpMb === undefined) {
    return ['--mount', 'type=tmpfs,destination=/tmp,readonly'];
  }
  if (
    !Number.isSafeInteger(writableTmpMb) ||
    writableTmpMb <= 0 ||
    writableTmpMb > MAX_WRITABLE_TMP_MB
  ) {
    throw new Error(`bad writableTmpMb: ${writableTmpMb}`);
  }
  return ['--tmpfs', `/tmp:rw,size=${writableTmpMb}m,mode=1777`];
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

/**
 * Pinned by content: a registry digest (`name@sha256:...`) or a local image ID (`sha256:...`, the
 * hash of the image config, which names every layer). Locally built images, such as the witness
 * runner, only have the second.
 */
const isPinned = (image: string): boolean =>
  /@sha256:[0-9a-f]{64}$/.test(image) || /^sha256:[0-9a-f]{64}$/.test(image);

/**
 * Docker argv for one jailed run. Every flag here is a security control; tests pin each one.
 *
 * - gVisor runtime, so the process talks to gVisor's kernel, never the host's.
 * - `label=disable`: gVisor cannot run with an SELinux process label, so SELinux confinement of
 *   the container is replaced by gVisor's own sandbox. See docs/lanes/lane2/sandbox-runner.md.
 * - No network, or only a per-case internal network (see network.ts), read-only root, all capabilities dropped, no privilege gain, unprivileged user.
 * - Memory with swap equal to memory, so the limit cannot be stretched with swap (L2-01 finding).
 * - `/tmp` and `/dev/shm` are read-only tmpfs; `/scratch` is the only writable path. A tool run
 *   may ask for a writable, size-capped `/tmp` tmpfs instead (`writableTmpMb`).
 */
export function buildGvisorRunArgs(spec: GvisorRunSpec): string[] {
  if (!isPinned(spec.image))
    throw new Error(`image must be pinned by sha256 digest or image ID: ${spec.image}`);
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
    userArg(spec.user),
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
    ...tmpArgs(spec.writableTmpMb),
    '--mount',
    'type=tmpfs,destination=/dev/shm,readonly',
    '--env',
    'HOME=/scratch',
    '--env',
    `TMPDIR=${spec.writableTmpMb === undefined ? '/scratch' : '/tmp'}`,
    // With a writable /tmp, caches go there too (Go's os.UserCacheDir reads XDG_CACHE_HOME), so a
    // read-only cache such as OSV-Scanner's offline database is found at /tmp/<tool dir>.
    ...(spec.writableTmpMb === undefined ? [] : ['--env', 'XDG_CACHE_HOME=/tmp']),
    ...spec.mounts.flatMap((m) => [
      '--mount',
      `type=bind,source=${m.hostPath},destination=${m.containerPath}${m.readOnly ? ',readonly' : ''}`,
    ]),
    spec.image,
    ...spec.command,
  ];
}
