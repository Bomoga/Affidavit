import { describe, expect, it } from 'vitest';
import { PROMPTS, PROMPT_IDS } from './registry.js';
import { checkVersionHistory, promptDigest } from './versioning.js';
import { VERSION_HISTORY } from './version-history.js';

describe('prompt version history', () => {
  it('matches the committed history (changing a prompt without bumping its version fails here)', () => {
    expect(checkVersionHistory(PROMPTS, VERSION_HISTORY)).toEqual([]);
  });

  it('records a history entry for every prompt id', () => {
    for (const id of PROMPT_IDS) {
      expect(VERSION_HISTORY[id]).toBeDefined();
    }
  });

  it('rejects edited text under an unchanged version', () => {
    const edited = {
      ...PROMPTS,
      defense: { ...PROMPTS.defense, system: PROMPTS.defense.system + ' Extra rule.' },
    };
    const problems = checkVersionHistory(edited, VERSION_HISTORY);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('defense');
    expect(problems[0]).toMatch(/bump/i);
  });

  it('rejects a bumped version that was not added to the history', () => {
    const bumped = {
      ...PROMPTS,
      remedy: { ...PROMPTS.remedy, version: '9.9.9', system: PROMPTS.remedy.system + ' Extra.' },
    };
    const problems = checkVersionHistory(bumped, VERSION_HISTORY);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('remedy');
    expect(problems[0]).toContain(promptDigest(bumped.remedy));
  });

  it('rejects rewriting the recorded digest of the current version', () => {
    // Older entries cannot be recomputed (their text is gone), so the check pins the
    // current version's digest. Rolling a prompt back is caught by the next test.
    const tampered = JSON.parse(JSON.stringify(VERSION_HISTORY)) as typeof VERSION_HISTORY;
    tampered.prosecution[PROMPTS.prosecution.version] = 'f'.repeat(64);
    expect(checkVersionHistory(PROMPTS, tampered).length).toBeGreaterThan(0);
  });

  it('rejects a prompt whose version is older than the newest history entry', () => {
    const rolledBack = { ...PROMPTS, defense: { ...PROMPTS.defense, version: '1.0.0' } };
    const problems = checkVersionHistory(rolledBack, VERSION_HISTORY);
    expect(problems.some((p) => p.includes('defense') && p.includes('newer'))).toBe(true);
  });

  it('accepts a properly bumped prompt once its new version is appended', () => {
    const bumped = {
      ...PROMPTS,
      remedy: { ...PROMPTS.remedy, version: '9.9.9', system: PROMPTS.remedy.system + ' Extra.' },
    };
    const history = JSON.parse(JSON.stringify(VERSION_HISTORY)) as typeof VERSION_HISTORY;
    history.remedy['9.9.9'] = promptDigest(bumped.remedy);
    expect(checkVersionHistory(bumped, history)).toEqual([]);
  });
});
