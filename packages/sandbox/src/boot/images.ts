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
