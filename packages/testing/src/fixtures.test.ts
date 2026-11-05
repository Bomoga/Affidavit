import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  AdmissibilityRule,
  CaseFile,
  ExhibitResult,
  TrialEvent,
  VerifyResult,
} from '@affidavit/contracts';
import { listFixtureFiles, readFixtureJson } from './fixtures.js';

/** Maps a fixture path to the schema it must satisfy. An unmapped fixture fails the suite. */
function schemaForFixture(path: string): z.ZodType | null {
  if (path.startsWith('casefiles/')) return CaseFile;
  if (path.startsWith('exhibit-results/verify-')) return VerifyResult;
  if (path.startsWith('exhibit-results/')) return ExhibitResult;
  if (path.startsWith('trials/') && path.endsWith('.events.json')) return TrialEvent.array();
  return null;
}

const files = listFixtureFiles();

describe('fixtures', () => {
  it('the minimum Phase 0 set exists', () => {
    expect(files).toContain('casefiles/nodegoat-sqli-001.json');
    expect(files).toContain('exhibit-results/admissible.json');
    expect(files).toContain('exhibit-results/verify-pass.json');
    expect(files).toContain('exhibit-results/verify-fail.json');
    expect(files).toContain('trials/nodegoat-sqli-001.events.json');
    expect(files).toContain('trials/escalated-001.events.json');
    for (const rule of AdmissibilityRule.options) {
      expect(files).toContain(`exhibit-results/rejected-${rule}.json`);
    }
  });

  it.each(files)('%s is covered by a schema and parses', (path) => {
    const schema = schemaForFixture(path);
    expect(schema, `no schema mapped for ${path}`).not.toBeNull();
    const parsed = schema?.safeParse(readFixtureJson(path));
    expect(parsed?.success, parsed?.success === false ? parsed.error.message : '').toBe(true);
  });

  it('each rejected result names the rule in its file name', () => {
    for (const rule of AdmissibilityRule.options) {
      const r = ExhibitResult.parse(readFixtureJson(`exhibit-results/rejected-${rule}.json`));
      expect(r.admissible).toBe(false);
      expect(r.rejectedBy).toBe(rule);
    }
  });

  it('trial streams have contiguous seq from 0 and the right terminal event', () => {
    for (const [file, last] of [
      ['trials/nodegoat-sqli-001.events.json', 'verdict-written'],
      ['trials/escalated-001.events.json', 'escalated'],
    ] as const) {
      const events = TrialEvent.array().parse(readFixtureJson(file));
      events.forEach((e, i) => expect(e.seq).toBe(i));
      expect(events.at(-1)?.type).toBe(last);
    }
  });

  it('fixtures contain no em dashes', () => {
    for (const f of files) {
      expect(JSON.stringify(readFixtureJson(f))).not.toContain('—');
    }
  });
});
