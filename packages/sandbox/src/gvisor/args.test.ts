import { describe, expect, it } from 'vitest';
import { PROBE_IMAGE } from '../containment/probes.js';
import { AUDIT_RUNTIME, RUN_LABEL, buildGvisorRunArgs } from './args.js';

const spec = {
  name: 'affidavit-test',
  runId: 'abc',
  image: PROBE_IMAGE,
  command: ['node', '-e', '1'],
  mounts: [{ hostPath: '/work/repo', containerPath: '/src', readOnly: true }],
};
const args = buildGvisorRunArgs(spec);
const flags = args.slice(0, args.indexOf(PROBE_IMAGE));
const pair = (flag: string, value: string) =>
  flags.some((f, i) => f === flag && flags[i + 1] === value);

describe('buildGvisorRunArgs', () => {
  it.each([
    ['--runtime', AUDIT_RUNTIME],
    ['--network', 'none'],
    ['--cap-drop', 'ALL'],
    ['--security-opt', 'no-new-privileges'],
    ['--security-opt', 'label=disable'],
    ['--user', '65534:65534'],
    ['--pids-limit', '256'],
    ['--memory', '1024m'],
    ['--memory-swap', '1024m'],
    ['--mount', 'type=tmpfs,destination=/tmp,readonly'],
    ['--mount', 'type=tmpfs,destination=/dev/shm,readonly'],
    ['--label', `${RUN_LABEL}=abc`],
  ])('sets %s %s', (flag, value) => {
    expect(pair(flag, value)).toBe(true);
  });

  it('makes the root filesystem read-only', () => {
    expect(flags).toContain('--read-only');
  });

  it('never adds a privileged flag, a host namespace, or the Docker socket', () => {
    const joined = flags.join(' ');
    expect(joined).not.toMatch(
      /--privileged|--pid[= ]host|--network[= ]host|--ipc[= ]host|--userns[= ]host/,
    );
    expect(joined).not.toMatch(/docker\.sock/);
    expect(flags).not.toContain('-v');
    expect(flags).not.toContain('--volume');
    expect(joined).not.toMatch(/--cap-add/);
  });

  it('keeps swap equal to memory so the limit cannot be stretched', () => {
    const custom = buildGvisorRunArgs({
      ...spec,
      limits: { memoryMb: 512, pids: 64, cpus: 2, scratchMb: 16 },
    });
    expect(custom[custom.indexOf('--memory') + 1]).toBe('512m');
    expect(custom[custom.indexOf('--memory-swap') + 1]).toBe('512m');
  });

  it('bind-mounts with --mount and honours read-only', () => {
    expect(pair('--mount', 'type=bind,source=/work/repo,destination=/src,readonly')).toBe(true);
    const rw = buildGvisorRunArgs({
      ...spec,
      mounts: [{ hostPath: '/work/out', containerPath: '/out', readOnly: false }],
    });
    expect(rw).toContain('type=bind,source=/work/out,destination=/out');
  });

  it('puts the image and command last, untouched', () => {
    expect(args.slice(args.indexOf(PROBE_IMAGE))).toEqual([PROBE_IMAGE, 'node', '-e', '1']);
  });

  it('refuses an image that is not pinned by digest', () => {
    expect(() => buildGvisorRunArgs({ ...spec, image: 'node:22-alpine' })).toThrow(/pinned/);
    expect(() => buildGvisorRunArgs({ ...spec, image: 'node@sha256:abc' })).toThrow(/pinned/);
    expect(() => buildGvisorRunArgs({ ...spec, image: 'sha256:abc' })).toThrow(/pinned/);
    expect(() => buildGvisorRunArgs({ ...spec, image: `x sha256:${'a'.repeat(64)}` })).toThrow(
      /pinned/,
    );
  });

  it('accepts a local image ID, which is a content hash too', () => {
    const id = `sha256:${'a'.repeat(64)}`;
    expect(buildGvisorRunArgs({ ...spec, image: id })).toContain(id);
  });

  it('opens stdin only when asked', () => {
    expect(flags).not.toContain('-i');
    expect(buildGvisorRunArgs({ ...spec, stdin: true })).toContain('-i');
  });
});

describe('buildGvisorRunArgs: case network', () => {
  const net = 'affidavit-net-0123456789abcdef';

  it('joins only a per-case network, with hosts and no host search domains', () => {
    const a = buildGvisorRunArgs({
      ...spec,
      network: { name: net, hosts: { target: '172.18.0.2' } },
    });
    const f = a.slice(0, a.indexOf(PROBE_IMAGE));
    expect(f[f.indexOf('--network') + 1]).toBe(net);
    expect(f[f.indexOf('--add-host') + 1]).toBe('target:172.18.0.2');
    expect(f[f.indexOf('--dns-search') + 1]).toBe('.');
  });

  it.each(['host', 'bridge', 'none', 'affidavit-net-xyz', 'container:abc', `${net} --privileged`])(
    'refuses to join %j',
    (name) => {
      expect(() => buildGvisorRunArgs({ ...spec, network: { name } })).toThrow(/per-case network/);
    },
  );

  it.each([
    ['a host name with a colon', { 'evil:1.2.3.4 x': '1.2.3.4' }],
    ['an address that is not IPv4', { target: 'example.com' }],
    ['an upper-case name', { Target: '172.18.0.2' }],
  ])('refuses %s in /etc/hosts', (_label, hosts) => {
    expect(() => buildGvisorRunArgs({ ...spec, network: { name: net, hosts } })).toThrow(
      /bad host/,
    );
  });
});

describe('buildGvisorRunArgs: file size limit', () => {
  it('sets RLIMIT_FSIZE only when asked', () => {
    expect(flags.some((f) => f.startsWith('fsize='))).toBe(false);
    const a = buildGvisorRunArgs({ ...spec, maxFileBytes: 1048576 });
    expect(a[a.indexOf('fsize=1048576:1048576') - 1]).toBe('--ulimit');
  });

  it.each([0, -1, 1.5, Number.NaN])('refuses %s', (n) => {
    expect(() => buildGvisorRunArgs({ ...spec, maxFileBytes: n })).toThrow(/maxFileBytes/);
  });
});

describe('buildGvisorRunArgs for tool runs', () => {
  const toolFlags = (over: Partial<Parameters<typeof buildGvisorRunArgs>[0]>) => {
    const a = buildGvisorRunArgs({ ...spec, ...over });
    return a.slice(0, a.indexOf(PROBE_IMAGE));
  };
  const has = (f: string[], flag: string, value: string) =>
    f.some((x, i) => x === flag && f[i + 1] === value);

  it('keeps /tmp read-only and TMPDIR on /scratch by default', () => {
    expect(has(flags, '--env', 'TMPDIR=/scratch')).toBe(true);
    expect(flags.join(' ')).not.toContain('/tmp:rw');
    expect(flags.join(' ')).not.toContain('XDG_CACHE_HOME');
  });

  it('gives a size-capped writable /tmp tmpfs and TMPDIR=/tmp on request', () => {
    const f = toolFlags({ writableTmpMb: 512 });
    expect(has(f, '--tmpfs', '/tmp:rw,size=512m,mode=1777')).toBe(true);
    expect(has(f, '--env', 'TMPDIR=/tmp')).toBe(true);
    expect(has(f, '--env', 'XDG_CACHE_HOME=/tmp')).toBe(true);
    expect(has(f, '--mount', 'type=tmpfs,destination=/tmp,readonly')).toBe(false);
    // Everything else stays: read-only root, no capabilities, scratch home.
    expect(f).toContain('--read-only');
    expect(has(f, '--cap-drop', 'ALL')).toBe(true);
    expect(has(f, '--env', 'HOME=/scratch')).toBe(true);
    expect(has(f, '--mount', 'type=tmpfs,destination=/dev/shm,readonly')).toBe(true);
  });

  it.each([0, -1, 1.5, 4097, Number.NaN])('refuses writableTmpMb %s', (mb) => {
    expect(() => toolFlags({ writableTmpMb: mb })).toThrow();
  });

  it('runs as a given non-root user', () => {
    expect(has(toolFlags({ user: '1000:1000' }), '--user', '1000:1000')).toBe(true);
  });

  it.each(['0:0', '0:1000', '1000:0', 'root', '1000', '1000:1000,0', '-1:5'])(
    'refuses the user %j',
    (user) => {
      expect(() => toolFlags({ user })).toThrow();
    },
  );
});
