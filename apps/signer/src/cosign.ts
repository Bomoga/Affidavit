import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Attestation, BundleManifest, type SignerPort } from '@affidavit/contracts';
import {
  attestationProblem,
  canonicalJson,
  manifestStatement,
  publicKeyId,
} from '@affidavit/evidence';

const exec = promisify(execFile);

/**
 * A Sigstore signing config with no Fulcio, Rekor or timestamp service: cosign signs with the
 * team key only and uploads nothing. Verdicts are private, so they never go to Sigstore's public
 * transparency log (docs/plan.md, signing key decision).
 */
export const OFFLINE_SIGNING_CONFIG = JSON.stringify({
  mediaType: 'application/vnd.dev.sigstore.signingconfig.v0.2+json',
});

export interface CosignSignerOptions {
  /**
   * What cosign signs with: a path to an encrypted cosign key file, or a KMS reference
   * (`awskms://`, `gcpkms://`, `azurekms://`, `hashivault://`). Which one is used in production
   * is the open custody decision in docs/decisions.md; nothing here depends on it.
   */
  keyRef: string;
  /** The matching public key (PEM). Its digest is the attestation's `keyId`. */
  publicKeyPem: string;
  /** The password of a file key (`COSIGN_PASSWORD`); omitted for KMS keys. */
  password?: string;
  cosignPath?: string;
  /** Private directory for the statement and the bundle while cosign runs. */
  workDir?: string;
}

export class SigningError extends Error {
  override name = 'SigningError';
}

/**
 * `SignerPort` over `cosign attest-blob`. It signs only what it builds itself from a manifest
 * that parses: the in-toto statement from `manifestStatement`, whose subject is the manifest's
 * canonical bytes. The caller never chooses the statement, the subject or the predicate type.
 * Every attestation is checked (`attestationProblem`) before it is returned.
 *
 * cosign runs with an environment holding only PATH, a throwaway HOME and the key password, so
 * no ambient cloud or OIDC credential is picked up.
 */
export class CosignSigner implements SignerPort {
  readonly keyId: string;

  constructor(private readonly opts: CosignSignerOptions) {
    this.keyId = publicKeyId(opts.publicKeyPem);
  }

  async sign(manifest: BundleManifest): Promise<Attestation> {
    const m = BundleManifest.parse(manifest);
    const statement = manifestStatement(m);
    const dir = await mkdtemp(join(this.opts.workDir ?? tmpdir(), 'affidavit-sign-'));
    try {
      const statementPath = join(dir, 'statement.json');
      const configPath = join(dir, 'signing-config.json');
      const bundlePath = join(dir, 'attestation.sigstore.json');
      await writeFile(statementPath, canonicalJson(statement), { mode: 0o600 });
      await writeFile(configPath, OFFLINE_SIGNING_CONFIG, { mode: 0o600 });
      const env: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: dir };
      if (this.opts.password !== undefined) env.COSIGN_PASSWORD = this.opts.password;
      try {
        await exec(
          this.opts.cosignPath ?? 'cosign',
          [
            'attest-blob',
            '--key',
            this.opts.keyRef,
            '--statement',
            statementPath,
            '--signing-config',
            configPath,
            '--bundle',
            bundlePath,
          ],
          { env, timeout: 60_000 },
        );
      } catch (err) {
        const e = err as NodeJS.ErrnoException & { stderr?: string };
        if (e.code === 'ENOENT') throw new SigningError('cosign is not installed');
        const line = (e.stderr ?? '').split('\n').find((l) => l.startsWith('Error:'));
        throw new SigningError(`cosign attest-blob failed: ${line ?? 'no error line'}`);
      }
      const attestation = Attestation.parse({
        schemaVersion: 1,
        statement,
        signature: await readFile(bundlePath, 'utf8'),
        keyId: this.keyId,
      });
      const problem = attestationProblem(attestation, m);
      if (problem !== null) throw new SigningError(`cosign produced a bad attestation: ${problem}`);
      return attestation;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
