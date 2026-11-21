import { readFile, stat } from 'node:fs/promises';
import { CosignSigner } from './cosign.js';
import { startSignerServer } from './server.js';

/**
 * The signer process. Configuration comes from the environment:
 *
 * - `AFFIDAVIT_SIGNER_SOCKET`: unix socket to listen on.
 * - `AFFIDAVIT_SIGNER_KEY`: cosign key reference (a file path or a KMS URI).
 * - `AFFIDAVIT_SIGNER_PUBLIC_KEY`: path to the matching public key (PEM).
 * - `AFFIDAVIT_SIGNER_PASSWORD_FILE`: file holding the key password (file keys only).
 *
 * A file key, and its password file, must be readable by this user only (mode 0400 or 0600):
 * the API and the worker share a group with the signer for the socket, never for the key.
 */
export async function loadConfig(env: NodeJS.ProcessEnv): Promise<{
  socketPath: string;
  signer: CosignSigner;
}> {
  const need = (name: string): string => {
    const v = env[name];
    if (v === undefined || v === '') throw new Error(`${name} is not set`);
    return v;
  };
  const socketPath = need('AFFIDAVIT_SIGNER_SOCKET');
  const keyRef = need('AFFIDAVIT_SIGNER_KEY');
  const publicKeyPem = await readFile(need('AFFIDAVIT_SIGNER_PUBLIC_KEY'), 'utf8');
  const isFileKey = !/^[a-z]+:\/\//.test(keyRef);
  let password: string | undefined;
  if (isFileKey) {
    await ownerOnly(keyRef, 'the signing key');
    const passwordFile = need('AFFIDAVIT_SIGNER_PASSWORD_FILE');
    await ownerOnly(passwordFile, 'the key password file');
    password = (await readFile(passwordFile, 'utf8')).replace(/\r?\n$/, '');
  }
  return {
    socketPath,
    signer: new CosignSigner({
      keyRef,
      publicKeyPem,
      ...(password === undefined ? {} : { password }),
    }),
  };
}

async function ownerOnly(path: string, what: string): Promise<void> {
  const st = await stat(path);
  if (!st.isFile()) throw new Error(`${what} is not a regular file`);
  if ((st.mode & 0o077) !== 0) {
    throw new Error(`${what} is readable by group or others; it must be mode 0400 or 0600`);
  }
}

async function main(): Promise<void> {
  const { socketPath, signer } = await loadConfig(process.env);
  const running = await startSignerServer({
    socketPath,
    signer,
    onError: (err) => console.error(`signing failed: ${(err as Error).message}`),
  });
  console.log(`signer listening, key ${signer.keyId}`);
  const stop = () => {
    void running.close().finally(() => process.exit(0));
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}
