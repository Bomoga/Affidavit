import { readFile, readdir } from 'node:fs/promises';
import { BundleManifest } from '@affidavit/contracts';
import { SignerClient } from './client.js';

/**
 * Run as the API's identity by the isolation test (isolation.integration.test.ts): tries to read
 * the signing key, its password and its directory, then asks the signer for a signature. Prints
 * one JSON line. Not part of the package's exports.
 */
const [keyPath, passwordPath, keyDir, socketPath, manifestJson] = process.argv.slice(2);

async function attempt(f: () => Promise<unknown>): Promise<string> {
  try {
    await f();
    return 'read';
  } catch (err) {
    return (err as NodeJS.ErrnoException).code ?? 'error';
  }
}

const manifest = BundleManifest.parse(JSON.parse(manifestJson ?? ''));
const out = {
  uid: process.getuid?.(),
  key: await attempt(() => readFile(keyPath ?? '')),
  password: await attempt(() => readFile(passwordPath ?? '')),
  keyDir: await attempt(() => readdir(keyDir ?? '')),
  attestation: await new SignerClient(socketPath ?? '').sign(manifest),
};
console.log(JSON.stringify(out));
