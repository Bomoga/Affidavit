/**
 * Reads the syscall trace gVisor writes for a container (the `runsc-affidavit` runtime runs with
 * `--strace`) and turns it into what the containment suite and the Judge call observations.
 *
 * Only syscall exit lines are used, because they carry the result:
 *
 *   I1114 02:07:19.833280  1 strace.go:606] [   3:   3] sh X connect(0x3 socket:[1], 0x56 {Family: AF_INET, Addr: 1.1.1.1, Port: 443}, 0x10) = -1 errno=101 (network is unreachable) (11.276µs)
 *
 * The trace is written by gVisor's kernel, outside the jailed process, but gVisor prints two
 * things the jailed process controls without escaping them: its command name (up to 15 bytes,
 * set with prctl or `process.title`) and path arguments. Verified on runsc release-20261109.0:
 *
 * - A command name with a space or newline would make a connect line unreadable and hide the
 *   attempt. Any syscall line that does not parse, or that continues onto a line without
 *   gVisor's log prefix, marks the trace `tampered`; a witness run with a tampered trace is never
 *   judged (fail closed). Multi-line messages that are not syscall lines (gVisor dumps the OCI
 *   spec at startup) are ignored.
 * - A path containing a newline can add forged lines that look real. Those only add attempts,
 *   which can make a run look worse but never better: a real connect line carries no path, so it
 *   cannot be hidden this way. See docs/lanes/lane2/sandbox-runner.md.
 */

import { inCidr } from './cidr.js';

/**
 * One attempt to reach outside the jail, as gVisor's kernel recorded it. Only fields gVisor
 * renders itself: never the command name or any path, which the jailed process controls.
 */
export interface EgressEvent {
  syscall: 'connect' | 'sendto' | 'sendmsg' | 'sendmmsg';
  family: 'ipv4' | 'ipv6';
  /** The destination address, checked to be a well-formed IP address. */
  address: string;
  /** The destination port, when gVisor printed one. */
  port: number | null;
  /**
   * `blocked`: refused with an unreachable or permission errno (`BLOCKED_ERRNOS`); `failed`: any
   * other error, for example EINPROGRESS (115) from a non-blocking connect, which says nothing
   * about whether the packet left; `sent`: it returned success (for example a UDP send).
   */
  outcome: 'blocked' | 'failed' | 'sent';
  /** The errno of a blocked or failed attempt (101 is ENETUNREACH), else null. */
  errno: number | null;
  /** Sent to Docker's embedded DNS resolver, which forwards names to the host. */
  dns: boolean;
}

/** Most egress events kept per run; `egressAttempts` still counts every one. */
export const MAX_EGRESS_EVENTS = 50;

/**
 * Errnos that mean the jail refused the attempt: EPERM (1), EACCES (13), ENETUNREACH (101) and
 * EHOSTUNREACH (113). Any other error is listed as `failed`, never as `blocked`.
 */
export const BLOCKED_ERRNOS: ReadonlySet<number> = new Set([1, 13, 101, 113]);

export interface TraceObservations {
  egressAttempts: number;
  /**
   * The first `MAX_EGRESS_EVENTS` egress attempts in trace order. Fewer entries than
   * `egressAttempts` means the rest were counted but not listed.
   */
  egress: EgressEvent[];
  /**
   * True only when this run's whole trace was read and parsed. False when tracing was off or the
   * trace passed its size cap: then `egress` is empty because nothing was observed, not because
   * nothing tried to leave. A tampered trace is read but may hide lines, so a complete egress log
   * also needs `tampered` false (see `egressObserved`).
   */
  traced: boolean;
  deniedReads: number;
  deniedWrites: number;
  pidsLimitHit: boolean;
  /** Exit lines that were recognised. Zero means the trace is empty or unreadable. */
  syscalls: number;
  /**
   * A syscall line was malformed or split, or the runner cut the trace off at its size cap, so
   * the jailed process may have hidden an attempt.
   */
  tampered: boolean;
}

export interface TraceOptions {
  /**
   * Host paths the jail must never touch (credential files, the evidence store). Any attempt to
   * open one counts as a denied read, even when it fails with ENOENT because it is not mounted.
   */
  sensitivePaths: readonly string[];
  /**
   * IPv4 subnets of the case network (the target). Connects inside them are the witness doing its
   * job, not egress. Everything else that is not loopback is egress, and so is Docker's embedded
   * DNS resolver on 127.0.0.11, which forwards to the host.
   */
  localNetworks?: readonly string[];
}

/** gVisor's log prefix (glog): level, date, time, thread, source file and line. */
const LOG_LINE = /^[IWDEF]\d{4} \d{2}:\d{2}:\d{2}\.\d+\s+\d+ [\w.-]+:\d+\] /;
/** The prefix of a syscall line, up to and including the task id block. */
const SYSCALL_LINE =
  /^[IWDEF]\d{4} \d{2}:\d{2}:\d{2}\.\d+\s+\d+ strace\.go:\d+\] \[\s*\d+:\s*\d+\] /;
/** After the prefix: a command name without whitespace (Linux caps it at 15 bytes), then entry. */
const ENTRY = /^\S{1,15} E \w+\(.*\)$/;
/** After the prefix: command name, exit marker, syscall, arguments, return value, errno. */
const EXIT =
  /^\S{1,15} X (\w+)\((.*)\) = (-?\d+)(?: \(0x[0-9a-f]+\))?(?: errno=(\d+) \([^)]*\))? \([\d.]+[µnm]?s\)$/;

const EPERM = 1;
const EAGAIN = 11;
const EACCES = 13;
const EROFS = 30;
const DENIED = new Set([EPERM, EACCES, EROFS]);

const OPENS = new Set(['open', 'openat', 'openat2', 'creat']);
const WRITES = new Set([
  'mkdir',
  'mkdirat',
  'unlink',
  'unlinkat',
  'rename',
  'renameat',
  'renameat2',
  'link',
  'linkat',
  'symlink',
  'symlinkat',
  'truncate',
]);
/**
 * gVisor's own warning when the host refuses it a process. Under gVisor, Docker's pids limit
 * applies on the host to the sandbox, which needs a host stub process per address space; at the
 * limit the jailed execve fails with ENOMEM and gVisor logs this (runsc release-20261109.0).
 */
const HOST_PROCESS_REFUSED =
  /^W\d{4} \d{2}:\d{2}:\d{2}\.\d+\s+\d+ task_image\.go:\d+\] Failed to create new memory manager/;

const FORKS = new Set(['clone', 'clone3', 'fork', 'vfork']);
const SENDS = new Set(['connect', 'sendto', 'sendmsg', 'sendmmsg']);

const WRITE_FLAGS = /O_WRONLY|O_RDWR|O_CREAT|O_TRUNC|O_APPEND/;

/** First pointer argument rendered as a path: `0x7ecc2080ed3f /etc/ld.so.cache`. */
function firstPath(args: string): string | null {
  const m = /0x[0-9a-f]+ (\/[^,]*)/.exec(args);
  return m?.[1] ?? null;
}

/**
 * The destination of a send when it is outside the jail: an IPv4 or IPv6 socket address that is
 * neither loopback nor inside the case network. IPv4-mapped IPv6 addresses are judged as the IPv4
 * address they carry. Null for a local destination or one gVisor did not render as an address.
 */
function remoteDestination(
  args: string,
  localNetworks: readonly string[],
): { family: 'ipv4' | 'ipv6'; address: string; port: number | null } | null {
  const m = /Family: (AF_INET6?), Addr: ([^,}]+)(?:, Port: (\d+))?/.exec(args);
  if (!m) return null;
  const family = m[1] === 'AF_INET6' ? 'ipv6' : 'ipv4';
  const address = (m[2] ?? '').trim();
  const portNum = m[3] === undefined ? null : Number(m[3]);
  const port = portNum !== null && portNum <= 65535 ? portNum : null;
  const dest = { family, address, port } as const;
  let v4 = address;
  if (family === 'ipv6') {
    if (address === '::1') return null;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped === null) return dest;
    v4 = mapped[1] ?? '';
  }
  // Docker's embedded DNS resolver sits on loopback inside every container on a user-defined
  // network and forwards queries to the host's resolvers, so a DNS query is a channel out.
  if (v4 === DOCKER_EMBEDDED_DNS) return dest;
  if (v4.startsWith('127.')) return null;
  return localNetworks.some((net) => inCidr(v4, net)) ? null : dest;
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/**
 * A well-formed IPv4 or IPv6 address (`node:net` is outside the egress guard's allowlist). IPv6:
 * hex groups of 1 to 4 digits, at most one `::`, eight groups in all, a dotted IPv4 tail counting
 * as two.
 */
export function isIpAddress(s: string): boolean {
  if (IPV4.test(s)) return true;
  if (s.length > 45 || !/^[0-9A-Fa-f:.]+$/.test(s)) return false;
  let groups = s;
  let tail = 0;
  const lastColon = s.lastIndexOf(':');
  if (s.slice(lastColon + 1).includes('.')) {
    if (!IPV4.test(s.slice(lastColon + 1))) return false;
    groups = s.slice(0, lastColon + 1) + '0';
    tail = 1;
  }
  const halves = groups.split('::');
  if (halves.length > 2) return false;
  const parts = halves.map((h) => (h === '' ? [] : h.split(':')));
  if (!parts.every((ps) => ps.every((g) => /^[0-9A-Fa-f]{1,4}$/.test(g)))) return false;
  const count = parts.reduce((n, ps) => n + ps.length, 0) + tail;
  return halves.length === 2 ? count <= 7 : count === 8;
}

/**
 * Docker's embedded DNS server address on user-defined networks. It looks like loopback, but it
 * resolves names through the host, so any send to it counts as egress.
 */
export const DOCKER_EMBEDDED_DNS = '127.0.0.11';

const under = (path: string, root: string): boolean =>
  path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`);

/**
 * Whether a run's egress log is a complete record of its attempts: the whole trace was read and
 * parsed, and no line of it was malformed or split. Only then does an empty `egress` mean nothing
 * tried to leave.
 */
export const egressObserved = (t: Pick<TraceObservations, 'traced' | 'tampered'>): boolean =>
  t.traced && !t.tampered;

export function parseTrace(text: string, opts: TraceOptions): TraceObservations {
  const out: TraceObservations = {
    egressAttempts: 0,
    egress: [],
    traced: true,
    deniedReads: 0,
    deniedWrites: 0,
    pidsLimitHit: false,
    syscalls: 0,
    tampered: false,
  };
  let afterSyscallLine = false;
  for (const line of text.split('\n')) {
    if (line === '') continue;
    if (!LOG_LINE.test(line)) {
      // A continuation. After a syscall line it means a newline inside a name or path.
      if (afterSyscallLine) out.tampered = true;
      continue;
    }
    const prefix = SYSCALL_LINE.exec(line);
    afterSyscallLine = prefix !== null;
    if (prefix === null) {
      if (HOST_PROCESS_REFUSED.test(line)) out.pidsLimitHit = true;
      continue;
    }
    const body = line.slice(prefix[0].length);
    const m = EXIT.exec(body);
    if (!m) {
      if (!ENTRY.test(body)) out.tampered = true;
      continue;
    }
    out.syscalls += 1;
    const name = m[1] ?? '';
    const args = m[2] ?? '';
    const failed = Number(m[3]) < 0;
    const errno = m[4] === undefined ? null : Number(m[4]);
    const denied = failed && errno !== null && DENIED.has(errno);

    if (SENDS.has(name)) {
      const dest = remoteDestination(args, opts.localNetworks ?? []);
      if (dest !== null) {
        out.egressAttempts += 1;
        // Counted either way; listed only with an address that is really an IP address.
        if (out.egress.length < MAX_EGRESS_EVENTS && isIpAddress(dest.address)) {
          out.egress.push({
            syscall: name as EgressEvent['syscall'],
            ...dest,
            outcome: !failed
              ? 'sent'
              : errno !== null && BLOCKED_ERRNOS.has(errno)
                ? 'blocked'
                : 'failed',
            errno: failed ? errno : null,
            dns:
              dest.address === DOCKER_EMBEDDED_DNS || /^::ffff:127\.0\.0\.11$/i.test(dest.address),
          });
        }
      }
    } else if (OPENS.has(name)) {
      const path = firstPath(args);
      const sensitive = path !== null && opts.sensitivePaths.some((p) => under(path, p));
      const writing = name === 'creat' || WRITE_FLAGS.test(args);
      if (writing && (denied || (sensitive && failed))) out.deniedWrites += 1;
      else if (!writing && (denied || (sensitive && failed))) out.deniedReads += 1;
    } else if (WRITES.has(name)) {
      if (denied) out.deniedWrites += 1;
    } else if (FORKS.has(name)) {
      if (failed && errno === EAGAIN) out.pidsLimitHit = true;
    }
  }
  return out;
}
