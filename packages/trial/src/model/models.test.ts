import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PromptId } from '@affidavit/contracts';
import { ModelConfigError } from './errors.js';
import { createModelPortFromEnv, modelModeFrom } from './factory.js';
import {
  DEFAULT_MODEL_TABLE,
  KNOWN_MODEL_IDS,
  MODEL_ENV_VARS,
  checkModelTable,
  resolveModelTable,
} from './models.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('model table', () => {
  it('has a known default for every prompt id and keeps the independence rules', () => {
    expect(Object.keys(DEFAULT_MODEL_TABLE).sort()).toEqual([...PromptId.options].sort());
    for (const m of Object.values(DEFAULT_MODEL_TABLE)) expect(KNOWN_MODEL_IDS).toContain(m);
    expect(DEFAULT_MODEL_TABLE.defense).not.toBe(DEFAULT_MODEL_TABLE['defense-second-attempt']);
    const jurors = [
      DEFAULT_MODEL_TABLE['juror-security'],
      DEFAULT_MODEL_TABLE['juror-maintainability'],
      DEFAULT_MODEL_TABLE['juror-blast-radius'],
    ];
    expect(new Set(jurors).size).toBe(3);
    expect(() => checkModelTable({ ...DEFAULT_MODEL_TABLE })).not.toThrow();
  });

  it('refuses the same model for both Defense attempts', () => {
    expect(() =>
      checkModelTable({
        ...DEFAULT_MODEL_TABLE,
        'defense-second-attempt': DEFAULT_MODEL_TABLE.defense,
      }),
    ).toThrow(/second Defense attempt/);
  });

  it('refuses two jurors on the same model', () => {
    expect(() =>
      checkModelTable({
        ...DEFAULT_MODEL_TABLE,
        'juror-blast-radius': DEFAULT_MODEL_TABLE['juror-security'],
      }),
    ).toThrow(/each juror/);
  });

  it('fails closed on an unknown model id, a missing prompt, or an unknown prompt', () => {
    expect(() => checkModelTable({ ...DEFAULT_MODEL_TABLE, remedy: 'gpt-something' })).toThrow(
      ModelConfigError,
    );
    const { remedy: _drop, ...missing } = DEFAULT_MODEL_TABLE;
    void _drop;
    expect(() => checkModelTable(missing)).toThrow(/no model for prompt remedy/);
    expect(() => checkModelTable({ ...DEFAULT_MODEL_TABLE, wizard: 'claude-opus-5-5' })).toThrow(
      /unknown prompt id/,
    );
  });

  it('resolves defaults, then the config file, then one env var per prompt', () => {
    const dir = mkdtempSync(join(tmpdir(), 'affidavit-models-'));
    dirs.push(dir);
    const file = join(dir, 'models.json');
    writeFileSync(
      file,
      JSON.stringify({ models: { remedy: 'claude-sonnet-5-5', prosecution: 'claude-opus-5' } }),
    );
    const table = resolveModelTable({
      AFFIDAVIT_MODEL_CONFIG: file,
      [MODEL_ENV_VARS.prosecution]: 'claude-opus-4-8',
    });
    expect(table.remedy).toBe('claude-sonnet-5-5');
    expect(table.prosecution).toBe('claude-opus-4-8');
    expect(table.defense).toBe(DEFAULT_MODEL_TABLE.defense);
  });

  it('refuses an env override that breaks a rule or names an unknown model', () => {
    expect(() =>
      resolveModelTable({ ANTHROPIC_MODEL_DEFENSE_SECOND: DEFAULT_MODEL_TABLE.defense }),
    ).toThrow(ModelConfigError);
    expect(() => resolveModelTable({ ANTHROPIC_MODEL_REMEDY: 'claude-opus-5-5-20990101' })).toThrow(
      ModelConfigError,
    );
    expect(() =>
      resolveModelTable({ AFFIDAVIT_MODEL_CONFIG: join(tmpdir(), 'no-such-file.json') }),
    ).toThrow(ModelConfigError);
  });
});

describe('createModelPortFromEnv', () => {
  it('defaults to live, accepts record and replay, and refuses anything else', () => {
    expect(modelModeFrom({})).toBe('live');
    expect(modelModeFrom({ AFFIDAVIT_MODEL_MODE: 'record' })).toBe('record');
    expect(modelModeFrom({ AFFIDAVIT_MODEL_MODE: 'replay' })).toBe('replay');
    expect(() => modelModeFrom({ AFFIDAVIT_MODEL_MODE: 'yolo' })).toThrow(ModelConfigError);
  });

  it('allows record and replay only when AFFIDAVIT_ENV is development or test; live otherwise', () => {
    const dir = { AFFIDAVIT_RECORD_DIR: tmpdir() };
    for (const deployEnv of [
      undefined,
      '',
      'production',
      'Production',
      'PRODUCTION ',
      'staging',
      'prod',
      'dev',
      'testing',
      ' test',
      'test ',
      '﻿test',
      'test\n',
    ]) {
      const env = deployEnv === undefined ? dir : { ...dir, AFFIDAVIT_ENV: deployEnv };
      for (const mode of ['record', 'replay']) {
        expect(
          () => createModelPortFromEnv({ ...env, AFFIDAVIT_MODEL_MODE: mode }),
          `${String(deployEnv)} ${mode}`,
        ).toThrow(/AFFIDAVIT_ENV/);
      }
      expect(() => createModelPortFromEnv({ ...env, AFFIDAVIT_MODEL_MODE: 'live' })).not.toThrow();
      expect(() => createModelPortFromEnv(env)).not.toThrow();
    }
    for (const deployEnv of ['development', 'test', ' Development ', 'TEST', '\ttest\t']) {
      for (const mode of ['record', 'replay']) {
        expect(
          () =>
            createModelPortFromEnv({
              ...dir,
              AFFIDAVIT_ENV: deployEnv,
              AFFIDAVIT_MODEL_MODE: mode,
            }),
          `${deployEnv} ${mode}`,
        ).not.toThrow();
      }
    }
  });

  it('record mode runs only with an explicit AFFIDAVIT_RECORD_DIR', () => {
    const dev = { AFFIDAVIT_ENV: 'development', AFFIDAVIT_MODEL_MODE: 'record' };
    expect(() => createModelPortFromEnv(dev)).toThrow(/AFFIDAVIT_RECORD_DIR/);
    expect(() => createModelPortFromEnv({ ...dev, AFFIDAVIT_RECORD_DIR: '' })).toThrow(
      ModelConfigError,
    );
    expect(() => createModelPortFromEnv({ ...dev, AFFIDAVIT_RECORD_DIR: tmpdir() })).not.toThrow();
  });

  it('builds without an API key, since the key is read only at call time', () => {
    expect(() => createModelPortFromEnv({})).not.toThrow();
    expect(() => createModelPortFromEnv({ AFFIDAVIT_MODEL_TIMEOUT_MS: '5' })).toThrow(
      ModelConfigError,
    );
  });
});
