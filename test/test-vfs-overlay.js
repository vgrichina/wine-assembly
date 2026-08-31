#!/usr/bin/env node
// Writable C:\ overlay — phase ⑤ of docs/design-byo-media.md.
//
// Every case here is one line of that doc's "Overlay semantics" section:
// copy-on-write over a mounted base file (both branches), create, delete as a
// whiteout that enumeration honours, rename, the read-only-drive rule, and a
// hydration round trip that is byte-exact through the on-disk Node store.
//
// No emulator: this is the VFS and the two lib/ files, so it runs in a second
// and a failure names the rule it broke rather than an app that stopped.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { VirtualFS } = require('../lib/filesystem');
const VfsOverlay = require('../lib/vfs-overlay');
const { memoryStore, nodeDirStore, assertStore } = require('../lib/overlay-store');
const byteProvider = require('../lib/byte-provider');

const GENERIC_WRITE = 0x40000000;
const GENERIC_READ = 0x80000000;
const CREATE_ALWAYS = 2;
const OPEN_EXISTING = 3;

let failures = 0;
const cases = [];
function test(name, fn) { cases.push({ name, fn }); }

function bytes(text) { return new Uint8Array(Buffer.from(text, 'latin1')); }
function text(data) { return Buffer.from(data).toString('latin1'); }

function writeGuestFile(vfs, guestPath, contents) {
  const handle = vfs.createFile(guestPath, GENERIC_WRITE, CREATE_ALWAYS);
  assert.ok(handle, `createFile(${guestPath}) failed`);
  const data = bytes(contents);
  const result = vfs.writeFile(handle, data, data.length);
  assert.ok(result.ok, `writeFile(${guestPath}) failed`);
  vfs.closeHandle(handle);
  return handle;
}

function enumerate(vfs, pattern) {
  const first = vfs.findFirstFile(pattern);
  if (!first.handle) return [];
  const names = [first.entry.name];
  for (;;) {
    const next = vfs.findNextFile(first.handle);
    if (!next) break;
    names.push(next.name);
  }
  vfs.findClose(first.handle);
  return names.filter(n => n !== '.' && n !== '..');
}

// A base "mount": a zip/ISO-style provider-backed entry, exactly as
// lib/zip-mount.js and lib/iso9660.js create them. Deliberately async-only —
// no `readRangeSync` — because that is the shape of every interesting source
// (a remote Range read, an OPFS handle on the main thread) and the only one
// where copy-on-write has a question to answer.
class AsyncOnlyProvider {
  constructor(data, name) {
    this.bytes = data;
    this.size = data.length;
    this.name = name;
  }
  readRange(off, len) {
    return Promise.resolve(this.bytes.subarray(off, Math.min(this.size, off + len)));
  }
  close() {}
}

function mountProviderFile(vfs, guestPath, contents) {
  const provider = new AsyncOnlyProvider(bytes(contents), guestPath);
  return vfs.setProviderFile(guestPath, {
    provider: byteProvider.cached(provider), attrs: 0x20,
  });
}

// ---------------------------------------------------------------- semantics

test('store interface is validated at attach, not at eviction time', () => {
  assert.throws(() => assertStore({ list() {}, read() {} }, 'x'), /missing writeBatch/);
  assert.throws(() => VfsOverlay.attach(new VirtualFS(), { store: {} }), /missing list/);
});

test('create, modify and delete are journalled as file/whiteout records', async () => {
  const vfs = new VirtualFS();
  const store = memoryStore();
  const overlay = VfsOverlay.attach(vfs, { store });

  writeGuestFile(vfs, 'C:\\keep.txt', 'hello');
  vfs.createDirectory('C:\\sub');
  writeGuestFile(vfs, 'C:\\sub\\gone.txt', 'temporary');
  assert.ok(vfs.deleteFile('C:\\sub\\gone.txt'));

  const report = await overlay.flush();
  assert.strictEqual(report.failed, 0, JSON.stringify(report.errors));
  const records = await store.list();
  const byPath = new Map(records.map(r => [r.path, r]));
  assert.strictEqual(byPath.get('c:\\keep.txt').kind, 'file');
  assert.strictEqual(byPath.get('c:\\keep.txt').size, 5);
  assert.strictEqual(byPath.get('c:\\sub').kind, 'dir');
  assert.strictEqual(byPath.get('c:\\sub\\gone.txt').kind, 'whiteout',
    'a deleted file must be recorded as a whiteout, not simply forgotten');
});

test('a whiteout survives re-mounting the base: enumeration does not resurrect it', async () => {
  const store = memoryStore();

  const first = new VirtualFS();
  mountProviderFile(first, 'C:\\game\\data.dat', 'from the archive');
  mountProviderFile(first, 'C:\\game\\readme.txt', 'read me');
  const overlay = VfsOverlay.attach(first, { store });
  assert.deepStrictEqual(enumerate(first, 'C:\\game\\*').sort(),
    ['data.dat', 'readme.txt']);
  assert.ok(first.deleteFile('C:\\game\\readme.txt'));
  await overlay.flush();

  // Second process: the base mount runs again, then the overlay replays.
  const second = new VirtualFS();
  mountProviderFile(second, 'C:\\game\\data.dat', 'from the archive');
  mountProviderFile(second, 'C:\\game\\readme.txt', 'read me');
  const replay = VfsOverlay.attach(second, { store });
  const report = await replay.hydrate();
  assert.strictEqual(report.whiteouts, 1);
  assert.deepStrictEqual(enumerate(second, 'C:\\game\\*'), ['data.dat'],
    'FindFirstFile over the re-mounted base resurrected a deleted file');
  assert.strictEqual(second.getFileAttributes('C:\\game\\readme.txt'), 0xFFFFFFFF);
});

test('copy-on-write over a resident base file keeps the base mount intact', async () => {
  const store = memoryStore();
  const first = new VirtualFS();
  mountProviderFile(first, 'C:\\game\\config.ini', 'volume=5');
  // Case 1 of the doc's three: pre-materialized, so the bytes are resident.
  await first.materialize('C:\\game\\config.ini');
  const overlay = VfsOverlay.attach(first, { store });
  writeGuestFile(first, 'C:\\game\\config.ini', 'volume=9');
  await overlay.flush();

  const second = new VirtualFS();
  mountProviderFile(second, 'C:\\game\\config.ini', 'volume=5');
  const replay = VfsOverlay.attach(second, { store });
  await replay.hydrate();
  const entry = second.files.get('c:\\game\\config.ini');
  assert.strictEqual(text(entry.data), 'volume=9',
    'the overlay copy must win over the base mount');
});

test('an unresident provider file opened for write fails loudly, not silently', () => {
  const vfs = new VirtualFS();
  mountProviderFile(vfs, 'C:\\game\\big.dat', 'x'.repeat(64));
  const overlay = VfsOverlay.attach(vfs, { store: memoryStore() });
  // Case 2: nothing has filled the chunk cache, so CreateFile-for-write has no
  // synchronous way to copy on write and must not pretend otherwise.
  const handle = vfs.createFile('C:\\game\\big.dat', GENERIC_WRITE, OPEN_EXISTING);
  assert.strictEqual(handle, 0, 'the open must fail rather than park or truncate');
  assert.strictEqual(overlay.lastError, VfsOverlay.ERROR_NOT_READY);
  assert.strictEqual(overlay.errors.length, 1);
  assert.match(overlay.errors[0].message, /materialize/);
  // Read-only opens of the same file are unaffected.
  const reader = vfs.createFile('C:\\game\\big.dat', GENERIC_READ, OPEN_EXISTING);
  assert.ok(reader, 'a read-only open of a lazy entry must still succeed');
});

test('a read-only drive refuses every mutation with ERROR_WRITE_PROTECT', () => {
  const vfs = new VirtualFS();
  mountProviderFile(vfs, 'D:\\setup\\install.dat', 'disc');
  vfs.setDriveReadOnly('D', true);
  const overlay = VfsOverlay.attach(vfs, { store: memoryStore() });

  const refusals = [
    ['createFile', () => vfs.createFile('D:\\new.txt', GENERIC_WRITE, CREATE_ALWAYS)],
    ['deleteFile', () => vfs.deleteFile('D:\\setup\\install.dat')],
    ['createDirectory', () => vfs.createDirectory('D:\\newdir')],
    ['removeDirectory', () => vfs.removeDirectory('D:\\setup')],
    ['moveFile', () => vfs.moveFile('D:\\setup\\install.dat', 'D:\\moved.dat')],
    ['copyFile', () => vfs.copyFile('D:\\setup\\install.dat', 'D:\\copy.dat', 0)],
    ['setFileAttributes', () => vfs.setFileAttributes('D:\\setup\\install.dat', 0x80)],
  ];
  for (const [name, run] of refusals) {
    overlay.lastError = 0;
    vfs.lastFsError = 0;
    assert.ok(!run(), `${name} on a read-only drive must fail`);
    assert.strictEqual(overlay.lastError, VfsOverlay.ERROR_WRITE_PROTECT,
      `${name} did not latch ERROR_WRITE_PROTECT`);
    assert.strictEqual(vfs.lastFsError, VfsOverlay.ERROR_WRITE_PROTECT);
  }
  assert.deepStrictEqual(overlay.dirtyPaths(), [],
    'nothing on a read-only drive may enter the journal');
});

test('rename records the whiteout and the create in one batch', async () => {
  const store = memoryStore();
  const first = new VirtualFS();
  const overlay = VfsOverlay.attach(first, { store });
  writeGuestFile(first, 'C:\\notes.txt', 'draft');
  assert.ok(first.moveFile('C:\\notes.txt', 'C:\\final.txt'));
  await overlay.flush();

  const second = new VirtualFS();
  await VfsOverlay.attach(second, { store }).hydrate();
  assert.deepStrictEqual(enumerate(second, 'C:\\*.txt'), ['final.txt']);
  assert.strictEqual(text(second.files.get('c:\\final.txt').data), 'draft');
});

test('paths are journalled under VirtualFS normalization, case-folded once', async () => {
  const store = memoryStore();
  const first = new VirtualFS();
  const overlay = VfsOverlay.attach(first, { store });
  writeGuestFile(first, 'C:\\Docs\\Mixed Case.TXT', 'one');
  // The same file under a different spelling must update the same record.
  writeGuestFile(first, 'c:/docs/./mixed case.txt', 'two');
  await overlay.flush();
  const records = await store.list();
  const files = records.filter(r => r.kind === 'file');
  assert.strictEqual(files.length, 1, 'two spellings produced two records');
  assert.strictEqual(files[0].path, 'c:\\docs\\mixed case.txt');

  const second = new VirtualFS();
  await VfsOverlay.attach(second, { store }).hydrate();
  assert.strictEqual(text(second.files.get('c:\\docs\\mixed case.txt').data), 'two');
});

// --------------------------------------------------------------- node store

test('the Node store round-trips a tree byte-exactly across processes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wine-overlay-'));
  const payloads = {
    'C:\\app\\app.exe': Buffer.alloc(3 * 1024 * 1024, 0xAB), // past the 2MB localStorage cap
    'C:\\app\\config.ini': Buffer.from('[Setup]\r\nDir=C:\\app\r\n', 'latin1'),
    'C:\\app\\data\\level.dat': Buffer.from([0, 1, 2, 253, 254, 255]),
  };

  const first = new VirtualFS();
  const overlay = VfsOverlay.attach(first, { store: nodeDirStore(dir) });
  for (const [guestPath, buffer] of Object.entries(payloads)) {
    const handle = first.createFile(guestPath, GENERIC_WRITE, CREATE_ALWAYS);
    assert.ok(handle, guestPath);
    const data = new Uint8Array(buffer);
    first.writeFile(handle, data, data.length);
    first.closeHandle(handle);
  }
  const report = await overlay.flush();
  assert.strictEqual(report.failed, 0, JSON.stringify(report.errors));
  assert.ok(fs.existsSync(path.join(dir, 'index.json')));

  // A brand new process: a new store object over the same directory.
  const second = new VirtualFS();
  const replay = VfsOverlay.attach(second, { store: nodeDirStore(dir) });
  const hydrated = await replay.hydrate();
  assert.strictEqual(hydrated.files, 3, JSON.stringify(replay.errors));
  assert.strictEqual(replay.errors.length, 0, JSON.stringify(replay.errors));
  for (const [guestPath, buffer] of Object.entries(payloads)) {
    const entry = second.files.get(second._resolvePath(guestPath));
    assert.ok(entry, `${guestPath} did not come back`);
    assert.ok(Buffer.from(entry.data).equals(buffer), `${guestPath} is not byte-exact`);
  }
  assert.ok(second.dirs.has('c:\\app\\data'),
    'hydration must recreate the parent directories the files need');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a short blob is reported, never mounted as a truncated file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wine-overlay-torn-'));
  const first = new VirtualFS();
  const overlay = VfsOverlay.attach(first, { store: nodeDirStore(dir) });
  writeGuestFile(first, 'C:\\torn.bin', 'abcdefghij');
  await overlay.flush();

  const blobs = fs.readdirSync(path.join(dir, 'blobs'));
  assert.strictEqual(blobs.length, 1);
  fs.writeFileSync(path.join(dir, 'blobs', blobs[0]), Buffer.from('abc'));

  const second = new VirtualFS();
  const replay = VfsOverlay.attach(second, { store: nodeDirStore(dir) });
  const report = await replay.hydrate();
  assert.strictEqual(report.files, 0);
  assert.strictEqual(replay.errors.length, 1);
  assert.match(replay.errors[0].message, /3 bytes, index says 10/);
  assert.ok(!second.files.has('c:\\torn.bin'),
    'a torn blob must not be mounted at all');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a failing store is held in errors, not swallowed', async () => {
  const vfs = new VirtualFS();
  const broken = {
    list: () => Promise.resolve([]),
    read: () => Promise.resolve(null),
    writeBatch: () => Promise.reject(new Error('QuotaExceededError')),
    remove: () => Promise.resolve(),
  };
  const overlay = VfsOverlay.attach(vfs, { store: broken });
  writeGuestFile(vfs, 'C:\\save.dat', 'progress');
  const report = await overlay.flush();
  assert.strictEqual(report.written, 0);
  assert.strictEqual(report.failed, 1);
  assert.match(overlay.errors[0].message, /QuotaExceededError/);
});

test('detach flushes and restores the original VirtualFS methods', async () => {
  const vfs = new VirtualFS();
  const store = memoryStore();
  const before = vfs.writeFile;
  const overlay = VfsOverlay.attach(vfs, { store });
  assert.notStrictEqual(vfs.writeFile, before);
  writeGuestFile(vfs, 'C:\\late.txt', 'flushed by detach');
  await overlay.detach();
  assert.strictEqual(vfs.writeFile, before);
  assert.strictEqual((await store.list()).length, 1);
});

(async () => {
  for (const { name, fn } of cases) {
    try {
      await fn();
      console.log(`PASS  ${name}`);
    } catch (error) {
      failures++;
      console.log(`FAIL  ${name}`);
      console.log(`      ${error && error.stack ? error.stack.split('\n').slice(0, 4).join('\n      ') : error}`);
    }
  }
  console.log(failures ? `\n${failures} failing` : `\nAll ${cases.length} overlay cases pass`);
  process.exit(failures ? 1 : 0);
})();
