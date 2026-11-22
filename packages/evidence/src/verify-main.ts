import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { VERIFY_EXIT, verifyBundleFiles } from './verify.js';

const USAGE = `usage: verify <bundle.tar> <attestation.json> --key <public.pem> [--key <older.pem>] [--expect-sha256 <hex>]

Checks an Affidavit evidence bundle and its signed attestation offline, with cosign.
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
        key: { type: 'string', multiple: true },
        'expect-sha256': { type: 'string' },
        cosign: { type: 'string' },
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
    publicKeyPaths: values.key ?? [],
    ...(values['expect-sha256'] === undefined ? {} : { expectedSha256: values['expect-sha256'] }),
    ...(values.cosign === undefined ? {} : { cosignPath: values.cosign }),
    out,
  });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await verifyMain(process.argv.slice(2));
}
