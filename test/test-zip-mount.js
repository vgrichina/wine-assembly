#!/usr/bin/env node
// Read-only ZIP mount (docs/design-byo-media.md phase 2).
//
// The archive is built by the system `zip` at test time, then mounted into a
// real VirtualFS and read back through the same Win32 surface the guest uses:
// FindFirstFile/FindNextFile enumeration and CreateFile/ReadFile bytes. The
// unsupported-method path is checked too, because a silent guess there hands
// the guest garbage that looks like a decoder bug several thousand
// instructions later.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { VirtualFS } = require('../lib/filesystem');
const zipMount = require('../lib/zip-mount');
const { makeTestZip, makeRawZip, makeBadMethodZip } = require('./fixtures/make-test-zip');

const GENERIC_READ = 0x80000000;
const OPEN_EXISTING = 3;

// Read a whole file the way the guest does: CreateFile, then ReadFile in
// chunks. A provider-backed entry can answer `pending` instead of bytes — the
// same IO_WAIT the host turns into a yield — so this drives that loop too.
async function readWholeFile(vfs, guestPath, chunk) {
  const handle = vfs.createFile(guestPath, GENERIC_READ, OPEN_EXISTING);
  assert.ok(handle && handle !== 0xFFFFFFFF, `CreateFile failed for ${guestPath}`);
  const size = vfs.getFileSize(handle);
  const out = new Uint8Array(size);
  const step = chunk || size || 1;
  let pos = 0;
  let guard = 0;
  while (pos < size) {
    const want = Math.min(step, size - pos);
    const buf = new Uint8Array(want);
    const res = vfs.readFile(handle, buf, want);
    if (res.pending) {
      assert.ok(++guard < 10000, `read loop did not converge for ${guestPath}`);
      await vfs.fillPendingRead(res.pending);
      continue;
    }
    assert.ok(res.ok, `ReadFile failed for ${guestPath}`);
    assert.ok(res.bytesRead > 0, `ReadFile returned 0 bytes for ${guestPath}`);
    out.set(buf.subarray(0, res.bytesRead), pos);
    pos += res.bytesRead;
  }
  vfs.closeHandle(handle);
  return out;
}

function enumerate(vfs, pattern) {
  const found = [];
  const first = vfs.findFirstFile(pattern);
  if (!first || !first.handle || first.handle === 0xFFFFFFFF) return found;
  found.push(first.entry ? first.entry.name : first.name);
  let handle = first.handle;
  for (;;) {
    const next = vfs.findNextFile(handle);
    if (!next) break;
    found.push(next.name);
  }
  vfs.findClose(handle);
  return found;
}

function testCatalog(fixture) {
  const bytes = new Uint8Array(fs.readFileSync(fixture.zipPath));
  const entries = zipMount.readCatalogSync(bytes);
  const files = entries.filter(e => !e.isDirectory);
  assert.ok(files.length >= 4, `expected >=4 files, got ${files.length}`);

  const methods = new Set(files.map(e => e.method));
  assert.ok(methods.has(zipMount.METHOD_STORED), 'fixture must contain a stored entry');
  assert.ok(methods.has(zipMount.METHOD_DEFLATE), 'fixture must contain a deflated entry');

  // Every entry decodes to exactly its catalogued size and CRC — the same
  // check tools/zip-dir.js --check runs.
  for (const entry of files) {
    const data = zipMount.extractSync(bytes, entry);
    assert.strictEqual(data.length, entry.uncompressedSize, `size mismatch for ${entry.name}`);
    assert.strictEqual(zipMount.crc32(data), entry.crc, `CRC mismatch for ${entry.name}`);
  }

  const nonAscii = files.find(e => /[^\x00-\x7f]/.test(e.name));
  assert.ok(nonAscii, 'fixture must contain a non-ASCII entry name');

  // The wrapper folder every "compress this directory" zip carries.
  assert.strictEqual(zipMount.commonTopFolder(entries), fixture.top);
  console.log(`  catalog: ${files.length} files, methods {${[...methods].join(',')}}, ` +
    `non-ASCII name ${JSON.stringify(nonAscii.name)}`);
}

async function testMount(fixture) {
  const bytes = new Uint8Array(fs.readFileSync(fixture.zipPath));
  const vfs = new VirtualFS();
  const result = zipMount.mountZipSync(vfs, bytes, { zipPath: fixture.zipPath });

  assert.strictEqual(result.root, 'c:\\program files\\keen4\\');
  // The single top-level folder is unwrapped: no keen4\keen4\.
  assert.ok(!result.mounted.some(p => p.includes('keen4\\keen4')),
    `wrapper folder was not unwrapped: ${result.mounted.join(', ')}`);

  // Enumeration must not inflate anything: sizes come from the catalog.
  const names = enumerate(vfs, result.root + '*.*').map(n => n.toLowerCase());
  assert.ok(names.includes('readme.txt'), `README.TXT missing from ${names.join(', ')}`);
  assert.ok(names.includes('big.dat'), `BIG.DAT missing from ${names.join(', ')}`);
  assert.ok(names.includes('data'), `DATA subdirectory missing from ${names.join(', ')}`);

  const nested = enumerate(vfs, result.root + 'data\\*.*').map(n => n.toLowerCase());
  assert.ok(nested.includes('nested.dat'), `nested entry missing from ${nested.join(', ')}`);

  // Byte-exact reads, stored and deflated, through the guest's own path. The
  // small chunk size makes a multi-read file out of a small fixture, which is
  // what catches a mount that only works when the guest reads everything at
  // once.
  for (const file of fixture.files) {
    const guestPath = result.root + file.rel.replace(/\//g, '\\').toLowerCase();
    const got = await readWholeFile(vfs, guestPath, 1024);
    assert.deepStrictEqual(Buffer.from(got), file.data, `content mismatch for ${guestPath}`);
  }

  // Timestamps come from the archive, not from the clock: mounting the same
  // archive twice must give the same last-write time.
  const key = vfs._normPath(result.root + 'readme.txt');
  const second = new VirtualFS();
  zipMount.mountZipSync(second, bytes, { zipPath: fixture.zipPath });
  assert.deepStrictEqual(vfs.files.get(key).lastWriteTime,
    second.files.get(vfs._normPath(result.root + 'readme.txt')).lastWriteTime,
    'zip mounts must carry the archive timestamp, not the wall clock');

  // An explicit root overrides the default Program Files location.
  const custom = new VirtualFS();
  const custom2 = zipMount.mountZipSync(custom, bytes,
    { zipPath: fixture.zipPath, root: 'd:\\games\\keen' });
  assert.strictEqual(custom2.root, 'd:\\games\\keen\\');
  assert.ok(custom.files.has('d:\\games\\keen\\readme.txt'));

  console.log(`  mounted ${result.mounted.length} files at ${result.root}`);
}

async function testAsyncProviderMount(fixture) {
  const bytes = new Uint8Array(fs.readFileSync(fixture.zipPath));
  // The byte-provider interface from docs/design-byo-media.md: readRange only,
  // no random access to the whole buffer. Whatever lands here is what a File
  // slice or an HTTP Range read would supply.
  const reads = [];
  const provider = {
    size: bytes.length,
    async readRange(off, len) {
      reads.push([off, len]);
      return bytes.subarray(off, off + len);
    },
  };
  const vfs = new VirtualFS();
  const result = await zipMount.mountZip(vfs, provider, { zipPath: fixture.zipPath });
  assert.strictEqual(result.root, 'c:\\program files\\keen4\\');
  for (const file of fixture.files) {
    const guestPath = result.root + file.rel.replace(/\//g, '\\').toLowerCase();
    assert.deepStrictEqual(Buffer.from(await readWholeFile(vfs, guestPath, 4096)), file.data,
      `provider-mounted content mismatch for ${guestPath}`);
  }
  // Tail-first: the first read is the EOCD scan window at the end of the file.
  assert.strictEqual(reads[0][0] + reads[0][1], bytes.length,
    'the catalog read must start from the tail');
  console.log(`  provider mount: ${reads.length} range reads, first at tail`);
}

function testUnsupportedMethod() {
  const badPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wa-zip-bad-')), 'bad.zip');
  makeBadMethodZip(badPath, 9);
  const bytes = new Uint8Array(fs.readFileSync(badPath));

  // The catalog still parses — the refusal is about the data, not the shape.
  const entries = zipMount.readCatalogSync(bytes);
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].method, 9);

  assert.throws(() => zipMount.extractSync(bytes, entries[0]),
    /unsupported compression method 9/,
    'extracting an unknown method must fail loudly');
  assert.throws(() => zipMount.mountZipSync(new VirtualFS(), bytes, { zipPath: badPath }),
    /unsupported compression method 9/,
    'mounting an archive with an unknown method must fail before the guest sees it');

  // A non-zip is rejected with a message that says what was actually wrong.
  assert.throws(() => zipMount.readCatalogSync(new Uint8Array(1024)),
    /no end-of-central-directory/, 'a non-zip must be named as such');
  console.log('  unsupported method 9 and non-zip both rejected');
}

// An archive is untrusted input. Each of these is a hostile or corrupt shape
// that must produce a named failure rather than a mount.
function testHostileArchives() {
  const vfs = () => new VirtualFS();
  const mount = bytes => zipMount.mountZipSync(vfs(), bytes, { zipPath: 'hostile.zip' });

  // Zip Slip and its relatives: none of these may ever reach the VFS.
  const escapes = [
    ['../evil.txt', /escapes its mount root/],
    ['a/../../evil.txt', /escapes its mount root/],
    ['/etc/passwd', /absolute path/],
    ['D:\\evil.txt', /drive letter/],
    ['\\\\server\\share\\evil.txt', /UNC path/],
    ['CON', /reserved device name/],
    ['sub/NUL.txt', /reserved device name/],
  ];
  for (const [name, pattern] of escapes) {
    // Paired with an innocuous sibling so the archive still has a common
    // top-level folder to unwrap where one applies.
    assert.throws(() => mount(makeRawZip([{ name }, { name: 'ok.txt' }])), pattern,
      `hostile entry name ${JSON.stringify(name)} must be refused`);
  }

  // Two names that are one path to Win32.
  assert.throws(() => mount(makeRawZip([{ name: 'Setup.EXE' }, { name: 'setup.exe' }])),
    /both mount at/, 'case-folded duplicates must be refused, not silently merged');

  // A CRC that does not describe the bytes.
  const badCrc = makeRawZip([{ name: 'DATA.BIN', data: Buffer.from('real bytes'), crc: 0x12345678 }]);
  const entries = zipMount.readCatalogSync(badCrc);
  assert.throws(() => zipMount.extractSync(badCrc, entries[0]),
    /CRC32 .* does not match/, 'a wrong CRC must be reported as corruption');

  // A catalog that lies about how big an entry inflates to.
  const lying = makeRawZip([
    { name: 'LIAR.BIN', data: Buffer.from('four'), uncompressedSize: 4096 },
  ]);
  const lyingEntries = zipMount.readCatalogSync(lying);
  assert.throws(() => zipMount.extractSync(lying, lyingEntries[0]),
    /inflated 4 bytes, the catalog declares 4096/,
    'a size that disagrees with the payload must be reported');

  // Encrypted entries are refused by their general-purpose bit alone.
  assert.throws(() => mount(makeRawZip([{ name: 'SECRET.BIN', flags: 0x0001 }])),
    /encrypted/, 'an encrypted entry must be refused');
  assert.throws(() => mount(makeRawZip([{ name: 'MASKED.BIN', flags: 0x2000 }])),
    /masks its local header/, 'a masked local header must be refused');

  // Zip-bomb budget: a declared size over the per-entry cap never allocates.
  assert.throws(
    () => zipMount.mountZipSync(vfs(), makeRawZip([{ name: 'BIG.BIN' }]),
      { zipPath: 'hostile.zip', maxEntryBytes: 4 }),
    /over the 4-byte per-entry limit/, 'the per-entry cap must be enforced from the catalog');

  // And the whole-mount budget is charged where bytes are actually produced.
  const budgeted = new VirtualFS();
  const result = zipMount.mountZipSync(budgeted,
    makeRawZip([{ name: 'A.BIN', data: Buffer.alloc(64, 1) }]),
    { zipPath: 'hostile.zip', maxTotalBytes: 8, verifyStored: true });
  assert.throws(() => budgeted.files.get(result.mounted[0]).data,
    /materialization budget/, 'the mount budget must stop a lazy read too');

  console.log(`  ${escapes.length} escaping names, duplicates, bad CRC, lying size, ` +
    'encryption and both budgets all refused');
}

async function main() {
  const fixture = makeTestZip();
  if (!fixture) {
    console.log('SKIP: no system `zip` available to build the fixture');
    return;
  }
  try {
    console.log(`fixture: ${fixture.zipPath}`);
    testCatalog(fixture);
    await testMount(fixture);
    await testAsyncProviderMount(fixture);
    testUnsupportedMethod();
    testHostileArchives();
    console.log('PASS test-zip-mount');
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
}

main().catch(e => {
  console.error('FAIL test-zip-mount:', e.message);
  process.exit(1);
});
