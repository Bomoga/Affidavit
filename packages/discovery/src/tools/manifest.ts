import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BundleManifest } from '@affidavit/contracts';

export type ToolName = 'semgrep' | 'osv-scanner' | 'gitleaks' | 'codeql';

export interface ToolEntry {
  name: ToolName;
  enabled: boolean;
  version: string | null;
  image: string | null;
  tag: string | null;
  digest: string | null;
  /** `image@sha256:...`. Null only for a disabled tool. Never a bare tag. */
  reference: string | null;
  resolvedVia: string;
  resolvedOn: string | null;
  outputFormat: 'sarif' | 'json';
  okExitCodes: number[];
  /** Exit codes that mean "nothing to scan, no report written" (OSV-Scanner 128). Subset of okExitCodes. */
  emptyExitCodes?: number[];
  blockedBy?: string;
  dockerfile?: string;
}

export interface ToolManifest {
  schemaVersion: 1;
  tools: ToolEntry[];
}

const TOOL_NAMES: readonly string[] = ['semgrep', 'osv-scanner', 'gitleaks', 'codeql'];
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const DIGEST_REF = /^[a-z0-9][a-z0-9./_-]*@sha256:[0-9a-f]{64}$/;

/** A caller asked for the version of a tool that is unknown or disabled (a caller mistake). */
export class ToolSelectionError extends Error {
  readonly tool: string;
  constructor(tool: string, why: string) {
    super(`cannot record a version for ${tool}: ${why}`);
    this.name = 'ToolSelectionError';
    this.tool = tool;
  }
}

function fail(msg: string): never {
  throw new Error(`invalid tool manifest: ${msg}`);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(o: Record<string, unknown>, k: string): string {
  const v = o[k];
  if (typeof v !== 'string' || v === '') fail(`${k} must be a non-empty string`);
  return v;
}

function strOrNull(o: Record<string, unknown>, k: string): string | null {
  const v = o[k];
  if (v === null) return null;
  if (typeof v !== 'string' || v === '') fail(`${k} must be a string or null`);
  return v;
}

function parseTool(raw: unknown): ToolEntry {
  if (!isRecord(raw)) fail('tool entry must be an object');
  const name = str(raw, 'name');
  if (!TOOL_NAMES.includes(name)) fail(`unknown tool ${name}`);
  if (typeof raw['enabled'] !== 'boolean') fail(`${name}: enabled must be a boolean`);
  const enabled = raw['enabled'];
  const reference = strOrNull(raw, 'reference');
  const digest = strOrNull(raw, 'digest');
  const image = strOrNull(raw, 'image');
  const version = strOrNull(raw, 'version');
  if (reference !== null) {
    if (!DIGEST_REF.test(reference)) fail(`${name}: reference must be image@sha256:<64 hex>`);
    if (digest === null || image === null || reference !== `${image}@${digest}`) {
      fail(`${name}: reference must equal image@digest`);
    }
    if (!DIGEST.test(digest)) fail(`${name}: digest malformed`);
  }
  if (name === 'codeql' && enabled) {
    fail('codeql cannot be enabled in the manifest until the licensing decision (P0-10) lands');
  }
  if (enabled) {
    if (reference === null) fail(`${name}: an enabled tool needs a digest reference`);
    if (version === null || !/^\d+\.\d+\.\d+$/.test(version)) fail(`${name}: version required`);
  }
  const codes = raw['okExitCodes'];
  if (!Array.isArray(codes) || codes.length === 0 || !codes.every((c) => Number.isInteger(c))) {
    fail(`${name}: okExitCodes must be a non-empty list of integers`);
  }
  const empty = raw['emptyExitCodes'];
  if (
    empty !== undefined &&
    (!Array.isArray(empty) ||
      !empty.every((c) => Number.isInteger(c) && (codes as number[]).includes(c as number)))
  ) {
    fail(`${name}: emptyExitCodes must be integers that are also in okExitCodes`);
  }
  const format = raw['outputFormat'];
  if (format !== 'sarif' && format !== 'json') fail(`${name}: outputFormat must be sarif or json`);
  const entry: ToolEntry = {
    name: name as ToolName,
    enabled,
    version,
    image,
    tag: strOrNull(raw, 'tag'),
    digest,
    reference,
    resolvedVia: str(raw, 'resolvedVia'),
    resolvedOn: strOrNull(raw, 'resolvedOn'),
    outputFormat: format,
    okExitCodes: codes as number[],
  };
  if (empty !== undefined) entry.emptyExitCodes = empty as number[];
  if (typeof raw['blockedBy'] === 'string') entry.blockedBy = raw['blockedBy'];
  if (typeof raw['dockerfile'] === 'string') entry.dockerfile = raw['dockerfile'];
  return entry;
}

export function parseToolManifest(raw: unknown): ToolManifest {
  if (!isRecord(raw) || raw['schemaVersion'] !== 1) fail('schemaVersion must be 1');
  const tools = raw['tools'];
  if (!Array.isArray(tools)) fail('tools must be an array');
  const parsed = tools.map(parseTool);
  const seen = new Set<string>();
  for (const t of parsed) {
    if (seen.has(t.name)) fail(`duplicate tool ${t.name}`);
    seen.add(t.name);
  }
  return { schemaVersion: 1, tools: parsed };
}

/**
 * Walks up from this file to the repo root (the directory holding docker/tools/tools.json). Only
 * works where docker/tools ships with the code. A deployment without the repo layout must pass
 * explicit paths: `loadToolManifest(path)` and `ToolRunOptions.configDir`.
 */
export function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, 'docker', 'tools', 'tools.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error('docker/tools/tools.json not found above ' + dir);
    dir = parent;
  }
}

export function loadToolManifest(path?: string): ToolManifest {
  const file = path ?? join(repoRoot(), 'docker', 'tools', 'tools.json');
  return parseToolManifest(JSON.parse(readFileSync(file, 'utf8')));
}

export function enabledToolNames(manifest: ToolManifest): ToolName[] {
  return manifest.tools.filter((t) => t.enabled).map((t) => t.name);
}

/**
 * For BundleManifest.toolVersions: tool name to `<version>@<image digest>`, so a run can be
 * replayed against the exact image. Pass the names of the tools that actually ran so the bundle
 * does not claim tools that did not. Naming a disabled or unknown tool throws.
 */
export function toolVersions(
  manifest: ToolManifest,
  ran: Iterable<ToolName>,
): BundleManifest['toolVersions'] {
  const out: Record<string, string> = {};
  for (const name of new Set<ToolName>(ran)) {
    const t = manifest.tools.find((x) => x.name === name);
    if (!t) throw new ToolSelectionError(name, 'it is not in the manifest');
    if (!t.enabled || !t.version || !t.digest) {
      throw new ToolSelectionError(name, 'it is disabled, so it cannot have run');
    }
    out[name] = `${t.version}@${t.digest}`;
  }
  return out;
}

/** True when this exit code means "nothing to scan" and the tool writes no report. */
export function isEmptyExit(manifest: ToolManifest, name: ToolName, code: number): boolean {
  return manifest.tools.find((t) => t.name === name)?.emptyExitCodes?.includes(code) ?? false;
}

export function isOkExit(manifest: ToolManifest, name: ToolName, code: number): boolean {
  return manifest.tools.find((t) => t.name === name)?.okExitCodes.includes(code) ?? false;
}
