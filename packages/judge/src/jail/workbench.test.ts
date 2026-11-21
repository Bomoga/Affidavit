import { describe, expect, it } from 'vitest';
import type { ExecutionRequest } from '../executor.js';
import { BootedTargets, type BootedTarget } from './booted.js';
import { APPLY_SCRIPT, NUMSTAT_SCRIPT, ownBootedTarget, splitNumstat } from './workbench.js';

const target = (url: string): BootedTarget =>
  ({
    endpoint: { net: { name: 'affidavit-net-0000000000000000' }, hosts: {}, url },
    imageId: `sha256:${'a'.repeat(64)}`,
    sidecarImages: {},
    recipe: { workdir: '/app' },
  }) as unknown as BootedTarget;

const DIGEST = `sha256:${'a'.repeat(64)}`;
/** `imageDigest: null` leaves the digest out of the case file's target. */
const req = (variant: ExecutionRequest['variant'], imageDigest: string | null = DIGEST) =>
  ({
    variant,
    target: { variant, ...(imageDigest === null ? {} : { imageDigest }) },
  }) as ExecutionRequest;

describe('BootedTargets', () => {
  it("serves a target only when the case file's imageDigest is the booted image", async () => {
    const t = new BootedTargets({ vulnerable: target('http://target:4000') });
    expect((await t.endpoint(req('vulnerable'))).url).toBe('http://target:4000');
    await expect(t.endpoint(req('vulnerable', `sha256:${'b'.repeat(64)}`))).rejects.toThrow(
      /is not the booted vulnerable image/,
    );
    await expect(t.endpoint(req('vulnerable', null))).rejects.toThrow(/no imageDigest/);
  });

  it('serves the registered variant and throws for one that has no target', async () => {
    const t = new BootedTargets({ vulnerable: target('http://target:4000') });
    expect((await t.endpoint(req('vulnerable'))).url).toBe('http://target:4000');
    await expect(t.endpoint(req('safe'))).rejects.toThrow(/no booted target for the safe/);
  });

  it('registers the patched target while a patch is verified, and forgets it after', async () => {
    const t = new BootedTargets();
    t.set('patched', target('http://target:4000'));
    expect(() => t.set('patched', target('http://other:4000'))).toThrow(/already registered/);
    expect((await t.endpoint(req('patched'))).url).toBe('http://target:4000');
    t.delete('patched');
    await expect(t.endpoint(req('patched'))).rejects.toThrow();
  });
});

describe('ownBootedTarget (the patched network is never leaked)', () => {
  const net = { name: 'affidavit-net-1111111111111111' } as never;
  const recorder = () => {
    const removed: unknown[] = [];
    return { removed, remove: (n: unknown) => (removed.push(n), Promise.resolve()) };
  };

  it('removes the network when a later step throws', async () => {
    const { removed, remove } = recorder();
    await expect(
      ownBootedTarget(net, () => Promise.reject(new Error('deriveRecipe threw')), remove),
    ).rejects.toThrow(/deriveRecipe threw/);
    expect(removed).toEqual([net]);
  });

  it('removes the network when a patched target is already registered', async () => {
    const { removed, remove } = recorder();
    const targets = new BootedTargets({ patched: target('http://old:4000') });
    await expect(
      ownBootedTarget(
        net,
        () => {
          targets.set('patched', target('http://new:4000'));
          return Promise.resolve({ ok: true as const });
        },
        remove,
      ),
    ).rejects.toThrow(/already registered/);
    expect(removed).toEqual([net]);
  });

  it('removes it on a refused outcome and keeps it only when handed over', async () => {
    const { removed, remove } = recorder();
    expect(await ownBootedTarget(net, () => Promise.resolve({ ok: false }), remove)).toEqual({
      ok: false,
    });
    expect(removed).toEqual([net]);
    expect(await ownBootedTarget(net, () => Promise.resolve({ ok: true }), remove)).toEqual({
      ok: true,
    });
    expect(removed).toEqual([net]);
  });
});

describe('splitNumstat', () => {
  it('splits the code and full parts', () => {
    expect(
      splitNumstat('== code\n1\t1\ta.js\n== full\n1\t1\ta.js\n2\t0\ttest/a.test.js\n'),
    ).toEqual(['1\t1\ta.js\n', '1\t1\ta.js\n2\t0\ttest/a.test.js\n']);
    expect(splitNumstat('== code\n== full\n3\t0\ttest/x.js\n')).toEqual(['', '3\t0\ttest/x.js\n']);
  });

  it('returns unparseable parts when the markers are missing', () => {
    expect(splitNumstat('1\t1\ta.js\n')).toEqual(['?', '?']);
  });
});

describe('the jailed git scripts', () => {
  it('never use --unsafe-paths, never read config, and copy the tree without .git', () => {
    for (const script of [NUMSTAT_SCRIPT, APPLY_SCRIPT]) {
      expect(script).not.toContain('--unsafe-paths');
      expect(script).toContain('GIT_CONFIG_NOSYSTEM=1');
      expect(script).toContain('GIT_CONFIG_GLOBAL=/dev/null');
      expect(script).toContain('GIT_CEILING_DIRECTORIES=/w');
    }
    expect(APPLY_SCRIPT).toContain('--exclude=.git');
    expect(NUMSTAT_SCRIPT).toContain('git apply --numstat');
    expect(NUMSTAT_SCRIPT).not.toMatch(/git apply \/patch/);
  });
});
