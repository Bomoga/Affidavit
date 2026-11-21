import { describe, expect, it } from 'vitest';
import { parseStagePayload, stageJobKey, stageTaskIdentifier } from './queue.js';

const payload = { tenantId: 't1', caseId: 'c1', stage: 'map', attempt: 1 } as const;

describe('stage job identity', () => {
  it('derives a stable key from tenant, case, stage and attempt', () => {
    expect(stageJobKey(parseStagePayload(payload))).toBe(stageJobKey(parseStagePayload(payload)));
    const k = (over: object) => stageJobKey(parseStagePayload({ ...payload, ...over }));
    const keys = new Set([
      k({}),
      k({ attempt: 2 }),
      k({ stage: 'arraign' }),
      k({ caseId: 'c2' }),
      k({ tenantId: 't2' }),
    ]);
    expect(keys.size).toBe(5);
  });

  it('cannot collide through delimiter tricks in ids', () => {
    const a = stageJobKey(parseStagePayload({ ...payload, tenantId: 'a:b', caseId: 'c' }));
    const b = stageJobKey(parseStagePayload({ ...payload, tenantId: 'a', caseId: 'b:c' }));
    expect(a).not.toBe(b);
  });

  it('uses one task identifier per stage', () => {
    expect(stageTaskIdentifier('map')).toBe('case-stage:map');
    expect(stageTaskIdentifier('verify')).not.toBe(stageTaskIdentifier('jury'));
  });

  it('rejects malformed payloads', () => {
    expect(() => parseStagePayload({ ...payload, stage: 'nope' })).toThrow();
    expect(() => parseStagePayload({ ...payload, attempt: 0 })).toThrow();
    expect(() => parseStagePayload({ ...payload, caseId: '' })).toThrow();
    expect(() => parseStagePayload(null)).toThrow();
  });
});
