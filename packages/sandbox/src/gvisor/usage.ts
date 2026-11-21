/**
 * Resource use of one jailed run (L2-11), read from the container's cgroup v2 files while it
 * runs. gVisor's sandbox runs inside the container's cgroup, so these cover the jailed process
 * and gVisor's own overhead for it. The cgroup disappears when the container stops, so the runner
 * samples on every watch tick and keeps the highest values: a lower bound on the real peak, close
 * to it for any run longer than a few ticks. A run too short to be sampled reports nulls, never
 * zeros.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface RunUsage {
  /** Highest `memory.peak` seen, in bytes, or null when never sampled. */
  memoryPeakBytes: number | null;
  /** CPU time from `cpu.stat` `usage_usec`, in whole milliseconds, or null when never sampled. */
  cpuMs: number | null;
}

export const NO_USAGE: Readonly<RunUsage> = { memoryPeakBytes: null, cpuMs: null };

/**
 * Where Docker puts a container's cgroup: `system.slice/docker-<id>.scope` with the systemd
 * driver (this host), `docker/<id>` with cgroupfs.
 */
export const DEFAULT_CGROUP_DIRS: readonly ((id: string) => string)[] = [
  (id) => join('/sys/fs/cgroup/system.slice', `docker-${id}.scope`),
  (id) => join('/sys/fs/cgroup/docker', id),
];

const CONTAINER_ID = /^[0-9a-f]{64}$/;

/** `memory.peak`: one decimal integer. */
export function parseMemoryPeak(text: string): number | null {
  const t = text.trim();
  if (!/^\d{1,18}$/.test(t)) return null;
  return Number(t);
}

/** `cpu.stat`: the `usage_usec` line, as whole milliseconds. */
export function parseCpuStat(text: string): number | null {
  const m = /^usage_usec (\d{1,18})$/m.exec(text);
  return m === null ? null : Math.floor(Number(m[1]) / 1000);
}

/** The higher of each value; null only where both are null. */
export function mergeUsage(a: Readonly<RunUsage>, b: Readonly<RunUsage>): RunUsage {
  const max = (x: number | null, y: number | null) =>
    x === null ? y : y === null ? x : Math.max(x, y);
  return {
    memoryPeakBytes: max(a.memoryPeakBytes, b.memoryPeakBytes),
    cpuMs: max(a.cpuMs, b.cpuMs),
  };
}

/** One sample of a running container's cgroup, or nulls when it cannot be read. */
export async function sampleUsage(
  containerId: string,
  dirs: readonly ((id: string) => string)[] = DEFAULT_CGROUP_DIRS,
): Promise<RunUsage> {
  if (!CONTAINER_ID.test(containerId)) return { ...NO_USAGE };
  for (const dirOf of dirs) {
    const dir = dirOf(containerId);
    const [peak, cpu] = await Promise.all([
      readFile(join(dir, 'memory.peak'), 'utf8').catch(() => null),
      readFile(join(dir, 'cpu.stat'), 'utf8').catch(() => null),
    ]);
    if (peak === null && cpu === null) continue;
    return {
      memoryPeakBytes: peak === null ? null : parseMemoryPeak(peak),
      cpuMs: cpu === null ? null : parseCpuStat(cpu),
    };
  }
  return { ...NO_USAGE };
}
