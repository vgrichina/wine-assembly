#!/usr/bin/env node
'use strict';

// tools/union-gate.js is the wrong-variant gate for every WATX
// (layout-union ...) in the tree. A gate whose only evidence is that it passes
// has no evidence it can still FAIL — and the note in its own harvestGuards
// records a check that silently stopped running for exactly that reason. So
// each of its failure modes is planted here and must be caught.
//
// Two of the old gdi-variant-gate.js failure modes are deliberately absent,
// because they are no longer expressible: a variant that disagrees about the
// shared prefix, and variants of differing size. The prefix is written once in
// the (layout-union ...) and the compiler pads every variant to the widest, so
// there is nothing to plant. Reading above the prefix through the union name is
// likewise a compile error now, covered in watx-compiler-typed-pointers.test.js
// rather than here.

const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const GATE = path.join(ROOT, 'tools', 'union-gate.js');
let checks = 0;

function check(cond, message) { assert.ok(cond, message); checks++; }

// Plants go into a COPY. The tree is shared with other agents, and a test that
// mutates src/*.wat in place is one interrupted run away from committing a
// planted bug.
function plantDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'union-gate-plant-'));
  for (const f of fs.readdirSync(SRC).filter(x => x.endsWith('.wat')))
    fs.copyFileSync(path.join(SRC, f), path.join(dir, f));
  return dir;
}

function runGate(dir) {
  try {
    return { ok: true, out: execFileSync('node', [GATE, `--src=${dir}`],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 << 20 }) };
  } catch (e) {
    return { ok: false, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

function replaceOnce(text, before, after, label) {
  const first = text.indexOf(before);
  check(first >= 0, `${label}: fixture exists`);
  check(text.indexOf(before, first + before.length) < 0, `${label}: fixture is unique`);
  return text.slice(0, first) + after + text.slice(first + before.length);
}

// Plant `edit(text)` into `file` and require the gate to fail with `pattern`.
function expectCaught(label, file, edit, pattern) {
  const dir = plantDir();
  const p = path.join(dir, file);
  fs.writeFileSync(p, edit(fs.readFileSync(p, 'utf8')));
  const r = runGate(dir);
  check(!r.ok, `${label}: gate must FAIL on the plant, but it passed:\n${r.out}`);
  check(pattern.test(r.out), `${label}: expected ${pattern}, got:\n${r.out}`);
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── the tree itself is clean, and the gate is actually looking at something ──
{
  const r = runGate(SRC);
  check(r.ok, `live source passes the gate:\n${r.out}`);
  const m = /union-gate: (\d+) GdiObject sites OK.*?\((\d+) on the shared prefix.*?(\d+) spelling a variant.*?of which (\d+) are cross-checked.*?and (\d+) are per-arm/s.exec(r.out);
  check(m !== null, `gate prints its site census:\n${r.out}`);
  const [, total, prefix, variant, guarded, perArm] = m.map(Number);
  // Parity with tools/gdi-variant-gate.js, measured on the pre-union tree at
  // 132c610f: 160 sites / 24 prefix / 136 variant / 23 guarded / 26 per-arm.
  // These are floors, not equalities -- the family may grow -- but a COLLAPSE
  // is the failure this pins, because every structural weakening of the scan
  // shows up as sites quietly going missing rather than as an error.
  check(total >= 160, `site count has not collapsed (got ${total}, parity baseline 160)`);
  check(prefix >= 24, `prefix sites (got ${prefix}, baseline 24)`);
  check(variant >= 136, `variant-spelling sites (got ${variant}, baseline 136)`);
  check(guarded >= 23, `tag-guard cross-checked sites (got ${guarded}, baseline 23)`);
  check(perArm >= 26, `per-arm sites (got ${perArm}, baseline 26)`);
}

// ── the union table the gate reads comes from the compiler, not a regex ─────
{
  const out = execFileSync('node', [GATE, '--unions'], { cwd: ROOT, encoding: 'utf8' });
  check(/\(layout-union GdiObject\) 48 bytes, tag type@\+4 of enum GdiType/.test(out),
        `the lowered union is reported:\n${out}`);
  check(/prefix\s+handle@\+0, type@\+4/.test(out), 'the prefix comes from the declaration');
  for (const [v, tag] of [['GdiPen', 1], ['GdiBrush', 2], ['GdiBitmap', 3], ['GdiFont', 4],
                          ['GdiPalette', 5], ['GdiMetafile', '6\\|7']])
    check(new RegExp(`variant\\s+${v}\\s+tag ${tag}\\b`).test(out), `${v} carries its tag value`);
  check(/\(view GdiPenBrush\) over GdiPen, GdiBrush: style@\+8, color@\+16, flags@\+20/.test(out),
        'the pen/brush projection adopts its targets\' offsets');
}

// ── 1. an unattributed site ─────────────────────────────────────────────────
// A new function reads a variant field and nobody decided what type it holds.
// Planted into a file that carries no per-arm bySite keys, and with the line
// count preserved: those keys are LINE NUMBERS, so a plant that shifts them
// would fail the gate for the wrong reason.
expectCaught('unattributed', '10b-gdi-font.wat',
  (t) => replaceOnce(t, '(func $gdi_bitmap_font_bind',
    '(func $gdi_object_freshly_added (param $h i32) (result i32) (effects) ' +
    '(load.field.memarg GdiBitmap bits (call $gdi_object_record (local.get $h)))) ' +
    '(func $gdi_bitmap_font_bind', 'a new unattributed function'),
  /\$gdi_object_freshly_added reads \+24 of a GdiObject record but is NOT ATTRIBUTED/);

// ── 2. the source names one variant, the attribution names another ──────────
// THE wrong-layout bug: a font's +24 strike read as a bitmap's pixel bits.
// Compiles perfectly; means something completely different.
expectCaught('wrong-variant', '09a4-handlers-gdi.wat',
  (t) => replaceOnce(t, '(load.field.memarg GdiFont strike', '(load.field.memarg GdiBitmap bits',
                     'a font strike read as bitmap bits'),
  /spells GdiBitmap at \+24, but the attribution \(by function\) says GdiFont/);

// ── 3. a prefix site that claims a variant it has not established ───────────
expectCaught('prefix-claims-a-variant', '10e-gdi-metafile.wat',
  // $gdi_object_type IS the read that decides the type, so it is the clearest
  // possible case of a site that cannot name a variant yet.
  (t) => replaceOnce(t, '(if (local.get $p) (then (return (load.field.memarg GdiObject type',
                     '(if (local.get $p) (then (return (load.field.memarg GdiBitmap type',
                     'a +4 read spelling a variant'),
  /reads the shared prefix \(\+4\) but spells it GdiBitmap/);

// ── 4. reading a word the variant does not own ──────────────────────────────
// GdiBitmap's +44 exists only to pin the 48-byte stride. It is named
// `reserved`, and a read of it is the attribution being wrong.
expectCaught('reserved-field', '09a-handlers.wat',
  (t) => replaceOnce(t, '(local.set $bpp (load.field.memarg GdiBitmap bpp',
                     '(local.set $bpp (load.field.memarg GdiBitmap reserved',
                     'a read of the stride padding'),
  /which GdiBitmap declares as 'reserved'/);

// ── 5. the attribution contradicts the function's own tag guard ─────────────
// This is the check that exists because the other three were measured
// insufficient: a mis-attribution between two variants that both declare a
// field at the offset in question passes every other check silently.
//
// So the plant leaves the SOURCE SPELLING alone and moves the guard instead.
// $gdi_font_height is attributed to GdiFont and tests `type == 4`; retagging
// its guard to 5 makes the function claim it holds a palette while the
// attribution still says font. Nothing else in the file changes, and no other
// check can see it -- the offset is a real GdiFont field, the spelling matches
// the attribution, and it is not a prefix read.
expectCaught('attribution-vs-guard', '10f-gdi-dc.wat',
  (t) => replaceOnce(t,
    '(i32.eq (load.field.memarg GdiObject type (local.get $p)) (i32.const 4)))\n' +
    '      (then (return (load.field.memarg GdiFont height (local.get $p)))))',
    '(i32.eq (load.field.memarg GdiObject type (local.get $p)) (i32.const 5)))\n' +
    '      (then (return (load.field.memarg GdiFont height (local.get $p)))))',
    "$gdi_font_height's own type guard"),
  /\$gdi_font_height is attributed to GdiFont \(tag 4\), but the function's own discriminant guard tests \+4 against 5/);

// ── 6. the gate noticing it has stopped seeing anything ─────────────────────
// The migration-status lesson: a check that stops running is worse than no
// check. If the site scan ever stops recognizing the spelling, every plant
// above would pass silently -- so zero sites is itself a failure.
{
  const dir = plantDir();
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    fs.writeFileSync(p, fs.readFileSync(p, 'utf8')
      .replace(/\((load|store)\.field(\.memarg)?\s+Gdi/g, '($1.field$2 NotGdi'));
  }
  const r = runGate(dir);
  check(!r.ok, 'gate fails when it can no longer see any site');
  check(/found ZERO sites for GdiObject/.test(r.out), `expected the zero-sites refusal, got:\n${r.out}`);
  fs.rmSync(dir, { recursive: true, force: true });
}

// NOTE on the one failure mode not planted here: RAW hand-spelled arithmetic
// (`(i32.load offset=24 (call $gdi_object_record …))`). That path runs through
// tools/struct-offset-census.js, which scans the real src/ and takes no --src,
// so it cannot be pointed at a copy. Its healthy state -- the census exiting
// "no such base" -- is asserted on every build by the gate itself, and the
// summary line above prints "no raw hand-spelled site(s) remain" from it.

console.log(`test-union-gate: ${checks} checks passed`);
