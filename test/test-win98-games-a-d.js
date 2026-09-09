'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  APPS, DESKTOP_APPS, LOCAL_CANDIDATE_APPS, DEBUG_ONLY_APPS,
} = require('../lib/apps');
const { EXE_PATCHES, applyExeCompatibilityPatches } = require('../lib/app-profiles');
const { GUEST_BASE: guestBase } = require('../lib/region-map.generated');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const localIds = new Set(LOCAL_CANDIDATE_APPS.map(([id]) => id));
const publicIds = new Set(DESKTOP_APPS.map(([id]) => id));
const debugIds = new Set(DEBUG_ONLY_APPS.map(([id]) => id));
const expected = {
  curse_monkey_island_demo: ['COMI.EXE', 11],
  atomic_bomberman_demo: ['_BOMB.EXE', 151],
  broken_sword_demo: ['WINSWORD.EXE', 551],
  dungeon_keeper_demo: ['KEEPER95.EXE', 165],
  darkstone_demo: ['DarkstoneDemo.exe', 12],
};

for (const [id, [exeName, companionCount]] of Object.entries(expected)) {
  const app = APPS[id];
  assert(app, `${id} has an app registry entry`);
  assert(localIds.has(id), `${id} is available on localhost`);
  assert(!publicIds.has(id), `${id} is not deployed publicly`);
  assert(!debugIds.has(id), `${id} is not duplicated in debug-only apps`);
  assert(app.requiredFiles, `${id} requires its complete resource tree`);
  assert(app.exe.startsWith('test/binaries/win98-games-a-d/'));
  assert(app.exe.endsWith('/' + exeName));
  assert(app.localFileManifest.endsWith('/.wine-assembly-browser.json'));
  assert(html.includes(`<option value="${id}">`),
    `${id} has a concrete debug-toolbar option`);

  const exe = path.join(root, app.exe);
  if (!fs.existsSync(exe)) continue;
  const manifestPath = path.join(root, app.localFileManifest);
  assert(fs.existsSync(manifestPath), `${id} browser manifest was generated`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.strictEqual(manifest.schemaVersion, 1);
  assert.strictEqual(manifest.files.length, companionCount);
  assert(!manifest.files.some(file => file.url === exeName),
    `${id} manifest does not fetch its executable twice`);
  for (const file of manifest.files) {
    assert(file.vfsPath.startsWith('c:\\'));
    assert(fs.existsSync(path.join(path.dirname(manifestPath), file.url)),
      `${id} manifest asset is missing: ${file.url}`);
  }
}

assert.deepStrictEqual(APPS.broken_sword_demo.dlls.map(file => path.basename(file)),
  ['SMACKW32.DLL']);
assert.strictEqual(APPS.broken_sword_demo.startupInput, undefined,
  'the working opening movie is not skipped automatically');
assert.deepStrictEqual(APPS.broken_sword_demo.touchControls, {},
  'the mouse-driven game exposes mobile Fit/Fill without fake game buttons');
assert.deepStrictEqual(APPS.dungeon_keeper_demo.dlls.map(file => path.basename(file)),
  ['MSS32.DLL', 'WSND7R.DLL', 'SMACKW32.DLL']);
assert(APPS.dungeon_keeper_demo.exe.includes(
  'Dungeon Keeper Demo-SWonly/installed/'),
  'Dungeon Keeper launches only the original installer output');
assert.strictEqual(APPS.atomic_bomberman_demo.touchControls.dpad.ways, 4);
assert.deepStrictEqual(APPS.atomic_bomberman_demo.touchControls.buttons,
  [{ vk: 0x20, label: 'Bomb', pos: 'br' }]);

const expiryPatch = EXE_PATCHES['_bomb.exe'];
assert.strictEqual(expiryPatch.length, 1, 'Atomic Bomberman patch count');
const memory = new ArrayBuffer(0x220000);
const bytes = new Uint8Array(memory);
const expiryWa = expiryPatch[0].addr - 0x400000 + guestBase;
bytes.set(expiryPatch[0].expected, expiryWa);
assert.strictEqual(applyExeCompatibilityPatches('_BOMB.EXE', {
  get_image_base: () => 0x400000,
  get_guest_base: () => guestBase,
}, memory, { log: () => {} }), 1, 'verified Atomic Bomberman alpha is patched');
assert.deepStrictEqual(
  [...bytes.slice(expiryWa, expiryWa + expiryPatch[0].replacement.length)],
  expiryPatch[0].replacement,
  'the alpha upper expiry cutoff is extended');

console.log('PASS  five Archive.org Windows 98 demos are reproducible local apps');
