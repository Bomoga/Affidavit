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

  /** A string whose content is checked later (a path): only the type is checked here. */
  raw(v: unknown, pointer: string): string {
    if (typeof v !== 'string') this.fail('wrong-type', pointer, 'expected a string');
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

export type PathResult = { ok: true; path: string } | { ok: false; why: string };

/**
 * Maps a report path to a repo-relative path, or says why it is unsafe. The tools run with the
 * repo mounted at `/src`, so an absolute path must start with `/src/`; a relative one (CodeQL's
 * `%SRCROOT%` form) is taken as repo-relative.
 *
 * `decode` is true only for CodeQL, whose SARIF writes real URIs. Semgrep writes the raw file name
 * with no URI encoding (`/src/100%.js`, `/src/a%20b.js` are real names), so its paths are never
 * decoded. A path is decoded at most once, here: the segments checked below are the final names
 * and must never be decoded again by any caller.
 *
 * Unsafe means: another absolute path, a scheme or drive letter on a relative path, an empty, `.`
 * or `..` segment, a control character, or an over-long path. A backslash is an ordinary file name
 * character on the Linux target, so it is allowed. The caller records an unsafe path as a skipped
 * finding; it is not a structural error.
 */
export function safeRepoPath(uri: string, decode: boolean): PathResult {
  if (uri.length === 0 || uri.length > LIMITS.string)
    return { ok: false, why: 'empty or too long' };
  let path = uri;
  if (decode) {
    try {
      path = decodeURIComponent(uri);
    } catch {
      return { ok: false, why: 'invalid percent-encoding' };
    }
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(path)) return { ok: false, why: 'control character' };
  if (path.startsWith('/')) {
    if (!path.startsWith('/src/')) return { ok: false, why: 'absolute path outside /src' };
    path = path.slice('/src/'.length);
  } else if (SCHEME.test(path)) {
    return { ok: false, why: 'has a scheme or drive letter' };
  }
  if (path.length === 0) return { ok: false, why: 'empty path' };
  // A UNC-style name (`\\host\share`) is refused. A backslash is otherwise an ordinary name
  // character on the Linux target, but a `..` between backslashes would be a traversal on any
  // consumer that treats it as a separator, so segments are checked split on both.
  if (uri.startsWith('\\\\') || path.startsWith('\\\\'))
    return { ok: false, why: 'UNC-style path' };
  for (const seg of path.split(/[/\\]/)) {
    if (seg === '' || seg === '.' || seg === '..') {
      return { ok: false, why: 'empty, "." or ".." path segment' };
    }
  }
  return { ok: true, path };
}
