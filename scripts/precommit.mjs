// Pre-commit checks (run by .githooks/pre-commit, or `npm run precommit`):
//   1. app files changed → APP_VERSION must change too (installed apps only update on a new version)
//   2. every JS file parses
//   3. unit tests
//   4. relay tests, when worker/ files are staged
//   5. browser smoke test, if Playwright is installed (skip with SKIP_E2E=1)
// Note: checks run against the working tree, not just the staged changes.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
process.chdir(root);
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const staged = git('diff', '--cached', '--name-only', '--diff-filter=ACMRD').split('\n').filter(Boolean);
let failed = false;

function run(title, cmd, args, opts = {}) {
  const t = Date.now();
  process.stdout.write(`▶ ${title}\n`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  const ok = r.status === 0;
  console.log(`${ok ? '✔' : '✖'} ${title} (${((Date.now() - t) / 1000).toFixed(1)} s)\n`);
  if (!ok) failed = true;
}

// 1. version bump
const APP = /^(index\.html|sw\.js|manifest\.webmanifest|css\/|js\/|icons\/|vendor\/)/;
const hasHead = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { stdio: 'ignore' }).status === 0;
if (hasHead && staged.some((f) => APP.test(f))) {
  const diff = git('diff', '--cached', '-U0', '--', 'js/config.js');
  if (!/^\+export const APP_VERSION/m.test(diff)) {
    console.log('✖ App files changed but APP_VERSION in js/config.js did not.\n  Bump it, or installed copies of the app keep running the old version.\n');
    failed = true;
  } else console.log('✔ APP_VERSION bumped\n');
}

// 2. syntax
const SKIP = new Set(['node_modules', 'vendor', '.git', '.wrangler']);
const jsFiles = (dir) => readdirSync(dir).flatMap((name) => {
  const p = join(dir, name);
  if (SKIP.has(name)) return [];
  if (statSync(p).isDirectory()) return jsFiles(p);
  return /\.m?js$/.test(name) ? [p] : [];
});
const bad = jsFiles('.').filter((f) => spawnSync(process.execPath, ['--check', f], { stdio: ['ignore', 'ignore', 'inherit'] }).status !== 0);
if (bad.length) { console.log(`✖ Syntax errors in: ${bad.join(', ')}\n`); failed = true; } else console.log('✔ JavaScript parses\n');

// 3. unit tests
const units = readdirSync('test/unit').filter((f) => f.endsWith('.test.mjs')).map((f) => join('test/unit', f));
run('Unit tests', process.execPath, ['--test', '--test-reporter=dot', ...units]);

// 4. relay
if (staged.some((f) => f.startsWith('worker/'))) {
  if (existsSync('worker/node_modules')) run('Relay tests', 'npm', ['test', '--silent'], { cwd: 'worker' });
  else console.log('! worker/ changed but worker/node_modules is missing: run `npm install` in worker/ to test the relay\n');
}

// 5. browser
let playwright = false;
try { await import('playwright'); playwright = true; } catch {}
if (process.env.SKIP_E2E) console.log('! Browser smoke test skipped (SKIP_E2E)\n');
else if (!playwright) console.log('! Browser smoke test skipped: run `npm install && npx playwright install chromium` to enable it\n');
else run('Browser smoke test', process.execPath, ['test/e2e/smoke.mjs']);

if (failed) {
  console.log('Commit blocked. Fix the above, or skip the checks once with `git commit --no-verify`.');
  process.exit(1);
}
