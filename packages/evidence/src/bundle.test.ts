import { describe, expect, it } from 'vitest';
import { pack } from 'tar-stream';
import {
  BUNDLE_FORMAT_KEY,
  CASEFILE_ENTRY_ID,
  buildBundle,
  loadBundle,
  openBundle,
  storeBundle,
} from './bundle.js';
import { canonicalBytes, canonicalJson, sha256Hex } from './canonical.js';
import { BundleIntegrityError } from './errors.js';
import { MemoryEvidenceStore } from './store.js';
import { readTar, writeTar } from './tar.js';
import {
  SAFE_DIGEST,
  VULN_DIGEST,
  bundleInput,
  caseFile,
  records,
  verdict,
} from './test-helpers.js';

/** Rewrites one file inside a bundle, keeping every other byte and the manifest as they were. */
async function tamper(
  bytes: Uint8Array,
  edit: (files: Map<string, Uint8Array>) => void,
): Promise<Uint8Array> {
  const files = await readTar(bytes);
  edit(files);
  return writeTar([...files].map(([name, b]) => ({ name, bytes: b })));
}

const flipByte = (b: Uint8Array, at = 10): Uint8Array => {
  const copy = new Uint8Array(b);
  copy[at] = (copy[at] ?? 0) ^ 0x01;
  return copy;
};

async function integrityError(p: Promise<unknown>): Promise<BundleIntegrityError> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(BundleIntegrityError);
  return err as BundleIntegrityError;
}

describe('buildBundle', () => {
  it('is deterministic: the same evidence gives the same bytes and digest', async () => {
    const a = await buildBundle(bundleInput());
    const again = await buildBundle(bundleInput());
    expect(a.sha256).toBe(sha256Hex(a.bytes));
    expect(Buffer.from(again.bytes).equals(Buffer.from(a.bytes))).toBe(true);
  });

  it('writes a manifest that pins both targets and lists every exhibit and result', async () => {
    const { manifest, bytes } = await buildBundle(bundleInput());
    expect(manifest.targetDigests).toEqual({ vulnerable: VULN_DIGEST, safe: SAFE_DIGEST });
    expect(manifest.exhibits.map((e) => e.id)).toEqual([
      CASEFILE_ENTRY_ID,
      'exhibit-witness-001',
      'exhibit-counter-001',
      'exhibit-patch-001',
    ]);
    expect(manifest.results).toEqual([
      'exhibit-witness-001',
      'exhibit-counter-001',
      'exhibit-patch-001',
    ]);
    expect(manifest.toolVersions[BUNDLE_FORMAT_KEY]).toBe('1');
    const files = await readTar(bytes);
    expect([...files.keys()].sort()).toEqual([
      'casefile.json',
      'exhibits/exhibit-counter-001.json',
      'exhibits/exhibit-patch-001.json',
      'exhibits/exhibit-witness-001.json',
      'manifest.json',
      'verdict.json',
    ]);
    for (const e of manifest.exhibits) expect(sha256Hex(files.get(e.path)!)).toBe(e.sha256);
  });

  it('hashes the verdict without its bundleSha256, which cannot be inside the bundle it names', async () => {
    const plain = await buildBundle(bundleInput());
    const withSha = await buildBundle(
      bundleInput({ verdict: { ...verdict(), bundleSha256: 'f'.repeat(64) } }),
    );
    expect(withSha.manifest.verdictSha256).toBe(plain.manifest.verdictSha256);
    expect(plain.manifest.verdictSha256).toBe(sha256Hex(canonicalBytes(verdict())));
  });

  it.each([
    ['an unpinned vulnerable target', () => bundleInput({ caseFile: caseFile(false) })],
    [
      'an unpinned safe variant',
      () => {
        const cf = caseFile();
        return bundleInput({
          caseFile: { ...cf, safeVariant: { ...cf.safeVariant!, imageDigest: undefined } },
        });
      },
    ],
    [
      'a verdict citing an exhibit that is not included',
      () => bundleInput({ exhibits: records().slice(0, 2) }),
    ],
    [
      'a counterexample whose witness is not included',
      () =>
        bundleInput({ exhibits: records().slice(1, 2), verdict: { ...verdict(), exhibits: [] } }),
    ],
    ['the same exhibit twice', () => bundleInput({ exhibits: [...records(), records()[0]!] })],
    [
      'a verdict for another case',
      () => bundleInput({ verdict: { ...verdict(), caseId: 'case-other' as never } }),
    ],
    [
      'an exhibit id that is not a safe file name',
      () => {
        const [w, ...rest] = records();
        if (w?.kind !== 'witness') throw new Error('fixture');
        return bundleInput({
          exhibits: [{ ...w, result: { ...w.result, exhibitId: '../x' as never } }, ...rest],
        });
      },
    ],
    [
      'a caller setting the format version',
      () => bundleInput({ toolVersions: { [BUNDLE_FORMAT_KEY]: '9' } }),
    ],
  ])('refuses %s', async (_name, input) => {
    await expect(buildBundle(input())).rejects.toThrow();
  });
});

describe('openBundle', () => {
  it('opens an untouched bundle and sets the pinned digests on the case file', async () => {
    const built = await buildBundle(bundleInput({ caseFile: { ...caseFile() } }));
    const opened = await openBundle(built.bytes, { expectedSha256: built.sha256 });
    expect(opened.caseFile.target.imageDigest).toBe(VULN_DIGEST);
    expect(opened.caseFile.safeVariant?.imageDigest).toBe(SAFE_DIGEST);
    expect([...opened.exhibits.keys()]).toEqual(built.manifest.results);
    expect(canonicalJson(opened.verdict)).toBe(canonicalJson(verdict()));
  });

  it.each(['exhibit-witness-001', 'exhibit-counter-001', 'exhibit-patch-001'])(
    'names %s when one byte of it changes',
    async (id) => {
      const { bytes } = await buildBundle(bundleInput());
      const bad = await tamper(bytes, (f) => {
        f.set(`exhibits/${id}.json`, flipByte(f.get(`exhibits/${id}.json`)!));
      });
      const err = await integrityError(openBundle(bad));
      expect(err.exhibitId).toBe(id);
      expect(err.message).toContain(id);
    },
  );

  it('names every exhibit file byte: flipping any single byte fails with that id', async () => {
    const { bytes } = await buildBundle(bundleInput());
    const witness = (await readTar(bytes)).get('exhibits/exhibit-witness-001.json')!;
    for (let at = 0; at < witness.byteLength; at += 17) {
      const bad = await tamper(bytes, (f) =>
        f.set('exhibits/exhibit-witness-001.json', flipByte(witness, at)),
      );
      expect((await integrityError(openBundle(bad))).exhibitId).toBe('exhibit-witness-001');
    }
  });

  it('names the case file and the verdict when they change', async () => {
    const { bytes } = await buildBundle(bundleInput());
    const cf = await tamper(bytes, (f) =>
      f.set('casefile.json', flipByte(f.get('casefile.json')!)),
    );
    expect((await integrityError(openBundle(cf))).exhibitId).toBe(CASEFILE_ENTRY_ID);
    const v = await tamper(bytes, (f) => f.set('verdict.json', flipByte(f.get('verdict.json')!)));
    expect((await integrityError(openBundle(v))).exhibitId).toBe('verdict');
  });

  it('refuses a bundle that does not hash to the expected digest', async () => {
    const { bytes } = await buildBundle(bundleInput());
    const err = await integrityError(openBundle(bytes, { expectedSha256: '0'.repeat(64) }));
    expect(err.exhibitId).toBe('manifest.json');
  });

  it('refuses a missing exhibit file and an unlisted extra file', async () => {
    const { bytes } = await buildBundle(bundleInput());
    const missing = await tamper(bytes, (f) => f.delete('exhibits/exhibit-patch-001.json'));
    expect((await integrityError(openBundle(missing))).exhibitId).toBe('exhibit-patch-001');
    const extra = await tamper(bytes, (f) => f.set('exhibits/smuggled.json', canonicalBytes({})));
    expect((await integrityError(openBundle(extra))).message).toContain('exhibits/smuggled.json');
  });

  it('refuses a consistent rewrite that files one exhibit result under another id', async () => {
    const { bytes } = await buildBundle(bundleInput());
    const bad = await tamper(bytes, (f) => {
      const swapped = canonicalBytes(records()[1]);
      f.set('exhibits/exhibit-witness-001.json', swapped);
      const m = JSON.parse(Buffer.from(f.get('manifest.json')!).toString()) as {
        exhibits: { id: string; sha256: string }[];
      };
      for (const e of m.exhibits) if (e.id === 'exhibit-witness-001') e.sha256 = sha256Hex(swapped);
      f.set('manifest.json', canonicalBytes(m));
    });
    expect((await integrityError(openBundle(bad))).exhibitId).toBe('exhibit-witness-001');
  });

  it('refuses a case file whose digest disagrees with the manifest', async () => {
    const { bytes } = await buildBundle(bundleInput());
    const bad = await tamper(bytes, (f) => {
      const cf = caseFile();
      const forged = canonicalBytes({
        ...cf,
        target: { ...cf.target, imageDigest: `sha256:${'d'.repeat(64)}` },
      });
      f.set('casefile.json', forged);
      const m = JSON.parse(Buffer.from(f.get('manifest.json')!).toString()) as {
        exhibits: { id: string; sha256: string }[];
      };
      for (const e of m.exhibits) if (e.id === CASEFILE_ENTRY_ID) e.sha256 = sha256Hex(forged);
      f.set('manifest.json', canonicalBytes(m));
    });
    const err = await integrityError(openBundle(bad));
    expect(err.exhibitId).toBe(CASEFILE_ENTRY_ID);
    expect(err.reason).toContain('digest');
  });

  it.each([
    [
      'a symlink entry',
      { name: 'casefile.json', type: 'symlink' as const, linkname: '/etc/passwd' },
    ],
    ['a parent-directory name', { name: '../escape.json', type: 'file' as const }],
    ['an absolute name', { name: '/abs.json', type: 'file' as const }],
    ['a directory entry', { name: 'exhibits', type: 'directory' as const }],
  ])('refuses %s', async (_name, header) => {
    const p = pack();
    const chunks: Buffer[] = [];
    const done = (async () => {
      for await (const c of p) chunks.push(c as Buffer);
    })();
    if (header.type === 'file') p.entry({ ...header, size: 2 }, '{}');
    else p.entry({ ...header, size: 0 }, '');
    p.finalize();
    await done;
    await integrityError(openBundle(new Uint8Array(Buffer.concat(chunks))));
  });

  it('refuses bytes that are not a tar and a bundle over the size limit', async () => {
    await integrityError(openBundle(new Uint8Array(Buffer.from('not a tar at all'))));
    const { bytes } = await buildBundle(bundleInput());
    const err = await integrityError(
      openBundle(bytes, { limits: { maxEntries: 100, maxEntryBytes: 64, maxTotalBytes: 1 << 20 } }),
    );
    expect(err.message).toContain('size limit');
  });
});

describe('storeBundle and loadBundle', () => {
  it('stores the tar and each file under its own digest and loads it back checked', async () => {
    const store = new MemoryEvidenceStore();
    const built = await buildBundle(bundleInput());
    expect(await storeBundle(store, built)).toBe(built.sha256);
    for (const e of built.manifest.exhibits) expect(await store.get(e.sha256)).not.toBeNull();
    expect(await store.get(built.manifest.verdictSha256)).not.toBeNull();
    const loaded = await loadBundle(store, built.sha256);
    expect(loaded?.sha256).toBe(built.sha256);
    expect(await loadBundle(store, '0'.repeat(64))).toBeNull();
  });
});
