import { CreateBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { buildBundle, loadBundle, storeBundle } from './bundle.js';
import { sha256Hex } from './canonical.js';
import { EvidenceCorruptError } from './errors.js';
import { S3EvidenceStore } from './store.js';
import { bundleInput } from './test-helpers.js';

// Needs an S3-compatible service, for example a local MinIO. Run with
// `AFFIDAVIT_S3_ENDPOINT=http://127.0.0.1:9000 AFFIDAVIT_S3_ACCESS_KEY=... AFFIDAVIT_S3_SECRET_KEY=...
//  pnpm --filter @affidavit/evidence test:s3`; skipped in plain `pnpm test`.
const endpoint = process.env.AFFIDAVIT_S3_ENDPOINT;

describe.runIf(endpoint !== undefined)('S3EvidenceStore against a real service', () => {
  const client = new S3Client({
    endpoint,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.AFFIDAVIT_S3_ACCESS_KEY ?? '',
      secretAccessKey: process.env.AFFIDAVIT_S3_SECRET_KEY ?? '',
    },
  });
  const bucket = `affidavit-test-${Date.now()}`;

  it('stores a bundle under the tenant prefix and loads it back checked', async () => {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
    const store = new S3EvidenceStore({ client, bucket, prefix: 'tenants/t1/' });
    const built = await buildBundle(bundleInput());
    expect(await storeBundle(store, built)).toBe(built.sha256);
    const loaded = await loadBundle(store, built.sha256);
    expect(loaded?.manifest.caseId).toBe('case-nodegoat-sqli-001');
    expect(await store.get('0'.repeat(64))).toBeNull();
  });

  it('is refused by the service when the bytes do not match the declared checksum', async () => {
    const body = new Uint8Array(Buffer.from('real bytes'));
    await expect(
      client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: `tenants/t1/sha256/${sha256Hex(body)}`,
          Body: body,
          ChecksumSHA256: Buffer.from(sha256Hex('other bytes'), 'hex').toString('base64'),
        }),
      ),
    ).rejects.toThrow();
  });

  it('throws when an object was replaced behind the store', async () => {
    const store = new S3EvidenceStore({ client, bucket, prefix: 'tenants/t2/' });
    const sha = await store.put(new Uint8Array(Buffer.from('original')));
    // Written around the store, with no checksum, as a compromised writer would.
    await client.send(
      new PutObjectCommand({ Bucket: bucket, Key: store.key(sha), Body: Buffer.from('swapped') }),
    );
    await expect(store.get(sha)).rejects.toBeInstanceOf(EvidenceCorruptError);
  });
});
