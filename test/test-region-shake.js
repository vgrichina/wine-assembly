#!/usr/bin/env node

'use strict';

// §8 of docs/watx-region-safety-design.md asks for the memory map to be
// PERMUTED and the emulator to still work, because that is the only evidence
// nothing depends on a region's address. tools/region-shake-smoke.js proves the
// picture; this proves the thing that has to happen first — that the shaken
// layout can be PLACED at all.
//
// It is here because it did not. `gap`, `pad` and `reverse` all died with
// "$THREAD_CACHE_BASE cannot be allocated at 0x1C000000: pinned
// $DIB_BACKING_BASE occupies it", so region-shake-smoke's own default mode list
// was 1-of-3 red and the two dead modes were simply not run. A shake mode that
// silently cannot run is worthless in exactly the way a green run suggests it
// is not.
//
// The cause was the allocator, not capacity. The pins cut the usable space into
// four disjoint windows; the canonical placer carries ONE monotonic cursor and
// never backfills, so overflowing the smallest window (73KB, holding 54 tiny
// regions) made it jump past $GUEST_BASE and abandon every free byte below it.
// The map had 5.43MB of tail slack against 3.55MB of shake inflation. The shake
// path now does best-fit across the free windows instead.
//
// So: every mode must place, the pins must not move, the result must be a legal
// map, and it must actually be DIFFERENT — a shake that quietly places
// everything where canonical did is green and proves nothing. A future pin move
// that re-breaks any of that fails here, loudly, instead of being discovered as
// a mode nobody runs.

const assert = require('assert');
const path = require('path');
const { layout } = require('../tools/region-layout.js');

const ROOT = path.join(__dirname, '..');
const hex = (n) => `0x${(n >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
const mb = (n) => `${(n / 1048576).toFixed(2)} MB`;

let checks = 0;
const check = (cond, what) => { assert.ok(cond, what); checks++; };

// region-shake-smoke.js's default list first, then the two it does not run by
// default — those are exactly the ones that rotted unnoticed, so they are
// covered here even though no app is launched on them.
const MODES = ['gap', 'rotate', '0x9E3779B9', 'reverse', 'pad'];

const canonical = layout();
const canonBase = new Map(canonical.regions.map(r => [r.name, r.base]));
const pinNames = canonical.regions
  .filter(r => r.kind !== 'alloc' && r.kind !== 'span').map(r => r.name);
check(pinNames.length > 0, 'the canonical map has pinned/derived regions to flow around');
check(canonical.counts.allocated > 100,
  `most of the map is allocated (${canonical.counts.allocated}), so a shake has something to move`);

for (const mode of MODES) {
  // 1. IT PLACES. This is the regression: all three of gap/pad/reverse threw.
  let L;
  try {
    L = layout({ shake: mode });
  } catch (err) {
    assert.fail(`shake '${mode}' does not place: ${err && err.message}\n` +
      `  This is the failure that made region-shake-smoke 1-of-3 red. If a pin was just\n` +
      `  moved or grown, the shake now has less room to flow around it — see\n` +
      `  placeShakenAroundPins in tools/watx-src/compiler-codegen.js.`);
  }
  checks++;

  const alloc = L.regions.filter(r => r.kind === 'alloc');
  const solid = L.regions.filter(r => r.kind !== 'span').sort((a, b) => a.base - b.base);

  // 2. THE PINS DO NOT MOVE. Moving $GUEST_BASE or a guest-VA-anchored stack
  //    changes the guest ABI, which is a different experiment entirely.
  for (const name of pinNames) {
    const now = L.regions.find(r => r.name === name);
    check(now && now.base === canonBase.get(name),
      `${mode}: pinned ${name} stays at ${hex(canonBase.get(name))}`);
  }

  // 3. IT IS A LEGAL MAP. A shake that places everything on top of everything
  //    else would satisfy "it placed" and nothing else.
  for (let i = 1; i < solid.length; i++) {
    const prev = solid[i - 1], cur = solid[i];
    const nested = prev.name === cur.within || cur.name === prev.within;
    if (nested) continue;
    check(cur.base >= prev.base + prev.size,
      `${mode}: ${cur.name} at ${hex(cur.base)} does not overlap ${prev.name} ` +
      `[${hex(prev.base)},${hex(prev.base + prev.size)})`);
  }
  const last = solid[solid.length - 1];
  check(last.base + last.size <= L.memoryBytes,
    `${mode}: the map ends at ${hex(last.base + last.size)}, inside the ${mb(L.memoryBytes)} of memory`);
  for (const r of alloc) {
    check(r.align > 0 && (r.base % r.align) === 0,
      `${mode}: ${r.name} at ${hex(r.base)} meets its ${hex(r.align)} alignment`);
  }

  // 4. IT ACTUALLY MOVED. The point of a shake is that the addresses are
  //    different; placing them all back where canonical had them would be green
  //    and worthless. `rotate` moves the fewest by construction (it shifts the
  //    sequence by one, so a region whose neighbours are the same size can land
  //    where it started), hence a floor well under 100%.
  const moved = alloc.filter(r => r.base !== canonBase.get(r.name)).length;
  check(moved >= alloc.length / 2,
    `${mode}: ${moved} of ${alloc.length} allocated regions moved (need at least half)`);

  // 5. AND IT DID NOT HAVE TO GIVE UP ITS INFLATION TO GET THERE. A region that
  //    fits nowhere at its padded footprint is placed unpadded rather than
  //    failing the build — the right fallback, but a weaker experiment than the
  //    one that was asked for, so it is worth knowing when it starts happening.
  //    Today's map needs none of it; this is an early warning, not a hard law.
  check(L.shakeScaledDown === 0,
    `${mode}: no region had to be placed without its gap/padding (got ${L.shakeScaledDown}); ` +
    `if this starts failing the map has tightened and the shake is weaker than it reads`);

  console.log(`  ${String(mode).padEnd(12)} placed, ${moved}/${alloc.length} moved, ` +
    `map ends ${hex(L.end)}, ${L.shakeScaledDown} scaled down`);
}

// 6. THE CANONICAL LAYOUT IS UNTOUCHED BY ANY OF IT. The shake has its own
//    placer; the canonical build must still get the single-cursor first fit it
//    always had, or every artifact in the tree moves. Asking again AFTER five
//    shaken compiles is the cheap version of that assertion.
const again = layout({ fresh: true });
for (const r of again.regions) {
  check(r.base === canonBase.get(r.name),
    `canonical ${r.name} is still at ${hex(canonBase.get(r.name))} after the shakes`);
}
check(again.shakeScaledDown === 0, 'the canonical layout scales nothing down');

console.log(`PASS  every region shake places a legal, different map (${checks} checks, ` +
  `${MODES.length} modes, ${canonical.counts.allocated} allocated regions)`);
