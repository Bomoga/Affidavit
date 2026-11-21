import { realpathSync } from 'node:fs';
import { isAbsolute, posix } from 'node:path';

export interface Mount {
  hostPath: string;
  containerPath: string;
  readOnly: boolean;
}

/** Container paths a mount may never cover: kernel interfaces and the jail's own scratch. */
const RESERVED_CONTAINER_PATHS = ['/proc', '/sys', '/dev', '/scratch', '/tmp', '/etc', '/'];

/** Characters that change the meaning of a `--mount` value or a log line. */
const UNSAFE = /[,:=\n\r\0"']/;

/** `posix.normalize` without a trailing slash, so `/tmp/` and `/tmp` are the same target. */
export function normalizeContainerPath(path: string): string {
  const n = posix.normalize(path);
  return n.length > 1 ? n.replace(/\/+$/, '') : n;
}

const under = (path: string, root: string): boolean =>
  path === root || path.startsWith(root === '/' ? '/' : `${root}/`);

/**
 * Checks every mount against an allowlist of host roots, after resolving symlinks, so a mount can
 * never reach the Docker socket, a credential, or the evidence store by naming a parent directory
 * (`/var/run`), a `..` path, or a symlink that points outside the workspace. Returns the mounts
 * with host paths resolved. Throws on the first bad mount.
 */
export function validateMounts(
  mounts: readonly Mount[],
  allowedRoots: readonly string[],
  opts: {
    /**
     * Allow targets strictly under `/tmp` (never `/tmp` itself). Only for runs whose `/tmp` is a
     * writable tmpfs (`writableTmpMb`), where a read-only database can sit inside it.
     */
    allowUnderTmp?: boolean;
  } = {},
): Mount[] {
  const roots = allowedRoots.map((r) => {
    if (!isAbsolute(r)) throw new Error(`allowed root must be absolute: ${r}`);
    const real = realpathSync(r);
    if (real === '/') throw new Error('the filesystem root cannot be an allowed mount root');
    return real;
  });
  return mounts.map((m) => {
    for (const [field, value] of [
      ['hostPath', m.hostPath],
      ['containerPath', m.containerPath],
    ] as const) {
      if (!isAbsolute(value)) throw new Error(`${field} must be absolute: ${value}`);
      if (UNSAFE.test(value)) throw new Error(`${field} has a character not allowed in mounts`);
    }
    const host = realpathSync(m.hostPath);
    if (!roots.some((r) => under(host, r))) {
      throw new Error(`mount source ${host} is outside the allowed roots`);
    }
    if (/docker\.sock|containerd\.sock|podman\.sock/.test(host)) {
      throw new Error('refusing to mount a container runtime socket');
    }
    const target = normalizeContainerPath(m.containerPath);
    const underTmpAllowed = opts.allowUnderTmp === true && target.startsWith('/tmp/');
    if (underTmpAllowed && !m.readOnly) {
      throw new Error(`a mount under /tmp must be read-only: ${target}`);
    }
    if (
      RESERVED_CONTAINER_PATHS.some((p) =>
        p === '/' ? target === '/' : under(target, p) && !(p === '/tmp' && underTmpAllowed),
      )
    ) {
      throw new Error(`mount target ${target} is reserved`);
    }
    return { hostPath: host, containerPath: target, readOnly: m.readOnly };
  });
}
