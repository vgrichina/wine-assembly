// Lazy (provider-backed) VFS entries — phase ① of docs/design-byo-media.md.
//
// The claim under test is a strong one: a file mounted through a byte provider
// must be indistinguishable from the same file mounted eagerly. Every check
// here is therefore a *comparison* against an eager mount of identical bytes
// rather than a hand-written expectation — a lazy path that quietly returns a
// short read is the failure mode that matters, and only a byte-for-byte
// comparison catches it.
//
// The second half covers the part the CLI would otherwise never exercise. A
// Node provider can read synchronously, so a headless run of a lazy mount
// never parks; `{sync: false}` takes that fast path away and forces the
// pending → fill → retry dance the browser always uses.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { VirtualFS } = require('../lib/filesystem');
const bp = require('../lib/byte-provider');

let passed = 0, failed = 0;
const async_tests = [];
function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      async_tests.push(r.then(
        () => { passed++; console.log(`  PASS: ${name}`); },
        e => { failed++; console.log(`  FAIL: ${name} — ${e.message}`); }));
      return;
    }
    passed++; console.log(`  PASS: ${name}`);
  } catch (e) { failed++; console.log(`  FAIL: ${name} — ${e.message}`); }
}

// A deterministic megabyte with no repeating period shorter than the file, so
// a read that lands at the wrong offset cannot accidentally match.
const SIZE = 1024 * 1024 + 4321;
const BYTES = new Uint8Array(SIZE);
{
  let x = 0x13579bdf;
  for (let i = 0; i < SIZE; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    BYTES[i] = (x >>> 16) & 0xff;
  }
}
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-lazy-'));
const FILE = path.join(TMP, 'media.dat');
fs.writeFileSync(FILE, BYTES);

const GUEST = 'C:\\GAME\\MEDIA.DAT';
const NORM = 'c:\\game\\media.dat';

function eagerVfs() {
  const vfs = new VirtualFS();
  vfs.files.set(NORM, { data: new Uint8Array(BYTES), attrs: 0x20 });
  vfs.ensureParentDirs(NORM);
  return vfs;
}

function lazyVfs(opts) {
  const vfs = new VirtualFS();
  const provider = new bp.NodeFileProvider(FILE, opts || {});
  vfs.setProviderFile(GUEST, { provider, attrs: 0x20 });
  return vfs;
}

// Read a whole file through the public handle API in `step`-sized chunks.
// Returns the concatenated bytes, or the first pending record encountered.
function readAll(vfs, step) {
  const h = vfs.createFile(GUEST, 0x80000000, 3);
  assert(h, 'createFile failed');
  const out = new Uint8Array(SIZE);
  let got = 0;
  for (;;) {
    const buf = new Uint8Array(step);
    const r = vfs.readFile(h, buf, step);
    if (r.pending) return { pending: r.pending, handle: h, got };
    assert(r.ok, 'readFile failed');
    if (!r.bytesRead) break;
    out.set(buf.subarray(0, r.bytesRead), got);
    got += r.bytesRead;
    assert(got <= SIZE, 'read past end of file');
  }
  vfs.closeHandle(h);
  return { bytes: out.subarray(0, got) };
}

console.log('Lazy VFS entry tests:');

test('mounting through a provider does not materialize the file', () => {
  const vfs = lazyVfs();
  const entry = vfs.files.get(NORM);
  assert(entry._provider, 'entry should carry a provider');
  assert.strictEqual(entry._size, SIZE);
  // Nothing has been read yet: the chunk cache is empty.
  assert.strictEqual(entry._provider.stats.fetches, 0,
    'mounting must not read any bytes');
});

test('GetFileSize / size fields agree with an eager mount', () => {
  const lazy = lazyVfs(), eager = eagerVfs();
  const hl = lazy.createFile(GUEST, 0x80000000, 3);
  const he = eager.createFile(GUEST, 0x80000000, 3);
  assert.strictEqual(lazy.getFileSize(hl), eager.getFileSize(he));
  assert.strictEqual(lazy.getFileSize(hl), SIZE);
  // Seeking to FILE_END must not need the bytes either.
  assert.strictEqual(lazy.setFilePointer(hl, 0, 2), eager.setFilePointer(he, 0, 2));
  assert.strictEqual(lazy.files.get(NORM)._provider.stats.fetches, 0,
    'size and seek must not pull any chunk in');
});

test('GetFileAttributes agrees with an eager mount', () => {
  assert.strictEqual(lazyVfs().getFileAttributes(GUEST),
    eagerVfs().getFileAttributes(GUEST));
});

test('FindFirstFile agrees with an eager mount', () => {
  const lazy = lazyVfs(), eager = eagerVfs();
  const l = lazy.findFirstFile('C:\\GAME\\*.DAT');
  const e = eager.findFirstFile('C:\\GAME\\*.DAT');
  assert(l.handle && e.handle, 'both mounts should find the file');
  assert.strictEqual(l.entry.name, e.entry.name);
  assert.strictEqual(l.entry.size, e.entry.size);
  assert.strictEqual(l.entry.size, SIZE);
  assert.strictEqual(lazy.findNextFile(l.handle), null);
  assert.strictEqual(lazy.files.get(NORM)._provider.stats.fetches, 0,
    'enumeration must not materialize the file');
});

for (const step of [1, 512, 4096, 300000, SIZE + 1]) {
  test(`ReadFile in ${step}-byte chunks is byte-for-byte the eager result`, () => {
    const lazyBytes = readAll(lazyVfs(), step).bytes;
    const eagerBytes = readAll(eagerVfs(), step).bytes;
    assert.strictEqual(lazyBytes.length, SIZE, 'lazy short read');
    assert.strictEqual(eagerBytes.length, SIZE, 'eager short read');
    assert(Buffer.compare(Buffer.from(lazyBytes), Buffer.from(eagerBytes)) === 0,
      'lazy bytes differ from eager bytes');
  });
}

test('a read that straddles a chunk boundary is contiguous', () => {
  const vfs = lazyVfs();
  const chunk = vfs.files.get(NORM)._provider.chunkSize;
  const h = vfs.createFile(GUEST, 0x80000000, 3);
  vfs.setFilePointer(h, chunk - 7, 0);
  const buf = new Uint8Array(21);
  const r = vfs.readFile(h, buf, 21);
  assert(r.ok && r.bytesRead === 21, 'straddling read failed');
  assert(Buffer.compare(Buffer.from(buf),
    Buffer.from(BYTES.subarray(chunk - 7, chunk + 14))) === 0,
    'straddling read returned the wrong bytes');
});

test('reading past EOF returns 0 bytes, not a failure', () => {
  const vfs = lazyVfs();
  const h = vfs.createFile(GUEST, 0x80000000, 3);
  vfs.setFilePointer(h, SIZE, 0);
  const r = vfs.readFile(h, new Uint8Array(16), 16);
  assert(r.ok, 'read at EOF should succeed');
  assert.strictEqual(r.bytesRead, 0);
});

test('the LRU bound keeps a big file from becoming resident', () => {
  const vfs = new VirtualFS();
  const provider = new bp.NodeFileProvider(FILE);
  // 4 chunks of 64KB resident: reading the whole file must evict, not grow.
  vfs.setProviderFile(GUEST, {
    provider: new bp.ChunkCache(provider, { chunkSize: 65536, maxChunks: 4, readAhead: 0 }),
  });
  const got = readAll(vfs, 4096).bytes;
  assert.strictEqual(got.length, SIZE);
  const cache = vfs.files.get(NORM)._provider;
  assert(cache._chunks.size <= 4, `resident chunks ${cache._chunks.size} exceeded the bound`);
  assert(cache.stats.fetches >= 16, 'the whole file should have been fetched in chunks');
});

test('writing to a lazy entry materializes it (copy-on-write)', () => {
  const vfs = lazyVfs();
  const h = vfs.createFile(GUEST, 0x40000000, 3);
  vfs.setFilePointer(h, 10, 0);
  vfs.writeFile(h, new Uint8Array([1, 2, 3]), 3);
  const entry = vfs.files.get(NORM);
  assert(!entry._provider, 'the provider should be dropped once written');
  assert.strictEqual(entry.data.length, SIZE, 'size must survive the copy');
  const expect = new Uint8Array(BYTES);
  expect.set([1, 2, 3], 10);
  assert(Buffer.compare(Buffer.from(entry.data), Buffer.from(expect)) === 0,
    'copy-on-write lost or reordered the original bytes');
});

test('TRUNCATE_EXISTING drops the provider without reading it', () => {
  const vfs = lazyVfs();
  const before = vfs.files.get(NORM)._provider;
  const h = vfs.createFile(GUEST, 0x40000000, 5);
  assert(h, 'truncating open failed');
  const entry = vfs.files.get(NORM);
  assert(!entry._provider, 'truncation should drop the provider');
  assert.strictEqual(entry.data.length, 0);
  assert.strictEqual(before.stats.fetches, 0, 'truncation must not read the file');
});

test('CopyFile off a lazy mount shares the provider instead of materializing', () => {
  const vfs = lazyVfs();
  assert(vfs.copyFile(GUEST, 'C:\\GAME\\COPY.DAT', false), 'copyFile failed');
  const copy = vfs.files.get('c:\\game\\copy.dat');
  assert(copy._provider, 'the copy should share the source provider');
  assert.strictEqual(copy._size, SIZE);
  assert.strictEqual(vfs.files.get(NORM)._provider.stats.fetches, 0,
    'copying must not pull the whole file in');
  // Independent all the same: writing to the copy must not touch the source.
  const h = vfs.createFile('C:\\GAME\\COPY.DAT', 0x40000000, 3);
  vfs.writeFile(h, new Uint8Array([9]), 1);
  assert(!copy._provider, 'the written copy should have materialized');
  assert(vfs.files.get(NORM)._provider, 'the source must still be lazy');
});

test('entry.data materializes a sync-capable provider', () => {
  const vfs = lazyVfs();
  const data = vfs.files.get(NORM).data;
  assert(Buffer.compare(Buffer.from(data), Buffer.from(BYTES)) === 0,
    'whole-file materialization returned the wrong bytes');
});

// ---- the async arm: pending → fill → retry ------------------------------

test('an async-only provider reports pending, never a short read', () => {
  const vfs = lazyVfs({ sync: false });
  const r = readAll(vfs, 4096);
  assert(r.pending, 'the first read should have parked');
  assert.strictEqual(r.got, 0, 'nothing should have been reported before the park');
  assert.strictEqual(r.pending.path, NORM);
  assert.strictEqual(r.pending.offset, 0);
  assert(r.pending.length > 0);
  // The file position must be untouched, so the retry is the same call.
  assert.strictEqual(vfs.handles.get(r.handle >>> 0).pos, 0);
});

test('a mid-file park rewinds nothing and resumes at the same offset', async () => {
  const vfs = lazyVfs({ sync: false });
  const h = vfs.createFile(GUEST, 0x80000000, 3);
  const buf = new Uint8Array(64);
  let r = vfs.readFile(h, buf, 64);
  assert(r.pending, 'expected a park');
  await vfs.fillPendingRead(r.pending);
  r = vfs.readFile(h, buf, 64);
  assert(r.ok && r.bytesRead === 64, 'the retried read should hit the cache');
  assert(Buffer.compare(Buffer.from(buf), Buffer.from(BYTES.subarray(0, 64))) === 0);
  // Now seek far away, into a chunk nothing has fetched, and park again.
  const far = 900000;
  vfs.setFilePointer(h, far, 0);
  r = vfs.readFile(h, buf, 64);
  assert(r.pending, 'a fresh chunk should park again');
  assert.strictEqual(r.pending.offset, far, 'the park should name the wanted offset');
  assert.strictEqual(vfs.handles.get(h >>> 0).pos, far, 'a park must not move the file pointer');
  await vfs.fillPendingRead(r.pending);
  r = vfs.readFile(h, buf, 64);
  assert(r.ok && r.bytesRead === 64);
  assert(Buffer.compare(Buffer.from(buf), Buffer.from(BYTES.subarray(far, far + 64))) === 0,
    'the retried read returned the wrong bytes');
});

test('driving the whole file through park/fill/retry matches the eager bytes',
  async () => {
    const vfs = lazyVfs({ sync: false });
    const h = vfs.createFile(GUEST, 0x80000000, 3);
    const out = new Uint8Array(SIZE);
    const step = 7777;
    let got = 0, parks = 0;
    for (;;) {
      const buf = new Uint8Array(step);
      const r = vfs.readFile(h, buf, step);
      if (r.pending) {
        parks++;
        assert(parks < 200, 'too many parks — fill is not satisfying the read');
        await vfs.fillPendingRead(r.pending);
        continue;
      }
      assert(r.ok, 'read failed');
      if (!r.bytesRead) break;
      out.set(buf.subarray(0, r.bytesRead), got);
      got += r.bytesRead;
    }
    assert.strictEqual(got, SIZE, 'short read across the park path');
    assert(Buffer.compare(Buffer.from(out), Buffer.from(BYTES)) === 0,
      'park/fill/retry produced different bytes than an eager mount');
    // One park per chunk, not one per ReadFile: ~4 chunks of 256KB, halved
    // again by read-ahead. The point of the cache is that this number stays
    // far below the 135 ReadFile calls it served.
    assert(parks <= 8, `expected a handful of parks, got ${parks}`);
  });

test('the host import reports pending separately from failure', () => {
  const { createFilesystemImports } = require('../lib/filesystem');
  const vfs = lazyVfs({ sync: false });
  // A 1MB scratch "guest" memory; g2w is identity-ish for this harness, which
  // is all the read path needs.
  const memory = new WebAssembly.Memory({ initial: 40 });
  const imports = createFilesystemImports({
    getMemory: () => memory.buffer,
    exports: { get_image_base: () => 0x400000 },
    vfs,
  });
  const GUEST_BASE = 0x400000; // maps to WASM 0x12000
  const handle = vfs.createFile(GUEST, 0x80000000, 3);
  const ok = imports.fs_read_file(handle, GUEST_BASE, 4096, 0);
  assert.strictEqual(ok, 0, 'a parked read must return 0 from fs_read_file');
  assert.strictEqual(imports.fs_read_pending(), 1,
    'fs_read_pending must distinguish a park from a failure');
  // A genuine failure (bad handle) must not look like a park.
  assert.strictEqual(imports.fs_read_file(0xdead, GUEST_BASE, 16, 0), 0);
  assert.strictEqual(imports.fs_read_pending(), 0,
    'a failed read must not report pending');
});

test('a provider whose fill rejects latches a read failure, not a park loop',
  async () => {
    let asked = 0;
    const broken = {
      size: SIZE,
      readRange() { asked++; return Promise.reject(new Error('network went away')); },
    };
    const vfs = new VirtualFS();
    vfs.setProviderFile(GUEST, { provider: broken });
    const h = vfs.createFile(GUEST, 0x80000000, 3);
    let r = vfs.readFile(h, new Uint8Array(64), 64);
    assert(r.pending, 'the first read should park');
    assert.strictEqual(await vfs.fillPendingRead(r.pending), false, 'fill should report failure');
    r = vfs.readFile(h, new Uint8Array(64), 64);
    assert(!r.ok && r.faulted, 'the retry must fail, not park again');
    assert.strictEqual(r.error, 30, 'ERROR_READ_FAULT');
    assert(asked > 0, 'the provider should actually have been asked');
  });

test('a fill that never satisfies the read gives up instead of spinning', () => {
  // Resolves, but hands back nothing — a provider lying about its size, or a
  // Range response the server truncated.
  const liar = { size: SIZE, readRange: () => Promise.resolve(new Uint8Array(0)) };
  const vfs = new VirtualFS();
  vfs.setProviderFile(GUEST, { provider: liar });
  const h = vfs.createFile(GUEST, 0x80000000, 3);
  let r;
  for (let i = 0; i < 6; i++) {
    r = vfs.readFile(h, new Uint8Array(64), 64);
    if (!r.pending) break;
    vfs.pendingRead = r.pending;   // what the host loop records before filling
  }
  assert(r && r.faulted, 'a read that never becomes servable must fault');
  assert.strictEqual(r.error, 30);
});

test('the pending record names the handle and position it belongs to', () => {
  const vfs = lazyVfs({ sync: false });
  const a = vfs.createFile(GUEST, 0x80000000, 3);
  const b = vfs.createFile(GUEST, 0x80000000, 3);
  assert(a !== b, 'two handles on one file');
  vfs.setFilePointer(b, 700000, 0);
  const ra = vfs.readFile(a, new Uint8Array(16), 16);
  const rb = vfs.readFile(b, new Uint8Array(16), 16);
  assert(ra.pending && rb.pending);
  assert.strictEqual(ra.pending.handle, a >>> 0);
  assert.strictEqual(rb.pending.handle, b >>> 0);
  assert.strictEqual(ra.pending.pos, 0);
  assert.strictEqual(rb.pending.pos, 700000);
});

test('an async-only provider raises a named error on a consumer that cannot wait',
  () => {
    const vfs = lazyVfs({ sync: false });
    assert.throws(() => vfs.files.get(NORM).data, /async-only provider/,
      'materializing an unfilled async provider must fail loudly');
  });

test('vfs.materialize pre-fills an async-only provider for those consumers',
  async () => {
    const vfs = lazyVfs({ sync: false });
    const data = await vfs.materialize(GUEST);
    assert(Buffer.compare(Buffer.from(data), Buffer.from(BYTES)) === 0);
    // And now the ordinary accessor works, as every non-ReadFile path needs.
    assert.strictEqual(vfs.files.get(NORM).data.length, SIZE);
  });

test('vfs.materialize streams files larger than the ChunkCache LRU bound',
  async () => {
    const bigSize = bp.DEFAULT_CHUNK_SIZE * (bp.DEFAULT_MAX_CHUNKS + 1) + 137;
    const requests = [];
    const byteAt = i => (Math.imul(i, 131) ^ (i >>> 8) ^ 0x5a) & 0xff;
    const provider = {
      size: bigSize,
      readRange(off, len) {
        requests.push({ off, len });
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) bytes[i] = byteAt(off + i);
        return Promise.resolve(bytes);
      },
    };
    const vfs = new VirtualFS();
    const guest = 'C:\\GAME\\LARGE.EXE';
    const norm = 'c:\\game\\large.exe';
    vfs.setProviderFile(guest, { provider });

    const data = await vfs.materialize(guest);
    assert.strictEqual(data.length, bigSize);
    for (let i = 0; i < data.length; i++) {
      if (data[i] !== byteAt(i)) assert.fail(`wrong byte at ${i}`);
    }
    assert(requests.length > 1, 'the whole file was requested as one cache-busting range');
    assert(Math.max(...requests.map(r => r.len)) <= 4 * 1024 * 1024,
      'materialization requests must stay bounded');
    assert.strictEqual(vfs.files.get(norm)._provider, null,
      'the completed file must become an ordinary eager entry');
    assert.strictEqual(vfs.files.get(norm).data, data,
      'ordinary consumers must receive the materialized bytes without another read');
  });

// ---- chunk cache unit checks --------------------------------------------

test('ChunkCache.tryRead returns null on a miss, never a partial buffer', () => {
  const cache = new bp.ChunkCache(
    { size: 1000, readRange: () => Promise.resolve(new Uint8Array(0)) },
    { chunkSize: 100 });
  assert.strictEqual(cache.tryRead(0, 10), null);
  assert.strictEqual(cache.stats.misses, 1);
});

test('SliceProvider windows a parent provider', async () => {
  const parent = new bp.BytesProvider(BYTES);
  const slice = new bp.SliceProvider(parent, 1000, 256);
  assert.strictEqual(slice.size, 256);
  assert(Buffer.compare(Buffer.from(slice.readRangeSync(0, 256)),
    Buffer.from(BYTES.subarray(1000, 1256))) === 0);
  assert(Buffer.compare(Buffer.from(await slice.readRange(16, 16)),
    Buffer.from(BYTES.subarray(1016, 1032))) === 0);
});

test('setProviderFile honours an offset/length window', () => {
  const vfs = new VirtualFS();
  vfs.setProviderFile('C:\\GAME\\ENTRY.BIN', {
    provider: new bp.BytesProvider(BYTES), offset: 4096, length: 300,
  });
  const h = vfs.createFile('C:\\GAME\\ENTRY.BIN', 0x80000000, 3);
  assert.strictEqual(vfs.getFileSize(h), 300);
  const buf = new Uint8Array(300);
  const r = vfs.readFile(h, buf, 300);
  assert(r.ok && r.bytesRead === 300);
  assert(Buffer.compare(Buffer.from(buf), Buffer.from(BYTES.subarray(4096, 4396))) === 0,
    'the window returned the wrong bytes');
  const tail = vfs.readFile(h, new Uint8Array(16), 16);
  assert(tail.ok && tail.bytesRead === 0, 'the window must end at its length');
});

Promise.all(async_tests).then(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
});
