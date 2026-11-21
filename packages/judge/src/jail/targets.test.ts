import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CaseFile } from '@affidavit/contracts';
import type {
  BootOutcome,
  BootRecipe,
  BuildOptions,
  BuildOutcome,
  CaseNetwork,
} from '@affidavit/sandbox';
import { describe, expect, it } from 'vitest';
import type { ExecutionRequest, RawAttempt } from '../executor.js';
import { Judge } from '../judge.js';
import { DEFAULT_POLICY } from '../rules.js';
import { gateCaseFile, gateWitness, raw, ScriptedExecutor } from '../test-helpers.js';
import { WorkerLease } from './lease.js';
import { CaseBoundJudge } from './real.js';
import {
  CaseBootError,
  CaseTargets,
  directorySources,
  fingerprintSourceTree,
  recipeSurfaceMismatch,
  type SourceResolver,
  type TargetBootDeps,
} from './targets.js';

const VULN_DIR = '/src/vulnerable';
const SAFE_DIR = '/src/safe';
const digestOf = (dir: string) => `sha256:${(dir === VULN_DIR ? 'a' : 'b').repeat(64)}`;

const recipe = (over: Partial<BootRecipe> = {}): BootRecipe => ({
  base: 'node:20',
  workdir: '/app',
  command: ['node', 'server.js'],
  env: {},
  port: 4000,
  healthRoute: '/login',
  healthTimeoutMs: 60_000,
  sidecars: [{ name: 'mongo', image: 'mongo:4' } as BootRecipe['sidecars'][number]],
  stubs: [],
  buildScript: false,
  ...over,
});

type Step = string;

interface FakeOpts {
  build?: (dir: string) => BuildOutcome | Promise<BuildOutcome>;
  boot?: (n: number, imageId: string) => BootOutcome | Promise<BootOutcome>;
  createNetwork?: (n: number) => Promise<CaseNetwork>;
  remove?: (net: CaseNetwork) => Promise<void>;
  recipeFor?: (dir: string) => BootRecipe;
  fingerprint?: (dir: string) => Promise<string>;
}

/** Fake sandbox steps that record their order and which networks are still alive. */
function fakeDeps(o: FakeOpts = {}) {
  const log: Step[] = [];
  const alive = new Set<string>();
  const buildOpts: BuildOptions[] = [];
  let nets = 0;
  let boots = 0;
  const deps: TargetBootDeps = {
    buildTarget(dir, _hints, opts) {
      log.push(`build ${dir}`);
      buildOpts.push(opts);
      if (o.build) return Promise.resolve(o.build(dir));
      return Promise.resolve({
        ok: true,
        imageId: digestOf(dir),
        baseImage: 'node@sha256:' + 'c'.repeat(64),
        recipe: o.recipeFor?.(dir) ?? recipe(),
        stage: {} as never,
        ...(opts.dependencyBundle === undefined
          ? {}
          : {
              dependencyBundle: { sha256: 'sha256:' + 'd'.repeat(64), sections: {}, packages: 1 },
            }),
      });
    },
    async createCaseNetwork() {
      nets++;
      const net = o.createNetwork
        ? await o.createNetwork(nets)
        : {
            name: `affidavit-net-${String(nets).padStart(16, '0')}`,
            runId: String(nets),
            subnet: '',
          };
      log.push(`network ${net.name}`);
      alive.add(net.name);
      return net;
    },
    bootTarget(net, imageId) {
      boots++;
      log.push(`boot ${imageId.slice(7, 8)} on ${net.name}`);
      if (o.boot) return Promise.resolve(o.boot(boots, imageId));
      return Promise.resolve({
        status: 'healthy',
        url: 'http://target:4000',
        hosts: { target: '172.18.0.2', mongo: '172.18.0.3' },
        services: [],
        sidecarImages: { mongo: 'mongo@sha256:' + 'e'.repeat(64) },
      });
    },
    async removeCaseNetwork(net) {
      log.push(`remove ${net.name}`);
      if (o.remove) await o.remove(net);
      alive.delete(net.name);
    },
    fingerprintTree(dir) {
      return o.fingerprint ? o.fingerprint(dir) : Promise.resolve(`tree:${dir}`);
    },
    listCaseRuns() {
      log.push('list');
      return Promise.resolve([...alive].map((n) => n.slice('affidavit-net-'.length)));
    },
  };
  return { deps, log, alive, buildOpts };
}

const caseFile = (): CaseFile => gateCaseFile();
const noSafe = (): CaseFile => {
  const { safeVariant: _s, ...rest } = caseFile();
  void _s;
  return CaseFile.parse(rest);
};

const sources: SourceResolver = (_cf, v) =>
  Promise.resolve({ ok: true, dir: v === 'vulnerable' ? VULN_DIR : SAFE_DIR });

const provider = (o: FakeOpts = {}, src: SourceResolver = sources) => {
  const f = fakeDeps(o);
  return { ...f, targets: new CaseTargets({ workRoot: '/work', sources: src, deps: f.deps }) };
};

const req = (cf: CaseFile, variant: 'vulnerable' | 'safe'): ExecutionRequest =>
  ({
    caseFile: cf,
    variant,
    target: variant === 'vulnerable' ? cf.target : cf.safeVariant,
  }) as ExecutionRequest;

describe('CaseTargets.boot', () => {
  it('resolves, builds both, then boots both, each on its own network, and records the digests', async () => {
    const { targets, log, alive } = provider();
    const out = await targets.boot(caseFile());
    expect(log).toEqual([
      `build ${VULN_DIR}`,
      `build ${SAFE_DIR}`,
      'network affidavit-net-0000000000000001',
      'boot a on affidavit-net-0000000000000001',
      'network affidavit-net-0000000000000002',
      'boot b on affidavit-net-0000000000000002',
    ]);
    expect(out).toMatchObject({
      ok: true,
      digests: { vulnerable: digestOf(VULN_DIR), safe: digestOf(SAFE_DIR) },
    });
    if (!out.ok) throw new Error('unreachable');
    expect(out.caseFile.target.imageDigest).toBe(digestOf(VULN_DIR));
    expect(out.caseFile.safeVariant?.imageDigest).toBe(digestOf(SAFE_DIR));
    expect(alive.size).toBe(2);
  });

  it('boots only the vulnerable target for a case file with no safe variant', async () => {
    const { targets, log } = provider();
    const out = await targets.boot(noSafe());
    expect(out).toMatchObject({ ok: true, digests: { vulnerable: digestOf(VULN_DIR) } });
    expect(log.filter((l) => l.startsWith('boot'))).toHaveLength(1);
  });

  it('passes the case dependency bundle to both builds and records its digest', async () => {
    const f = fakeDeps();
    const bundle = { path: '/b/x.tar', sha256: 'd'.repeat(64), allowedRoot: '/b' };
    const targets = new CaseTargets({
      workRoot: '/work',
      sources,
      deps: f.deps,
      dependencyBundle: () => bundle,
    });
    const cf = caseFile();
    await targets.boot(cf);
    expect(f.buildOpts.map((o) => o.dependencyBundle)).toEqual([bundle, bundle]);
    expect(await targets.dependencyBundles(cf)).toEqual({
      vulnerable: 'sha256:' + 'd'.repeat(64),
      safe: 'sha256:' + 'd'.repeat(64),
    });
  });

  it('is unsupported at source, building nothing, when the safe tree cannot be found', async () => {
    const { targets, log } = provider({}, (_cf, v) =>
      Promise.resolve(
        v === 'safe' ? { ok: false, reason: 'no safe tree' } : { ok: true, dir: VULN_DIR },
      ),
    );
    expect(await targets.boot(caseFile())).toEqual({
      ok: false,
      kind: 'unsupported',
      variant: 'safe',
      step: 'source',
      reason: 'no safe tree',
    });
    expect(log).toEqual([]);
  });

  it('starts nothing when the safe build is unsupported', async () => {
    const { targets, log, alive } = provider({
      build: (dir) =>
        dir === SAFE_DIR
          ? { ok: false, unsupported: true, step: 'recipe', reason: 'needs a dependency fetch' }
          : {
              ok: true,
              imageId: digestOf(dir),
              baseImage: 'node',
              recipe: recipe(),
              stage: {} as never,
            },
    });
    const out = await targets.boot(caseFile());
    expect(out).toMatchObject({ ok: false, kind: 'unsupported', variant: 'safe', step: 'build' });
    expect(log.some((l) => l.startsWith('network') || l.startsWith('boot'))).toBe(false);
    expect(alive.size).toBe(0);
  });

  it('turns a build that throws into boot-failed', async () => {
    const { targets } = provider({
      build: () => Promise.reject(new Error('docker is gone')),
    });
    expect(await targets.boot(caseFile())).toMatchObject({
      ok: false,
      kind: 'boot-failed',
      variant: 'vulnerable',
      step: 'build',
    });
  });

  it('is unsupported at compare, booting nothing, when the safe recipe exposes another port', async () => {
    const { targets, log } = provider({
      recipeFor: (dir) => (dir === SAFE_DIR ? recipe({ port: 4001 }) : recipe()),
    });
    expect(await targets.boot(caseFile())).toMatchObject({
      ok: false,
      kind: 'unsupported',
      variant: 'safe',
      step: 'compare',
    });
    expect(log.some((l) => l.startsWith('boot'))).toBe(false);
  });

  it('tears down the vulnerable target when the safe target is unhealthy', async () => {
    const { targets, alive, log } = provider({
      boot: (n) =>
        n === 2
          ? { status: 'failed', reason: 'health route never answered' }
          : {
              status: 'healthy',
              url: 'http://target:4000',
              hosts: { target: '1' },
              services: [],
              sidecarImages: {},
            },
    });
    const cf = caseFile();
    const out = await targets.boot(cf);
    expect(out).toMatchObject({ ok: false, kind: 'boot-failed', variant: 'safe', step: 'boot' });
    expect(alive.size).toBe(0);
    expect(log.slice(-2)).toEqual([
      'remove affidavit-net-0000000000000002',
      'remove affidavit-net-0000000000000001',
    ]);
    await expect(targets.endpoint(req(cf, 'vulnerable'))).rejects.toBeInstanceOf(CaseBootError);
  });

  it('removes its network and boots no safe target when the vulnerable target is unhealthy', async () => {
    const { targets, alive, log } = provider({
      boot: () => ({ status: 'unsupported', reason: 'tried to reach the internet' }),
    });
    expect(await targets.boot(caseFile())).toMatchObject({
      ok: false,
      kind: 'unsupported',
      variant: 'vulnerable',
      step: 'boot',
    });
    expect(log.filter((l) => l.startsWith('boot'))).toHaveLength(1);
    expect(alive.size).toBe(0);
  });

  it('tears down the vulnerable target when the safe network cannot be created', async () => {
    const { targets, alive } = provider({
      createNetwork: (n) =>
        n === 2
          ? Promise.reject(new Error('address pool exhausted'))
          : Promise.resolve({ name: 'affidavit-net-0000000000000001', runId: '1', subnet: '' }),
    });
    expect(await targets.boot(caseFile())).toMatchObject({
      ok: false,
      kind: 'boot-failed',
      variant: 'safe',
      step: 'network',
    });
    expect(alive.size).toBe(0);
  });

  it('turns a boot that throws into boot-failed and tears down', async () => {
    const { targets, alive } = provider({
      boot: (n) => (n === 2 ? Promise.reject(new Error('docker run failed')) : healthy()),
    });
    expect(await targets.boot(caseFile())).toMatchObject({ kind: 'boot-failed', step: 'boot' });
    expect(alive.size).toBe(0);
  });

  it('reports a teardown that failed on the outcome instead of hiding it', async () => {
    const { targets } = provider({
      boot: (n) => (n === 2 ? { status: 'failed', reason: 'unhealthy' } : healthy()),
      remove: () => Promise.reject(new Error('network in use')),
    });
    const out = await targets.boot(caseFile());
    expect(out).toMatchObject({ ok: false, kind: 'boot-failed' });
    expect(!out.ok && out.teardown).toMatch(/network in use/);
  });

  it('refuses a safe target that answers at another URL', async () => {
    const { targets, alive } = provider({
      boot: (n) => (n === 2 ? { ...healthy(), url: 'http://target:4001' } : healthy()),
    });
    expect(await targets.boot(caseFile())).toMatchObject({
      kind: 'unsupported',
      variant: 'safe',
      step: 'compare',
    });
    expect(alive.size).toBe(0);
  });

  it('shares one boot between concurrent callers of the same case', async () => {
    const { targets, log } = provider();
    const cf = caseFile();
    await Promise.all([targets.boot(cf), targets.boot(cf), targets.bind(cf)]);
    expect(log.filter((l) => l.startsWith('build'))).toHaveLength(2);
  });

  it('remembers unsupported, but boots again after boot-failed', async () => {
    let fail = true;
    const { targets, log } = provider({
      build: (dir) =>
        fail
          ? { ok: false, unsupported: false, step: 'assemble', reason: 'transient' }
          : {
              ok: true,
              imageId: digestOf(dir),
              baseImage: 'node',
              recipe: recipe(),
              stage: {} as never,
            },
    });
    const cf = caseFile();
    expect(await targets.boot(cf)).toMatchObject({ kind: 'boot-failed' });
    fail = false;
    expect(await targets.boot(cf)).toMatchObject({ ok: true });

    const u = provider({
      build: () => ({ ok: false, unsupported: true, step: 'base', reason: 'not node' }),
    });
    await u.targets.boot(cf);
    await u.targets.boot(cf);
    expect(u.log.filter((l) => l.startsWith('build'))).toHaveLength(1);
    expect(log.filter((l) => l.startsWith('build'))).toHaveLength(3);
  });
});

function healthy(): BootOutcome {
  return {
    status: 'healthy',
    url: 'http://target:4000',
    hosts: { target: '172.18.0.2', mongo: '172.18.0.3' },
    services: [],
    sidecarImages: {},
  };
}

describe('CaseTargets.bind and endpoint', () => {
  it('fills in the booted digests and serves each variant only for its own image', async () => {
    const { targets } = provider();
    const bound = await targets.bind(caseFile());
    expect((await targets.endpoint(req(bound, 'vulnerable'))).url).toBe('http://target:4000');
    expect((await targets.endpoint(req(bound, 'safe'))).url).toBe('http://target:4000');
    const swapped: ExecutionRequest = { ...req(bound, 'safe'), target: bound.target };
    await expect(targets.endpoint(swapped)).rejects.toThrow(/is not the booted safe image/);
  });

  it('refuses an unbooted case, and a case file that names other images', async () => {
    const { targets } = provider();
    const cf = caseFile();
    await expect(targets.endpoint(req(cf, 'vulnerable'))).rejects.toThrow(/no booted targets/);
    const other = CaseFile.parse({
      ...cf,
      target: { ...cf.target, imageDigest: `sha256:${'f'.repeat(64)}` },
    });
    await expect(targets.bind(other)).rejects.toThrow(/names vulnerable image/);
  });

  it('refuses a different case file under the same case id', async () => {
    const { targets } = provider();
    const cf = caseFile();
    await targets.bind(cf);
    const moved = CaseFile.parse({ ...cf, target: { ...cf.target, commit: 'c'.repeat(40) } });
    await expect(targets.bind(moved)).rejects.toThrow(/booted from another case file/);
  });

  it('throws CaseBootError from bind when the boot failed', async () => {
    const { targets } = provider({
      build: () => ({ ok: false, unsupported: true, step: 'recipe', reason: 'fetch' }),
    });
    const err = await targets.bind(caseFile()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CaseBootError);
    expect((err as CaseBootError).failure).toMatchObject({ kind: 'unsupported', step: 'build' });
  });
});

describe('CaseTargets.release and close', () => {
  it('removes both networks and forgets the case', async () => {
    const { targets, alive } = provider();
    const cf = caseFile();
    await targets.bind(cf);
    await targets.release(cf.id);
    expect(alive.size).toBe(0);
    expect(targets.caseIds).toEqual([]);
    await targets.release(cf.id); // no-op
    await expect(targets.endpoint(req(cf, 'vulnerable'))).rejects.toThrow(/no booted targets/);
  });

  it('tries every network and then throws the first teardown error', async () => {
    const removed: string[] = [];
    const { targets } = provider({
      remove: (net) => {
        removed.push(net.name);
        return removed.length === 1 ? Promise.reject(new Error('busy')) : Promise.resolve();
      },
    });
    const cf = caseFile();
    await targets.bind(cf);
    await expect(targets.release(cf.id)).rejects.toThrow(/busy/);
    expect(removed).toHaveLength(2);
  });

  it('close releases every case', async () => {
    const { targets, alive } = provider();
    const a = caseFile();
    const b = CaseFile.parse({ ...caseFile(), id: 'case-other-001' });
    await targets.bind(a);
    await targets.bind(b);
    expect(alive.size).toBe(4);
    await targets.close();
    expect(alive.size).toBe(0);
  });
});

describe('recipeSurfaceMismatch', () => {
  it('accepts the same surface and names the field that differs', () => {
    expect(recipeSurfaceMismatch(recipe(), recipe({ command: ['node', 'other.js'] }))).toBeNull();
    expect(recipeSurfaceMismatch(recipe(), recipe({ healthRoute: '/' }))).toMatch(/healthRoute/);
    expect(recipeSurfaceMismatch(recipe(), recipe({ sidecars: [] }))).toMatch(/sidecars/);
  });
});

describe('directorySources', () => {
  it('resolves only the exact repo, commit and variant, and refuses duplicates', async () => {
    const cf = caseFile();
    const resolve = directorySources([
      { repo: cf.target.repo, commit: cf.target.commit, variant: 'vulnerable', dir: '/v' },
    ]);
    expect(await resolve(cf, 'vulnerable')).toEqual({ ok: true, dir: '/v' });
    expect(await resolve(cf, 'safe')).toMatchObject({ ok: false });
    const e = { repo: 'r', commit: 'c', variant: 'safe' as const, dir: '/x' };
    expect(() => directorySources([e, e])).toThrow(/two source directories/);
    expect(() => directorySources([{ ...e, dir: 'relative' }])).toThrow(/absolute/);
  });
});

describe('CaseBoundJudge', () => {
  const answer = (results: boolean) => (): RawAttempt => raw([results, results, results]);

  it('runs the witness on both booted variants with the digests the provider recorded', async () => {
    const { targets } = provider();
    const exec = new ScriptedExecutor(async (r) => {
      await targets.endpoint(r); // the executor asks the provider, as JailExecutor does
      return answer(r.variant === 'vulnerable')();
    });
    const judge = new CaseBoundJudge(new Judge(exec, DEFAULT_POLICY), targets);
    const result = await judge.runWitness(caseFile(), gateWitness(), ['vulnerable']);
    expect(result).toMatchObject({ admissible: true, vulnPass: true, safeVariantFail: true });
    expect(exec.requests.map((r) => [r.variant, r.target.imageDigest])).toEqual([
      ['vulnerable', digestOf(VULN_DIR)],
      ['vulnerable', digestOf(VULN_DIR)],
      ['vulnerable', digestOf(VULN_DIR)],
      ['safe', digestOf(SAFE_DIR)],
      ['safe', digestOf(SAFE_DIR)],
      ['safe', digestOf(SAFE_DIR)],
    ]);
  });

  it('runs no witness at all when the safe variant fails to boot', async () => {
    const { targets, alive } = provider({
      boot: (n) => (n === 2 ? { status: 'failed', reason: 'unhealthy' } : healthy()),
    });
    const exec = new ScriptedExecutor(answer(true));
    const judge = new CaseBoundJudge(new Judge(exec, DEFAULT_POLICY), targets);
    await expect(
      judge.runWitness(caseFile(), gateWitness(), ['vulnerable']),
    ).rejects.toBeInstanceOf(CaseBootError);
    expect(exec.requests).toEqual([]);
    expect(alive.size).toBe(0);
  });
});

describe('the safe variant must differ from the vulnerable one (review of #61)', () => {
  it('refuses a resolver that returns the same tree for both variants, building nothing', async () => {
    const { targets, log } = provider({}, () => Promise.resolve({ ok: true, dir: VULN_DIR }));
    const exec = new ScriptedExecutor(() => raw([true, true, true]));
    const judge = new CaseBoundJudge(new Judge(exec, DEFAULT_POLICY), targets);
    const out = await targets.boot(caseFile());
    expect(out).toMatchObject({ ok: false, kind: 'unsupported', variant: 'safe', step: 'compare' });
    expect(!out.ok && out.reason).toMatch(/same source tree/);
    expect(log.some((l) => l.startsWith('build') || l.startsWith('boot'))).toBe(false);
    await expect(
      judge.runWitness(caseFile(), gateWitness(), ['vulnerable']),
    ).rejects.toBeInstanceOf(CaseBootError);
    expect(exec.requests).toEqual([]);
  });

  it('refuses two directories whose trees have the same content', async () => {
    const { targets } = provider({ fingerprint: () => Promise.resolve('same') });
    const out = await targets.boot(caseFile());
    expect(out).toMatchObject({ kind: 'unsupported', step: 'compare' });
    expect(!out.ok && out.reason).toMatch(/same source tree/);
  });

  it('refuses identical vulnerable and safe images before any boot', async () => {
    const { targets, log, alive } = provider({
      build: () => ({
        ok: true,
        imageId: digestOf(VULN_DIR),
        baseImage: 'node',
        recipe: recipe(),
        stage: {} as never,
      }),
    });
    const out = await targets.boot(caseFile());
    expect(out).toMatchObject({ ok: false, kind: 'unsupported', variant: 'safe', step: 'compare' });
    expect(!out.ok && out.reason).toMatch(/same image/);
    expect(log.some((l) => l.startsWith('network') || l.startsWith('boot'))).toBe(false);
    expect(alive.size).toBe(0);
  });

  it('a fingerprint that throws is boot-failed, never a pass', async () => {
    const { targets } = provider({ fingerprint: () => Promise.reject(new Error('EACCES')) });
    expect(await targets.boot(caseFile())).toMatchObject({ ok: false, kind: 'boot-failed' });
  });
});

describe('sessions after a failed teardown (review of #61)', () => {
  it('keeps a boot-failed case whose teardown failed tracked, and retries the teardown', async () => {
    let removable = false;
    const { targets, alive } = provider({
      boot: (n) => (n === 2 ? { status: 'failed', reason: 'unhealthy' } : healthy()),
      remove: () => (removable ? Promise.resolve() : Promise.reject(new Error('busy'))),
    });
    const cf = caseFile();
    expect(await targets.boot(cf)).toMatchObject({ ok: false, kind: 'boot-failed' });
    expect(targets.caseIds).toEqual([cf.id]);
    await expect(targets.release(cf.id)).rejects.toThrow(/busy/);
    expect(targets.caseIds).toEqual([cf.id]);
    removable = true;
    await targets.release(cf.id);
    expect(targets.caseIds).toEqual([]);
    expect(alive.size).toBe(0);
  });

  it('does not boot again while an earlier teardown is still failing', async () => {
    const { targets, log } = provider({
      boot: (n) => (n === 2 ? { status: 'failed', reason: 'unhealthy' } : healthy()),
      remove: () => Promise.reject(new Error('busy')),
    });
    const cf = caseFile();
    await targets.boot(cf);
    const builds = log.filter((l) => l.startsWith('build')).length;
    const again = await targets.boot(cf);
    expect(!again.ok && again.teardown).toMatch(/busy/);
    expect(log.filter((l) => l.startsWith('build')).length).toBe(builds);
  });

  it('a session whose boot threw is a boot-failed outcome, and release is a no-op after it', async () => {
    const { targets } = provider({}, () => {
      throw new Error('resolver bug');
    });
    const cf = caseFile();
    expect(await targets.boot(cf)).toMatchObject({
      ok: false,
      kind: 'boot-failed',
      step: 'source',
    });
    await targets.release(cf.id);
    await targets.release(cf.id);
    expect(targets.caseIds).toEqual([]);
  });

  describe('worker lease', () => {
    const hexNet = (n: number): Promise<CaseNetwork> => {
      const runId = n.toString(16).padStart(16, '0');
      return Promise.resolve({ name: `affidavit-net-${runId}`, runId, subnet: '' });
    };
    const ledger = (fail = false) => {
      const l = {
        runs: [] as string[],
        addRun: (r: string) => {
          if (fail) return Promise.reject(new Error('disk full'));
          l.runs.push(r);
          return Promise.resolve();
        },
        removeRun: (r: string) => {
          l.runs = l.runs.filter((x) => x !== r);
          return Promise.resolve();
        },
      };
      return l;
    };

    it('records each case network before booting on it, and forgets it once removed', async () => {
      const f = fakeDeps({ createNetwork: hexNet });
      const lease = ledger();
      const resolved = new CaseTargets({
        workRoot: '/work',
        sources: (_cf, v) => Promise.resolve({ ok: true, dir: v === 'safe' ? SAFE_DIR : VULN_DIR }),
        deps: f.deps,
        lease,
      });
      const cf = caseFile();
      expect(await resolved.boot(cf)).toMatchObject({ ok: true });
      expect(lease.runs).toEqual(['0000000000000001', '0000000000000002']);
      await resolved.release(cf.id);
      expect(lease.runs).toEqual([]);
    });

    it('a lease that cannot be written is a boot failure that tears down the network', async () => {
      const f = fakeDeps({ createNetwork: hexNet });
      const targets = new CaseTargets({
        workRoot: '/work',
        sources: (_cf, v) => Promise.resolve({ ok: true, dir: v === 'safe' ? SAFE_DIR : VULN_DIR }),
        deps: f.deps,
        lease: ledger(true),
      });
      expect(await targets.boot(caseFile())).toMatchObject({
        ok: false,
        kind: 'boot-failed',
        step: 'network',
        reason: expect.stringMatching(/worker lease: disk full/) as unknown,
      });
      expect(f.log.some((l) => l.startsWith('boot '))).toBe(false);
      expect(f.alive.size).toBe(0);
    });

    it('sweepOrphans removes only a dead owner run and never a live or unclaimed one', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'affidavit-targets-lease-'));
      try {
        const f = fakeDeps({ createNetwork: hexNet });
        // Three labelled networks on the host: run 1 (dead owner), 2 (live owner), 3 (no lease).
        for (let i = 0; i < 3; i++) await f.deps.createCaseNetwork();
        const identity = { pidNs: 'pid:[1]', bootId: 'b' };
        const at = (pid: number) =>
          WorkerLease.acquire(dir, {
            hostname: 'h',
            pid,
            identity,
            procStart: `${pid}`,
            heartbeatMs: 0,
            now: () => 0,
          });
        const mine = await at(1000);
        const dead = await at(1001);
        await dead.addRun('0000000000000001');
        const live = await at(1002);
        await live.addRun('0000000000000002');
        const targets = new CaseTargets({
          workRoot: '/work',
          sources: directorySources([]),
          deps: f.deps,
          lease: mine,
        });
        const out = await targets.sweepOrphans(dir, mine, {
          warn: () => undefined,
          identity,
          isAlive: (pid) => pid !== 1001,
          procStart: (pid) => Promise.resolve(`${pid}`),
          now: () => 60 * 60_000,
        });
        expect(out.removed).toEqual(['0000000000000001']);
        expect(out.kept).toEqual(['0000000000000002']);
        expect(out.unknown).toEqual(['0000000000000003']);
        expect([...f.alive].sort()).toEqual([
          'affidavit-net-0000000000000002',
          'affidavit-net-0000000000000003',
        ]);
        await live.close();
        await mine.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

describe('fingerprintSourceTree', () => {
  it('is equal for equal content, differs on any change, and skips VCS data', async () => {
    const root = mkdtempSync(join(tmpdir(), 'affidavit-fp-'));
    try {
      const make = (name: string, body: string) => {
        const d = join(root, name);
        mkdirSync(join(d, 'app'), { recursive: true });
        writeFileSync(join(d, 'app', 'a.js'), body);
        return d;
      };
      const a = make('a', 'x');
      const b = make('b', 'x');
      const c = make('c', 'y');
      mkdirSync(join(b, '.git'));
      writeFileSync(join(b, '.git', 'HEAD'), 'ignored');
      expect(await fingerprintSourceTree(a)).toBe(await fingerprintSourceTree(b));
      expect(await fingerprintSourceTree(a)).not.toBe(await fingerprintSourceTree(c));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
