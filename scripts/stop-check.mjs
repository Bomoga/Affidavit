// Claude Code Stop hook: before a session finishes, typecheck and lint the repo and run the tests of
// every package with uncommitted or branch changes. Exit code 2 sends the output back to Claude so
// it fixes the failure instead of stopping. Skips itself on a second stop to avoid a loop.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const shell = process.platform === 'win32';

let input = {};
try {
  input = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  // Not invoked by the hook runner; carry on.
}
if (input.stop_hook_active) process.exit(0);

function git(args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

const changed = new Set([
  ...git(['diff', '--name-only', 'HEAD']),
  ...git(['ls-files', '--others', '--exclude-standard']),
  ...git(['diff', '--name-only', 'origin/main...HEAD']),
]);

const packages = new Set();
for (const file of changed) {
  const m = /^(apps|packages)\/([^/]+)\//.exec(file);
  if (m) packages.add(`${m[1]}/${m[2]}`);
}

function run(label, args) {
  const r = spawnSync('pnpm', args, { cwd: root, encoding: 'utf8', shell });
  if (r.status !== 0) {
    process.stderr.write(`${label} failed:\n${r.stdout}\n${r.stderr}\n`);
    process.exit(2);
  }
}

run('typecheck', ['typecheck']);
run('lint', ['lint']);
for (const dir of packages) {
  const name = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8')).name;
  run(`tests for ${name}`, ['--filter', name, 'test']);
}
