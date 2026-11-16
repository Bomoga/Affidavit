import { samples, TrialEvent } from '@affidavit/contracts';
import { expect, it } from 'vitest';
import { PgCaseStore } from './case-store.js';
import { PgEventSink } from './event-sink.js';
import { BUDGET, describePg, sampleCase, useTestDatabase } from './test-support.js';

const T = 'tenant-e';

describePg('PgEventSink', () => {
  const db = useTestDatabase([T]);

  async function setup() {
    const file = sampleCase(T);
    await new PgCaseStore(db().app, T).open(file, BUDGET);
    return { file, sink: new PgEventSink(db().app, T) };
  }

  const base = (caseId: string, seq: number) => ({
    schemaVersion: 1,
    caseId,
    seq,
    at: '2026-11-05T12:00:00.000Z',
  });

  const count = async (table: string, caseId: string): Promise<number> => {
    const { rows } = await db().admin.query<{ n: string }>(
      `select count(*)::text as n from ${table} where case_id = $1`,
      [caseId],
    );
    return Number(rows[0]!.n);
  };

  it('is idempotent on (caseId, seq): the same seq with different content keeps the first', async () => {
    const { file, sink } = await setup();
    const first = TrialEvent.parse({
      ...base(file.id, 0),
      stage: 'map',
      actor: 'judge',
      type: 'stage-entered',
      payload: { from: 'intake' },
    });
    const second = TrialEvent.parse({
      ...base(file.id, 0),
      stage: 'arraign',
      actor: 'defense',
      type: 'stage-entered',
      payload: { from: 'map' },
    });
    await sink.emit(first);
    await sink.emit(first);
    await sink.emit(second);
    expect(await sink.events(file.id)).toEqual([first]);
    expect(await count('events', file.id)).toBe(1);
  });

  it('writes ballot and escalation side rows once, however often the event is emitted', async () => {
    const { file, sink } = await setup();
    const ballot = TrialEvent.parse({
      ...base(file.id, 3),
      stage: 'jury',
      actor: 'juror',
      type: 'ballot-cast',
      payload: { ballot: samples.Ballot },
    });
    const escalated = TrialEvent.parse({
      ...base(file.id, 4),
      stage: 'defense',
      actor: 'judge',
      type: 'escalated',
      payload: { escalation: { ...(samples.Escalation as object), caseId: file.id } },
    });
    const exhausted = TrialEvent.parse({
      ...base(file.id, 5),
      stage: 'defense',
      actor: 'judge',
      type: 'budget-exhausted',
      payload: {
        escalation: {
          ...(samples.Escalation as object),
          caseId: file.id,
          reason: 'budget-exhausted',
        },
      },
    });
    for (let i = 0; i < 3; i++) {
      await sink.emit(ballot);
      await sink.emit(escalated);
      await sink.emit(exhausted);
    }
    expect(await count('events', file.id)).toBe(3);
    expect(await count('ballots', file.id)).toBe(1);
    expect(await count('escalations', file.id)).toBe(2);
  });

  it('rejects an escalation or verdict payload that names a different case', async () => {
    const { file, sink } = await setup();
    const other = sampleCase(T);
    await new PgCaseStore(db().app, T).open(other, BUDGET);
    const bad = TrialEvent.parse({
      ...base(file.id, 0),
      stage: 'defense',
      actor: 'judge',
      type: 'escalated',
      payload: { escalation: { ...(samples.Escalation as object), caseId: other.id } },
    });
    await expect(sink.emit(bad)).rejects.toThrow(/payload for case/);
    const badVerdict = TrialEvent.parse({
      ...base(file.id, 1),
      stage: 'verdict',
      actor: 'judge',
      type: 'verdict-written',
      payload: { verdict: { ...(samples.Verdict as object), caseId: other.id } },
    });
    await expect(sink.emit(badVerdict)).rejects.toThrow(/payload for case/);
    expect(await count('escalations', other.id)).toBe(0);
    expect(await count('events', file.id)).toBe(0);
  });

  it('lists events in seq order and resumes after a seq', async () => {
    const { file, sink } = await setup();
    for (const seq of [2, 0, 1]) {
      await sink.emit(
        TrialEvent.parse({
          ...base(file.id, seq),
          stage: 'map',
          actor: 'judge',
          type: 'stage-entered',
          payload: {},
        }),
      );
    }
    expect((await sink.events(file.id)).map((e) => e.seq)).toEqual([0, 1, 2]);
    expect((await sink.events(file.id, 0)).map((e) => e.seq)).toEqual([1, 2]);
  });
});
