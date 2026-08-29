// Unit tests for VirtualFS — findFirstFile, createFile basename fallback, path resolution
const assert = require('assert');

// VirtualFS is exported. It used not to be, and this file used to slice the
// class body out of the source and eval it -- which silently drops every
// module-level helper the class calls, so the day filesystem.js grew an
// entrySize() helper these tests started failing with "entrySize is not
// defined" against working code. Require the module.
const { VirtualFS, createFilesystemImports } = require('../lib/filesystem');

function makeVFS(files) {
  const vfs = new VirtualFS();
  for (const [key, size] of Object.entries(files)) {
    vfs.files.set(key, { data: new Uint8Array(size), attrs: 0x20 });
  }
  return vfs;
}

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  PASS: ${name}`); }
  catch (e) { failed++; console.log(`  FAIL: ${name} — ${e.message}`); }
}

console.log('VFS tests:');

test('standard Win98 shell folders exist before an installer runs', () => {
  const vfs = makeVFS({});
  assert(vfs.dirs.has('c:\\windows\\start menu'));
  assert(vfs.dirs.has('c:\\windows\\start menu\\programs'));
  assert(vfs.dirs.has('c:\\windows\\start menu\\programs\\startup'));
  assert(vfs.dirs.has('c:\\windows\\desktop'));
});

// --- findFirstFile ---

test('wildcard *.* in CWD finds files in c:\\', () => {
  const vfs = makeVFS({ 'c:\\foo.txt': 10, 'c:\\bar.dat': 20 });
  const r = vfs.findFirstFile('.\\*.*');
  assert(r.handle, 'should find files');
  assert((r.handle >>> 0) <= 0x7fffffff,
    'search handle must remain nonnegative for MSVCRT _findfirst');
});

test('wildcard *.* on different drive letter finds nothing', () => {
  const vfs = makeVFS({ 'c:\\foo.txt': 10 });
  const r = vfs.findFirstFile('D:\\*.*');
  assert(!r.handle, 'should not find files on D:');
});

test('exact drive-root lookup returns the existing root directory', () => {
  const vfs = makeVFS({ 'c:\\fall.exe': 10 });
  const r = vfs.findFirstFile('C:\\');
  assert(r.handle, 'a mounted drive root should be discoverable');
  assert.strictEqual(r.entry.attrs, 0x10);
});

test('manifest parent registration makes a non-C drive enumerable', () => {
  const vfs = makeVFS({ 'd:\\cd2\\data\\iwdcd.2': 1 });
  vfs.ensureParentDirs('D:\\CD2\\Data\\IWDCD.2');
  assert.strictEqual(vfs.setCurrentDirectory('D:\\'), true,
    'the mounted drive root must be a real directory');
  const root = vfs.findFirstFile('D:\\*.*');
  assert(root.handle, 'the mounted drive root must be enumerable');
  assert.strictEqual(root.entry.name, 'cd2');
  assert.strictEqual(root.entry.attrs, 0x10);
});

test('basename fallback finds file by name on wrong drive', () => {
  const vfs = makeVFS({ 'c:\\demoopen.ddv': 100 });
  const r = vfs.findFirstFile('D:\\abe\\demoopen.ddv');
  assert(r.handle, 'should find via basename fallback');
  assert.strictEqual(r.entry.name, 'demoopen.ddv');
});

test('exact lookup in an existing directory does not find a nested basename', () => {
  const vfs = makeVFS({
    'c:\\windows\\temp\\_istmp0.dir\\isuninst.exe': 314880,
  });
  vfs.dirs.add('c:\\windows\\temp\\_istmp0.dir');
  const r = vfs.findFirstFile('C:\\WINDOWS\\IsUninst.exe');
  assert(!r.handle, 'FindFirstFile must not recurse below an existing directory');
});

test('wildcard *.ddv finds only .ddv files', () => {
  const vfs = makeVFS({ 'c:\\a.ddv': 1, 'c:\\b.txt': 2, 'c:\\c.ddv': 3 });
  const r = vfs.findFirstFile('.\\*.ddv');
  assert(r.handle, 'should find .ddv files');
  // Enumerate all
  const names = [r.entry.name];
  let next;
  while ((next = vfs.findNextFile(r.handle))) names.push(next.name);
  assert.strictEqual(names.length, 2);
  assert(names.includes('a.ddv'));
  assert(names.includes('c.ddv'));
});

test('parent traversal clamps at drive root for sibling asset wildcards', () => {
  const vfs = makeVFS({ 'c:\\maps\\entry.dx': 10, 'c:\\maps\\training.dx': 20 });
  vfs.dirs.add('c:\\maps');
  const r = vfs.findFirstFile('..\\Maps\\*.dx');
  assert(r.handle, 'C:\\..\\Maps must resolve to C:\\Maps');
  const names = [r.entry.name];
  let next;
  while ((next = vfs.findNextFile(r.handle))) names.push(next.name);
  assert.deepStrictEqual(names, ['entry.dx', 'training.dx']);
});

test('relative missing subdir wildcard falls back to current directory', () => {
  const vfs = makeVFS({ 'c:\\armies_1.cpn': 1, 'c:\\readme.txt': 2, 'c:\\reigno_1.cpn': 3 });
  const r = vfs.findFirstFile('campaign\\*.cpn');
  assert(r.handle, 'should find flat campaign files');
  const names = [r.entry.name];
  let next;
  while ((next = vfs.findNextFile(r.handle))) names.push(next.name);
  assert.deepStrictEqual(names, ['armies_1.cpn', 'reigno_1.cpn']);
});

test('broad wildcard in a missing relative directory does not enumerate the root', () => {
  const vfs = makeVFS({ 'c:\\game.exe': 1, 'c:\\readme.txt': 2 });
  const r = vfs.findFirstFile('palettes\\*');
  assert(!r.handle, 'a missing palettes directory must not expose root entries');
});

test('absolute missing subdir wildcard does not use flat fallback', () => {
  const vfs = makeVFS({ 'c:\\armies_1.cpn': 1 });
  const r = vfs.findFirstFile('D:\\campaign\\*.cpn');
  assert(!r.handle, 'absolute wildcard should not fall back across drives');
});

test('case insensitive matching', () => {
  const vfs = makeVFS({ 'c:\\readme.txt': 5 });
  const r = vfs.findFirstFile('.\\README.TXT');
  assert(r.handle, 'should find case-insensitively');
});

// --- createFile basename fallback ---

test('createFile OPEN_EXISTING with wrong drive uses basename fallback', () => {
  const vfs = makeVFS({ 'c:\\level.lvl': 50 });
  const h = vfs.createFile('D:\\game\\level.lvl', 0x80000000, 3); // OPEN_EXISTING
  assert(h && h !== 0xFFFFFFFF, 'should open via basename fallback');
});

test('createFile OPEN_EXISTING without match returns error', () => {
  const vfs = makeVFS({ 'c:\\other.txt': 5 });
  const h = vfs.createFile('D:\\game\\level.lvl', 0x80000000, 3);
  assert(!h || h === -1 || h === null, 'should fail when file not found');
});

test('read-only drive permits reads and rejects every write path', () => {
  const vfs = makeVFS({ 'd:\\manual.hlp': 50 });
  vfs.dirs.add('d:');
  vfs.dirs.add('d:\\');
  vfs.setDriveReadOnly('D:');

  const readHandle = vfs.createFile('D:\\manual.hlp', 0x80000000, 3);
  assert(readHandle, 'existing file should remain readable');
  assert.strictEqual(vfs.getFileAttributes('D:\\manual.hlp'), 0x21,
    'immutable-media files advertise FILE_ATTRIBUTE_READONLY');
  assert.strictEqual(vfs.createFile('D:\\cache.tmp', 0x40000000, 2), 0,
    'CREATE_ALWAYS must fail');
  assert.strictEqual(vfs.createFile('D:\\manual.hlp', 0x40000000, 3), 0,
    'GENERIC_WRITE OPEN_EXISTING must fail');
  assert.deepStrictEqual(vfs.writeFile(readHandle, Uint8Array.of(1), 1),
    { ok: false, bytesWritten: 0 }, 'writes through a read handle must fail');
  assert.strictEqual(vfs.setFileAttributes('D:\\manual.hlp', 0x20), false);
  assert.strictEqual(vfs.deleteFile('D:\\manual.hlp'), false);
  assert.strictEqual(vfs.createDirectory('D:\\cache'), false);
  assert.strictEqual(vfs.removeDirectory('D:\\'), false);
  assert.strictEqual(vfs.moveFile('D:\\manual.hlp', 'C:\\manual.hlp'), false);
  assert.strictEqual(vfs.copyFile('D:\\manual.hlp', 'D:\\copy.hlp', false), false);

  vfs.setDriveReadOnly('D', false);
  assert(vfs.createFile('D:\\cache.tmp', 0x40000000, 2),
    'making the drive writable restores normal creation');
});

test('chunked writes grow capacity geometrically but expose exact file size', () => {
  const vfs = makeVFS({});
  const handle = vfs.createFile('C:\\cache\\data\\area.bif', 0x40000000, 2);
  assert(vfs.dirs.has('c:\\cache') && vfs.dirs.has('c:\\cache\\data'),
    'creating a nested cache file registers every parent directory');
  for (let chunk = 0; chunk < 4096; chunk++) {
    const data = new Uint8Array(257).fill(chunk & 0xff);
    assert.deepStrictEqual(vfs.writeFile(handle, data, data.length),
      { ok: true, bytesWritten: 257 });
  }
  const entry = vfs.files.get('c:\\cache\\data\\area.bif');
  assert.strictEqual(entry.data.length, 4096 * 257,
    'logical length must not expose spare capacity');
  assert(entry._capacityData.length >= entry.data.length);
  assert(entry._capacityData.length < entry.data.length * 2,
    'doubling keeps spare capacity bounded');
  assert.strictEqual(vfs.getFileSize(handle), entry.data.length);
  assert.strictEqual(entry.data[256], 0);
  assert.strictEqual(entry.data[257], 1);

  vfs.setFilePointer(handle, 100, 0);
  assert(vfs.setEndOfFile(handle));
  assert.strictEqual(entry.data.length, 100);
  vfs.setFilePointer(handle, 200, 0);
  assert(vfs.setEndOfFile(handle));
  assert.strictEqual(entry.data.length, 200);
  assert(entry.data.subarray(100).every(byte => byte === 0),
    'extending a truncated file zero-fills the restored range');
});

// --- path resolution ---

test('relative path resolves against CWD', () => {
  const vfs = new VirtualFS();
  assert.strictEqual(vfs._resolvePath('foo.txt'), 'c:\\foo.txt');
  vfs.dirs.add('c:\\game');
  assert.strictEqual(vfs.setCurrentDirectory('C:\\game'), true);
  assert.strictEqual(vfs._resolvePath('data.dat'), 'c:\\game\\data.dat');
});

test('setCurrentDirectory normalizes trailing backslash', () => {
  const vfs = new VirtualFS();
  vfs.dirs.add('c:\\game');
  assert.strictEqual(vfs.setCurrentDirectory('C:\\game\\'), true);
  assert.strictEqual(vfs.getCurrentDirectory(), 'c:\\game\\');
  assert.strictEqual(vfs.setCurrentDirectory('C:\\'), true);
  assert.strictEqual(vfs.getCurrentDirectory(), 'c:\\');
});

test('setCurrentDirectory rejects files and missing alias paths without changing CWD', () => {
  const vfs = makeVFS({ 'c:\\dialog.tlk': 16 });
  assert.strictEqual(vfs.setCurrentDirectory('C:\\dialog.tlk'), false,
    'an existing file is not a directory');
  assert.strictEqual(vfs.setCurrentDirectory('hd0:\\dialog.tlk'), false,
    'a failed application alias probe must not become the process directory');
  assert.strictEqual(vfs.getCurrentDirectory(), 'C:\\');
  assert.strictEqual(vfs.getFullPathName('.\\dialog.tlk'), 'C:\\dialog.tlk');
});

test('GetFullPathName rejects an empty filename instead of fabricating the drive', () => {
  const memory = new ArrayBuffer(0x1000);
  const bytes = new Uint8Array(memory);
  bytes.fill(0x5a, 0x200, 0x220);
  const imports = createFilesystemImports({ getMemory: () => memory });
  assert.strictEqual(imports.fs_get_full_path_name(0x100, 16, 0x200, 0, 1), 0);
  assert.strictEqual(bytes[0x200], 0x5a, 'failure must not replace the output with C:');
});

test('SearchPath finds an installed DLL in the Win98 system directory', () => {
  const memory = new ArrayBuffer(0x1000);
  const bytes = new Uint8Array(memory);
  const writeA = (addr, value) => {
    for (let i = 0; i < value.length; i++) bytes[addr + i] = value.charCodeAt(i);
    bytes[addr + value.length] = 0;
  };
  const vfs = makeVFS({ 'c:\\windows\\system\\shell32.dll': 64 });
  const imports = createFilesystemImports({ vfs, getMemory: () => memory });
  writeA(0x100, 'shell32.dll');
  assert.strictEqual(imports.fs_search_path(0, 0x100, 0, 260, 0x200, 0, 0), 29);
  assert.strictEqual(
    Buffer.from(bytes.subarray(0x200, 0x200 + 29)).toString('latin1').toLowerCase(),
    'c:\\windows\\system\\shell32.dll'
  );
});

// --- AbeDemo specific scenario ---

test('AbeDemo: wildcard scan after loading exe sibling files', () => {
  const vfs = new VirtualFS();
  const abeFiles = ['abedemo.exe', 'demoopen.ddv', 'gamebgn.ddv', 'r1p18p19.ddv',
    'r1p19p18.ddv', 'readme.txt', 'c1.lvl', 'r1.lvl', 's1.lvl'];
  for (const f of abeFiles) {
    vfs.files.set('c:\\' + f, { data: new Uint8Array(100), attrs: 0x20 });
  }
  // Game scans D:\abe\demoopen.ddv — should find via basename
  const r1 = vfs.findFirstFile('D:\\abe\\demoopen.ddv');
  assert(r1.handle, 'demoopen.ddv via basename fallback');

  // Game scans .\*.* — should find all files in c:\
  const r2 = vfs.findFirstFile('.\\*.*');
  assert(r2.handle, 'wildcard in CWD should find files');
  const names = [r2.entry.name];
  let next;
  while ((next = vfs.findNextFile(r2.handle))) names.push(next.name);
  assert(names.length >= 9, `expected >=9 files, got ${names.length}: ${names}`);

  // Game scans D:\*.* — should NOT find files (different drive)
  const r3 = vfs.findFirstFile('D:\\*.*');
  assert(!r3.handle, 'D:\\ wildcard should find nothing');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
