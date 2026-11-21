/**
 * Docker volumes are the one way a jailed run could leave state behind after `docker rm`: an image
 * that declares `VOLUME` gets an anonymous volume per container, and that volume outlives the
 * container unless it is removed with it. The runner refuses such images outright (it never
 * needs one: `/scratch` is a tmpfs) and also removes and checks for any volume a container had.
 */

/**
 * Paths declared by an image's `Config.Volumes`, from
 * `docker image inspect --format '{{json .Config.Volumes}}'`. Throws on anything it cannot read,
 * so an unreadable answer never counts as "no volumes".
 */
export function parseImageVolumes(json: string): string[] {
  let value: unknown;
  try {
    value = JSON.parse(json.trim());
  } catch {
    throw new Error(`cannot read the image's Config.Volumes: ${json.slice(0, 200)}`);
  }
  if (value === null) return [];
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`unexpected Config.Volumes: ${json.slice(0, 200)}`);
  }
  return Object.keys(value).sort();
}

/** Throws unless the image declares no volumes. */
export function assertNoImageVolumes(image: string, json: string): void {
  const volumes = parseImageVolumes(json);
  if (volumes.length > 0) {
    throw new Error(
      `image ${image} declares volumes (${volumes.join(', ')}); the sandbox refuses images with VOLUME, since an anonymous volume could keep state after teardown`,
    );
  }
}

/**
 * Declared volumes that no tmpfs mount covers exactly. A long-running service (a database
 * sidecar) may use an image with `VOLUME` only when every declared path gets a capped tmpfs:
 * Docker then mounts the tmpfs there and creates no anonymous volume, so the rule above (no Docker
 * volume ever exists for a jailed container) still holds. `startJailedService` refuses any image
 * this returns a path for, and checks the started container has no volume mount at all.
 */
export function uncoveredVolumes(
  volumes: readonly string[],
  tmpfs: readonly { path: string }[],
): string[] {
  const norm = (p: string): string => p.replace(/\/+$/, '') || '/';
  const covered = new Set(tmpfs.map((t) => norm(t.path)));
  return volumes.filter((v) => !covered.has(norm(v)));
}

/**
 * Names of the Docker volumes a container had mounted, from
 * `docker inspect --format '{{json .Mounts}}'`. Bind and tmpfs mounts are not volumes.
 */
export function parseContainerVolumes(json: string): string[] {
  let value: unknown;
  try {
    value = JSON.parse(json.trim());
  } catch {
    throw new Error(`cannot read the container's Mounts: ${json.slice(0, 200)}`);
  }
  if (value === null) return [];
  if (!Array.isArray(value)) throw new Error(`unexpected Mounts: ${json.slice(0, 200)}`);
  const names: string[] = [];
  for (const m of value as unknown[]) {
    if (typeof m !== 'object' || m === null) throw new Error('unexpected entry in Mounts');
    const { Type, Name } = m as { Type?: unknown; Name?: unknown };
    if (Type !== 'volume') continue;
    if (typeof Name !== 'string' || Name === '') throw new Error('volume mount without a name');
    names.push(Name);
  }
  return names.sort();
}
