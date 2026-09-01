#!/usr/bin/env node

// The pre-extracted desktop icons are current with the registry and the
// executables they came out of.
//
//   node test/test-app-icon-assets.js
//
// This is the staleness gate for `node tools/extract-app-icons.js`. It belongs
// here rather than in tools/build.sh because nothing about it involves the
// wasm: adding an app to lib/apps.js or replacing its executable is a change
// no WAT rebuild would notice, and the only symptom of forgetting to rerun the
// generator is that the live site quietly goes back to downloading that app's
// whole executable on every cold page load to find its icon. That regression
// is invisible in a screenshot — the right icon still appears — so it needs a
// check that reads the assets rather than the picture.
//
// test/test-icon-extract.js owns the *decoding* (both executable containers,
// pixel equality against the checked-in PNGs, the loader's bucket routing).
// This owns the generator being idempotent and the tracked files matching what
// it would write right now, including lib/app-icon-manifest.json.

'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TOOL = path.join(ROOT, 'tools', 'extract-app-icons.js');
const MANIFEST = path.join(ROOT, 'lib', 'app-icon-manifest.json');

let passed = 0;
let failed = 0;
function check(what, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail && !ok ? ` -- ${detail}` : ''}`);
  ok ? passed++ : failed++;
}

check('lib/app-icon-manifest.json exists', fs.existsSync(MANIFEST));

let output = '';
let status = 0;
try {
  output = execFileSync(process.execPath, [TOOL, '--check'],
    { cwd: ROOT, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
} catch (e) {
  status = e.status === undefined ? 1 : e.status;
  output = `${e.stdout || ''}${e.stderr || ''}`;
}

// The tool's own report is the useful failure message: it names each stale or
// missing file, and the fix is always the same one command.
if (status !== 0) {
  console.log(output.trimEnd());
  console.log('  -> rerun: node tools/extract-app-icons.js');
}
check('tools/extract-app-icons.js --check passes', status === 0,
  `exit ${status}`);

// An empty run would pass the check above by doing nothing at all.
const summary = /PASS\s+(\d+) pre-extracted desktop icons are current, manifest covers (\d+) apps/
  .exec(output);
check('the check actually covered the desktop set', !!summary && Number(summary[1]) > 0,
  output.trimEnd().split('\n').pop());
if (summary) {
  console.log(`      ${summary[1]} icons current, ${summary[2]} desktop apps in the manifest`);
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf-8'));
  const total = manifest.icons.length + manifest.noIcon.length + manifest.runtime.length;
  check('the manifest bucket totals match the tool report',
    total === Number(summary[2]) && manifest.icons.length === Number(summary[1]),
    `${manifest.icons.length} icons / ${total} total`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
