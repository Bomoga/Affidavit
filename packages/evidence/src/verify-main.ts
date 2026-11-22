import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { VERIFY_EXIT, verifyBundleFiles } from './verify.js';

const USAGE = `usage: verify <bundle.tar> <attestation.json> --keys <keys.json> [--expect-sha256 <hex>] [--revoked <keyId>]...

Checks an Affidavit evidence bundle and its signed attestation offline, with cosign.
--keys is the published keys file (format in docs/keys/README.md): every key with its status.
A key with status revoked is always refused. --revoked refuses one more key id on top of the file.
Exit codes: 0 verified, 1 not verified, 2 usage or unreadable file, 3 cosign not installed.`;

/** Parses `argv` (no node/script prefix) and runs the verification. Returns an exit code. */
export async function verifyMain(
  argv: readonly string[],
  out: (line: string) => void = (l) => process.stdout.write(`${l}\n`),
): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        keys: { type: 'string' },
        'expect-sha256': { type: 'string' },
        cosign: { type: 'string' },
        revoked: { type: 'string', multiple: true },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (err) {
    out((err as Error).message);
    out(USAGE);
    return VERIFY_EXIT.USAGE;
  }
  const { values, positionals } = parsed;
  if (values.help === true) {
    out(USAGE);
    return VERIFY_EXIT.VERIFIED;
  }
  if (positionals.length !== 2) {
    out(USAGE);
    return VERIFY_EXIT.USAGE;
  }
  const [bundlePath, attestationPath] = positionals as [string, string];
  return verifyBundleFiles({
    bundlePath,
    attestationPath,
    keysPath: values.keys,
    ...(values['expect-sha256'] === undefined ? {} : { expectedSha256: values['expect-sha256'] }),
    ...(values.cosign === undefined ? {} : { cosignPath: values.cosign }),
    ...(values.revoked === undefined ? {} : { revokedKeyIds: values.revoked }),
    out,
  });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await verifyMain(process.argv.slice(2));
}
