import { CaseStage } from '@affidavit/contracts';
import { FakeCaseStore, FakeEventSink } from '@affidavit/testing';
import { describe, expect, it } from 'vitest';
import { ConfigError, describeConfig, loadConfig } from './config.js';
import { selectCores, NotWiredError } from './handlers.js';
import { GuardedCaseStore, GuardedEventSink, LeaseLostError } from './guard.js';

const SECRET = 'hunter2-not-a-real-password';
const base = {
  AFFIDAVIT_APP_DATABASE_URL: `postgres://affidavit_app:${SECRET}@127.0.0.1:5432/affidavit`,
  AFFIDAVIT_WORKER_DATABASE_URL: `postgres://affidavit_worker:${SECRET}@127.0.0.1:5432/affidavit`,
};

describe('config', () => {
  it('defaults to fakes with sane numbers', () => {
    const c = loadConfig(base);
    expect([c.intake, c.trial, c.judge]).toEqual(['fake', 'fake', 'fake']);
    expect(c.leaseSeconds).toBe(300);
    expect(c.juryEnabled).toBe(true);
  });

  it('lists every problem and never echoes a connection string', () => {
    let err: unknown;
    try {
      loadConfig({
        AFFIDAVIT_APP_DATABASE_URL: `not a url ${SECRET}`,
        AFFIDAVIT_WORKER_DATABASE_URL: `http://x:${SECRET}@h/db`,
        AFFIDAVIT_TRIAL_IMPL: 'maybe',
        AFFIDAVIT_LEASE_SECONDS: '99999',
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    const message = (err as ConfigError).message;
    expect(message).not.toContain(SECRET);
    expect((err as ConfigError).problems).toHaveLength(4);
  });

  it('requires both database URLs', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
  });

  it('describeConfig carries no URL', () => {
    expect(JSON.stringify(describeConfig(loadConfig(base)))).not.toContain(SECRET);
  });
});

describe('handler selection', () => {
  it('wires a core for every non-terminal stage with fakes', () => {
    const cores = selectCores(loadConfig(base));
    const expected = CaseStage.options.filter(
      (s) => !['verdict', 'dismissed', 'escalated'].includes(s),
    );
    expect(Object.keys(cores).sort()).toEqual([...expected].sort());
  });

  it.each(['AFFIDAVIT_INTAKE_IMPL', 'AFFIDAVIT_TRIAL_IMPL', 'AFFIDAVIT_JUDGE_IMPL'])(
    'refuses %s=real until it is wired',
    (name) => {
      expect(() => selectCores(loadConfig({ ...base, [name]: 'real' }))).toThrow(NotWiredError);
    },
  );
});

describe('lease guard', () => {
  it('refuses port writes once the signal aborted, but still reads', async () => {
    const abort = new AbortController();
    const store = new GuardedCaseStore(new FakeCaseStore(), abort.signal);
    const sink = new GuardedEventSink(new FakeEventSink(), abort.signal);
    abort.abort();
    await expect(Promise.resolve().then(() => store.nextSeq('c' as never))).rejects.toBeInstanceOf(
      LeaseLostError,
    );
    await expect(
      Promise.resolve().then(() => store.transition('c' as never, 'map')),
    ).rejects.toBeInstanceOf(LeaseLostError);
    await expect(Promise.resolve().then(() => sink.emit({} as never))).rejects.toBeInstanceOf(
      LeaseLostError,
    );
    // A read reaches the inner store (which does not know the case), not the guard.
    await expect(Promise.resolve().then(() => store.stage('c' as never))).rejects.toThrow(
      /unknown case/,
    );
  });
});
