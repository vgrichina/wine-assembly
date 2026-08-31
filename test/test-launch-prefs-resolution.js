#!/usr/bin/env node
// Screen-size-driven launch preferences (lib/app-profiles.js LAUNCH_PREFS).
//
// The mechanism pre-sets an app's own stored setting from the size of the
// screen it is about to run on. The table is empty right now -- RollerCoaster
// Tycoon's entry was removed 2026-08-26 -- so what is checked here is the
// machinery plus the one thing that must not come back.
//
// Two halves:
//
//   1. the applier pokes only what it was asked to, declines (rather than
//      corrupting) a binary whose bytes are not what it expects, and is a
//      no-op for an app with no preferences;
//   2. our DirectDraw EnumDisplayModes still advertises the larger modes --
//      RollerCoaster Tycoon validates a mode against that enumerated list and
//      refuses anything missing from it, so a short list silently degrades its
//      Display Mode dropdown back to 640x480.

const fs = require('fs');
const path = require('path');
const { LAUNCH_PREFS, applyLaunchPreferences } = require('../lib/app-profiles');

const ROOT = path.join(__dirname, '..');
const IMAGE_BASE = 0x400000;
// From the map declared in src/00-regions.wat.
const GUEST_BASE = require('../lib/region-map.generated.js').GUEST_BASE;
const RCT_RES_BYTE = 0x0056fd6b;

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`  PASS ${msg}`); } else { fail++; console.log(`  FAIL ${msg}`); } };

// A fake loaded image: just enough memory for the guest address we poke.
function fakeImage(initialByte) {
  const memoryBuffer = new ArrayBuffer(4 * 1024 * 1024);
  const mem = new Uint8Array(memoryBuffer);
  const wa = (RCT_RES_BYTE - IMAGE_BASE + GUEST_BASE) >>> 0;
  mem[wa] = initialByte;
  return {
    memoryBuffer,
    read: () => mem[wa],
    exports: { get_image_base: () => IMAGE_BASE, get_guest_base: () => GUEST_BASE },
  };
}

// A stand-in for a real entry, so the machinery is exercised without depending
// on any particular app having preferences today.
const hookFor = (replacement) => () => ([{
  key: 'test-resolution',
  addr: RCT_RES_BYTE,
  expected: [0xff],
  replacement: [replacement],
  label: `test resolution = ${replacement}`,
}]);

function applyHook(initialByte, replacement) {
  const img = fakeImage(initialByte);
  const warnings = [];
  const applied = applyLaunchPreferences('RCT.exe', img.exports, img.memoryBuffer, {
    screen: { width: 1024, height: 768 },
    log: () => {},
    warn: (m) => warnings.push(m),
    hook: hookFor(replacement),
  });
  return { applied, value: img.read(), warnings };
}

console.log('RCT is NOT given a startup resolution any more:');
// Removed because it broke the app in every ordinary browser window. Driven by
// canvas size, any window >= 1024x768 selected mode 3 (1024x768), and mode 3
// crashes: marker 0xCA002E20, the guest RETs at 0x407165 into string data with
// ESP pointing into the emulator's threaded-code region. Measured, one variable
// per run, with --batch-size=200000:
//     --screen 640x480  -> mode 1  renders     --screen 1280x872 -> mode 3  CRASH @4436
//     --screen 800x600  -> mode 2  renders     same, WA_SKIP_LAUNCH_PREFS=1 -> renders
// The CLI's 640x480 default desktop picked mode 1, which is why this looked
// healthy headless while being broken for every visitor.
ok(!('rct.exe' in LAUNCH_PREFS),
  'no rct.exe entry -- mode 3 crashes the guest, see the comment above LAUNCH_PREFS');
const untouched = fakeImage(0xff);
ok(applyLaunchPreferences('RCT.exe', untouched.exports, untouched.memoryBuffer,
  { screen: { width: 1920, height: 1200 }, log: () => {}, warn: () => {} }) === 0 &&
  untouched.read() === 0xff,
  'a big screen leaves RCT.exe\'s mode byte at 0xff, so the game picks its own');

console.log('The applier pokes what it is asked to:');
const applied = applyHook(0xff, 0x02);
ok(applied.applied === 1 && applied.value === 0x02, 'an expected byte is replaced');

console.log('Declines rather than corrupting an unexpected binary:');
const stale = applyHook(0x02, 0x03);
ok(stale.applied === 0 && stale.value === 0x02,
  'a byte that is not the expected 0xff is left alone');
ok(stale.warnings.some(w => /unexpected byte/.test(w)), 'and says so');

console.log('Applies only to apps that have preferences:');
const other = fakeImage(0xff);
ok(applyLaunchPreferences('notepad.exe', other.exports, other.memoryBuffer,
  { screen: { width: 1024, height: 768 }, log: () => {}, warn: () => {} }) === 0,
  'an app with no entry is a no-op');

console.log('EnumDisplayModes still advertises the stock modes:');
// Not for the picker's sake any more -- for the game's own Display Mode
// dropdown, which validates each row against this list and drops the ones that
// are missing.
const dx = fs.readFileSync(path.join(ROOT, 'src', '09a8-handlers-directx.wat'), 'utf-8');
for (const [w, h] of [[640, 480], [800, 600], [1024, 768]]) {
  ok(new RegExp(`i32\\.const ${w}`).test(dx) && new RegExp(`i32\\.const ${h}`).test(dx),
    `${w}x${h} is in the mode table`);
}
// Keep the existing six resolutions x three depths in their original order;
// one appended 320x200x8 entry serves low-resolution Win9x cinematics.
ok(/i32\.ge_u \(local\.get \$idx\) \(i32\.const 19\)/.test(dx),
  'the enumeration runs to 19 entries (18 existing + 320x200x8)');
ok(/func \$enum_mode_host_w/.test(dx) && /func \$enum_mode_host_h/.test(dx),
  'the host screen is one of the advertised resolutions');
ok(/i32\.const 0xFFF8/.test(dx) && /\$enum_mode_clamp/.test(dx),
  'and is rounded and clamped');
ok(/\(i32\.const 640\) \(i32\.const 1280\)/.test(dx) &&
   /\(i32\.const 480\) \(i32\.const 1024\)/.test(dx),
  'to the same 640x480 .. 1280x1024 bounds');
// The list is a game's resolution *menu*, not a claim about the canvas.
// Filtering it to the canvas deletes rows from that menu, and picking one of
// the deleted rows looks like a mode change that does nothing.
const dispatch = dx.slice(dx.indexOf('(func $enum_modes_dispatch'));
ok(!/host_get_screen_size/.test(dispatch.slice(0, dispatch.indexOf('(func $', 8))),
  'and no mode is skipped for being larger than the canvas');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
