import {
  Attestation,
  CaseFile,
  Verdict,
  type BundleManifest,
  type CaseId,
  type CaseStore,
  type EvidenceStore,
  type SignerPort,
} from '@affidavit/contracts';
import { attestationProblem } from './attestation.js';
import { buildBundle, storeBundle, type ExhibitRecord } from './bundle.js';
import { canonicalBytes } from './canonical.js';

/**
 * Sealing (CR-11, second half): the step between a verdict and `CaseStore.appendVerdict` that
 * files the case's evidence as a bundle, has the signer attest its manifest, and sets the
 * verdict's `bundleSha256`. No contract change: `Verdict.bundleSha256` is already optional, and
 * the stored attestation is found by its own digest (`SealedVerdict.attestationSha256`).
 */

/** Sealing could not finish. The verdict must not be written without its bundle. */
export class SealError extends Error {
  constructor(
    readonly caseId: string,
    reason: string,
  ) {
    super(`sealing ${caseId} failed: ${reason}`);
    this.name = 'SealError';
  }
}

export interface SealInput {
  /** The case file with every variant's `imageDigest` set to the image the exhibits ran on. */
  caseFile: CaseFile;
  /** The verdict to seal. It must not carry a `bundleSha256` yet. */
  verdict: Verdict;
  /** Every exhibit the verdict cites, and every witness or counterexample those name. */
  exhibits: readonly ExhibitRecord[];
  /** Versions of the tools that produced the evidence (runner image, Judge, scanners). */
  toolVersions: Readonly<Record<string, string>>;
  createdAt: string;
}

export interface SealDeps {
  evidence: EvidenceStore;
  signer: SignerPort;
}

export interface SealedVerdict {
  /** The input verdict with `bundleSha256` set: what `appendVerdict` should store. */
  verdict: Verdict;
  bundleSha256: string;
  manifest: BundleManifest;
  attestation: Attestation;
  /** Where the attestation's canonical JSON is in the evidence store. */
  attestationSha256: string;
}

/**
 * Builds the bundle, stores it (the tar and each file under its own digest), has the signer
 * attest its manifest, checks the attestation is for that manifest (`attestationProblem`; the
 * signature itself is checked by whoever holds the public key), and stores the attestation.
 * Throws `SealError` at the first failure; nothing is half sealed from the caller's side, since
 * the verdict comes back only when every step passed. A failure may leave bundle files in the
 * store: they are content addressed and harmless, and no verdict names them.
 */
export async function sealVerdict(input: SealInput, deps: SealDeps): Promise<SealedVerdict> {
  const caseId = input.verdict.caseId;
  if (input.verdict.bundleSha256 !== undefined) {
    throw new SealError(caseId, 'the verdict already names a bundle');
  }
  const step = async <T>(what: string, run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (err) {
      if (err instanceof SealError) throw err;
      throw new SealError(caseId, `${what}: ${(err as Error).message.slice(0, 500)}`);
    }
  };

  const bundle = await step('building the bundle', () =>
    buildBundle({
      caseFile: input.caseFile,
      verdict: input.verdict,
      exhibits: input.exhibits,
      toolVersions: input.toolVersions,
      createdAt: input.createdAt,
    }),
  );
  const bundleSha256 = await step('storing the bundle', () => storeBundle(deps.evidence, bundle));
  const raw = await step('signing the manifest', () => deps.signer.sign(bundle.manifest));
  const problem = attestationProblem(raw, bundle.manifest);
  if (problem !== null) throw new SealError(caseId, `the signer's attestation: ${problem}`);
  const attestation = Attestation.parse(raw);
  const attBytes = canonicalBytes(attestation);
  const attestationSha256 = await step('storing the attestation', () =>
    deps.evidence.put(attBytes),
  );
  const verdict = Verdict.parse({ ...input.verdict, bundleSha256 });
  return { verdict, bundleSha256, manifest: bundle.manifest, attestation, attestationSha256 };
}

/**
 * What the sealer reads about a case. Lane 1 provides it from the case store (the exhibits as
 * submitted, the Judge's results, and the run logs the Judge's `RunLogRecorder` handed over);
 * the pinned case file comes from the Judge's targets (`CaseTargets.bind`).
 */
export interface SealSource {
  pinnedCaseFile(caseId: CaseId): Promise<CaseFile>;
  records(caseId: CaseId): Promise<readonly ExhibitRecord[]>;
}

export interface VerdictSealerOptions extends SealDeps {
  source: SealSource;
  toolVersions: Readonly<Record<string, string>>;
  /** Called after each sealed verdict, before it is written (for example to record the attestation's digest). */
  onSealed?: (sealed: SealedVerdict) => Promise<void> | void;
  now?: () => Date;
}

/**
 * Seals verdicts from a `SealSource`. A verdict that cites no exhibit passes through unsealed
 * (`bundleSha256` stays absent): nothing ran in the sandbox, so there is no evidence to attest,
 * and a bundle must pin a target image that a case dismissed before any boot never had. Every
 * other verdict is sealed or refused: there is no unsealed fallback.
 */
export class VerdictSealer {
  readonly #opts: VerdictSealerOptions;

  constructor(opts: VerdictSealerOptions) {
    this.#opts = opts;
  }

  async seal(verdict: Verdict): Promise<Verdict> {
    const v = Verdict.parse(verdict);
    if (v.exhibits.length === 0) {
      if (v.bundleSha256 !== undefined) {
        throw new SealError(v.caseId, 'a verdict citing no exhibit names a bundle');
      }
      return v;
    }
    const { source } = this.#opts;
    const read = async <T>(what: string, run: () => Promise<T>): Promise<T> => {
      try {
        return await run();
      } catch (err) {
        throw new SealError(v.caseId, `${what}: ${(err as Error).message.slice(0, 500)}`);
      }
    };
    const caseFile = await read('reading the pinned case file', () =>
      source.pinnedCaseFile(v.caseId),
    );
    if (caseFile.id !== v.caseId) {
      throw new SealError(v.caseId, `the pinned case file is for ${caseFile.id}`);
    }
    const exhibits = await read('reading the exhibit records', () => source.records(v.caseId));
    const sealed = await sealVerdict(
      {
        caseFile,
        verdict: v,
        exhibits,
        toolVersions: this.#opts.toolVersions,
        createdAt: (this.#opts.now?.() ?? new Date()).toISOString(),
      },
      this.#opts,
    );
    if (this.#opts.onSealed !== undefined) {
      await read('recording the sealed verdict', async () => this.#opts.onSealed!(sealed));
    }
    return sealed.verdict;
  }
}

/**
 * A `CaseStore` whose `appendVerdict` seals first and stores the sealed verdict. Every other
 * method is the inner store's. If sealing throws, nothing is appended, so the verdict stage fails
 * like any other stage error and the case keeps its stage.
 */
export function sealingCaseStore<S extends CaseStore>(
  store: S,
  sealer: Pick<VerdictSealer, 'seal'>,
): CaseStore {
  const wrapped: CaseStore = {
    open: (caseFile, budget) => store.open(caseFile, budget),
    stage: (caseId) => store.stage(caseId),
    transition: (caseId, to) => store.transition(caseId, to),
    chargeBudget: (caseId, cost) => store.chargeBudget(caseId, cost),
    nextSeq: (caseId) => store.nextSeq(caseId),
    appendVerdict: async (verdict) => store.appendVerdict(await sealer.seal(verdict)),
    getVerdict: (caseId) => store.getVerdict(caseId),
  };
  const release = store.releaseCharge?.bind(store);
  if (release !== undefined) wrapped.releaseCharge = release;
  return wrapped;
}
