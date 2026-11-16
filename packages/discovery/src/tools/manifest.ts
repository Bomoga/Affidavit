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
  enableFlag?: string;
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
  if (enabled) {
    if (reference === null) fail(`${name}: an enabled tool needs a digest reference`);
    if (version === null || !/^\d+\.\d+\.\d+$/.test(version)) fail(`${name}: version required`);
  }
  const codes = raw['okExitCodes'];
  if (!Array.isArray(codes) || !codes.every((c) => Number.isInteger(c))) {
    fail(`${name}: okExitCodes must be integers`);
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
  if (typeof raw['enableFlag'] === 'string') entry.enableFlag = raw['enableFlag'];
  if (typeof raw['blockedBy'] === 'string') entry.blockedBy = raw['blockedBy'];
  if (typeof raw['dockerfile'] === 'string') entry.dockerfile = raw['dockerfile'];
  return entry;
}

export function parseToolManifest(raw: unknown): ToolManifest {
  if (!isRecord(raw) || raw['schemaVersion'] !== 1) fail('schemaVersion must be 1');
  const tools = raw['tools'];
  if (!Array.isArray(tools)) fail('tools must be an array');
  return { schemaVersion: 1, tools: tools.map(parseTool) };
}

/** Walks up from this file to the repo root (the directory holding docker/tools/tools.json). */
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

/** For BundleManifest.toolVersions: enabled tool name to its recorded version. */
export function toolVersions(manifest: ToolManifest): BundleManifest['toolVersions'] {
  const out: Record<string, string> = {};
  for (const t of manifest.tools) if (t.enabled && t.version) out[t.name] = t.version;
  return out;
}

/** Enabled tool name to its digest-pinned image reference. */
export function toolImageRefs(manifest: ToolManifest): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of manifest.tools) if (t.enabled && t.reference) out[t.name] = t.reference;
  return out;
}

export function isOkExit(manifest: ToolManifest, name: ToolName, code: number): boolean {
  return manifest.tools.find((t) => t.name === name)?.okExitCodes.includes(code) ?? false;
}
