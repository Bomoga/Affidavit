import { chmod, lstat, unlink } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { BundleManifest, type SignerPort } from '@affidavit/contracts';

/** The only route: POST a `BundleManifest` as JSON, get an `Attestation` back. */
export const SIGN_PATH = '/v1/sign';
export const MAX_MANIFEST_BYTES = 1024 * 1024;

export interface SignerServerOptions {
  /** Unix socket path. The signer listens on nothing else: no TCP port exists. */
  socketPath: string;
  signer: SignerPort;
  /**
   * Socket file mode. Default 0o660: the signer's user and the group shared with the API and the
   * worker may connect; nobody else. The key file is never group readable.
   */
  socketMode?: number;
  maxBodyBytes?: number;
  /** Called with each signing failure (for the signer's own log); the client gets no detail. */
  onError?: (err: unknown) => void;
}

export interface RunningSigner {
  server: Server;
  close(): Promise<void>;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function readBody(req: IncomingMessage, max: number): Promise<string> {
  const declared = Number(req.headers['content-length'] ?? '0');
  if (Number.isFinite(declared) && declared > max) {
    req.resume();
    return Promise.reject(new HttpError(413, 'manifest too large'));
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      // Past the limit the rest is read and dropped, so the client still gets the 413.
      if (size <= max) chunks.push(c);
    });
    req.on('end', () => {
      if (size > max) reject(new HttpError(413, 'manifest too large'));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    ...(status === 413 ? { connection: 'close' } : {}),
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

/**
 * The signer service. It answers one request shape and signs only a manifest that parses; the
 * statement, subject and predicate type are built by the signer, never taken from the request.
 * Errors carry no detail beyond their class (no paths, key references or cosign output).
 */
export async function startSignerServer(opts: SignerServerOptions): Promise<RunningSigner> {
  const max = opts.maxBodyBytes ?? MAX_MANIFEST_BYTES;
  const server = createServer((req, res) => {
    void (async () => {
      try {
        if (req.url !== SIGN_PATH) throw new HttpError(404, 'not found');
        if (req.method !== 'POST') throw new HttpError(405, 'method not allowed');
        if (!(req.headers['content-type'] ?? '').startsWith('application/json')) {
          throw new HttpError(415, 'expected application/json');
        }
        const text = await readBody(req, max);
        let body: unknown;
        try {
          body = JSON.parse(text);
        } catch {
          throw new HttpError(400, 'body is not JSON');
        }
        const manifest = BundleManifest.safeParse(body);
        if (!manifest.success) throw new HttpError(400, 'body is not a bundle manifest');
        let attestation;
        try {
          attestation = await opts.signer.sign(manifest.data);
        } catch (err) {
          opts.onError?.(err);
          throw new HttpError(500, 'signing failed');
        }
        send(res, 200, attestation);
      } catch (err) {
        const e = err instanceof HttpError ? err : new HttpError(500, 'signing failed');
        if (!(err instanceof HttpError)) opts.onError?.(err);
        if (!res.headersSent) send(res, e.status, { error: e.message });
      }
    })();
  });

  // A stale socket from a previous run is removed; any other file at that path is left alone.
  try {
    if ((await lstat(opts.socketPath)).isSocket()) await unlink(opts.socketPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
  await chmod(opts.socketPath, opts.socketMode ?? 0o660);
  return {
    server,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err === undefined ? resolve() : reject(err))),
      ),
  };
}
