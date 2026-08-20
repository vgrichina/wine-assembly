// The two rules of VFS seeding that both hosts have to agree on: where an
// image finds itself, and what a Win16 module name can be spelled as on disk.
// Each was two copies before 2026-08-19, and a divergence in either shows up
// as "works in the browser, not in the CLI" with nothing in the failure that
// names a filename convention.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { seedExeImage, win16FileCandidates } = require('../lib/vfs-seed');

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL  ${name}: ${e.message}`);
  }
}

const ROOT = path.join(__dirname, '..');
const fakeVfs = () => ({ files: new Map(), dirs: new Set() });

console.log('=== vfs-seed ===');

check('the exe is reachable at the path GetModuleFileNameA reports', () => {
  const vfs = fakeVfs();
  seedExeImage(vfs, new Uint8Array([0x4d, 0x5a]), 'NOTEPAD.EXE');
  assert.ok(vfs.files.has('c:\\app.exe'), 'an app that opens its own reported path finds nothing');
  assert.ok(vfs.files.has('c:\\notepad.exe'), 'an app that remembers its own name finds nothing');
  assert.strictEqual(vfs.files.get('c:\\app.exe').data, vfs.files.get('c:\\notepad.exe').data,
    'both names must be the same bytes, not two copies');
  assert.strictEqual(vfs.files.get('c:\\app.exe').attrs, 0x20, 'FILE_ATTRIBUTE_ARCHIVE');
});

check('a launch path is reduced to its basename, lowercased', () => {
  const vfs = fakeVfs();
  const r = seedExeImage(vfs, new Uint8Array(4), '/host/dir/Sol.Exe');
  assert.strictEqual(r.base, 'sol.exe');
  assert.ok(vfs.files.has('c:\\sol.exe'), [...vfs.files.keys()].join(','));
  const win = seedExeImage(fakeVfs(), new Uint8Array(4), 'C:\\games\\HEARTS.EXE');
  assert.strictEqual(win.base, 'hearts.exe', 'a backslash path is a path too');
});

check('an exe already named app.exe is seeded once', () => {
  const vfs = fakeVfs();
  seedExeImage(vfs, new Uint8Array(4), 'APP.EXE');
  assert.deepStrictEqual([...vfs.files.keys()], ['c:\\app.exe']);
});

check('nothing to seed is not a throw', () => {
  assert.strictEqual(seedExeImage(null, new Uint8Array(4), 'a.exe'), null);
  assert.strictEqual(seedExeImage(fakeVfs(), null, 'a.exe'), null);
});

check('an ArrayBuffer of exe bytes is accepted as well as a view', () => {
  const vfs = fakeVfs();
  seedExeImage(vfs, new Uint8Array([1, 2, 3]).buffer, 'x.exe');
  assert.ok(vfs.files.get('c:\\app.exe').data instanceof Uint8Array);
  assert.strictEqual(vfs.files.get('c:\\app.exe').data.length, 3);
});

check('a Win16 module name is tried under all three spellings', () => {
  assert.deepStrictEqual(win16FileCandidates('CARDS'), ['CARDS.DLL', 'CARDS.dll', 'CARDS.EXE']);
});

// Both hosts must be calling this, not carrying their own copy — that is the
// entire point of the module, and a re-inlined literal would be invisible.
check('neither host still spells the candidates itself', () => {
  for (const f of ['host.js', 'test/run.js']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.ok(!/\$\{name\}\.DLL/.test(src), `${f} still builds its own Win16 candidate list`);
    assert.ok(!/files\.set\('c:\\\\app\.exe'/.test(src), `${f} still seeds the exe image itself`);
    assert.ok(/win16FileCandidates/.test(src) && /seedExeImage/.test(src),
      `${f} does not use lib/vfs-seed.js`);
  }
});

check('the page loads the module before host.js needs it', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const seed = html.indexOf('lib/vfs-seed.js');
  const host = html.indexOf('host.js');
  assert.ok(seed > 0, 'index.html never loads lib/vfs-seed.js — VfsSeed is undefined at launch');
  assert.ok(seed < host, 'vfs-seed.js must be loaded before host.js');
});

console.log(failures === 0 ? '\nAll vfs-seed checks passed' : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
