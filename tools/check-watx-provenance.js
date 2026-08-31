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
// ── Why there is a seal, and not just a list of hashes ───────────────────────
// Comparing recorded hashes against file bytes catches an edit to a vendored
// file. It does NOT catch the edit that matters more: changing a compiler file
// AND hand-editing its hash in PROVENANCE.md, which leaves the gate green and
// no written record of what changed or why. "Also add a CHANGELOG entry" was a
// rule a human could simply not follow.
//
// So the two documents are chained:
//
//   manifest (the sha256 block)
//        │  sha256 of its normalized lines
//        ▼
//   manifest-sha256 ──── must appear verbatim in ────► CHANGELOG.md
//        │                                                  │
//        │ recorded in PROVENANCE's seal                     │ sha256
//        ▼                                                  ▼
//   ................. seal block in PROVENANCE.md ...........
//
// Touch any vendored file and the manifest digest changes, so CHANGELOG.md must
// name the new digest — which changes CHANGELOG's own hash, which the seal
// records. There is no way to move one end without moving the other, and every
// link is checked on a normal verify, not only under --update.
//
// The digest depends on the manifest alone, never on the changelog, so the
// chain is a line and not a fixpoint: compute, write the entry, re-record.
//
// That chain still only protects the entries that are IN the manifest. What
// files must be in it is a separate question, and it is answered by
// REQUIRED_FILES below — in code, because a list the sealed document carries
// could be shortened and re-sealed like anything else in it.
//
// Usage:
//   node tools/check-watx-provenance.js            # verify (the build gate)
//   node tools/check-watx-provenance.js --update    # re-record hashes + seal
//
// --update refuses to write until CHANGELOG.md already names the new manifest
// digest, and prints the digest to paste. It writes both hashes together or
// neither, so the seal is never half-applied.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const PROVENANCE = path.join(ROOT, 'tools', 'watx-src', 'PROVENANCE.md');
const CHANGELOG = path.join(ROOT, 'tools', 'watx-src', 'CHANGELOG.md');
const UPDATE = process.argv.includes('--update');

// ── What must be monitored ───────────────────────────────────────────────────
// The seal proves the recorded hashes were not edited behind the changelog's
// back. It cannot prove the LIST is complete: delete a file's line from the
// manifest, quote the new digest in CHANGELOG.md, re-seal, and every check
// passes while that file is no longer watched at all. A monitoring system whose
// coverage its own subject can shrink is not monitoring anything.
//
// So the required set lives here, in code, not in the sealed document. Adding
// or removing a vendored file must edit this array in the same commit — which
// is the correct friction: it puts the coverage change in the diff, where a
// reviewer reads it, instead of inside a block of hex nobody diffs by eye.
const REQUIRED_FILES = [
  'tools/watx.js',
  'tools/watx-src/compiler-parser.js',
  'tools/watx-src/compiler-stages.js',
  'tools/watx-src/compiler-codegen.js',
  'tools/watx-src/compiler.js',
  'test/watx-compiler-wine-parity.test.js',
  'test/watx-compiler-production.test.js',
  'test/watx-compiler-emit-stack.test.js',
  'test/watx-compiler-br-table.test.js',
  'test/watx-compiler-bulk-memory.test.js',
  'test/watx-compiler-simd.test.js',
];

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

const parsed = [];
for (const raw of fence[1].split('\n')) {
  const line = raw.trim();
  if (!line) continue;
  const m = /^([0-9a-f]{64})\s+(\S+)$/.exec(line);
  if (!m) fail(`malformed manifest line: ${line}`);
  parsed.push({ hash: m[1], file: m[2] });
}
if (parsed.length === 0) fail('the sha256 manifest is empty');

const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

// ── Coverage: the manifest must be exactly REQUIRED_FILES ────────────────────
// Checked before any hash is compared, and enforced in BOTH modes: an --update
// that quietly accepted a short list would just be the same attack with an
// extra step. Duplicates count as a coverage defect too — two lines for one
// path let a stale hash sit next to a fresh one.
const seen = new Map();
for (const e of parsed) {
  if (seen.has(e.file)) fail(`manifest lists ${e.file} twice`);
  seen.set(e.file, e);
}
const required = new Set(REQUIRED_FILES);
const dropped = REQUIRED_FILES.filter((f) => !seen.has(f));
const unexpected = parsed.map((e) => e.file).filter((f) => !required.has(f));

if ((dropped.length || unexpected.length) && !UPDATE) {
  fail(
    'the recorded manifest is not the set this gate requires:\n' +
    (dropped.length
      ? '  required by REQUIRED_FILES but NOT RECORDED (so not monitored):\n    ' +
        dropped.join('\n    ') + '\n' : '') +
    (unexpected.length
      ? '  recorded but not required — remove the line, or add the path to REQUIRED_FILES:\n    ' +
        unexpected.join('\n    ') + '\n' : '') +
    '\nIf this is a deliberate coverage change, edit REQUIRED_FILES in\n' +
    'tools/check-watx-provenance.js in the same commit, then run --update.'
  );
}

// --update reconciles the block to REQUIRED_FILES rather than refusing, so a
// legitimate add is "edit the array, run --update twice" and never a deadlock
// where the manifest cannot be brought into a state the gate accepts. It is not
// a hole: the array it reconciles TO is source code in the same diff, and the
// changelog seal below still has to be satisfied afterwards.
if (UPDATE && (dropped.length || unexpected.length)) {
  for (const f of dropped) console.log(`check-watx-provenance: adding ${f} to the manifest`);
  for (const f of unexpected) console.log(`check-watx-provenance: dropping ${f} from the manifest`);
}

// Order follows REQUIRED_FILES so the digest depends on recorded content and not
// on how the block happens to be sorted. A file required but not yet recorded
// carries no hash until --update supplies one.
const entries = REQUIRED_FILES.map((f) => seen.get(f) || { hash: null, file: f });

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
  fail('these files are required by this gate but do not exist:\n  ' +
       missing.join('\n  ') +
       '\nA vendored file cannot be deleted without removing it from ' +
       'REQUIRED_FILES\nin tools/check-watx-provenance.js and saying why in CHANGELOG.md.');
}

// The manifest digest is taken over normalized `<hash>  <file>` lines, so
// reflowing whitespace or reordering the block's blank lines cannot change it
// while the recorded content stays the same.
const digestOf = (list, hashFor) =>
  crypto.createHash('sha256')
    .update(list.map((e) => `${hashFor(e)}  ${e.file}`).join('\n'))
    .digest('hex');

const recordedDigest = digestOf(entries, (e) => e.hash);   // what PROVENANCE says
const actualDigest = digestOf(entries, (e) => actual.get(e.file)); // what the files are

const changelogText = fs.readFileSync(CHANGELOG, 'utf8');
const changelogHash = sha256(CHANGELOG);

// The seal: two labelled lines binding the manifest to the changelog.
const SEAL_RE = /```seal\r?\n([\s\S]*?)```/;
const readSeal = (text) => {
  const m = SEAL_RE.exec(text);
  if (!m) return null;
  const get = (label) => {
    const hit = new RegExp('^' + label + '\\s+([0-9a-f]{64})$', 'm').exec(m[1]);
    return hit ? hit[1] : null;
  };
  return { manifest: get('manifest-sha256'), changelog: get('changelog-sha256') };
};

const sealText = (manifestDigest, clogHash) =>
  '```seal\n' +
  `manifest-sha256   ${manifestDigest}\n` +
  `changelog-sha256  ${clogHash}\n` +
  '```';

if (UPDATE) {
  // Refuse to record anything until the changelog explains this exact manifest.
  if (!changelogText.includes(actualDigest)) {
    fail(
      'nothing was written. The new manifest digest is:\n\n' +
      `  ${actualDigest}\n\n` +
      'Add a dated entry to tools/watx-src/CHANGELOG.md saying what changed and\n' +
      'why, quoting that digest verbatim in it, then run --update again.\n' +
      (drifted.length
        ? 'Changed files:\n  ' + drifted.map((d) => d.file).join('\n  ')
        : 'No vendored file changed; the manifest itself was edited.')
    );
  }
  let block = '';
  for (const e of entries) block += `${actual.get(e.file)}  ${e.file}\n`;
  let out = doc.replace(fence[1], block);
  const newSeal = sealText(actualDigest, changelogHash);
  out = SEAL_RE.test(out) ? out.replace(SEAL_RE, newSeal) : out.trimEnd() + '\n\n' + newSeal + '\n';
  fs.writeFileSync(PROVENANCE, out);
  console.log(`check-watx-provenance: re-recorded ${drifted.length} file hash(es) and the seal ` +
              `in ${path.relative(ROOT, PROVENANCE)}`);
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

// ── The seal ─────────────────────────────────────────────────────────────────
// Reached only when every vendored file matches its recorded hash. What is left
// to prove is that the RECORD was not edited on its own.
const seal = readSeal(doc);
if (!seal || !seal.manifest || !seal.changelog) {
  fail(
    `no usable \`\`\`seal block in ${path.relative(ROOT, PROVENANCE)}.\n` +
    'It must contain a manifest-sha256 and a changelog-sha256 line; without\n' +
    'them a hand-edited hash cannot be told from a recorded one. Run\n' +
    '`node tools/check-watx-provenance.js --update` to write it.'
  );
}

if (seal.manifest !== recordedDigest) {
  fail(
    'PROVENANCE.md\'s hash manifest does not match its own seal — the recorded\n' +
    'hashes were edited without re-sealing:\n' +
    `  seal says     ${seal.manifest}\n` +
    `  manifest is   ${recordedDigest}\n` +
    'Add a CHANGELOG.md entry quoting the new digest, then run --update.'
  );
}

if (!changelogText.includes(recordedDigest)) {
  fail(
    'tools/watx-src/CHANGELOG.md does not mention the current manifest digest\n' +
    `  ${recordedDigest}\n` +
    'so nothing in this repository explains what the recorded compiler bytes are.\n' +
    'Every manifest change must land with a dated CHANGELOG entry quoting its digest.'
  );
}

if (seal.changelog !== changelogHash) {
  fail(
    'tools/watx-src/CHANGELOG.md changed without re-sealing PROVENANCE.md:\n' +
    `  seal says     ${seal.changelog}\n` +
    `  changelog is  ${changelogHash}\n` +
    'Run `node tools/check-watx-provenance.js --update`.'
  );
}

console.log(`check-watx-provenance: OK (all ${REQUIRED_FILES.length} required files present ` +
            'and matching, manifest sealed against CHANGELOG.md)');
