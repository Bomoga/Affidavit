import { request } from 'node:http';
import { Attestation, BundleManifest, type SignerPort } from '@affidavit/contracts';
import { attestationProblem } from '@affidavit/evidence';
import { SIGN_PATH } from './server.js';

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export class SignerUnavailableError extends Error {
  override name = 'SignerUnavailableError';
}

/**
 * `SignerPort` for the API and the worker: asks the signer service over its unix socket. It holds
 * no key and cannot read one. It still checks what comes back (`attestationProblem`), so a
 * signer that returned an attestation for a different manifest is an error, not a signature.
 */
export class SignerClient implements SignerPort {
  constructor(
    private readonly socketPath: string,
    private readonly timeoutMs = 90_000,
  ) {}

  async sign(manifest: BundleManifest): Promise<Attestation> {
    const m = BundleManifest.parse(manifest);
    const { status, text } = await this.#post(JSON.stringify(m));
    if (status !== 200) {
      let reason = `status ${status}`;
      try {
        const body = JSON.parse(text) as { error?: unknown };
        if (typeof body.error === 'string') reason = body.error;
      } catch {
        // keep the status
      }
      throw new SignerUnavailableError(`signer refused: ${reason}`);
    }
    let attestation: Attestation;
    try {
      attestation = Attestation.parse(JSON.parse(text));
    } catch {
      throw new SignerUnavailableError('signer returned something that is not an attestation');
    }
    const problem = attestationProblem(attestation, m);
    if (problem !== null)
      throw new SignerUnavailableError(`signer returned a bad attestation: ${problem}`);
    return attestation;
  }

  #post(body: string): Promise<{ status: number; text: string }> {
    return new Promise((resolve, reject) => {
      const req = request(
        {
          socketPath: this.socketPath,
          path: SIGN_PATH,
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
          },
          timeout: this.timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (c: Buffer) => {
            size += c.length;
            if (size > MAX_RESPONSE_BYTES) {
              res.destroy(new SignerUnavailableError('signer response too large'));
              return;
            }
            chunks.push(c);
          });
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }),
          );
          res.on('error', reject);
        },
      );
      req.on('timeout', () => req.destroy(new SignerUnavailableError('signer timed out')));
      req.on('error', (err) =>
        reject(
          err instanceof SignerUnavailableError
            ? err
            : new SignerUnavailableError(`cannot reach the signer: ${err.message}`, { cause: err }),
        ),
      );
      req.end(body);
    });
  }
}
