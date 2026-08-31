#!/usr/bin/env node
// check-watx-provenance.js — the vendored WATX compiler has not drifted silently.
//
// tools/watx-src/PROVENANCE.md records a SHA-256 for every file imported from
// ../android-emu. A vendored compiler is only trustworthy while somebody can say
// what it is a copy OF, so an edit to any of those files must come with an
// updated hash and a CHANGELOG entry in the same commit. This gate turns "the
// compiler quietly diverged from its import point" into a build failure instead
// of an archaeology problem six months later.
//
// It deliberately checks nothing about the compiler's behavior — the six
// test/watx-compiler-*.test.js suites do that. This one only answers "are these
// the bytes we recorded".
//
// Usage:
//   node tools/check-watx-provenance.js            # verify
//   node tools/check-watx-provenance.js --update    # rewrite the recorded hashes
//
// --update is for a deliberate change: it rewrites the block, then still fails
// if CHANGELOG.md has not been touched more recently than the file you changed,
// so the note cannot be forgotten.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const PROVENANCE = path.join(ROOT, 'tools', 'watx-src', 'PROVENANCE.md');
const CHANGELOG = path.join(ROOT, 'tools', 'watx-src', 'CHANGELOG.md');
const UPDATE = process.argv.includes('--update');

function fail(msg) {
  console.error('check-watx-provenance: ' + msg);
  process.exit(1);
}

if (!fs.existsSync(PROVENANCE)) fail(`missing ${path.relative(ROOT, PROVENANCE)}`);
if (!fs.existsSync(CHANGELOG)) fail(`missing ${path.relative(ROOT, CHANGELOG)}`);

const doc = fs.readFileSync(PROVENANCE, 'utf8');

// The manifest is a ```sha256 fenced block of `<hash>  <repo-relative path>`.
const fence = /```sha256\r?\n([\s\S]*?)```/.exec(doc);
if (!fence) {
  fail(`no \`\`\`sha256 block in ${path.relative(ROOT, PROVENANCE)} — the recorded ` +
       'hash manifest is how this gate knows what was imported');
}

const entries = [];
for (const raw of fence[1].split('\n')) {
  const line = raw.trim();
  if (!line) continue;
  const m = /^([0-9a-f]{64})\s+(\S+)$/.exec(line);
  if (!m) fail(`malformed manifest line: ${line}`);
  entries.push({ hash: m[1], file: m[2] });
}
if (entries.length === 0) fail('the sha256 manifest is empty');

const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

const drifted = [];
const missing = [];
const actual = new Map();

for (const e of entries) {
  const abs = path.join(ROOT, e.file);
  if (!fs.existsSync(abs)) { missing.push(e.file); continue; }
  const got = sha256(abs);
  actual.set(e.file, got);
  if (got !== e.hash) drifted.push({ ...e, got });
}

if (missing.length) {
  fail('these files are recorded in PROVENANCE.md but do not exist:\n  ' +
       missing.join('\n  '));
}

if (UPDATE) {
  let block = '';
  for (const e of entries) block += `${actual.get(e.file)}  ${e.file}\n`;
  fs.writeFileSync(PROVENANCE, doc.replace(fence[1], block));
  console.log(`check-watx-provenance: rewrote ${drifted.length} hash(es) in ` +
              path.relative(ROOT, PROVENANCE));
  if (drifted.length) {
    // The hash is now honest; the human-readable reason may not be.
    const clogMtime = fs.statSync(CHANGELOG).mtimeMs;
    const stale = drifted.filter((d) => fs.statSync(path.join(ROOT, d.file)).mtimeMs > clogMtime);
    if (stale.length) {
      fail('hashes updated, but CHANGELOG.md is older than these changed files:\n  ' +
           stale.map((d) => d.file).join('\n  ') +
           '\nAdd a dated entry to tools/watx-src/CHANGELOG.md saying what changed and why.');
    }
  }
  process.exit(0);
}

if (drifted.length) {
  fail(
    'the vendored WATX compiler has drifted from its recorded import:\n' +
    drifted.map((d) => `  ${d.file}\n    recorded ${d.hash}\n    actual   ${d.got}`).join('\n') +
    '\n\nIf the change is deliberate: add a dated entry to tools/watx-src/CHANGELOG.md,\n' +
    'then run `node tools/check-watx-provenance.js --update` to re-record the hashes.\n' +
    'If it is not: you have an unreviewed edit to a vendored compiler.'
  );
}

console.log(`check-watx-provenance: OK (${entries.length} vendored files match PROVENANCE.md)`);
