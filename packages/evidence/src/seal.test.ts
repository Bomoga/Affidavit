import {
  Attestation,
  Verdict,
  type BundleManifest,
  type CaseId,
  type CaseStore,
  type SignerPort,
} from '@affidavit/contracts';
import { describe, expect, it, vi } from 'vitest';
import { loadBundle } from './bundle.js';
import { canonicalBytes, sha256Hex } from './canonical.js';
import {
  SealError,
  VerdictSealer,
  sealVerdict,
  sealingCaseStore,
  type SealSource,
} from './seal.js';
import { MemoryEvidenceStore } from './store.js';
import { caseFile, fakeAttestation, pem, records, verdict } from './test-helpers.js';

const KEY = pem();
const TOOLS = { judge: '0.0.0' };
const AT = '2026-11-22T12:00:00.000Z';

/** A signer that attests whatever manifest it gets, like the real one, with a made-up signature. */
class FakeSigner implements SignerPort {
  readonly signed: BundleManifest[] = [];
  constructor(private readonly tweak?: (a: Attestation) => Attestation) {}
  sign(manifest: BundleManifest): Promise<Attestation> {
    this.signed.push(manifest);
    const a = fakeAttestation(manifest, KEY);
    return Promise.resolve(this.tweak === undefined ? a : this.tweak(a));
  }
}

const input = () => ({
  caseFile: caseFile(),
  verdict: verdict(),
  exhibits: records(),
  toolVersions: TOOLS,
  createdAt: AT,
});

describe('sealVerdict', () => {
  it('stores the bundle and the attestation and sets bundleSha256 on the verdict', async () => {
    const evidence = new MemoryEvidenceStore();
    const signer = new FakeSigner();
    const sealed = await sealVerdict(input(), { evidence, signer });

    expect(sealed.verdict).toEqual({ ...verdict(), bundleSha256: sealed.bundleSha256 });
    expect(Verdict.parse(sealed.verdict)).toEqual(sealed.verdict);
    const loaded = await loadBundle(evidence, sealed.bundleSha256);
    expect(loaded?.manifest).toEqual(sealed.manifest);
    // The bundle holds the verdict without its own address.
    expect(loaded?.verdict.bundleSha256).toBeUndefined();
    expect(signer.signed).toEqual([sealed.manifest]);
    const att = await evidence.get(sealed.attestationSha256);
    expect(att).toEqual(canonicalBytes(sealed.attestation));
    expect(sealed.attestationSha256).toBe(sha256Hex(canonicalBytes(sealed.attestation)));
  });

  it('gives the same bundle for the same evidence', async () => {
    const a = await sealVerdict(input(), {
      evidence: new MemoryEvidenceStore(),
      signer: new FakeSigner(),
    });
    const b = await sealVerdict(input(), {
      evidence: new MemoryEvidenceStore(),
      signer: new FakeSigner(),
    });
    expect(a.bundleSha256).toBe(b.bundleSha256);
  });

  it('refuses a verdict that already names a bundle, before signing', async () => {
    const signer = new FakeSigner();
    const v = { ...verdict(), bundleSha256: 'a'.repeat(64) } as Verdict;
    await expect(
      sealVerdict({ ...input(), verdict: v }, { evidence: new MemoryEvidenceStore(), signer }),
    ).rejects.toThrow(/already names a bundle/);
    expect(signer.signed).toEqual([]);
  });

  it('refuses an unpinned case file and a verdict citing a missing exhibit, before signing', async () => {
    const signer = new FakeSigner();
    const deps = { evidence: new MemoryEvidenceStore(), signer };
    await expect(sealVerdict({ ...input(), caseFile: caseFile(false) }, deps)).rejects.toThrow(
      SealError,
    );
    await expect(
      sealVerdict({ ...input(), exhibits: records().filter((r) => r.kind !== 'patch') }, deps),
    ).rejects.toThrow(/building the bundle/);
    expect(signer.signed).toEqual([]);
  });

  it('refuses an attestation for another manifest', async () => {
    const signer = new FakeSigner((a) => ({
      ...a,
      statement: { ...a.statement, predicate: { other: true } },
    }));
    await expect(
      sealVerdict(input(), { evidence: new MemoryEvidenceStore(), signer }),
    ).rejects.toThrow(/attestation: statement does not match the manifest/);
  });

  it('reports a signer failure as a SealError', async () => {
    const signer: SignerPort = { sign: () => Promise.reject(new Error('socket closed')) };
    const err = await sealVerdict(input(), { evidence: new MemoryEvidenceStore(), signer }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SealError);
    expect((err as Error).message).toMatch(/signing the manifest: socket closed/);
  });
});

const source = (over: Partial<SealSource> = {}): SealSource => ({
  pinnedCaseFile: () => Promise.resolve(caseFile()),
  records: () => Promise.resolve(records()),
  ...over,
});

describe('VerdictSealer', () => {
  it('seals from the source and calls onSealed before returning', async () => {
    const onSealed = vi.fn();
    const sealer = new VerdictSealer({
      evidence: new MemoryEvidenceStore(),
      signer: new FakeSigner(),
      source: source(),
      toolVersions: TOOLS,
      onSealed,
      now: () => new Date(AT),
    });
    const v = await sealer.seal(verdict());
    expect(v.bundleSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(onSealed).toHaveBeenCalledOnce();
    expect(onSealed.mock.calls[0]![0]).toMatchObject({ verdict: v, bundleSha256: v.bundleSha256 });
  });

  it('passes a verdict citing no exhibit through unsealed, without reading the source', async () => {
    const pinnedCaseFile = vi.fn(() => Promise.resolve(caseFile()));
    const signer = new FakeSigner();
    const sealer = new VerdictSealer({
      evidence: new MemoryEvidenceStore(),
      signer,
      source: source({ pinnedCaseFile }),
      toolVersions: TOOLS,
    });
    const dismissed = Verdict.parse({
      ...verdict(),
      outcome: 'dismissed',
      severity: undefined,
      exhibits: [],
    });
    expect(await sealer.seal(dismissed)).toEqual(dismissed);
    expect(pinnedCaseFile).not.toHaveBeenCalled();
    expect(signer.signed).toEqual([]);
  });

  it('refuses a pinned case file for another case', async () => {
    const other = { ...caseFile(), id: 'case-other' as CaseId };
    const sealer = new VerdictSealer({
      evidence: new MemoryEvidenceStore(),
      signer: new FakeSigner(),
      source: source({ pinnedCaseFile: () => Promise.resolve(other) }),
      toolVersions: TOOLS,
    });
    await expect(sealer.seal(verdict())).rejects.toThrow(/pinned case file is for case-other/);
  });

  it('turns a source or onSealed failure into a SealError', async () => {
    const base = {
      evidence: new MemoryEvidenceStore(),
      signer: new FakeSigner(),
      toolVersions: TOOLS,
    };
    await expect(
      new VerdictSealer({
        ...base,
        source: source({ records: () => Promise.reject(new Error('db down')) }),
      }).seal(verdict()),
    ).rejects.toThrow(/reading the exhibit records: db down/);
    await expect(
      new VerdictSealer({
        ...base,
        source: source(),
        onSealed: () => {
          throw new Error('no row');
        },
      }).seal(verdict()),
    ).rejects.toThrow(/recording the sealed verdict: no row/);
  });
});

class MemoryStore implements CaseStore {
  readonly verdicts: Verdict[] = [];
  open = () => Promise.resolve();
  stage = () => Promise.resolve('verdict' as const);
  transition = () => Promise.resolve();
  chargeBudget = () =>
    Promise.resolve({ usd: 0, inputTokens: 0, outputTokens: 0, exhausted: false } as never);
  nextSeq = () => Promise.resolve(1);
  appendVerdict = (v: Verdict) => {
    this.verdicts.push(v);
    return Promise.resolve();
  };
  getVerdict = () => Promise.resolve(this.verdicts[0] ?? null);
}

describe('sealingCaseStore', () => {
  it('appends the sealed verdict', async () => {
    const inner = new MemoryStore();
    const sealed = { ...verdict(), bundleSha256: 'b'.repeat(64) } as Verdict;
    const store = sealingCaseStore(inner, { seal: () => Promise.resolve(sealed) });
    await store.appendVerdict(verdict());
    expect(inner.verdicts).toEqual([sealed]);
    expect('releaseCharge' in store).toBe(false);
  });

  it('appends nothing when sealing fails', async () => {
    const inner = new MemoryStore();
    const store = sealingCaseStore(inner, {
      seal: () => Promise.reject(new SealError('case-x', 'signer down')),
    });
    await expect(store.appendVerdict(verdict())).rejects.toThrow(SealError);
    expect(inner.verdicts).toEqual([]);
  });

  it('keeps releaseCharge when the inner store has it', async () => {
    const releaseCharge = vi.fn(() => Promise.resolve('released' as never));
    const inner = Object.assign(new MemoryStore(), { releaseCharge });
    const store = sealingCaseStore(inner, { seal: (v) => Promise.resolve(v) });
    await expect(store.releaseCharge!(verdict().caseId, {} as never, 3)).resolves.toBe('released');
    expect(releaseCharge).toHaveBeenCalledWith(verdict().caseId, {}, 3);
  });
});
