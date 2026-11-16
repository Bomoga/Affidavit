import { describe, expect, it } from 'vitest';
import { buildProbeDockerArgs } from './plain-docker.js';
import { PROBE_IMAGE } from './probes.js';

describe('buildProbeDockerArgs', () => {
  const args = buildProbeDockerArgs('affidavit-probe-x', '{}');
  const beforeImage = args.slice(0, args.indexOf(PROBE_IMAGE));

  it('keeps every Phase 1 safety flag', () => {
    const joined = beforeImage.join(' ');
    for (const flag of [
      '--network none',
      '--read-only',
      '--cap-drop ALL',
      '--security-opt no-new-privileges',
      '--pids-limit',
      '--memory',
    ]) {
      expect(joined).toContain(flag);
    }
  });

  it('mounts no host path and never loosens isolation', () => {
    expect(beforeImage).not.toContain('-v');
    expect(beforeImage).not.toContain('--privileged');
    expect(beforeImage.join(' ')).not.toMatch(/docker\.sock|--network host|--net=host|--cap-add/);
  });

  it('names the container instead of auto-removing it, so OOM state can be read', () => {
    expect(beforeImage).not.toContain('--rm');
    expect(beforeImage).toContain('--name');
    expect(beforeImage).toContain('-i');
  });

  it('gives the probe a tmpfs scratch directory', () => {
    expect(beforeImage).toContain('--tmpfs');
  });

  it('uses an image pinned by digest and feeds the probe on stdin', () => {
    expect(PROBE_IMAGE).toMatch(/@sha256:[0-9a-f]{64}$/);
    expect(args.slice(args.indexOf(PROBE_IMAGE) + 1)).toEqual([
      'node',
      '--input-type=module',
      '-',
      '{}',
    ]);
  });
});
