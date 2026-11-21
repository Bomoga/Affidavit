import { gunzipSync } from 'node:zlib';
import tar from 'tar-stream';

export interface PackageInspection {
  name: string | undefined;
  version: string | undefined;
  /**
   * What npm would run at install time if scripts were enabled: `preinstall`, `install` and
   * `postinstall` from package.json, and `binding.gyp` (npm's implicit `node-gyp rebuild` when a
   * package ships one without its own install script). Empty for a package that needs none.
   */
  installScripts: string[];
}

export type InspectRead = { ok: true; info: PackageInspection } | { ok: false; reason: string };

const MAX_PACKAGE_JSON_BYTES = 1024 * 1024;
const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall'] as const;

/**
 * Reads a package tarball (gzip of a tar, as the npm registry serves it) without writing anything:
 * finds `<top>/package.json` and `<top>/binding.gyp` one level down, as npm does after stripping
 * the first path component. The content is untrusted data; it is parsed, never run. Refused: a
 * tarball that unpacks past `maxUnpackedBytes`, is not a tar, or has no or several package.json.
 */
export async function inspectPackageTarball(
  tgz: Buffer,
  maxUnpackedBytes: number,
): Promise<InspectRead> {
  let raw: Buffer;
  try {
    raw = gunzipSync(tgz, { maxOutputLength: maxUnpackedBytes });
  } catch (err) {
    const tooBig =
      err instanceof RangeError || (err as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE';
    return {
      ok: false,
      reason: tooBig ? `unpacks to more than ${maxUnpackedBytes} bytes` : 'is not a gzip file',
    };
  }
  const extract = tar.extract();
  const manifests: Buffer[] = [];
  let gyp = false;
  const done = (async (): Promise<string | null> => {
    for await (const entry of extract) {
      const parts = entry.header.name.split('/').filter((p) => p !== '' && p !== '.');
      const depthOne = parts.length === 2;
      if (depthOne && parts[1] === 'package.json' && entry.header.type === 'file') {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const c of entry as AsyncIterable<Buffer>) {
          size += c.length;
          if (size > MAX_PACKAGE_JSON_BYTES) return 'has a package.json over 1 MiB';
          chunks.push(c);
        }
        manifests.push(Buffer.concat(chunks));
        continue;
      }
      if (depthOne && parts[1] === 'binding.gyp') gyp = true;
      entry.resume();
    }
    return null;
  })();
  extract.end(raw);
  let why: string | null;
  try {
    why = await done;
  } catch {
    return { ok: false, reason: 'is not a tar archive' };
  }
  if (why !== null) return { ok: false, reason: why };
  if (manifests.length === 0) return { ok: false, reason: 'has no package.json' };
  if (manifests.length > 1) return { ok: false, reason: 'has more than one package.json' };
  let pkg: unknown;
  try {
    pkg = JSON.parse((manifests[0] as Buffer).toString('utf8'));
  } catch {
    return { ok: false, reason: 'has a package.json that is not JSON' };
  }
  if (typeof pkg !== 'object' || pkg === null || Array.isArray(pkg)) {
    return { ok: false, reason: 'has a package.json that is not an object' };
  }
  const p = pkg as Record<string, unknown>;
  const scripts =
    typeof p.scripts === 'object' && p.scripts !== null
      ? (p.scripts as Record<string, unknown>)
      : {};
  const installScripts: string[] = INSTALL_SCRIPTS.filter((k) => typeof scripts[k] === 'string');
  const hasOwnInstall =
    typeof scripts.install === 'string' || typeof scripts.preinstall === 'string';
  if ((gyp || p.gypfile === true) && !hasOwnInstall) installScripts.push('binding.gyp');
  return {
    ok: true,
    info: {
      name: typeof p.name === 'string' ? p.name : undefined,
      version: typeof p.version === 'string' ? p.version : undefined,
      installScripts,
    },
  };
}
