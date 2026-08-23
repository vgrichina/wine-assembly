#!/usr/bin/env node
const assert = require('assert');
const { createStorageImports, setIniValue, setRegValue } = require('../lib/storage');
const { g2w, readStrA } = require('../lib/mem-utils');

const IMAGE_BASE = 0x400000;
const memory = new ArrayBuffer(0x20000);
const mem = new Uint8Array(memory);
const dv = new DataView(memory);
const ctx = {
  getMemory: () => memory,
  exports: {
    get_image_base: () => IMAGE_BASE,
  },
};
const storage = createStorageImports(ctx);

function writeGuestString(guestAddr, value) {
  const wa = g2w(guestAddr, IMAGE_BASE);
  for (let i = 0; i < value.length; i++) mem[wa + i] = value.charCodeAt(i);
  mem[wa + value.length] = 0;
}

function writeGuestStringW(guestAddr, value) {
  const wa = g2w(guestAddr, IMAGE_BASE);
  for (let i = 0; i < value.length; i++) dv.setUint16(wa + i * 2, value.charCodeAt(i), true);
  dv.setUint16(wa + value.length * 2, 0, true);
}

function readGuestMultiString(guestAddr, isWide) {
  const wa = g2w(guestAddr, IMAGE_BASE);
  const values = [];
  let current = '';
  for (let i = 0; i < 512; i++) {
    const ch = isWide ? dv.getUint16(wa + i * 2, true) : mem[wa + i];
    if (ch) {
      current += String.fromCharCode(ch);
    } else if (current) {
      values.push(current);
      current = '';
    } else {
      break;
    }
  }
  return values;
}

function writeGuestU32(guestAddr, value) {
  dv.setUint32(g2w(guestAddr, IMAGE_BASE), value >>> 0, true);
}

function readGuestU32(guestAddr) {
  return dv.getUint32(g2w(guestAddr, IMAGE_BASE), true);
}

const subKeyGA = IMAGE_BASE + 0x1000;
const valueNameGA = IMAGE_BASE + 0x1100;
const valueGA = IMAGE_BASE + 0x1200;
const outGA = IMAGE_BASE + 0x1300;
const cbGA = IMAGE_BASE + 0x1400;
const phkGA = IMAGE_BASE + 0x1500;
const enumNameGA = IMAGE_BASE + 0x1900;
const enumNameLenGA = IMAGE_BASE + 0x1A00;
const enumTypeGA = IMAGE_BASE + 0x1B00;
const enumDataGA = IMAGE_BASE + 0x1C00;
const enumDataLenGA = IMAGE_BASE + 0x1D00;
const infoSubCountGA = IMAGE_BASE + 0x1E00;
const infoMaxSubKeyGA = IMAGE_BASE + 0x1E10;
const infoValueCountGA = IMAGE_BASE + 0x1E20;
const infoMaxValueNameGA = IMAGE_BASE + 0x1E30;
const infoMaxValueDataGA = IMAGE_BASE + 0x1E40;

writeGuestString(subKeyGA, 'Software\\WineAssemblyTest');
writeGuestString(valueNameGA, 'PlayerName');
writeGuestString(valueGA, 'Ada');

assert.strictEqual(storage.reg_create_key(0x80000001, g2w(subKeyGA, IMAGE_BASE), phkGA, 0), 0);
const hKey = readGuestU32(phkGA);
assert(hKey, 'reg_create_key should write a handle');

assert.strictEqual(storage.reg_set_value(hKey, g2w(valueNameGA, IMAGE_BASE), 1, valueGA, 4, 0), 0);
writeGuestU32(cbGA, 0);
assert.strictEqual(storage.reg_query_value(hKey, g2w(valueNameGA, IMAGE_BASE), 0, 0, cbGA, 0), 0);
assert.strictEqual(readGuestU32(cbGA), 4);

const rootHKey = storage.reg_open_key(0x80000001, 0, 0);
assert(rootHKey, 'predefined registry roots should open without a materialized root record');
writeGuestU32(enumNameLenGA, 64);
writeGuestU32(enumDataLenGA, 64);
assert.strictEqual(storage.reg_enum_value(
  hKey, 0, enumNameGA, enumNameLenGA, enumTypeGA, enumDataGA, enumDataLenGA, 0
), 0);
assert.strictEqual(readStrA(memory, g2w(enumNameGA, IMAGE_BASE)), 'PlayerName');
assert.strictEqual(readGuestU32(enumNameLenGA), 'PlayerName'.length);
assert.strictEqual(readGuestU32(enumTypeGA), 1);
assert.strictEqual(readStrA(memory, g2w(enumDataGA, IMAGE_BASE)), 'Ada');
assert.strictEqual(readGuestU32(enumDataLenGA), 4);
assert.strictEqual(storage.reg_query_info(
  hKey,
  infoSubCountGA,
  infoMaxSubKeyGA,
  infoValueCountGA,
  infoMaxValueNameGA,
  infoMaxValueDataGA,
  0
), 0);
assert.strictEqual(readGuestU32(infoSubCountGA), 0);
assert.strictEqual(readGuestU32(infoMaxSubKeyGA), 0);
assert.strictEqual(readGuestU32(infoValueCountGA), 1);
assert.strictEqual(readGuestU32(infoMaxValueNameGA), 'PlayerName'.length);
assert.strictEqual(readGuestU32(infoMaxValueDataGA), 4);

writeGuestU32(enumNameLenGA, 64);
assert.strictEqual(storage.reg_enum_key(0x80000002, 0, enumNameGA, 64, 0), 0);
assert.strictEqual(readStrA(memory, g2w(enumNameGA, IMAGE_BASE)).toLowerCase(), 'software');
writeGuestU32(cbGA, 32);
assert.strictEqual(storage.reg_query_value(hKey, g2w(valueNameGA, IMAGE_BASE), 0, outGA, cbGA, 0), 0);
assert.strictEqual(readStrA(memory, g2w(outGA, IMAGE_BASE)), 'Ada');
assert.strictEqual(readGuestU32(cbGA), 4);

setRegValue('HKCU\\ParentMaterialize\\Child\\Leaf', 'Enabled', 4, 7);
writeGuestString(subKeyGA, 'ParentMaterialize');
assert(storage.reg_open_key(0x80000001, g2w(subKeyGA, IMAGE_BASE), 0), 'setRegValue should create top-level parent registry keys');
writeGuestString(subKeyGA, 'ParentMaterialize\\Child\\Leaf');
const leafHKey = storage.reg_open_key(0x80000001, g2w(subKeyGA, IMAGE_BASE), 0);
assert(leafHKey, 'setRegValue should create parent registry keys so RegOpenKey can reach the leaf');
writeGuestString(valueNameGA, 'Enabled');
writeGuestU32(cbGA, 4);
assert.strictEqual(storage.reg_query_value(leafHKey, g2w(valueNameGA, IMAGE_BASE), 0, valueGA, cbGA, 0), 0);
assert.strictEqual(readGuestU32(valueGA), 7);

writeGuestString(subKeyGA, 'Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders');
const shellFoldersHKey = storage.reg_open_key(0x80000001, g2w(subKeyGA, IMAGE_BASE), 0);
assert(shellFoldersHKey, 'a stock Win98 profile exposes Explorer Shell Folders');

writeGuestString(subKeyGA, 'SOFTWARE\\Microsoft\\OLE');
assert(
  storage.reg_open_key(0x80000002, g2w(subKeyGA, IMAGE_BASE), 0),
  'a stock Win98 machine exposes the OLE policy key even when its optional values are absent'
);
writeGuestString(valueNameGA, 'Programs');
writeGuestU32(cbGA, 128);
assert.strictEqual(storage.reg_query_value(
  shellFoldersHKey, g2w(valueNameGA, IMAGE_BASE), 0, outGA, cbGA, 0
), 0);
assert.strictEqual(
  readStrA(memory, g2w(outGA, IMAGE_BASE)),
  'C:\\Windows\\Start Menu\\Programs',
  'installers can resolve the standard Win98 program-group directory'
);

writeGuestString(subKeyGA, 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders');
const commonShellFoldersHKey = storage.reg_open_key(0x80000002, g2w(subKeyGA, IMAGE_BASE), 0);
assert(commonShellFoldersHKey, 'a stock Win98 profile exposes machine-wide Explorer Shell Folders');
writeGuestString(valueNameGA, 'Common Desktop');
writeGuestU32(cbGA, 128);
assert.strictEqual(storage.reg_query_value(
  commonShellFoldersHKey, g2w(valueNameGA, IMAGE_BASE), 0, outGA, cbGA, 0
), 0);
assert.strictEqual(
  readStrA(memory, g2w(outGA, IMAGE_BASE)),
  'C:\\Windows\\All Users\\Desktop',
  'stock SHELL32 can resolve CSIDL_COMMON_DESKTOPDIRECTORY while constructing the desktop folder'
);

writeGuestString(subKeyGA, 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders');
const commonUserShellFoldersHKey = storage.reg_open_key(0x80000002, g2w(subKeyGA, IMAGE_BASE), 0);
assert(commonUserShellFoldersHKey, 'the installed Win98 profile exposes machine-wide User Shell Folders');
writeGuestU32(cbGA, 128);
assert.strictEqual(storage.reg_query_value(
  commonUserShellFoldersHKey, g2w(valueNameGA, IMAGE_BASE), 0, outGA, cbGA, 0
), 0);
assert.strictEqual(
  readStrA(memory, g2w(outGA, IMAGE_BASE)),
  'C:\\Windows\\All Users\\Desktop',
  'SHELL32 can populate its cached common-desktop PIDL before fallback writes occur'
);

writeGuestString(subKeyGA, 'Directory');
assert(
  storage.reg_open_key(0x80000000, g2w(subKeyGA, IMAGE_BASE), 0),
  'stock SHELL32 can classify filesystem PIDLs through the installed Directory class'
);

for (const clsid of [
  '{20D04FE0-3AEA-1069-A2D8-08002B30309D}',
  '{F3364BA0-65B9-11CE-A9BA-00AA004AE837}',
]) {
  writeGuestString(subKeyGA, 'CLSID\\' + clsid + '\\InprocServer32');
  const shellNamespaceHKey = storage.reg_open_key(0x80000000, g2w(subKeyGA, IMAGE_BASE), 0);
  assert(shellNamespaceHKey, 'stock Win98 SHELL32 namespace class ' + clsid + ' should be registered');
  writeGuestU32(cbGA, 128);
  assert.strictEqual(storage.reg_query_value(shellNamespaceHKey, 0, 0, outGA, cbGA, 0), 0);
  assert.strictEqual(
    readStrA(memory, g2w(outGA, IMAGE_BASE)).toLowerCase(),
    'c:\\windows\\system\\shell32.dll'
  );
}

writeGuestString(subKeyGA, 'CLSID\\{E7E4BC40-E76A-11CE-A9BB-00AA004AE837}\\InprocServer32');
const shdocvwFilesystemBinderHKey = storage.reg_open_key(0x80000000, g2w(subKeyGA, IMAGE_BASE), 0);
assert(shdocvwFilesystemBinderHKey, 'stock Win98 SHDOCVW filesystem binder should be registered');
writeGuestU32(cbGA, 128);
assert.strictEqual(storage.reg_query_value(shdocvwFilesystemBinderHKey, 0, 0, outGA, cbGA, 0), 0);
assert.strictEqual(
  readStrA(memory, g2w(outGA, IMAGE_BASE)).toLowerCase(),
  'c:\\windows\\system\\shdocvw.dll'
);

writeGuestString(subKeyGA, 'CLSID\\{AF604EFE-8897-11D1-B944-00A0C90312E1}\\InprocServer32');
const shdoc401HKey = storage.reg_open_key(0x80000000, g2w(subKeyGA, IMAGE_BASE), 0);
assert(shdoc401HKey, 'stock Win98 BROWSEUI desktop class should be registered');
writeGuestU32(cbGA, 128);
assert.strictEqual(storage.reg_query_value(shdoc401HKey, 0, 0, outGA, cbGA, 0), 0);
assert.strictEqual(
  readStrA(memory, g2w(outGA, IMAGE_BASE)).toLowerCase(),
  'c:\\windows\\system\\browseui.dll'
);
writeGuestString(subKeyGA, 'CLSID\\{A5E46E3A-8849-11D1-9D8C-00C04FC99D61}\\InprocServer32');
const shdocvwDesktopHKey = storage.reg_open_key(0x80000000, g2w(subKeyGA, IMAGE_BASE), 0);
assert(shdocvwDesktopHKey, 'stock Win98 SHDOCVW desktop view class should be registered');
writeGuestU32(cbGA, 128);
assert.strictEqual(storage.reg_query_value(shdocvwDesktopHKey, 0, 0, outGA, cbGA, 0), 0);
assert.strictEqual(
  readStrA(memory, g2w(outGA, IMAGE_BASE)).toLowerCase(),
  'c:\\windows\\system\\shdocvw.dll'
);
writeGuestString(subKeyGA, 'CLSID\\{ECD4FC4D-521C-11D0-B792-00A0C90312E1}\\InprocServer32');
const browseuiDesktopBandHKey = storage.reg_open_key(0x80000000, g2w(subKeyGA, IMAGE_BASE), 0);
assert(browseuiDesktopBandHKey, 'stock Win98 BROWSEUI desktop-band class should be registered');
writeGuestU32(cbGA, 128);
assert.strictEqual(storage.reg_query_value(browseuiDesktopBandHKey, 0, 0, outGA, cbGA, 0), 0);
assert.strictEqual(
  readStrA(memory, g2w(outGA, IMAGE_BASE)).toLowerCase(),
  'c:\\windows\\system\\browseui.dll'
);

const iniSectionGA = IMAGE_BASE + 0x1600;
const iniKeyGA = IMAGE_BASE + 0x1700;
const iniFileGA = IMAGE_BASE + 0x1800;
writeGuestString(iniSectionGA, 'intl');
writeGuestString(iniKeyGA, 'iCDateCount');
writeGuestString(iniFileGA, 'win.ini');
setIniValue('win.ini', 'intl', 'iCDateCount', -1);
assert.strictEqual(
  storage.ini_get_int(
    g2w(iniSectionGA, IMAGE_BASE),
    g2w(iniKeyGA, IMAGE_BASE),
    0,
    g2w(iniFileGA, IMAGE_BASE),
    0
  ),
  -1,
  'setIniValue should seed app startup INI values'
);

writeGuestString(iniSectionGA, 'MCI');
writeGuestString(iniFileGA, 'SYSTEM.INI');
assert(storage.ini_get_string(
  g2w(iniSectionGA, IMAGE_BASE), 0, 0, outGA, 128,
  g2w(iniFileGA, IMAGE_BASE), 0
) > 0);
assert.deepStrictEqual(
  readGuestMultiString(outGA, false).sort(),
  ['sequencer', 'waveaudio'],
  'system.ini should enumerate only supported MCI driver types'
);

setIniValue('system.ini', 'MCI', 'WaveAudio', 'custom-wave.drv');
writeGuestStringW(iniSectionGA, 'mci');
writeGuestStringW(iniKeyGA, 'WAVEAUDIO');
writeGuestStringW(iniFileGA, 'system.ini');
assert.strictEqual(storage.ini_get_string(
  g2w(iniSectionGA, IMAGE_BASE), g2w(iniKeyGA, IMAGE_BASE), 0,
  outGA, 128, g2w(iniFileGA, IMAGE_BASE), 1
), 'custom-wave.drv'.length);
assert.strictEqual(
  require('../lib/mem-utils').readStrW(memory, g2w(outGA, IMAGE_BASE)),
  'custom-wave.drv',
  'INI section/key lookup should be case-insensitive and preserve overrides'
);

writeGuestStringW(iniSectionGA, 'mci extensions');
writeGuestStringW(iniFileGA, 'WIN.INI');
assert(storage.ini_get_string(
  g2w(iniSectionGA, IMAGE_BASE), 0, 0, outGA, 128,
  g2w(iniFileGA, IMAGE_BASE), 1
) > 0);
assert.deepStrictEqual(
  readGuestMultiString(outGA, true).sort(),
  ['mid', 'midi', 'rmi', 'wav'],
  'win.ini should enumerate the media extensions backed by emulator MCI devices'
);

// COM formats GUIDs with lowercase hex while setup manifests commonly use
// uppercase. The activation lookup must use the same case-insensitive key
// semantics as RegOpenKeyEx.
const comMemory = new ArrayBuffer(0x400);
const comDv = new DataView(comMemory);
const clsidWA = 0x100;
const iidWA = 0x120;
comDv.setUint32(clsidWA, 0xECD4FC4D, true);
comDv.setUint16(clsidWA + 4, 0x521C, true);
comDv.setUint16(clsidWA + 6, 0x11D0, true);
new Uint8Array(comMemory).set([0xB7, 0x92, 0x00, 0xA0, 0xC9, 0x03, 0x12, 0xE1], clsidWA + 8);
comDv.setUint32(iidWA, 0, true); // IID_IUnknown
new Uint8Array(comMemory).set([0xC0, 0, 0, 0, 0, 0, 0, 0x46], iidWA + 8);
setRegValue(
  'HKCR\\CLSID\\{ECD4FC4D-521C-11D0-B792-00A0C90312E1}\\InprocServer32',
  '', 1, 'C:\\WINDOWS\\SYSTEM\\BROWSEUI.DLL'
);
const comStorage = createStorageImports({ getMemory: () => comMemory });
assert.strictEqual(
  comStorage.com_create_instance(clsidWA, 0, 1, iidWA, 0) >>> 0,
  0x80004005,
  'COM activation should find mixed-case CLSID registry paths before checking the loader'
);
const factory = 0x12345678;
const factoryOut = 0x140;
const cookie = comStorage.com_register_class_object(clsidWA, factory, 5, 1) >>> 0;
assert(cookie, 'CoRegisterClassObject host state issues a nonzero cookie');
assert.strictEqual(
  comStorage.com_create_instance(clsidWA, 0, 0x80000001, iidWA, factoryOut),
  0,
  'CoGetClassObject resolves a process-registered guest class factory'
);
assert.strictEqual(comDv.getUint32(factoryOut, true), factory,
  'registered class-factory pointers survive until activation');
assert.strictEqual(comStorage.com_revoke_class_object(cookie), 0,
  'CoRevokeClassObject removes the matching registration cookie');

console.log('PASS  registry REG_SZ stores guest strings through g2w');
console.log('PASS  setRegValue materializes parent registry keys');
console.log('PASS  Win98 Explorer Shell Folders expose the program-group directory');
console.log('PASS  registry roots, subkeys, and values enumerate with Win32 buffer semantics');
console.log('PASS  RegQueryInfoKey-style registry metadata reports counts and max lengths');
console.log('PASS  app startup INI values are visible to profile APIs');
console.log('PASS  system.ini exposes supported MCI drivers with case-insensitive overrides');
console.log('PASS  win.ini exposes the supported Media Player file extensions');
console.log('PASS  COM activation resolves CLSID registry paths case-insensitively');
console.log('PASS  process-registered COM class factories resolve and revoke by cookie');
