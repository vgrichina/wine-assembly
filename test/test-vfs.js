// Unit tests for VirtualFS — findFirstFile, createFile basename fallback, path resolution
const path = require('path');
const fs = require('fs');
const assert = require('assert');

// Extract VirtualFS from filesystem.js (it's not exported, so we re-require the module source)
// The class is used internally by createFilesystemImports, but we can instantiate it directly
// by evaluating just the class definition.
const fsSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'filesystem.js'), 'utf8');
const classMatch = fsSource.match(/^class VirtualFS \{/m);
if (!classMatch) throw new Error('Cannot find VirtualFS class in filesystem.js');
const classStart = classMatch.index;
// Find matching closing brace
let depth = 0, classEnd = classStart;
for (let i = classStart; i < fsSource.length; i++) {
  if (fsSource[i] === '{') depth++;
  else if (fsSource[i] === '}') { depth--; if (depth === 0) { classEnd = i + 1; break; } }
}
const VirtualFS = new Function('return ' + fsSource.slice(classStart, classEnd))();

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

// --- findFirstFile ---

test('wildcard *.* in CWD finds files in c:\\', () => {
  const vfs = makeVFS({ 'c:\\foo.txt': 10, 'c:\\bar.dat': 20 });
  const r = vfs.findFirstFile('.\\*.*');
  assert(r.handle, 'should find files');
});

test('wildcard *.* on different drive letter finds nothing', () => {
  const vfs = makeVFS({ 'c:\\foo.txt': 10 });
  const r = vfs.findFirstFile('D:\\*.*');
  assert(!r.handle, 'should not find files on D:');
});

test('basename fallback finds file by name on wrong drive', () => {
  const vfs = makeVFS({ 'c:\\demoopen.ddv': 100 });
  const r = vfs.findFirstFile('D:\\abe\\demoopen.ddv');
  assert(r.handle, 'should find via basename fallback');
  assert.strictEqual(r.entry.name, 'demoopen.ddv');
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

// --- path resolution ---

test('relative path resolves against CWD', () => {
  const vfs = new VirtualFS();
  assert.strictEqual(vfs._resolvePath('foo.txt'), 'c:\\foo.txt');
  vfs.setCurrentDirectory('C:\\game');
  assert.strictEqual(vfs._resolvePath('data.dat'), 'c:\\game\\data.dat');
});

test('setCurrentDirectory normalizes trailing backslash', () => {
  const vfs = new VirtualFS();
  vfs.setCurrentDirectory('C:\\game\\');
  assert.strictEqual(vfs.getCurrentDirectory(), 'c:\\game\\');
  vfs.setCurrentDirectory('C:\\');
  assert.strictEqual(vfs.getCurrentDirectory(), 'c:\\');
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
