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
// 1 = fullscreen 640x480, 2 = 800x600, 3 = the 1024x768 case (which is the one
// re-pointed at the screen when the screen is not a stock mode).
ok(pick(400, 300).value === 1, 'phone-sized 400x300 -> 640x480');
ok(pick(640, 480).value === 1, '640x480 -> 640x480');
ok(pick(800, 600).value === 2, '800x600 -> 800x600');
ok(pick(1024, 768).value === 3, '1024x768 -> the 1024x768 case, unmodified');
// A wide-but-short screen used to fall back to 800x600 and letterbox; now it
// gets its own exact mode, which is the whole point of the custom case.
const shortScreen = pick(1024, 600);
ok(shortScreen.value === 3, 'wide-but-short 1024x600 -> the re-pointed case');
ok(/1024x600/.test(LAUNCH_PREFS['rct.exe']({ screenW: 1024, screenH: 600 })[0].label),
  'at exactly 1024x600, not a 4:3 mode it does not fit');

console.log('A screen that is not a stock mode becomes one:');
const custom = LAUNCH_PREFS['rct.exe']({ screenW: 1280, screenH: 800 });
const modePokes = custom.filter(p => p.key === 'rct-custom-mode');
ok(custom[0].replacement[0] === 3, 'a 1280x800 browser window still selects case 3');
ok(modePokes.length === 4, 'and re-points its four immediates');
ok(/1280x800/.test(custom[0].label), 'labelled with the 16:10 size it will run at');
// Both axes floored to a multiple of 8 and clamped to 1280x1024, matching
// $enum_mode_host_w/h. Anything else and the game declines its own mode.
const odd = LAUNCH_PREFS['rct.exe']({ screenW: 1152, screenH: 901 });
ok(/1152x896/.test(odd[0].label), '1152x901 rounds down to 1152x896 (8-aligned)');
// Measured engine limits: past 1280 wide nothing is drawn, and a height that is
// not a multiple of 8 leaves a black strip along the bottom.
const oversized = LAUNCH_PREFS['rct.exe']({ screenW: 1512, screenH: 850 });
ok(/1280x848/.test(oversized[0].label),
  '1512x850 is capped to the 1280x848 the engine can actually paint');
ok(/1280x1024/.test(LAUNCH_PREFS['rct.exe']({ screenW: 1920, screenH: 1200 })[0].label),
  'and a 1920x1200 screen to 1280x1024');
ok(LAUNCH_PREFS['rct.exe']({ screenW: 1024, screenH: 768 })
  .every(p => p.key !== 'rct-custom-mode'),
  'an exactly-1024x768 screen leaves video_init alone');
ok(LAUNCH_PREFS['rct.exe']({ screenW: 640, screenH: 480 })
  .every(p => p.key !== 'rct-custom-mode'),
  'so does a small screen, where the stock ladder is right');

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
