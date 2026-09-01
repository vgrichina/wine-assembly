#!/usr/bin/env node

'use strict';

// `tools/region-census.js --js-copies` is the gate that refuses a hand-copied
// ALLOCATED region address in JS. The census's own ratchet deliberately ignores
// allocated bases (a base the allocator picked this morning cannot be "written
// down twice"), which left the runtime unguarded against precisely the failure
// wave 3 spent hours on: a JS file holding a base that MOVES the next time a
// size changes, with no error anywhere when it does. `d59ce229` is the proof it
// is not hypothetical — a copy of 0x07152000 was zeroing 32KB of $PE_STAGING on
// every worker spawn.
//
// A gate nobody has ever seen fire is a gate nobody knows works, so this plants
// a violation in a fixture string and asserts it is CAUGHT, then asserts the
// real tree is clean. The `sources` option exists for the first half: it swaps
// the disk scan for a Map, so the fixture never has to be a file on disk that
// some other tool would then have to be taught to ignore.

const assert = require('assert');
const { jsCopies, JS_COPY_FLOOR } = require('../tools/region-census.js');
const { collectDeclarations } = require('../tools/check-region-decls.js');

const hex = (n) => `0x${(n >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
let checks = 0;
const check = (cond, what) => { assert.ok(cond, what); checks++; };

// Pick a real allocated base above the floor to plant. Taking it from the live
// layout rather than writing one here means the fixture cannot go stale when
// the allocator moves things — which is the entire point of the gate.
const decls = collectDeclarations().filter(d => d.base !== null && d.size !== null);
const pinnedBases = new Set();
for (const d of decls) if (d.kind !== 'alloc') pinnedBases.add(d.base >>> 0);
const victim = decls.find(d => d.kind === 'alloc' &&
  (d.base >>> 0) >= JS_COPY_FLOOR && !pinnedBases.has(d.base >>> 0));
check(victim, 'the layout has at least one allocated base above the floor to test with');

const planted = hex(victim.base);

// 1. A planted copy is caught, and the report names the file, the line and the
//    region — a gate that only says "something is wrong" costs the next reader
//    the search this tool exists to skip.
const caught = jsCopies({ sources: new Map([
  ['lib/fixture-not-on-disk.js', [
    'const x = 1;',
    `const CACHE = ${planted} + tid * 0x8000;`,
    '',
  ].join('\n')],
]) });
check(caught.hits.length === 1, `planted ${planted} is caught (got ${caught.hits.length} hit(s))`);
check(caught.hits[0].file === 'lib/fixture-not-on-disk.js', 'the hit names the file');
check(caught.hits[0].line === 2, 'the hit names the line');
check(caught.hits[0].region.replace(/^\$/, '') === victim.name.replace(/^\$/, ''),
  `the hit names $${victim.name.replace(/^\$/, '')}`);

// 2. The same value inside a `//` comment is not a copy — a comment cannot be
//    read by the running program, and flagging prose would make the gate
//    unliveable in exactly the files that explain the map.
const commented = jsCopies({ sources: new Map([
  ['lib/fixture-not-on-disk.js', `// historically ${planted}\nconst x = 1;\n`],
]) });
check(commented.hits.length === 0, 'a value in a // comment is not a copy');

// 3. The generated mirror is the map rendered for JS and is exempt by name.
const mirror = jsCopies({ sources: new Map([
  ['lib/region-map.generated.js', `const B = ${planted};\n`],
]) });
check(mirror.hits.length === 0, 'lib/region-map.generated.js is exempt');

// 4. A value below the measured floor is NOT flagged. Allocated regions pack
//    from 0x100 up, so their low bases are 0x1000/0x2000/0x4000/0x10000 — the
//    commonest integers in a Win32 emulator. Matching those produced 205 false
//    positives in the sweep that chose the floor; this asserts the exemption
//    that keeps the gate at zero survives.
const low = decls.find(d => d.kind === 'alloc' && (d.base >>> 0) < JS_COPY_FLOOR &&
  (d.base >>> 0) >= 0x1000);
if (low) {
  const belowFloor = jsCopies({ sources: new Map([
    ['lib/fixture-not-on-disk.js', `const WS_TABSTOP = ${hex(low.base)};\n`],
  ]) });
  check(belowFloor.hits.length === 0,
    `${hex(low.base)} ($${low.name.replace(/^\$/, '')}) is below the ${hex(JS_COPY_FLOOR)} floor and not flagged`);
}

// 5. A PINNED or DERIVED region's BASE is legitimately written down —
//    src/00-regions.wat states it and tools/region-alloc.js tabulates it — so
//    it is not flagged even when the region packed below makes it their end.
const abuttingPin = decls.find(d => d.kind === 'alloc' &&
  pinnedBases.has((d.base + d.size) >>> 0) && ((d.base + d.size) >>> 0) >= JS_COPY_FLOOR);
if (abuttingPin) {
  const v = hex(abuttingPin.base + abuttingPin.size);
  const pinnedHit = jsCopies({ sources: new Map([
    ['tools/fixture-not-on-disk.js', `const B = ${v};\n`],
  ]) });
  check(pinnedHit.hits.length === 0,
    `${v} is a pinned base and is not flagged as $${abuttingPin.name.replace(/^\$/, '')}'s end`);
}

// 5b. But a pinned region's END is NOT exempt — it is just the next region's
//    allocated base, and that is not a hypothetical distinction. $THUNK_BASE
//    ends where the allocator put $PE_STAGING, and that exact address was the
//    scribble d59ce229 removed. An exemption for pinned ends would have let
//    this gate report the tree clean with the bug still in it.
const pinnedEnds = decls.filter(d => d.kind !== 'alloc')
  .map(d => (d.base + d.size) >>> 0).filter(v => v >= JS_COPY_FLOOR);
const endThatIsAllocBase = decls.find(d => d.kind === 'alloc' &&
  pinnedEnds.includes(d.base >>> 0));
if (endThatIsAllocBase) {
  const v = hex(endThatIsAllocBase.base);
  const endHit = jsCopies({ sources: new Map([
    ['lib/fixture-not-on-disk.js', `const CACHE = ${v} + tid * 0x8000;\n`],
  ]) });
  check(endHit.hits.length === 1,
    `${v} is a pinned region's END and an allocated base, and IS flagged ` +
    `(as $${endThatIsAllocBase.name.replace(/^\$/, '')})`);
}

// 6. And the real tree is clean, which is what the build gate asserts.
const live = jsCopies();
check(live.hits.length === 0,
  'no JS file in the tree copies an allocated region address:\n  ' +
  live.hits.map(h => `${h.file}:${h.line} ${h.literal} = $${h.region}`).join('\n  '));
check(live.checkedValues > 100,
  `the gate actually checks something (${live.checkedValues} value(s) at or above ${hex(JS_COPY_FLOOR)})`);

console.log(`PASS  allocated region addresses stay out of JS (${checks} checks, ` +
  `${live.checkedValues} values guarded)`);
