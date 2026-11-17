#!/usr/bin/env node
// Derives, from the pinned gitleaks image, which plain text file names it drops because it reads
// them as archives, and compares the result with ARCHIVE_NAME in
// packages/discovery/src/tools/unscannable.ts. Rerun it whenever the gitleaks pin in tools.json
// changes, and update ARCHIVE_NAME (and neutralArchiveName) if it reports a difference.
//
//   node docker/tools/probe/archive-names.mjs [--max-len 3]
//
// Needs Docker and the pinned image. It creates the files INSIDE a container (a Linux
// filesystem, so names that differ only in case stay distinct; do not run the probe on a host
// filesystem that ignores case), runs gitleaks with --network none, and reads the report back.
// Every file holds one plain text line with a fake key that a one-rule config recognises, so a
// name that is dropped shows up as a missing finding. Names tried: every extension of 1 to
// --max-len characters from [a-z0-9] (default 3, 47,988 extensions), and a list of longer
// archive and compression extensions, each as the last extension and followed by `.txt`, plus
// the upper case form of every extension that was dropped. No shell strings are built from the
// names: they are written to a file that the container reads line by line.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const manifest = JSON.parse(readFileSync(join(repo, 'docker', 'tools', 'tools.json'), 'utf8'));
const image = manifest.tools.find((t) => t.name === 'gitleaks')?.reference;
if (!image) throw new Error('no gitleaks reference in tools.json');

const maxLen = Number(process.argv[process.argv.indexOf('--max-len') + 1] || 3) || 3;

const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
const exts = [];
const build = (prefix, len) => {
  if (len === 0) return;
  for (const c of alphabet) {
    exts.push(prefix + c);
    if (len > 1) build(prefix + c, len - 1);
  }
};
build('', maxLen);
const longer = [
  'zipx',
  'tzst',
  'tbz2',
  'lzma',
  'cpio',
  'lzip',
  'gzip',
  'zstd',
  'snappy',
  'brotli',
  'lzop',
  'lzo',
  'xar',
  'pack',
  'zlib',
  'jar',
  'war',
  'ear',
  'apk',
  'ipa',
  'rpm',
  'deb',
  'cab',
  'iso',
  'dmg',
  'bzip',
  'tlz4',
  'txz',
  'tgz',
  'taz',
  'tlz',
  'tbz',
];
for (const e of longer) if (!exts.includes(e)) exts.push(e);

const work = mkdtempSync(join(tmpdir(), 'affidavit-archive-probe-'));
try {
  const names = [];
  const add = (n) => names.push(n);
  for (const e of exts) {
    add(`f.${e}`);
    add(`f.${e}.txt`);
  }
  writeFileSync(join(work, 'names.txt'), names.join('\n'));
  mkdirSync(join(work, 'out'));
  writeFileSync(
    join(work, 'gitleaks.toml'),
    [
      'title = "archive name probe"',
      '[[rules]]',
      'id = "probe-key"',
      'description = "fake key"',
      "regex = '''AFFIDAVIT_FAKE_KEY_[0-9A-F]{16}'''",
      'keywords = ["affidavit_fake_key_"]',
      '',
    ].join('\n'),
  );

  const script = [
    'mkdir -p /scan',
    'while IFS= read -r n; do printf \'k = "AFFIDAVIT_FAKE_KEY_0123456789ABCDEF"\\n\' > "/scan/$n"; done < /probe/names.txt',
    'gitleaks dir /scan --no-banner --no-color --redact --exit-code 0 --config /probe/gitleaks.toml --max-archive-depth 3 --report-format json --report-path /probe/out/r.json >/dev/null 2>&1',
  ].join('\n');

  const run = () =>
    execFileSync(
      'docker',
      [
        'run',
        '--rm',
        '--network',
        'none',
        '-v',
        `${work}:/probe`,
        '--entrypoint',
        'sh',
        image,
        '-c',
        script,
      ],
      {
        stdio: ['ignore', 'inherit', 'inherit'],
        maxBuffer: 1 << 28,
        env: { ...process.env, MSYS_NO_PATHCONV: '1' },
      },
    );
  const droppedOf = () => {
    const found = new Set(
      JSON.parse(readFileSync(join(work, 'out', 'r.json'), 'utf8')).map((r) =>
        r.File.replace(/^\/scan\//, ''),
      ),
    );
    return names.filter((n) => !found.has(n));
  };

  run();
  let dropped = droppedOf();

  // upper case of every extension that was dropped (names that differ only in case)
  const upper = [];
  for (const n of dropped) {
    const u = n
      .replace(/^f\./, (m) => m)
      .replace(/\.(.*?)(\.txt)?$/, (_m, e, t) => `.${e.toUpperCase()}${t ?? ''}`);
    if (u !== n) upper.push(u);
  }
  const all = [...new Set([...names, ...upper])];
  names.length = 0;
  names.push(...all);
  writeFileSync(join(work, 'names.txt'), names.join('\n'));
  run();
  dropped = droppedOf();

  // compare with ARCHIVE_NAME
  const src = readFileSync(
    join(repo, 'packages', 'discovery', 'src', 'tools', 'unscannable.ts'),
    'utf8',
  );
  const m = /export const ARCHIVE_NAME = \/(.*)\/([a-z]*);/.exec(src);
  if (!m) throw new Error('ARCHIVE_NAME not found in unscannable.ts');
  const rule = new RegExp(m[1], m[2]);
  const droppedSet = new Set(dropped);
  const shouldDrop = names.filter((n) => rule.test(n) && !droppedSet.has(n));
  const shouldScan = dropped.filter((n) => !rule.test(n));

  const first = (n) => /^f\.([^.]+)/.exec(n)?.[1] ?? n;
  const group = (list) => [...new Set(list.map((n) => first(n).toLowerCase()))].sort();
  console.log(`names tried: ${names.length}; dropped by gitleaks: ${dropped.length}`);
  console.log(`dropped first extensions (lower case): ${group(dropped).join(' ')}`);
  console.log(
    `ARCHIVE_NAME matches but gitleaks scanned: ${shouldDrop.length}; extensions: ${group(shouldDrop).join(' ')}`,
  );
  console.log(
    `gitleaks dropped but ARCHIVE_NAME does not match: ${shouldScan.length}; extensions: ${group(shouldScan).join(' ')}`,
  );
  for (const n of shouldScan.slice(0, 20)) console.log(`  MISSED: ${n}`);
  process.exitCode = shouldScan.length > 0 ? 1 : 0;
} finally {
  rmSync(work, { recursive: true, force: true });
}
