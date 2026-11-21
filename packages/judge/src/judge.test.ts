import { describe, expect, it } from 'vitest';
import type { CaseFile, Exhibit, Witness } from '@affidavit/contracts';
import { createHash } from 'node:crypto';
import { Judge, counterexampleExhibitId, witnessExhibitId } from './judge.js';
import { DEFAULT_POLICY } from './rules.js';
import {
  ScriptedExecutor,
  differentialTarget,
  exhibitResultFixture,
  gateCaseFile,
  gateWitness,
  raw,
} from './test-helpers.js';

const noSafeVariant = (): CaseFile => {
  const cf = gateCaseFile();
  delete cf.safeVariant;
  return cf;
};

const counterexample = (over: Partial<Exhibit> = {}): Exhibit =>
  ({
    schemaVersion: 1,
    id: 'exhibit-counter-001',
    caseId: 'case-nodegoat-sqli-001',
    author: 'prosecution',
    kind: 'counterexample',
    code: '/* prosecution counterexample */',
    sha256: '9'.repeat(64),
    ...over,
  }) as Exhibit;

describe('Judge.runWitness', () => {
  it('admits the gate witness with vulnPass and safeVariantFail', async () => {
    const exec = new ScriptedExecutor(differentialTarget(3));
    const result = await new Judge(exec).runWitness(gateCaseFile(), gateWitness(), [
      'vulnerable',
      'safe',
    ]);
    const expected = exhibitResultFixture('admissible.json');
    expect(result).toMatchObject({
      admissible: true,
      vulnPass: true,
      safeVariantFail: true,
      passed: true,
      egressAttempts: 0,
      familyResults: expected.familyResults,
    });
  });

  it('runs three attempts on each variant, in order, with the hard timeout', async () => {
    const exec = new ScriptedExecutor(differentialTarget(3));
    const cf = gateCaseFile();
    await new Judge(exec).runWitness(cf, gateWitness(), ['vulnerable', 'safe']);
    expect(exec.requests.map((r) => `${r.variant}:${r.attempt}`)).toEqual([
      'vulnerable:1',
      'vulnerable:2',
      'vulnerable:3',
      'safe:1',
      'safe:2',
      'safe:3',
    ]);
    expect(exec.requests.every((r) => r.timeoutMs === DEFAULT_POLICY.hardTimeoutMs)).toBe(true);
    expect(exec.requests[0]?.target).toEqual(cf.target);
    expect(exec.requests[3]?.target).toEqual(cf.safeVariant);
    expect(exec.requests[0]?.template).toBe(gateWitness().template);
  });

  it("passes the Judge's own artifact limit to the executor, not a default", async () => {
    const exec = new ScriptedExecutor(differentialTarget(3));
    const policy = { ...DEFAULT_POLICY, maxArtifactBytes: 123_456 };
    await new Judge(exec, policy).runWitness(gateCaseFile(), gateWitness(), ['vulnerable']);
    expect(exec.requests.every((r) => r.maxArtifactBytes === 123_456)).toBe(true);
  });

  it('runs the safe variant even when the caller only asks for vulnerable (F2)', async () => {
    const exec = new ScriptedExecutor(() => raw([true, true, true]));
    const result = await new Judge(exec).runWitness(gateCaseFile(), gateWitness(), ['vulnerable']);
    expect(exec.requests.some((r) => r.variant === 'safe')).toBe(true);
    expect(result).toMatchObject({ admissible: false, rejectedBy: 'differential' });
  });

  it('admits on vulnerable alone when the case has no safe variant', async () => {
    const exec = new ScriptedExecutor(differentialTarget(3));
    const result = await new Judge(exec).runWitness(noSafeVariant(), gateWitness(), ['vulnerable']);
    expect(exec.requests).toHaveLength(3);
    expect(result.admissible).toBe(true);
    expect(result.safeVariantFail).toBeUndefined();
  });

  it.each([
    [['patched', 'vulnerable'], /verifyPatch/],
    [['safe'], /vulnerable variant must be run/],
    [[], /vulnerable variant must be run/],
  ] as const)('refuses variants %j', async (variants, why) => {
    const exec = new ScriptedExecutor(differentialTarget(3));
    await expect(
      new Judge(exec).runWitness(gateCaseFile(), gateWitness(), variants),
    ).rejects.toThrow(why);
    expect(exec.requests).toHaveLength(0);
  });

  it('refuses a safe variant the case file does not have', async () => {
    const exec = new ScriptedExecutor(differentialTarget(3));
    await expect(
      new Judge(exec).runWitness(noSafeVariant(), gateWitness(), ['vulnerable', 'safe']),
    ).rejects.toThrow(/no safe variant/);
  });

  it.each([
    ['an empty template', { template: '' }],
    ['a parameter with no values', { params: [{ name: 'p', values: [] }] }],
    ['a missing field', { cls: undefined }],
    ['another case', { caseId: 'case-other' }],
    [
      'a family over the size limit',
      {
        params: [
          {
            name: 'p',
            values: Array.from({ length: DEFAULT_POLICY.maxFamilySize + 1 }, (_, i) => i),
          },
        ],
      },
    ],
  ])('rejects a witness with %s under schema without running it', async (_name, over) => {
    const exec = new ScriptedExecutor(differentialTarget(3));
    const witness = { ...gateWitness(), ...over } as unknown as Witness;
    const result = await new Judge(exec).runWitness(gateCaseFile(), witness, ['vulnerable']);
    expect(result).toMatchObject({ admissible: false, rejectedBy: 'schema', runs: [] });
    expect(exec.requests).toHaveLength(0);
  });

  it.each([
    [
      'a template over the size limit',
      () => ({ template: 'x'.repeat(DEFAULT_POLICY.maxSourceBytes + 1) }),
    ],
    [
      'parameters over the size limit',
      () => ({ params: [{ name: 'p', values: ['x'.repeat(DEFAULT_POLICY.maxParamsBytes)] }] }),
    ],
    ['a different vulnerability class than the case', () => ({ cls: 'idor' })],
    [
      'deeply nested parameter values',
      () => {
        let deep: unknown = 0;
        for (let i = 0; i < 100_000; i++) deep = [deep];
        return { params: [{ name: 'p', values: [deep] }] };
      },
    ],
  ])('rejects a witness with %s under schema without running it', async (_name, make) => {
    const exec = new ScriptedExecutor(differentialTarget(3));
    const witness = { ...gateWitness(), ...make() } as unknown as Witness;
    const result = await new Judge(exec).runWitness(gateCaseFile(), witness, ['vulnerable']);
    expect(result).toMatchObject({ admissible: false, rejectedBy: 'schema', runs: [] });
    expect(exec.requests).toHaveLength(0);
  });

  it('rejects a cyclic witness under schema instead of crashing', async () => {
    const exec = new ScriptedExecutor(differentialTarget(3));
    const cyclic: Record<string, unknown> = { ...gateWitness() };
    cyclic.self = cyclic;
    cyclic.params = [{ name: 'p', values: [cyclic] }];
    const result = await new Judge(exec).runWitness(gateCaseFile(), cyclic as unknown as Witness, [
      'vulnerable',
    ]);
    expect(result.rejectedBy).toBe('schema');
    expect(exec.requests).toHaveLength(0);
  });

  it('turns an executor returning garbage into an error, not a verdict', async () => {
    const exec = new ScriptedExecutor(() => ({
      ...raw([true, true, true]),
      egressAttempts: Number.NaN,
    }));
    await expect(
      new Judge(exec).runWitness(gateCaseFile(), gateWitness(), ['vulnerable']),
    ).rejects.toThrow(/egressAttempts/);
  });

  it('propagates executor failures instead of blaming the witness', async () => {
    const exec = new ScriptedExecutor(() => Promise.reject(new Error('docker daemon gone')));
    await expect(
      new Judge(exec).runWitness(gateCaseFile(), gateWitness(), ['vulnerable']),
    ).rejects.toThrow(/docker daemon gone/);
  });

  it('rejects a malformed case file before running anything', async () => {
    const exec = new ScriptedExecutor(differentialTarget(3));
    const bad = { ...gateCaseFile(), target: undefined } as unknown as CaseFile;
    await expect(new Judge(exec).runWitness(bad, gateWitness(), ['vulnerable'])).rejects.toThrow();
    expect(exec.requests).toHaveLength(0);
  });

  it('refuses a policy whose time budget is not below the hard timeout', () => {
    const exec = new ScriptedExecutor(differentialTarget(3));
    expect(
      () => new Judge(exec, { ...DEFAULT_POLICY, timeBudgetMs: DEFAULT_POLICY.hardTimeoutMs }),
    ).toThrow(/timeBudgetMs/);
  });
});

describe('witnessExhibitId', () => {
  it('is stable for the same template and family and ignores key order', () => {
    const w = gateWitness();
    const reordered = {
      params: [{ values: [1, 2, 3], name: 'threshold' }],
      template: w.template,
      caseId: w.caseId,
    };
    expect(witnessExhibitId(w)).toBe(witnessExhibitId(reordered));
    expect(witnessExhibitId(w)).toMatch(/^exhibit-witness-[0-9a-f]{24}$/);
  });

  it('changes when the case changes, so one witness in two cases gets two ids', () => {
    const w = gateWitness();
    expect(witnessExhibitId({ ...w, caseId: 'case-other' as Witness['caseId'] })).not.toBe(
      witnessExhibitId(w),
    );
  });

  it('changes when the template or the family changes', () => {
    const w = gateWitness();
    expect(witnessExhibitId({ ...w, template: `${w.template} ` })).not.toBe(witnessExhibitId(w));
    expect(witnessExhibitId({ ...w, params: [{ name: 'threshold', values: [1, 2] }] })).not.toBe(
      witnessExhibitId(w),
    );
  });

  it('is the id the Judge reports', async () => {
    const exec = new ScriptedExecutor(differentialTarget(3));
    const result = await new Judge(exec).runWitness(gateCaseFile(), gateWitness(), ['vulnerable']);
    expect(result.exhibitId).toBe(witnessExhibitId(gateWitness()));
  });
});

describe('Judge.runCounterexample', () => {
  it("runs the counterexample's code over the witness's family on both variants", async () => {
    const exec = new ScriptedExecutor(differentialTarget(3));
    const result = await new Judge(exec).runCounterexample(
      gateCaseFile(),
      gateWitness(),
      counterexample(),
    );
    expect(exec.requests).toHaveLength(6);
    expect(exec.requests.every((r) => r.template === '/* prosecution counterexample */')).toBe(
      true,
    );
    expect(exec.requests[0]?.params).toEqual(gateWitness().params);
    expect(result).toMatchObject({
      exhibitId: counterexampleExhibitId(counterexample(), gateWitness().params),
      admissible: true,
    });
  });

  it('applies the same rules as a witness', async () => {
    const exec = new ScriptedExecutor((req) =>
      raw([true, true, true], { egressAttempts: req.attempt === 2 ? 1 : 0 }),
    );
    const result = await new Judge(exec).runCounterexample(
      noSafeVariant(),
      gateWitness(),
      counterexample(),
    );
    expect(result.rejectedBy).toBe('no-egress');
  });

  it.each([
    ['a patch exhibit', { kind: 'patch' }],
    ['a witness exhibit', { kind: 'witness' }],
    ['another case', { caseId: 'case-other' }],
    ['code over the size limit', { code: 'x'.repeat(DEFAULT_POLICY.maxSourceBytes + 1) }],
  ] as [string, Record<string, unknown>][])(
    'rejects %s under schema without running it',
    async (_name, over) => {
      const exec = new ScriptedExecutor(differentialTarget(3));
      const ex = { ...counterexample(), ...over } as Exhibit;
      const result = await new Judge(exec).runCounterexample(gateCaseFile(), gateWitness(), ex);
      expect(result.rejectedBy).toBe('schema');
      expect(exec.requests).toHaveLength(0);
    },
  );

  it('rejects when the witness supplying the family is invalid', async () => {
    const exec = new ScriptedExecutor(differentialTarget(3));
    const badWitness = { ...gateWitness(), params: 'all of them' } as unknown as Witness;
    const result = await new Judge(exec).runCounterexample(
      gateCaseFile(),
      badWitness,
      counterexample(),
    );
    expect(result.rejectedBy).toBe('schema');
    expect(result.exhibitId).toMatch(/^exhibit-counterexample-invalid-[0-9a-f]{24}$/);
    expect(exec.requests).toHaveLength(0);
  });

  it('mints its own id instead of echoing the submitted Exhibit.id', async () => {
    const exec = new ScriptedExecutor(differentialTarget(3));
    const judge = new Judge(exec);
    const a = await judge.runCounterexample(gateCaseFile(), gateWitness(), counterexample());
    const b = await judge.runCounterexample(
      gateCaseFile(),
      gateWitness(),
      counterexample({ id: 'exhibit-witness-chosen-by-caller' as Exhibit['id'] }),
    );
    expect(a.exhibitId).toMatch(/^exhibit-counterexample-[0-9a-f]{24}$/);
    expect(b.exhibitId).toBe(a.exhibitId);
  });

  it('reports the minted id on a schema rejection too', async () => {
    const exec = new ScriptedExecutor(differentialTarget(3));
    const ex = counterexample({ caseId: 'case-other' as Exhibit['caseId'] });
    const result = await new Judge(exec).runCounterexample(gateCaseFile(), gateWitness(), ex);
    expect(result).toMatchObject({
      rejectedBy: 'schema',
      exhibitId: counterexampleExhibitId(ex, gateWitness().params),
    });
  });

  it('never collides with a witness id for the same code and family', () => {
    const w = gateWitness();
    const ex = counterexample({ code: w.template });
    expect(counterexampleExhibitId(ex, w.params).slice('exhibit-counterexample-'.length)).not.toBe(
      witnessExhibitId(w).slice('exhibit-witness-'.length),
    );
  });

  it('changes with the family it runs over', () => {
    const ex = counterexample();
    expect(counterexampleExhibitId(ex, [{ name: 'threshold', values: [1] }])).not.toBe(
      counterexampleExhibitId(ex, gateWitness().params),
    );
  });
});

describe('exhibit id recipe (the documented contract with Lane 3)', () => {
  // Recomputed with node:crypto from the recipe in rules-of-evidence.md, not from canonical.ts.
  const recipe = (kind: string, caseId: string, template: string, params: unknown): string => {
    const json = `{"caseId":${JSON.stringify(caseId)},"kind":${JSON.stringify(kind)},"params":${JSON.stringify(params)},"template":${JSON.stringify(template)}}`;
    return `exhibit-${kind}-${createHash('sha256').update(json).digest('hex').slice(0, 24)}`;
  };
  const params = [{ name: 'p', values: [1] }];

  it('matches the documented test vectors', () => {
    expect(witnessExhibitId({ caseId: 'case-x' as Witness['caseId'], template: 't', params })).toBe(
      'exhibit-witness-065ed82f887fd688aef7d3a3',
    );
    expect(
      counterexampleExhibitId({ caseId: 'case-x' as Exhibit['caseId'], code: 't' }, params),
    ).toBe('exhibit-counterexample-acffdfb8b1fadd693641b6d2');
  });

  it('matches the recipe for the gate witness and a counterexample', () => {
    const w = gateWitness();
    expect(witnessExhibitId(w)).toBe(recipe('witness', w.caseId, w.template, w.params));
    const ex = counterexample();
    expect(counterexampleExhibitId(ex, w.params)).toBe(
      recipe('counterexample', ex.caseId, ex.code, w.params),
    );
  });
});

describe('output size policy', () => {
  it('passes maxOutputBytes to the executor', async () => {
    const exec = new ScriptedExecutor(differentialTarget(3));
    await new Judge(exec).runWitness(gateCaseFile(), gateWitness(), ['vulnerable']);
    expect(exec.requests.every((r) => r.maxOutputBytes === DEFAULT_POLICY.maxOutputBytes)).toBe(
      true,
    );
  });

  it.each(['stdout', 'stderr'] as const)(
    'throws when the executor returns %s over the cap, instead of judging',
    async (stream) => {
      const policy = { ...DEFAULT_POLICY, maxOutputBytes: 8 };
      const exec = new ScriptedExecutor((req) => ({
        ...differentialTarget(3)(req),
        [stream]: 'x'.repeat(9),
      }));
      await expect(
        new Judge(exec, policy).runWitness(gateCaseFile(), gateWitness(), ['vulnerable']),
      ).rejects.toThrow(new RegExp(`${stream} over maxOutputBytes`));
    },
  );

  it('counts the cap in UTF-8 bytes, not characters', async () => {
    const policy = { ...DEFAULT_POLICY, maxOutputBytes: 8 };
    const exec = new ScriptedExecutor((req) => ({
      ...differentialTarget(3)(req),
      stdout: 'é'.repeat(5),
    }));
    await expect(
      new Judge(exec, policy).runWitness(gateCaseFile(), gateWitness(), ['vulnerable']),
    ).rejects.toThrow(/stdout over maxOutputBytes/);
  });

  it('accepts output exactly at the cap', async () => {
    const policy = { ...DEFAULT_POLICY, maxOutputBytes: 8 };
    const exec = new ScriptedExecutor((req) => ({
      ...differentialTarget(3)(req),
      stdout: 'x'.repeat(8),
    }));
    const result = await new Judge(exec, policy).runWitness(gateCaseFile(), gateWitness(), [
      'vulnerable',
    ]);
    expect(result.admissible).toBe(true);
  });

  it('refuses a policy with a negative or fractional output cap', () => {
    const exec = new ScriptedExecutor(differentialTarget(3));
    expect(() => new Judge(exec, { ...DEFAULT_POLICY, maxOutputBytes: -1 })).toThrow(
      /maxOutputBytes/,
    );
    expect(() => new Judge(exec, { ...DEFAULT_POLICY, maxOutputBytes: 1.5 })).toThrow(
      /maxOutputBytes/,
    );
  });
});

describe('Judge egress log (L2-11)', () => {
  const event = {
    syscall: 'connect',
    family: 'ipv4',
    address: '1.1.1.1',
    port: 443,
    outcome: 'blocked',
    errno: 101,
    dns: false,
  } as const;

  it('hands the recorder every attempt of every run, tagged with the run, once per exhibit', async () => {
    const exec = new ScriptedExecutor((req) => ({
      ...differentialTarget(3)(req),
      ...(req.variant === 'safe' && req.attempt === 2
        ? { egressAttempts: 1, egress: [event] }
        : {}),
    }));
    const calls: [string, unknown[]][] = [];
    const judge = new Judge(exec, DEFAULT_POLICY, undefined, {
      record: (id, entries) => calls.push([id, [...entries]]),
    });
    const result = await judge.runWitness(gateCaseFile(), gateWitness(), ['vulnerable']);
    expect(result.rejectedBy).toBe('no-egress');
    expect(calls).toEqual([
      [witnessExhibitId(gateWitness()), [{ ...event, variant: 'safe', attempt: 2 }]],
    ]);
  });

  it('records an empty log for a clean exhibit, and nothing for one refused before running', async () => {
    const calls: [string, number][] = [];
    const judge = new Judge(
      new ScriptedExecutor(differentialTarget(3)),
      DEFAULT_POLICY,
      undefined,
      {
        record: (id, entries) => calls.push([id, entries.length]),
      },
    );
    await judge.runWitness(gateCaseFile(), gateWitness(), ['vulnerable']);
    await judge.runCounterexample(gateCaseFile(), gateWitness(), counterexample({ kind: 'patch' }));
    expect(calls).toEqual([[witnessExhibitId(gateWitness()), 0]]);
  });
});
