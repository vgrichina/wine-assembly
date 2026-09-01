#!/usr/bin/env node

'use strict';

// `tools/region-census.js --embedded-wat` is the gate that refuses a
// hand-written map address inside a WAT fragment embedded in a JS test.
//
// It exists because test-wave-out-get-id proved the other two gates cannot see
// this class. That test appended a fragment storing the open waveOut handle at
// a hard-coded 0xD160 — $WAVE_OUT_SHARED before the map became allocated. The
// census ratchet ignores allocated bases by design, and --js-copies matches
// only literals equal to a CURRENT base or end, which a STALE copy never is;
// 0xC140, where the region actually moved to, is below its floor as well. So
// nothing fired, 0xD160 had meanwhile become an interior address of
// $SCROLL_TABLE, and $handle_waveOutGetID answered MMSYSERR_INVALHANDLE to a
// perfectly good handle while the store scribbled on the scroll table.
//
// The rule that catches it is narrower and exact rather than statistical: a
// fragment spliced into our own sources is compiled by our own compiler, so
// `region.addr` resolves inside it, and a bare `(i32.const N)` in a MEMORY
// OPERAND position is therefore a copy of the map by construction. No
// judgement about whether the number "looks like an address" — in that
// position it is one.
//
// A gate nobody has ever seen fire is a gate nobody knows works, so this plants
// violations in fixture strings and asserts they are CAUGHT, plants the
// look-alikes that must NOT be caught, and then asserts the real tree is clean.
// `sources` swaps the disk scan for a Map so no fixture is a file on disk that
// some other tool would then have to be taught to ignore.

const assert = require('assert');
const { embeddedWat, templateLiterals } = require('../tools/region-census.js');
const { collectDeclarations } = require('../tools/check-region-decls.js');

const hex = (n) => `0x${(n >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
let checks = 0;
const check = (cond, what) => { assert.ok(cond, what); checks++; };

// Take the victim from the live layout rather than writing an address here:
// a fixture with a literal in it would go stale the moment the allocator moves
// something, which is the exact failure this gate exists to prevent.
const decls = collectDeclarations()
  .filter(d => d.base !== null && d.size !== null && d.kind === 'alloc');
const victim = decls.find(d => d.size >= 0x40);
check(victim, 'the layout has an allocated region big enough to plant an interior address in');

const base = victim.base >>> 0;
const interior = (base + 0x20) >>> 0;
const shortName = victim.name.replace(/^\$/, '');

// Every fixture is written the way a real test writes one: `extraWat` is what
// bootRenderHarness splices into a src part, and naming it is what tells the
// gate this fragment is compiled into OUR module.
const fixture = (body) => new Map([['test/fixture-not-on-disk.js', [
  "const { bootRenderHarness } = require('./render-helper');",
  'const extraWat = String.raw`',
  body,
  '`;',
  '',
].join('\n')]]);

// 1. A store's ADDRESS operand is caught, and the report names the file, the
//    line, the region and the offset to write instead — a gate that only says
//    "something is wrong" costs the next reader the search it exists to skip.
const caught = embeddedWat({ sources: fixture(
  `  (func (export "t") (i32.store (i32.const ${hex(interior)}) (i32.const 1)))`) });
check(caught.hits.length === 1, `a planted store address is caught (got ${caught.hits.length})`);
check(caught.hits[0].file === 'test/fixture-not-on-disk.js', 'the hit names the file');
check(caught.hits[0].line === 3, `the hit names the line (got ${caught.hits[0].line})`);
check(caught.hits[0].region.replace(/^\$/, '') === shortName, `the hit names $${shortName}`);
check(caught.hits[0].offset === 0x20,
  `the hit names the offset to write instead (got ${hex(caught.hits[0].offset)})`);

// 2. INTERIOR addresses count, unlike --js-copies which is base/end only. This
//    is the wave-out bug exactly: 0xD160 was nobody's base, it was 0x1010 into
//    $SCROLL_TABLE, and that is precisely why the endpoint-matching gate was
//    blind to it.
check(caught.hits[0].value === interior, 'an interior address, not just a base, is a hit');

// 3. Every memory-operand position the rule claims to cover actually fires.
for (const body of [
  `  (func (export "t") (result i32) (i32.load (i32.const ${hex(interior)})))`,
  `  (func (export "t") (result i32) (i32.load8_u offset=4 (i32.const ${hex(interior)})))`,
  `  (func (export "t") (i64.store offset=8 align=8 (i32.const ${hex(interior)}) (i64.const 1)))`,
  `  (func (export "t") (result i32) (i32.atomic.load (i32.const ${hex(interior)})))`,
  `  (func (export "t") (result i32) (i32.atomic.rmw.add (i32.const ${hex(interior)}) (i32.const 1)))`,
  `  (func (export "t") (memory.fill (i32.const ${hex(interior)}) (i32.const 0) (i32.const 4)))`,
  `  (func (export "t") (i32.store (i32.const ${interior}) (i32.const 1)))`,
]) {
  const r = embeddedWat({ sources: fixture(body) });
  check(r.hits.length === 1, `caught in memory-operand position: ${body.trim().slice(0, 60)}`);
}

// 4. PRECISION. These are the positions the rule deliberately does NOT claim,
//    and a gate that guessed at them would cry wolf and get deleted. A stored
//    VALUE, a call argument and a global.set are all numbers whose meaning
//    needs a judgement; only the address operand is an address by syntax.
for (const body of [
  `  (func (export "t") (i32.store (global.get $TEST_SCRATCH) (i32.const ${hex(interior)})))`,
  `  (func (export "t") (call $some_helper (i32.const ${hex(interior)})))`,
  `  (func (export "t") (global.set $eip (i32.const ${hex(interior)})))`,
  `  (func (export "t") (result i32) (i32.load (i32.add (i32.const ${hex(interior)}) (local.get 0))))`,
]) {
  const r = embeddedWat({ sources: fixture(body) });
  check(r.hits.length === 0, `not flagged outside a memory operand: ${body.trim().slice(0, 60)}`);
}

// 5. An address in a `;;` comment is prose, not code. This is not a nicety:
//    the fragments that explain the map are the ones most likely to name it.
const commented = embeddedWat({ sources: fixture(
  `  ;; historically (i32.store (i32.const ${hex(interior)}) ...)\n  (func (export "t") (nop))`) });
check(commented.hits.length === 0, 'an address inside a ;; comment is not a copy');

// 6. A value in no allocated region is not a hit — a fragment is free to name
//    a guest VA or a scratch address the map does not cover.
const outside = embeddedWat({ sources: fixture(
  '  (func (export "t") (i32.store (i32.const 0x1FFFFFF0) (i32.const 1)))') });
check(outside.hits.length === 0, '0x1FFFFFF0 is inside no allocated region and is not flagged');

// 7. SCOPE. A compiler unit test builds a self-contained module with its own
//    memory, so its 0x100 is an offset into an address space that lives for
//    four lines. Scanning those was 38 hits and every one was noise. The
//    discriminator is what the fragment is compiled INTO, not what it is called:
//    a file that splices nothing into our sources is not scanned, and neither
//    is a fragment that brings its own memory or declares its own regions.
const standalone = embeddedWat({ sources: new Map([['test/watx-compiler-fixture.test.js', [
  'const wasm = build(`',
  '(memory 1 1 shared)',
  `(func $t (i32.store (i32.const ${hex(interior)}) (i32.const 1)))`,
  '`);',
  '',
].join('\n')]]) });
check(standalone.hits.length === 0, 'a standalone compiler fixture is out of scope');

const ownRegions = embeddedWat({ sources: fixture(
  `  (region.declare-fixed $POOL (base ${hex(base)}) (size 0x800))\n`
  + `  (func (export "t") (i32.store (i32.const ${hex(interior)}) (i32.const 1)))`) });
check(ownRegions.hits.length === 0, 'a fragment declaring its own regions is out of scope');

// 8. The template scanner itself, because it was born broken. Inside a template
//    body only a backtick, `${` and an escape are syntax — the first version
//    also honoured JS quotes there, so the apostrophe in a WAT comment reading
//    "the callback's stdcall RET 4" opened a string that swallowed the rest of
//    the file. The gate then found ZERO fragments in the very file whose 0x2DA
//    prompted it and reported the tree clean.
const apostrophe = templateLiterals(
  "const a = `\n;; the callback's own frame\n(i32.store (i32.const 1) (i32.const 2))\n`;\nconst b = 1;\n");
check(apostrophe.length === 1, `an apostrophe in a fragment does not eat the file (got ${apostrophe.length})`);
check(apostrophe[0].text.includes('i32.store'), 'the fragment body survives the apostrophe');

const interpolated = templateLiterals('const a = `(func ${name} (nop))`;\n');
check(interpolated.length === 1, 'a `${}` interpolation does not end the fragment');

// 9. And the real tree is clean, which is what the build gate asserts.
const live = embeddedWat();
check(live.hits.length === 0,
  'no embedded WAT fragment addresses the map by hand:\n  '
  + live.hits.map(h => `${h.file}:${h.line} ${h.literal} = $${h.region}+${hex(h.offset)}`).join('\n  '));
check(live.fragments > 50,
  `the gate actually scans something (${live.fragments} fragment(s) found)`);

console.log(`PASS  embedded WAT fragments address the map by name (${checks} checks, `
  + `${live.fragments} fragments, ${live.checkedRegions} allocated regions)`);
