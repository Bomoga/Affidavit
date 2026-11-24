import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { GetObjectCommand, NoSuchKey, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import type { EvidenceStore } from '@affidavit/contracts';
import { SHA256_HEX, sha256Hex } from './canonical.js';
import { EvidenceCorruptError } from './errors.js';

/** Largest object any store here will read back. A bundle is far smaller (see bundle.ts). */
export const MAX_OBJECT_BYTES = 256 * 1024 * 1024;

/** Every store checks what it reads: bytes that do not hash to their address throw. */
function verified(sha256: string, bytes: Uint8Array): Uint8Array {
  if (sha256Hex(bytes) !== sha256) throw new EvidenceCorruptError(sha256);
  return bytes;
}

/** In-process store for tests and one-shot tools. */
export class MemoryEvidenceStore implements EvidenceStore {
  readonly #objects = new Map<string, Uint8Array>();

  put(bytes: Uint8Array): Promise<string> {
    const sha = sha256Hex(bytes);
    this.#objects.set(sha, new Uint8Array(bytes));
    return Promise.resolve(sha);
  }

  get(sha256: string): Promise<Uint8Array | null> {
    if (!SHA256_HEX.test(sha256)) return Promise.resolve(null);
    const bytes = this.#objects.get(sha256);
    if (bytes === undefined) return Promise.resolve(null);
    return Promise.resolve().then(() => verified(sha256, new Uint8Array(bytes)));
  }

  /** Test hook: replace the stored bytes without changing the address. */
  corrupt(sha256: string, bytes: Uint8Array): void {
    this.#objects.set(sha256, new Uint8Array(bytes));
  }
}

/**
 * Store on a local directory: `<root>/<first two hex>/<sha256>`. Writes go to a temporary name
 * and are renamed into place, so a reader never sees half an object. Symlinks are never followed.
 */
export class FsEvidenceStore implements EvidenceStore {
  constructor(readonly root: string) {}

  #path(sha256: string): string {
    return join(this.root, sha256.slice(0, 2), sha256);
  }

  async put(bytes: Uint8Array): Promise<string> {
    const sha = sha256Hex(bytes);
    const dest = this.#path(sha);
    await mkdir(join(this.root, sha.slice(0, 2)), { recursive: true, mode: 0o700 });
    const tmp = `${dest}.${randomUUID()}.tmp`;
    const fh = await open(tmp, 'wx', 0o400);
    try {
      await fh.writeFile(bytes);
      await fh.sync();
    } finally {
      await fh.close();
    }
    try {
      await rename(tmp, dest);
    } catch (err) {
      await rm(tmp, { force: true });
      // Windows refuses to rename over an existing read-only object (EPERM, or EEXIST). The
      // address is the content, so an object that is already there and verifies is the same put.
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EEXIST' || code === 'EACCES') {
        const existing = await this.get(sha).catch(() => null);
        if (existing !== null) return sha;
      }
      throw err;
    }
    return sha;
  }

  async get(sha256: string): Promise<Uint8Array | null> {
    if (!SHA256_HEX.test(sha256)) return null;
    const path = this.#path(sha256);
    let st;
    try {
      st = await lstat(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    if (!st.isFile() || st.size > MAX_OBJECT_BYTES) throw new EvidenceCorruptError(sha256);
    return verified(sha256, new Uint8Array(await readFile(path)));
  }
}

export interface S3EvidenceStoreOptions {
  client: S3Client;
  bucket: string;
  /**
   * Key prefix, for example `tenants/<tenantId>/`. Evidence paths are prefixed by tenant
   * (docs/plan.md, cross-tenant leakage), so each tenant gets its own store instance.
   */
  prefix: string;
}

/**
 * Store on any S3-compatible service (MinIO locally, R2 or S3 for the demo). Objects live at
 * `<prefix>sha256/<sha256>`. Uploads carry `x-amz-checksum-sha256`, so the service itself refuses
 * bytes that do not match the address; reads are checked again here.
 */
export class S3EvidenceStore implements EvidenceStore {
  constructor(private readonly opts: S3EvidenceStoreOptions) {
    const segments = opts.prefix.split('/').slice(0, -1);
    const safe =
      opts.prefix === '' ||
      (opts.prefix.endsWith('/') &&
        segments.every((seg) => /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(seg) && seg !== '..'));
    if (!safe) {
      throw new Error('prefix must be empty or end with "/" and use only safe key characters');
    }
  }

  key(sha256: string): string {
    return `${this.opts.prefix}sha256/${sha256}`;
  }

  async put(bytes: Uint8Array): Promise<string> {
    const sha = sha256Hex(bytes);
    await this.opts.client.send(
      new PutObjectCommand({
        Bucket: this.opts.bucket,
        Key: this.key(sha),
        Body: bytes,
        ContentLength: bytes.byteLength,
        ContentType: 'application/octet-stream',
        ChecksumSHA256: Buffer.from(sha, 'hex').toString('base64'),
      }),
    );
    return sha;
  }

  async get(sha256: string): Promise<Uint8Array | null> {
    if (!SHA256_HEX.test(sha256)) return null;
    try {
      const out = await this.opts.client.send(
        new GetObjectCommand({ Bucket: this.opts.bucket, Key: this.key(sha256) }),
      );
      if (out.ContentLength !== undefined && out.ContentLength > MAX_OBJECT_BYTES) {
        throw new EvidenceCorruptError(sha256);
      }
      if (out.Body === undefined) return null;
      const bytes = await out.Body.transformToByteArray();
      if (bytes.byteLength > MAX_OBJECT_BYTES) throw new EvidenceCorruptError(sha256);
      return verified(sha256, bytes);
    } catch (err) {
      if (err instanceof NoSuchKey) return null;
      throw err;
    }
  }
}
