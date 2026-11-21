/**
 * The re-scan on the real pinned Semgrep image, and the recorder that can replace the hand-derived
 * SARIF in fixtures/corpus/rescan/derived with real runs. Skipped unless AFFIDAVIT_DOCKER_TESTS=1.
 * With AFFIDAVIT_RECORD_DIR (an existing directory) it also writes each run's raw SARIF there as
 * `semgrep-<variant>.sarif`:
 *   AFFIDAVIT_DOCKER_TESTS=1 AFFIDAVIT_RECORD_DIR=/tmp/rec pnpm --filter @affidavit/discovery exec vitest run rescan.docker
 * Containers run with `--network none`, read-only, no capabilities.
 */
import { execFile } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolRunnerPort } from '@affidavit/contracts';
import { describe, expect, it } from 'vitest';
import { rescanPatchedTree } from './index.js';
import {
  NOSQL_WHERE,
  RULES,
  SQL_CONCAT,
  buildTree,
  caseFileFor,
  type Variant,
} from './rescan.testutil.js';

const enabled = process.env['AFFIDAVIT_DOCKER_TESTS'] === '1';
const recordDir = process.env['AFFIDAVIT_RECORD_DIR'];

const JAIL = [
  '--rm',
  '--network',
  'none',
  '--read-only',
  '--cap-drop',
  'ALL',
  '--security-opt',
  'no-new-privileges',
  '--pids-limit',
  '256',
  '--memory',
  '1g',
];

function dockerRunner(variant: Variant): ToolRunnerPort {
  return {
    run(image, args, mounts) {
      return new Promise((resolve) => {
        const dockerArgs = [
          'run',
          ...JAIL,
          ...mounts.flatMap((m) => [
            '-v',
            `${m.hostPath}:${m.containerPath}${m.readOnly ? ':ro' : ''}`,
          ]),
          image,
          ...args,
        ];
        execFile('docker', dockerArgs, (error) => {
          const exitCode = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
          const out = mounts.find((m) => m.containerPath === '/out')?.hostPath ?? tmpdir();
          if (recordDir !== undefined && exitCode === 0) {
            copyFileSync(join(out, 'semgrep.sarif'), join(recordDir, `semgrep-${variant}.sarif`));
          }
          resolve({ exitCode, outputPath: out });
        });
      });
    },
  };
}

describe.skipIf(!enabled)('rescanPatchedTree on the pinned Semgrep image', () => {
  async function scan(variant: Variant, ruleId: string, line: number) {
    const work = mkdtempSync(join(tmpdir(), 'affidavit-rescan-docker-'));
    try {
      const tree = buildTree(variant, join(work, 'tree'));
      return await rescanPatchedTree(
        { runner: dockerRunner(variant), workRoot: work, rulesDir: RULES },
        caseFileFor(ruleId, 'src/routes.js', line),
        tree,
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  it('finds the $where sink in the vulnerable tree', async () => {
    const r = await scan('vulnerable', NOSQL_WHERE, 15);
    expect(r).toMatchObject({ clean: false, reason: 'finding-present' });
  }, 600_000);

  it('is clean for the $where rule once the sink is patched, and other findings stay', async () => {
    const r = await scan('patched', NOSQL_WHERE, 15);
    expect(r).toMatchObject({ clean: true, reason: 'clean' });
    expect(r.candidates.some((c) => c.file === 'src/routes.js')).toBe(true);
    // The SQL sink in the same file was not patched.
    const sql = await scan('patched', SQL_CONCAT, 9);
    expect(sql).toMatchObject({ clean: false, reason: 'finding-present' });
  }, 600_000);

  it('is not clean when the patch only moves the sink', async () => {
    const r = await scan('shifted', NOSQL_WHERE, 15);
    expect(r).toMatchObject({ clean: false, reason: 'finding-present' });
  }, 600_000);
});
