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
/** A host name: labels of letters, digits and hyphens, separated by dots (stub aliases). */
const HOST_ALIAS =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** A per-case internal network, and the names the jail may use for hosts on it. */
export interface JailNetwork {
  name: string;
  /** Host name to IPv4 address, written into the jail's /etc/hosts. */
  hosts?: Readonly<Record<string, string>>;
}

/**
 * The dependency fetch step of a split build (boot/fetch.ts). It joins a per-build network made
 * by `createCaseNetwork` (internal, no host address, IPv6 off), so it has no route out at all:
 * an IP literal or the bridge gateway is unreachable. Its only peer is the forward proxy, the one
 * name in its /etc/hosts; DNS points nowhere. The proxy decides what the fetch can reach.
 */
export interface FetchNetwork {
  /** A per-build case network (`CASE_NETWORK`), never shared across builds or cases. */
  name: string;
  /** The forward proxy on that network: the only host the fetch step can name. */
  proxy: { host: string; ip: string };
}

/**
 * A per-build bridge with a route out, joined only by the fetch proxy (boot/fetch.ts), which
 * forwards nothing but CONNECT to the registry on 443. Never joined by anything that runs
 * repository or package code.
 */
export const EGRESS_NETWORK = /^affidavit-egress-[0-9a-f]{16}$/;

/** An extra writable tmpfs, for example over an image's declared VOLUME. Memory-backed, capped. */
export interface TmpfsMount {
  path: string;
  sizeMb: number;
}

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Paths the spec controls itself, which a caller's tmpfs may not cover. */
const RESERVED_TMPFS = ['/', '/proc', '/sys', '/dev', '/dev/shm', '/scratch', '/tmp', '/etc'];
const TMPFS_PATH = /^\/[\w./@+-]*$/;

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
   * The fetch network instead of a case network or none. Only the split build's dependency
   * download uses it, and that step runs no package or repository code.
   */
  fetch?: FetchNetwork;
  /** A per-build egress bridge (`EGRESS_NETWORK`). Only the fetch proxy, our own code, joins one. */
  egress?: string;
  /** Environment for the process. HOME and TMPDIR are always /scratch and cannot be overridden. */
  env?: Readonly<Record<string, string>>;
  workdir?: string;
  /** Writable tmpfs mounts besides /scratch (service volumes). */
  tmpfs?: readonly TmpfsMount[];
  /**
   * Size of a writable /tmp in MiB. Unset, /tmp is a read-only tmpfs (witnesses); services such as
   * a database need a writable one for sockets and temporary files.
   */
  writableTmpMb?: number;
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

/** `--dns 0.0.0.0`: no resolver, so only the names written into /etc/hosts resolve. */
const NO_DNS = ['--dns', '0.0.0.0', '--dns-search', '.'];

function fetchArgs(fetch: FetchNetwork): string[] {
  if (!CASE_NETWORK.test(fetch.name)) {
    throw new Error(`the fetch step joins only a per-build network: ${fetch.name}`);
  }
  const { host, ip } = fetch.proxy;
  if (!HOST_ALIAS.test(host) || ipv4ToInt(ip) === null) {
    throw new Error(`bad fetch proxy entry: ${host} ${ip}`);
  }
  return ['--network', fetch.name, ...NO_DNS, '--add-host', `${host}:${ip}`];
}

function egressArgs(egress: string): string[] {
  if (!EGRESS_NETWORK.test(egress)) throw new Error(`not a per-build egress network: ${egress}`);
  return ['--network', egress, ...NO_DNS];
}

function anyNetworkArgs(spec: GvisorRunSpec): string[] {
  const chosen = [spec.network, spec.fetch, spec.egress].filter((n) => n !== undefined);
  if (chosen.length > 1) {
    throw new Error('a run joins one of a case network, the fetch network or an egress network');
  }
  if (spec.fetch !== undefined) return fetchArgs(spec.fetch);
  if (spec.egress !== undefined) return egressArgs(spec.egress);
  return networkArgs(spec.network);
}

function envArgs(env: Readonly<Record<string, string>> | undefined): string[] {
  return Object.entries(env ?? {}).flatMap(([k, v]) => {
    if (!ENV_KEY.test(k) || k === 'HOME' || k === 'TMPDIR') throw new Error(`bad env key: ${k}`);
    if (/[\n\r\0]/.test(v)) throw new Error(`bad env value for ${k}`);
    return ['--env', `${k}=${v}`];
  });
}

const positiveMb = (n: number, what: string): number => {
  if (!Number.isSafeInteger(n) || n <= 0 || n > 16_384) throw new Error(`bad ${what}: ${n}`);
  return n;
};

/** Null when `p` may carry an extra tmpfs (for an image volume), else why not. Non-throwing. */
export function tmpfsPathProblem(p: string): string | null {
  const path = p.replace(/\/+$/, '');
  if (
    !TMPFS_PATH.test(path) ||
    path.split('/').includes('..') ||
    RESERVED_TMPFS.some((r) => path === r || (r !== '/' && path.startsWith(`${r}/`)))
  ) {
    return `bad tmpfs path: ${p}`;
  }
  return null;
}

function tmpfsArgs(spec: GvisorRunSpec): string[] {
  const tmp =
    spec.writableTmpMb === undefined
      ? 'type=tmpfs,destination=/tmp,readonly'
      : `type=tmpfs,destination=/tmp,tmpfs-size=${positiveMb(spec.writableTmpMb, 'writableTmpMb') * 1024 * 1024},tmpfs-mode=1777`;
  const extra = (spec.tmpfs ?? []).flatMap((t) => {
    const problem = tmpfsPathProblem(t.path);
    if (problem !== null) throw new Error(problem);
    const path = t.path.replace(/\/+$/, '');
    const bytes = positiveMb(t.sizeMb, 'tmpfs size') * 1024 * 1024;
    return ['--mount', `type=tmpfs,destination=${path},tmpfs-size=${bytes},tmpfs-mode=1777`];
  });
  return ['--mount', tmp, '--mount', 'type=tmpfs,destination=/dev/shm,readonly', ...extra];
}

function fileSizeArgs(bytes: number | undefined): string[] {
  if (bytes === undefined) return [];
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error(`bad maxFileBytes: ${bytes}`);
  return ['--ulimit', `fsize=${bytes}:${bytes}`];
}

function checkWorkdir(w: string): string {
  if (!TMPFS_PATH.test(w) || w.split('/').includes('..')) throw new Error(`bad workdir: ${w}`);
  return w;
}

/**
 * Non-throwing checks for values that come from an untrusted target (boot recipes), so a bad
 * value becomes an `unsupported` outcome instead of an exception deep inside a run.
 */
export function hostAliasProblem(alias: string): string | null {
  return HOST_ALIAS.test(alias) ? null : `host alias ${JSON.stringify(alias)} is not a host name`;
}

export function envProblem(env: Readonly<Record<string, string>>): string | null {
  for (const [k, v] of Object.entries(env)) {
    if (!ENV_KEY.test(k) || k === 'HOME' || k === 'TMPDIR') {
      return `environment key ${JSON.stringify(k)} is not allowed`;
    }
    if (/[\n\r\0]/.test(v)) return `environment value of ${k} has a line break or NUL`;
  }
  return null;
}

/** Container paths a target's working directory (a bind mount target) may not be or sit under. */
const RESERVED_WORKDIR = ['/', '/proc', '/sys', '/dev', '/scratch', '/tmp', '/etc'];

export function workdirProblem(w: string): string | null {
  if (!TMPFS_PATH.test(w) || w.split('/').includes('..') || /[,:=]/.test(w)) {
    return `working directory ${JSON.stringify(w)} is not a plain absolute path`;
  }
  const p = w.replace(/\/+$/, '') || '/';
  if (RESERVED_WORKDIR.some((r) => p === r || (r !== '/' && p.startsWith(`${r}/`)))) {
    return `working directory ${p} is reserved by the jail`;
  }
  return null;
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
 * - `/tmp` and `/dev/shm` are read-only tmpfs and `/scratch` is the only writable path, unless the
 *   caller asks for a capped writable `/tmp` or extra capped tmpfs mounts (services only).
 * - Only a per-case network; for a dependency download, a per-build internal network whose only
 *   peer is the fetch proxy; for the fetch proxy alone, a per-build egress bridge.
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
    ...anyNetworkArgs(spec),
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
    ...tmpfsArgs(spec),
    ...(spec.workdir === undefined ? [] : ['--workdir', checkWorkdir(spec.workdir)]),
    ...envArgs(spec.env),
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
