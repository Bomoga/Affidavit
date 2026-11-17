// Strict guards for tool reports. Everything in a report is untrusted data: it is shape-checked,
// size-capped and never evaluated. Message text, snippets and help text are never read at all.

export type SourceTool = 'semgrep' | 'codeql' | 'osv';

export type MalformedCode =
  | 'invalid-json'
  | 'not-an-object'
  | 'wrong-version'
  | 'wrong-type'
  | 'too-large'
  | 'too-many'
  | 'bad-string'
  | 'bad-region'
  | 'bad-rule'
  | 'unsafe-uri'
  | 'unreadable'
  | 'invalid-candidate'
  | 'unsupported-tool'
  | 'unexpected';

/** A tool report that cannot be trusted as findings. Typed, so callers never see a raw crash. */
export class MalformedReportError extends Error {
  readonly tool: SourceTool | 'gitleaks';
  readonly code: MalformedCode;
  /** JSON-pointer-like location inside the report, for example `/runs/0/results/3`. */
  readonly pointer: string;
  constructor(
    tool: SourceTool | 'gitleaks',
    code: MalformedCode,
    pointer: string,
    why: string,
    options?: { cause?: unknown },
  ) {
    super(`malformed ${tool} report at ${pointer || '/'}: ${why} (${code})`, options);
    this.name = 'MalformedReportError';
    this.tool = tool;
    this.code = code;
    this.pointer = pointer;
  }
}

/** Hard caps. A report beyond any of them is rejected, not truncated. */
export const LIMITS = {
  runs: 64,
  rules: 20_000,
  results: 100_000,
  tags: 1_000,
  osvResults: 1_000,
  osvPackages: 100_000,
  osvVulns: 100_000,
  osvCwe: 1_000,
  candidates: 200_000,
  string: 4_096,
  ruleId: 512,
  line: 100_000_000,
} as const;

export type Obj = Record<string, unknown>;

export const isObj = (v: unknown): v is Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export class Guard {
  constructor(readonly tool: SourceTool) {}

  fail(code: MalformedCode, pointer: string, why: string): never {
    throw new MalformedReportError(this.tool, code, pointer, why);
  }

  obj(v: unknown, pointer: string): Obj {
    if (!isObj(v)) this.fail('wrong-type', pointer, 'expected an object');
    return v;
  }

  /** An array that must be present. */
  arr(v: unknown, pointer: string, max: number): unknown[] {
    if (!Array.isArray(v)) this.fail('wrong-type', pointer, 'expected an array');
    if (v.length > max) this.fail('too-many', pointer, `${v.length} entries, limit ${max}`);
    return v;
  }

  /** An array that may be absent (treated as empty); present but not an array is an error. */
  optArr(v: unknown, pointer: string, max: number): unknown[] {
    return v === undefined ? [] : this.arr(v, pointer, max);
  }

  /** A string with no control characters (NUL, newlines, DEL), within `max` UTF-16 units. */
  str(v: unknown, pointer: string, max: number = LIMITS.string): string {
    if (typeof v !== 'string') this.fail('wrong-type', pointer, 'expected a string');
    if (v.length === 0) this.fail('bad-string', pointer, 'empty string');
    if (v.length > max) this.fail('too-large', pointer, `string over ${max} characters`);
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(v)) this.fail('bad-string', pointer, 'control character');
    return v;
  }

  line(v: unknown, pointer: string): number {
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1 || v > LIMITS.line) {
      this.fail('bad-region', pointer, 'expected a line number from 1 to 100000000');
    }
    return v;
  }
}

/** Looks up an own property only, so `__proto__` and inherited names never leak in. */
export function own(o: Obj, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(o, key) ? o[key] : undefined;
}

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/**
 * Maps a report path to a repo-relative path. The tools run with the repo mounted at `/src`, so an
 * absolute path must start with `/src/`; a relative one (CodeQL's `%SRCROOT%` form) is taken as
 * repo-relative. Anything else (another absolute path, a scheme such as `file:`, a drive letter, a
 * backslash, an empty or `.` or `..` segment, a control character) throws `unsafe-uri`.
 */
export function repoRelativePath(g: Guard, raw: unknown, pointer: string): string {
  const uri = g.str(raw, pointer);
  let path: string;
  try {
    path = decodeURIComponent(uri);
  } catch {
    return g.fail('unsafe-uri', pointer, 'invalid percent-encoding');
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(path)) g.fail('unsafe-uri', pointer, 'control or backslash');
  if (SCHEME.test(path)) g.fail('unsafe-uri', pointer, 'has a scheme or drive letter');
  if (path.startsWith('/')) {
    if (!path.startsWith('/src/')) g.fail('unsafe-uri', pointer, 'absolute path outside /src');
    path = path.slice('/src/'.length);
  }
  if (path.length === 0) g.fail('unsafe-uri', pointer, 'empty path');
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') {
      g.fail('unsafe-uri', pointer, 'empty, "." or ".." path segment');
    }
  }
  return path;
}
