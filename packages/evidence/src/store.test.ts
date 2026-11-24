import { mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GetObjectCommand, NoSuchKey, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { afterAll, describe, expect, it } from 'vitest';
import { sha256Hex } from './canonical.js';
import { EvidenceCorruptError } from './errors.js';
import { FsEvidenceStore, MemoryEvidenceStore, S3EvidenceStore } from './store.js';

const dir = mkdtempSync(join(tmpdir(), 'affidavit-store-test-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const bytes = new Uint8Array(Buffer.from('exhibit bytes'));
const sha = sha256Hex(bytes);

describe.each([
  ['memory', () => new MemoryEvidenceStore()],
  ['filesystem', () => new FsEvidenceStore(mkdtempSync(join(dir, 'fs-')))],
])('%s store', (_name, make) => {
  it('files bytes under their SHA-256 and reads them back', async () => {
    const store = make();
    expect(await store.put(bytes)).toBe(sha);
    expect(Buffer.from((await store.get(sha))!).toString()).toBe('exhibit bytes');
    expect(await store.put(bytes)).toBe(sha);
  });

  it('returns null for a missing object or a malformed address', async () => {
    const store = make();
    expect(await store.get('0'.repeat(64))).toBeNull();
    expect(await store.get('../../etc/passwd')).toBeNull();
    expect(await store.get(sha.toUpperCase())).toBeNull();
  });
});

describe('MemoryEvidenceStore', () => {
  it('throws when stored bytes no longer hash to their address', async () => {
    const store = new MemoryEvidenceStore();
    await store.put(bytes);
    store.corrupt(sha, new Uint8Array(Buffer.from('other')));
    await expect(store.get(sha)).rejects.toBeInstanceOf(EvidenceCorruptError);
  });
});

describe('FsEvidenceStore', () => {
  it.skipIf(process.platform === 'win32')(
    'throws on corrupted bytes and refuses a symlink in place of an object',
    async () => {
      const root = mkdtempSync(join(dir, 'fs-corrupt-'));
      const store = new FsEvidenceStore(root);
      await store.put(bytes);
      const path = join(root, sha.slice(0, 2), sha);
      chmodSync(path, 0o600);
      writeFileSync(path, 'tampered');
      await expect(store.get(sha)).rejects.toBeInstanceOf(EvidenceCorruptError);
      rmSync(path);
      writeFileSync(join(root, 'real'), bytes);
      symlinkSync(join(root, 'real'), path);
      await expect(store.get(sha)).rejects.toBeInstanceOf(EvidenceCorruptError);
    },
  );

  it('leaves no temporary files behind', async () => {
    const root = mkdtempSync(join(dir, 'fs-tmp-'));
    await new FsEvidenceStore(root).put(bytes);
    expect(readdirSync(join(root, sha.slice(0, 2)))).toEqual([sha]);
  });
});

/** Just enough of S3Client: a bucket in a Map, honoring the checksum the way S3 does. */
function fakeS3() {
  const objects = new Map<string, Uint8Array>();
  const sent: unknown[] = [];
  const client = {
    send(cmd: unknown) {
      sent.push(cmd);
      if (cmd instanceof PutObjectCommand) {
        const body = cmd.input.Body as Uint8Array;
        const want = Buffer.from(sha256Hex(body), 'hex').toString('base64');
        if (cmd.input.ChecksumSHA256 !== want) return Promise.reject(new Error('BadDigest'));
        objects.set(`${cmd.input.Bucket}/${cmd.input.Key}`, body);
        return Promise.resolve({});
      }
      if (cmd instanceof GetObjectCommand) {
        const body = objects.get(`${cmd.input.Bucket}/${cmd.input.Key}`);
        if (body === undefined) {
          return Promise.reject(new NoSuchKey({ message: 'no such key', $metadata: {} }));
        }
        return Promise.resolve({
          ContentLength: body.byteLength,
          Body: { transformToByteArray: () => Promise.resolve(body) },
        });
      }
      return Promise.reject(new Error('unexpected command'));
    },
  };
  return { client: client as unknown as S3Client, objects, sent };
}

describe('S3EvidenceStore', () => {
  it('puts under the tenant prefix with a SHA-256 checksum and reads back checked', async () => {
    const s3 = fakeS3();
    const store = new S3EvidenceStore({
      client: s3.client,
      bucket: 'evidence',
      prefix: 'tenants/t1/',
    });
    expect(await store.put(bytes)).toBe(sha);
    expect([...s3.objects.keys()]).toEqual([`evidence/tenants/t1/sha256/${sha}`]);
    const put = s3.sent[0] as PutObjectCommand;
    expect(put.input.ChecksumSHA256).toBe(Buffer.from(sha, 'hex').toString('base64'));
    expect(Buffer.from((await store.get(sha))!).toString()).toBe('exhibit bytes');
    expect(await store.get('0'.repeat(64))).toBeNull();
  });

  it('throws when the service returns bytes that do not match the address', async () => {
    const s3 = fakeS3();
    const store = new S3EvidenceStore({ client: s3.client, bucket: 'evidence', prefix: '' });
    await store.put(bytes);
    s3.objects.set(`evidence/sha256/${sha}`, new Uint8Array(Buffer.from('swapped')));
    await expect(store.get(sha)).rejects.toBeInstanceOf(EvidenceCorruptError);
  });

  it.each(['tenants/t1', '../x/', 'a b/'])('refuses the prefix %j', (prefix) => {
    expect(() => new S3EvidenceStore({ client: fakeS3().client, bucket: 'b', prefix })).toThrow();
  });
});
