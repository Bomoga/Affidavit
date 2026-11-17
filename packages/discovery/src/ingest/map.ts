import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GitleaksFinding } from './findings.js';
import {
  extractLines,
  extractRegion,
  GLOBAL_MIN_BYTES,
  placeholderFor,
  SecretRedactor,
  type MapEntry,
} from './redactor.js';
import { RedactionIncompleteError, type ExclusionReason } from './types.js';

/** gitleaks reads a file in 100,000 byte chunks; columns after the first chunk are unreliable. */
const CHUNK_BYTES = 100_000;

const ARCHIVE_NAME = /\.(?:zip|gz|tgz|tar|bz2|xz|7z|jar|war|apk)(?:\.|$)/i;

function archiveSignature(b: Buffer): boolean {
  const at = (...bytes: number[]) => bytes.every((v, i) => b[i] === v);
  return (
    at(0x1f, 0x8b) ||
    at(0x50, 0x4b, 0x03, 0x04) ||
    at(0x50, 0x4b, 0x05, 0x06) ||
    at(0x42, 0x5a, 0x68) ||
    at(0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00) ||
    at(0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c) ||
    b.subarray(257, 262).toString('latin1') === 'ustar'
  );
}

const decoder = new TextDecoder('utf-8', { fatal: true });

function isText(b: Buffer): boolean {
  if (b.includes(0)) return false;
  try {
    decoder.decode(b);
    return true;
  } catch {
    return false;
  }
}

export interface BuiltMap {
  redactor: SecretRedactor;
  /** Files that must not leave, with why. */
  excluded: Map<string, ExclusionReason>;
  findings: number;
}

/**
 * Builds the redaction map from gitleaks findings. gitleaks runs with --redact, so its report
 * holds no secret: the full value is read back out of the checkout by region. Every finding ends
 * in exactly one of: an exact value; the whole line(s) when the region cannot be trusted
 * (columns after a 100 KB chunk, a region that does not fit the file); or the file being kept out
 * of the workspace (archives and other non-text files, which cannot be rewritten). A finding
 * whose file is missing throws RedactionIncompleteError. Nothing is silently dropped.
 */
export async function buildRedactionMap(
  rawDir: string,
  findings: readonly GitleaksFinding[],
  maxFileBytes: number,
): Promise<BuiltMap> {
  const excluded = new Map<string, ExclusionReason>();
  const unresolved: string[] = [];
  const cache = new Map<string, Buffer | 'too-large' | 'missing'>();
  const byValue = new Map<string, MapEntry>();

  const load = async (rel: string): Promise<Buffer | 'too-large' | 'missing'> => {
    const hit = cache.get(rel);
    if (hit !== undefined) return hit;
    let out: Buffer | 'too-large' | 'missing';
    try {
      const abs = join(rawDir, ...rel.split('/'));
      const st = await lstat(abs);
      if (!st.isFile()) out = 'missing';
      else if (st.size > maxFileBytes) out = 'too-large';
      else out = await readFile(abs);
    } catch {
      out = 'missing';
    }
    cache.set(rel, out);
    return out;
  };

  const add = (f: GitleaksFinding, value: Buffer, exact: boolean): void => {
    const key = `${exact ? 'x' : 'l'}:${value.toString('hex')}`;
    let e = byValue.get(key);
    if (e === undefined) {
      const id = byValue.size + 1;
      e = {
        id,
        ruleId: f.ruleId,
        value,
        exact,
        scope: value.length >= GLOBAL_MIN_BYTES ? 'global' : 'located',
        placeholder: placeholderFor(f.ruleId, id),
        locations: [],
      };
      byValue.set(key, e);
    }
    e.locations.push({ file: f.file, startLine: f.region.startLine, endLine: f.region.endLine });
  };

  for (const f of findings) {
    const buf = await load(f.file);
    if (buf === 'missing') {
      unresolved.push(`${f.file}:${f.region.startLine}`);
      continue;
    }
    if (buf === 'too-large') {
      excluded.set(f.file, 'too-large');
      continue;
    }
    const text = isText(buf);
    if (!text) {
      excluded.set(f.file, 'secret-in-non-text-file');
      if (archiveSignature(buf) || ARCHIVE_NAME.test(f.file)) continue; // region is in decompressed data
    }
    const trusted = f.origin === 'windows' || buf.length <= CHUNK_BYTES;
    const exact = trusted ? extractRegion(buf, f.region) : undefined;
    if (exact !== undefined && exact.toString('latin1').trim().length > 0) {
      add(f, Buffer.from(exact), true);
      continue;
    }
    const lines = extractLines(buf, f.region.startLine, f.region.endLine);
    if (lines !== undefined && lines.toString('latin1').trim().length > 0) {
      add(f, Buffer.from(lines), false);
      continue;
    }
    if (!excluded.has(f.file)) excluded.set(f.file, 'unresolvable-finding');
  }
  if (unresolved.length > 0) throw new RedactionIncompleteError(unresolved);
  return {
    redactor: new SecretRedactor([...byValue.values()]),
    excluded,
    findings: findings.length,
  };
}
