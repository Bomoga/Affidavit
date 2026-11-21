import { gunzipSync } from 'node:zlib';
import tar from 'tar-stream';

export interface PackageInspection {
  name: string | undefined;
  version: string | undefined;
  /**
   * What npm would run at install time if scripts were enabled, for the package and for every
   * package nested under `node_modules` inside its tarball (bundled dependencies):
   * `preinstall`, `install` and `postinstall` from each package.json, and `binding.gyp` (npm's
   * implicit `node-gyp rebuild` when a package ships one without its own install script). The
   * package's own entries are bare (`postinstall`); nested ones carry their path
   * (`node_modules/x: postinstall`). Empty for a package that needs none.
   */
  installScripts: string[];
  /**
   * `prepare` scripts, labelled the same way. npm runs `prepare` only for the root project and for
   * git or folder sources, never for a registry tarball, and the install uses `--ignore-scripts`,
   * so they do not make a package unsupported; the manifest records `prepareScriptIgnored`.
   */
  prepareScripts: string[];
}

export type InspectRead = { ok: true; info: PackageInspection } | { ok: false; reason: string };

const MAX_PACKAGE_JSON_BYTES = 1024 * 1024;
const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall'] as const;

/** A directory inside the package that npm treats as a package root: '' or nested node_modules. */
const PACKAGE_ROOT =
  /^(node_modules\/(@[^/]+\/)?[^/@][^/]*)(\/node_modules\/(@[^/]+\/)?[^/@][^/]*)*$/;
const isPackageRoot = (dir: string): boolean => dir === '' || PACKAGE_ROOT.test(dir);

type Obj = Record<string, unknown>;

function scriptsOf(pkg: Obj, gyp: boolean): string[] {
  const scripts =
    typeof pkg.scripts === 'object' && pkg.scripts !== null ? (pkg.scripts as Obj) : {};
  const found: string[] = INSTALL_SCRIPTS.filter((k) => typeof scripts[k] === 'string');
  const hasOwnInstall =
    typeof scripts.install === 'string' || typeof scripts.preinstall === 'string';
  if ((gyp || pkg.gypfile === true) && !hasOwnInstall) found.push('binding.gyp');
  return found;
}

/**
 * Reads a package tarball (gzip of a tar, as the npm registry serves it) without writing anything.
 * npm strips the first path component; below it, the package root and every `node_modules/<name>`
 * (or `node_modules/@scope/<name>`) directory at any depth is a package whose `package.json` and
 * `binding.gyp` are read. The content is untrusted data; it is parsed, never run. Refused: a
 * tarball that unpacks past `maxUnpackedBytes`, is not a tar, has no or several top-level
 * package.json, or has a package.json over 1 MiB or that is not a JSON object.
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
  const manifests = new Map<string, Buffer[]>();
  const gyps = new Set<string>();
  const done = (async (): Promise<string | null> => {
    for await (const entry of extract) {
      const parts = entry.header.name.split('/').filter((p) => p !== '' && p !== '.');
      const base = parts[parts.length - 1];
      const dir = parts.slice(1, -1).join('/');
      if (parts.length >= 2 && isPackageRoot(dir)) {
        if (base === 'package.json' && entry.header.type === 'file') {
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const c of entry as AsyncIterable<Buffer>) {
            size += c.length;
            if (size > MAX_PACKAGE_JSON_BYTES) return 'has a package.json over 1 MiB';
            chunks.push(c);
          }
          const list = manifests.get(dir) ?? [];
          list.push(Buffer.concat(chunks));
          manifests.set(dir, list);
          continue;
        }
        if (base === 'binding.gyp') gyps.add(dir);
      }
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
  const top = manifests.get('');
  if (top === undefined) return { ok: false, reason: 'has no package.json' };
  if (top.length > 1) return { ok: false, reason: 'has more than one package.json' };

  const installScripts: string[] = [];
  const prepareScripts: string[] = [];
  let own: Obj | undefined;
  for (const [dir, list] of [...manifests].sort(([a], [b]) => (a < b ? -1 : 1))) {
    for (const buf of list) {
      let pkg: unknown;
      try {
        pkg = JSON.parse(buf.toString('utf8'));
      } catch {
        return {
          ok: false,
          reason: `has a ${dir === '' ? '' : `${dir}/`}package.json that is not JSON`,
        };
      }
      if (typeof pkg !== 'object' || pkg === null || Array.isArray(pkg)) {
        return {
          ok: false,
          reason: `has a ${dir === '' ? '' : `${dir}/`}package.json that is not an object`,
        };
      }
      if (dir === '') own = pkg as Obj;
      for (const s of scriptsOf(pkg as Obj, gyps.has(dir))) {
        installScripts.push(dir === '' ? s : `${dir}: ${s}`);
      }
      const scripts = (pkg as Obj).scripts;
      if (
        typeof scripts === 'object' &&
        scripts !== null &&
        typeof (scripts as Obj).prepare === 'string'
      ) {
        prepareScripts.push(dir === '' ? 'prepare' : `${dir}: prepare`);
      }
    }
  }
  // A binding.gyp in a nested package root without a package.json is still a native build.
  for (const dir of gyps) {
    if (dir !== '' && !manifests.has(dir)) installScripts.push(`${dir}: binding.gyp`);
  }
  return {
    ok: true,
    info: {
      name: typeof own?.name === 'string' ? own.name : undefined,
      version: typeof own?.version === 'string' ? own.version : undefined,
      installScripts,
      prepareScripts,
    },
  };
}
