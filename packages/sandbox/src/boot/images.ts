import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/**
 * The namespace (first component) of a Hub name has no dots: Docker reads a first component with
 * a dot, a colon or the name `localhost` as a registry host.
 *
 * Image references taken from a target's Dockerfile or compose file are untrusted. The MVP only
 * pulls official or user images from Docker Hub by name and tag: no registry host (which could
 * point the Docker daemon at an internal service), no variables, no digests we did not resolve.
 */
const HUB_REF =
  /^(?:(?!localhost\/)[a-z0-9]+(?:[_-][a-z0-9]+)*\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[\w][\w.-]{0,127})?$/;
const PINNED = /^([a-z0-9]+(?:[._/-][a-z0-9]+)*)@sha256:[0-9a-f]{64}$/;

export function hubRefProblem(ref: string): string | null {
  if (PINNED.test(ref)) {
    const name = ref.split('@')[0] as string;
    const first = name.includes('/') ? (name.split('/')[0] as string) : '';
    return first.includes('.') || first === 'localhost'
      ? `image ${ref} is not on Docker Hub`
      : null;
  }
  if (!HUB_REF.test(ref)) return `image ${ref} is not a plain Docker Hub name and tag`;
  return null;
}

/**
 * Base images a target may be assembled on. The base is the root filesystem the target runs in,
 * and its offline `npm run build` (when the target has a build script) runs on it; nothing is
 * installed or rebuilt (deny-all egress, lead decision 2026-11-20). So it is held to an allowlist rather than any
 * Hub name: only the official `node` images (`node:<tag>`, `library/node:<tag>`, or either pinned
 * by digest). Sidecars (databases) are separate: they run as their own services and keep the
 * plain Hub rule above. Widen deliberately, one official image at a time.
 */
const BASE_REF = /^(?:library\/)?node(?::[\w][\w.-]{0,127}|@sha256:[0-9a-f]{64})?$/;

export function baseImageProblem(ref: string): string | null {
  return BASE_REF.test(ref) && hubRefProblem(ref) === null
    ? null
    : `base image ${ref} is not on the allowlist (official node images only)`;
}

/**
 * `ONBUILD` instructions in an image's config, from
 * `docker image inspect --format '{{json .Config.OnBuild}}'`. A base with ONBUILD triggers would
 * run repository-controlled steps (`ONBUILD RUN`) inside our generated build, so it is refused.
 * Throws on anything unreadable, so an odd answer never counts as "none".
 */
export function parseOnBuild(json: string): string[] {
  let value: unknown;
  try {
    value = JSON.parse(json.trim());
  } catch {
    throw new Error(`cannot read the image's Config.OnBuild: ${json.slice(0, 200)}`);
  }
  if (value === null) return [];
  if (!Array.isArray(value) || !value.every((x) => typeof x === 'string')) {
    throw new Error(`unexpected Config.OnBuild: ${json.slice(0, 200)}`);
  }
  return value;
}

export async function imageOnBuild(image: string): Promise<string[]> {
  const { stdout } = await exec('docker', [
    'image',
    'inspect',
    '--format',
    '{{json .Config.OnBuild}}',
    image,
  ]);
  return parseOnBuild(stdout);
}

/** Pulls an image Lane 2 pinned itself (`name:tag@sha256:...`), so the jail can inspect it. */
export async function pullPinned(ref: string): Promise<void> {
  if (!/@sha256:[0-9a-f]{64}$/.test(ref)) throw new Error(`not pinned by digest: ${ref}`);
  await exec('docker', ['pull', '--quiet', ref], { timeout: 600_000 });
}

/** Repository name as Docker reports it in RepoDigests (`node`, `library/x` is shown as `x`). */
function repoOf(ref: string): string {
  const noDigest = ref.split('@')[0] as string;
  const lastColon = noDigest.lastIndexOf(':');
  return lastColon > noDigest.lastIndexOf('/') ? noDigest.slice(0, lastColon) : noDigest;
}

/**
 * Pulls a Docker Hub image and returns it pinned as `repo@sha256:<digest>`, the form the jail
 * accepts. The digest is what the daemon resolved now; the boot result records it.
 */
export async function pinImage(ref: string): Promise<string> {
  const problem = hubRefProblem(ref);
  if (problem !== null) throw new Error(problem);
  await exec('docker', ['pull', '--quiet', ref], { timeout: 600_000 });
  const { stdout } = await exec('docker', [
    'image',
    'inspect',
    '--format',
    '{{json .RepoDigests}}',
    ref,
  ]);
  const digests = JSON.parse(stdout) as string[];
  const repo = repoOf(ref);
  const pinned = digests.find((d) => d.split('@')[0] === repo) ?? digests[0];
  if (pinned === undefined || !PINNED.test(pinned)) {
    throw new Error(`no registry digest for ${ref}`);
  }
  return pinned;
}

/** The VOLUME paths an image declares. The jail covers each with a capped tmpfs. */
export async function imageVolumes(image: string): Promise<string[]> {
  const { stdout } = await exec('docker', [
    'image',
    'inspect',
    '--format',
    '{{json .Config.Volumes}}',
    image,
  ]);
  const v = JSON.parse(stdout) as Record<string, unknown> | null;
  return Object.keys(v ?? {}).sort();
}
