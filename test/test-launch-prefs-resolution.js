#!/usr/bin/env node
// Screen-size-driven launch preferences (lib/app-profiles.js LAUNCH_PREFS).
//
// A game with a resolution setting of its own gets that setting pre-set from
// the size of the screen it is about to run on: the smallest mode on a phone,
// the largest one that fits on a laptop. Two halves have to agree for that to
// work, and both are checked here:
//
//   1. the picker maps a screen size to the right stored value, and declines
//      (rather than corrupting) a binary whose bytes are not what it expects;
//   2. our DirectDraw EnumDisplayModes advertises the larger modes at all —
//      RollerCoaster Tycoon validates the mode it is asked for against that
//      enumerated list and refuses anything missing from it, so a picker that
//      asks for 1024x768 while we only advertise up to 800x600 silently
//      degrades back to 640x480 and the whole feature does nothing.

const fs = require('fs');
const path = require('path');
const { LAUNCH_PREFS, applyLaunchPreferences } = require('../lib/app-profiles');

const ROOT = path.join(__dirname, '..');
const IMAGE_BASE = 0x400000;
const GUEST_BASE = 0x12000;
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

function pick(width, height, initialByte = 0xff) {
  const img = fakeImage(initialByte);
  const warnings = [];
  const applied = applyLaunchPreferences('RCT.exe', img.exports, img.memoryBuffer, {
    screen: { width, height },
    log: () => {},
    warn: (m) => warnings.push(m),
  });
  return { applied, value: img.read(), warnings };
}

console.log('RCT resolution picked from the screen size:');
// The largest of RCT's own stock modes that fits: 1 = fullscreen 640x480,
// 2 = 800x600, 3 = 1024x768. Only the default is chosen here — all four rows
// of the game's Display Mode dropdown stay selectable and mean what they say.
ok(pick(400, 300).value === 1, 'phone-sized 400x300 -> 640x480');
ok(pick(640, 480).value === 1, '640x480 -> 640x480');
ok(pick(800, 600).value === 2, '800x600 -> 800x600');
ok(pick(1024, 768).value === 3, '1024x768 -> 1024x768');
ok(pick(1920, 1200).value === 3, 'and anything larger -> 1024x768, the biggest it ships');
// A wide-but-short screen takes the largest mode whose *height* fits too,
// rather than one that would be cropped.
ok(pick(1024, 600).value === 2, 'wide-but-short 1024x600 -> 800x600, not 1024x768');

console.log('The game keeps its own mode list — nothing is re-pointed:');
// An earlier version re-pointed video_init's 1024x768 case at the screen size
// to fill the window exactly. That mode had to take over one of the four
// dropdown rows, so "Full Screen 1024x768" meant something else and true
// 1024x768 became unreachable. Only the default byte is poked now.
for (const [w, h] of [[1280, 800], [1152, 901], [1512, 850], [1920, 1200]]) {
  const pokes = LAUNCH_PREFS['rct.exe']({ screenW: w, screenH: h });
  ok(pokes.length === 1 && pokes[0].key === 'rct-resolution',
    `${w}x${h} pokes only the mode byte`);
}
ok(/1024x768/.test(LAUNCH_PREFS['rct.exe']({ screenW: 1280, screenH: 800 })[0].label),
  'and is labelled with the stock mode it selects');

console.log('Declines rather than corrupting an unexpected binary:');
const stale = pick(1024, 768, 0x02);
ok(stale.applied === 0 && stale.value === 0x02,
  'a byte that is not the expected 0xff is left alone');
ok(stale.warnings.some(w => /unexpected byte/.test(w)),
  'and says so');

console.log('Applies only to apps that have preferences:');
const other = fakeImage(0xff);
ok(applyLaunchPreferences('notepad.exe', other.exports, other.memoryBuffer,
  { screen: { width: 1024, height: 768 }, log: () => {}, warn: () => {} }) === 0,
  'an app with no entry is a no-op');
ok(typeof LAUNCH_PREFS['rct.exe'] === 'function', 'rct.exe entry is a function');

console.log('A manifest hook (lib/apps.js launchPrefs) overrides the table:');
const hooked = fakeImage(0xff);
const hookApplied = applyLaunchPreferences('RCT.exe', hooked.exports, hooked.memoryBuffer, {
  screen: { width: 1024, height: 768 },
  log: () => {}, warn: () => {},
  hook: () => ([{
    key: 'test-hook', addr: RCT_RES_BYTE, expected: [0xff], replacement: [0x02],
    label: 'test hook',
  }]),
});
ok(hookApplied === 1 && hooked.read() === 0x02, 'the hook ran instead of the table');

console.log('EnumDisplayModes advertises the modes the picker can ask for:');
const dx = fs.readFileSync(path.join(ROOT, 'src', '09a8-handlers-directx.wat'), 'utf-8');
for (const [w, h] of [[640, 480], [800, 600], [1024, 768]]) {
  ok(new RegExp(`i32\\.const ${w}`).test(dx) && new RegExp(`i32\\.const ${h}`).test(dx),
    `${w}x${h} is in the mode table`);
}
// idx/3 picks the resolution, idx%3 the depth — six resolutions, three depths,
// the sixth being the host screen itself so a re-pointed mode is enumerable.
ok(/i32\.ge_u \(local\.get \$idx\) \(i32\.const 18\)/.test(dx),
  'the enumeration runs to 18 entries (6 resolutions x 3 depths)');
ok(/func \$enum_mode_host_w/.test(dx) && /func \$enum_mode_host_h/.test(dx),
  'the host screen is one of the advertised resolutions');
ok(/i32\.const 0xFFF8/.test(dx) && /\$enum_mode_clamp/.test(dx),
  'and is rounded and clamped the same way the poke rounds it');
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
