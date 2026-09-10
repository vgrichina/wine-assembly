#!/usr/bin/env node
// Save bundles: export, tamper rejection, import round trip, and a real sync
// round trip against tools/save-sync-server.js, which this test starts and
// stops itself.
//
// The round trip is asserted three ways on purpose. State-exact says the guest
// sees what it saw before; byte-exact says the *bundle writer* did not quietly
// drop a field the reader also ignores (a semantic comparison passes happily
// when both sides forget the same thing); and the tamper cases say the reader
// refuses input it should never act on.

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync, spawn } = require('child_process');

const { VirtualFS } = require('../lib/filesystem');
const saveBundle = require('../lib/save-bundle');
const saveSync = require('../lib/save-sync');
const storage = require('../lib/storage');
const zipMount = require('../lib/zip-mount');

const PATTERNS = ['c:\\save\\*.sav', 'c:\\ui\\uilst.ini'];
const APP_ID = 'diablo_shareware';
const CREATED = '2026-08-30T12:34:56.000Z';

let checks = 0;
function ok(condition, label) {
  assert.ok(condition, label);
  checks++;
}
function eq(actual, expected, label) {
  assert.deepStrictEqual(actual, expected, label);
  checks++;
}
function rejects(fn, re, label) {
  assert.throws(fn, re, label);
  checks++;
}

// --------------------------------------------------------------- fixtures

function seedVfs() {
  const vfs = new VirtualFS();
  const save = vfs.createFile('C:\\Save\\GAME00.sav', 0x40000000, 2);
  vfs.writeFile(save, Uint8Array.from([1, 2, 3, 4, 5]), 5);
  vfs.setFileTimes(save, null, null, { lo: 0x89abcdef, hi: 0x01bf53eb });
  const second = vfs.createFile('C:\\Save\\GAME01.sav', 0x40000000, 2);
  vfs.writeFile(second, Uint8Array.from([9, 8, 7]), 3);
  const ini = vfs.createFile('C:\\UI\\uilst.ini', 0x40000000, 2);
  vfs.writeFile(ini, Buffer.from('[ui]\nlast=1\n'), 12);
  // Not a save: outside every glob, so it must never reach a bundle.
  const scratch = vfs.createFile('C:\\TEMP\\scratch.tmp', 0x40000000, 2);
  vfs.writeFile(scratch, Uint8Array.from([0xff]), 1);
  return vfs;
}

function fileState(vfs) {
  const out = {};
  for (const [p, e] of vfs.files.entries()) {
    out[p] = {
      data: Array.from(e.data),
      attrs: e.attrs >>> 0,
      lastWriteTime: e.lastWriteTime || null,
    };
  }
  return out;
}

// ------------------------------------------------------------ export/import

function testProviderResidency() {
  const vfs = seedVfs();
  let reads = 0;
  const provider = {
    size: 4,
    readRange(off, len) {
      reads++;
      return Promise.resolve(Uint8Array.from([0xc0, 0xff, 0xee, 0x00]).subarray(off, off + len));
    },
  };
  const entry = vfs.setProviderFile('C:\\Save\\FROM_CD.sav', { provider });
  const cache = entry._provider;

  const untouched = saveBundle.exportBundle({
    appId: APP_ID, vfs, patterns: PATTERNS, createdAt: CREATED, commit: 'deadbeef',
  });
  const first = saveBundle.readBundle(untouched);
  ok(!first.files.some(file => file.path === 'c:\\save\\from_cd.sav'),
    'an unresident provider-backed glob match is skipped');
  eq(reads, 0, 'save export does not fetch mounted content');
  ok(entry._provider === cache, 'save export leaves provider residency unchanged');

  // The VFS data setter is its copy-on-write boundary. Once a guest write has
  // replaced the provider, the same path is state and must no longer be
  // skipped merely because its property is still implemented by an accessor.
  entry.data = Uint8Array.from([7, 6, 5, 4]);
  const written = saveBundle.readBundle(saveBundle.exportBundle({
    appId: APP_ID, vfs, patterns: PATTERNS, createdAt: CREATED, commit: 'deadbeef',
  }));
  const saved = written.files.find(file => file.path === 'c:\\save\\from_cd.sav');
  ok(!!saved, 'a provider path becomes bundlable after copy-on-write');
  eq(Array.from(saved.data), [7, 6, 5, 4], 'the guest-written bytes are bundled');
}

function testExportShape() {
  const vfs = seedVfs();
  storage.setRegValue('HKCU\\Software\\Test\\Saves', 'Slot', 4, 7);
  storage.setIniValue('game.ini', 'Video', 'Mode', '640x480');

  const bytes = saveBundle.exportBundle({
    appId: APP_ID, vfs, patterns: PATTERNS, createdAt: CREATED, commit: 'deadbeef',
  });
  ok(bytes instanceof Uint8Array && bytes.length > 0, 'export produces bytes');
  eq([bytes[0], bytes[1]], [0x50, 0x4b], 'a bundle is a zip');

  const parsed = saveBundle.readBundle(bytes);
  eq(parsed.manifest.appId, APP_ID, 'manifest names the app');
  eq(parsed.manifest.createdAt, CREATED, 'manifest carries createdAt');
  eq(parsed.manifest.emulator.commit, 'deadbeef', 'manifest carries the emulator commit');
  eq(parsed.files.map(f => f.path).sort(),
    ['c:\\save\\game00.sav', 'c:\\save\\game01.sav', 'c:\\ui\\uilst.ini'],
    'only persistFiles matches are bundled');
  ok(!parsed.files.some(f => f.path.includes('scratch')),
    'a file outside the globs is not in the bundle');
  eq(Array.from(parsed.files.find(f => f.path.endsWith('game00.sav')).data),
    [1, 2, 3, 4, 5], 'save bytes survive');
  eq(parsed.files.find(f => f.path.endsWith('game00.sav')).lastWriteTime,
    { lo: 0x89abcdef, hi: 0x01bf53eb }, 'the Win32 last-write time survives');
  ok(parsed.registry['reg:HKCU\\Software\\Test\\Saves'], 'registry slice is bundled');
  ok(parsed.ini['ini:game.ini'], 'INI slice is bundled');

  // The zip must be readable by the ordinary reader too, not only by ours.
  const catalog = zipMount.readCatalogSync(bytes);
  ok(catalog.some(e => e.name === 'manifest.json'), 'zip-mount lists manifest.json');
  ok(catalog.every(e => e.method === zipMount.METHOD_STORED), 'bundle entries are stored');

  // Determinism: same inputs, same bytes.
  const again = saveBundle.exportBundle({
    appId: APP_ID, vfs, patterns: PATTERNS, createdAt: CREATED, commit: 'deadbeef',
  });
  eq(Buffer.from(again).toString('hex'), Buffer.from(bytes).toString('hex'),
    'the writer is deterministic');

  return { bytes, vfs };
}

function testRoundTrip(exported) {
  const before = fileState(exported.vfs);
  const storeBefore = storage.exportStore();

  // Wipe: a fresh VFS and a cleared store, as if this were another device.
  const wiped = new VirtualFS();
  storage.clearStore();
  ok(!storage.exportStore()['reg:HKCU\\Software\\Test\\Saves'],
    'clearStore drops the saved registry key');

  const result = saveBundle.importBundle(exported.bytes, {
    vfs: wiped, patterns: PATTERNS, appId: APP_ID, mode: 'replace',
  });
  eq(result.files.sort(),
    ['c:\\save\\game00.sav', 'c:\\save\\game01.sav', 'c:\\ui\\uilst.ini'],
    'import applies every bundled save');
  ok(result.storeKeys > 0, 'import restores registry/INI keys');

  for (const p of Object.keys(before)) {
    if (p.includes('scratch')) continue;   // never bundled, so never restored
    eq(fileState(wiped)[p], before[p], `state-exact restore of ${p}`);
  }
  eq(storage.exportStore()['reg:HKCU\\Software\\Test\\Saves'],
    storeBefore['reg:HKCU\\Software\\Test\\Saves'], 'the registry value comes back');
  eq(storage.exportStore()['ini:game.ini'], storeBefore['ini:game.ini'],
    'the INI section comes back');

  // Byte-exact: re-exporting the restored state reproduces the bundle.
  const reexported = saveBundle.exportBundle({
    appId: APP_ID, vfs: wiped, patterns: PATTERNS, createdAt: CREATED, commit: 'deadbeef',
  });
  eq(Buffer.from(reexported).toString('hex'), Buffer.from(exported.bytes).toString('hex'),
    'export -> wipe -> import -> export is byte-exact');
}

function testMergeMode(exported) {
  const vfs = new VirtualFS();
  const stale = vfs.createFile('C:\\Save\\GAME99.sav', 0x40000000, 2);
  vfs.writeFile(stale, Uint8Array.from([0xaa]), 1);
  saveBundle.importBundle(exported.bytes, {
    vfs, patterns: PATTERNS, appId: APP_ID, mode: 'merge', applyStore: false,
  });
  ok(vfs.files.has('c:\\save\\game99.sav'), 'merge leaves an unrelated save alone');

  const replaced = new VirtualFS();
  const doomed = replaced.createFile('C:\\Save\\GAME99.sav', 0x40000000, 2);
  replaced.writeFile(doomed, Uint8Array.from([0xaa]), 1);
  saveBundle.importBundle(exported.bytes, {
    vfs: replaced, patterns: PATTERNS, appId: APP_ID, mode: 'replace', applyStore: false,
  });
  ok(!replaced.files.has('c:\\save\\game99.sav'),
    'replace empties the persistable paths first');
}

// ---------------------------------------------------------------- tampering

// Rebuild a bundle with one member's bytes swapped, keeping the zip valid so
// the check under test is the manifest hash and not a CRC accident.
function rewriteMember(bytes, memberName, newData) {
  const catalog = zipMount.readCatalogSync(bytes);
  const members = catalog.map(entry => ({
    name: entry.name,
    data: entry.name === memberName
      ? newData
      : zipMount.extractSync(bytes, entry, {}),
  }));
  return buildZip(members);
}

// The test's own store-only writer, so a tampered fixture never depends on the
// writer under test being willing to produce it.
function buildZip(members) {
  const { crc32 } = zipMount;
  const locals = [];
  const centrals = [];
  let offset = 0;
  const u16 = v => { const b = Buffer.alloc(2); b.writeUInt16LE(v & 0xffff); return b; };
  const u32 = v => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; };
  for (const m of members) {
    const name = Buffer.from(m.name, 'utf8');
    const data = Buffer.from(m.data);
    const crc = crc32(new Uint8Array(data));
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(0), u16(0),
      u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), name, data,
    ]);
    centrals.push(Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(0),
      u32(crc), u32(data.length), u32(data.length), u16(name.length),
      u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name,
    ]));
    locals.push(local);
    offset += local.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(members.length), u16(members.length),
    u32(cd.length), u32(offset), u16(0),
  ]);
  return new Uint8Array(Buffer.concat([...locals, cd, eocd]));
}

function testTamper(exported) {
  const parsed = saveBundle.readBundle(exported.bytes);
  const saveMember = parsed.files.find(f => f.path.endsWith('game00.sav')).member;

  // 1. Content swapped under a manifest hash that still names the old bytes.
  const badHash = rewriteMember(exported.bytes, saveMember, Buffer.from([6, 6, 6, 6, 6]));
  rejects(() => saveBundle.readBundle(badHash), /hash mismatch/,
    'a swapped save is caught by its SHA-256');

  // 2. Path traversal: a manifest entry pointing outside the mount.
  const traversal = (() => {
    const m = JSON.parse(JSON.stringify(parsed.manifest));
    m.files[0].name = 'vfs/c/../../etc/passwd';
    m.files[0].path = 'c:\\..\\..\\etc\\passwd';
    return rewriteMember(
      rewriteMember(exported.bytes, 'manifest.json',
        Buffer.from(JSON.stringify(m, null, 2) + '\n')),
      saveMember, Buffer.from(parsed.files[0].data));
  })();
  rejects(() => saveBundle.readBundle(traversal), /unsafe path segment|guest path/,
    'a `..` in an entry name is refused');

  // 3. Escaping the vfs/ prefix entirely.
  rejects(() => saveBundle.memberToGuestPath('../../etc/passwd'), /outside vfs\//,
    'an entry outside vfs/ is refused');
  rejects(() => saveBundle.memberToGuestPath('vfs/c/nul.sav'), /reserved device/,
    'a Win32 device name is refused');
  rejects(() => saveBundle.memberToGuestPath('vfs/c/a\\b'), /backslash/,
    'a backslash in an entry name is refused');

  // 4. An entry the manifest never listed — no hash stands behind it.
  const smuggled = buildZip([
    ...zipMount.readCatalogSync(exported.bytes).map(e => ({
      name: e.name, data: Buffer.from(zipMount.extractSync(exported.bytes, e, {})),
    })),
    { name: 'vfs/c/save/extra.sav', data: Buffer.from([1]) },
  ]);
  rejects(() => saveBundle.readBundle(smuggled), /unlisted entry/,
    'an unlisted member is refused');

  // 5. Oversize, against the caller's cap.
  rejects(() => saveBundle.readBundle(exported.bytes, { maxBundleBytes: 32 }),
    /exceeds the 32-byte cap/, 'an oversized bundle is refused before parsing');
  rejects(() => saveBundle.exportBundle({
    appId: APP_ID, vfs: exported.vfs, patterns: PATTERNS, maxFileBytes: 2,
  }), /over the 2-byte per-file limit/, 'an oversized save is refused at export');

  // 6. Version and app identity.
  const futureVersion = (() => {
    const m = JSON.parse(JSON.stringify(parsed.manifest));
    m.version = 99;
    return rewriteMember(exported.bytes, 'manifest.json',
      Buffer.from(JSON.stringify(m, null, 2) + '\n'));
  })();
  rejects(() => saveBundle.readBundle(futureVersion), /unsupported bundle version 99/,
    'a newer bundle version is refused, not guessed at');
  rejects(() => saveBundle.importBundle(exported.bytes, {
    vfs: new VirtualFS(), patterns: PATTERNS, appId: 'some_other_app',
  }), /but "some_other_app" is running/, 'an app mismatch is refused by default');
  ok(saveBundle.importBundle(exported.bytes, {
    vfs: new VirtualFS(), patterns: PATTERNS, appId: 'some_other_app',
    allowAppMismatch: true, applyStore: false,
  }).files.length === 3, 'allowAppMismatch overrides it deliberately');

  // 7. The running app's globs, not the bundle's claim, are the allow-list.
  rejects(() => saveBundle.importBundle(exported.bytes, {
    vfs: new VirtualFS(), patterns: ['c:\\other\\*.dat'], appId: APP_ID, applyStore: false,
  }), /outside the app's persistFiles globs/,
    'a bundle cannot write a path the running app may not persist');
  rejects(() => saveBundle.importBundle(exported.bytes, {
    vfs: new VirtualFS(), patterns: [], appId: APP_ID, applyStore: false,
  }), /no persistFiles globs/, 'an app with no globs imports nothing');
}

// ------------------------------------------------------------------- urls

function testUrls() {
  eq(saveSync.saveKey(APP_ID), `wine-saves-${APP_ID}`, 'the berrry key for an app');
  eq(saveSync.dataUrl('', APP_ID), `/api/data/wine-saves-${APP_ID}`,
    'same-origin is the default endpoint, as a deployed page wants');
  eq(saveSync.dataUrl('http://h:1/', APP_ID), `http://h:1/api/data/wine-saves-${APP_ID}`,
    'a configured endpoint is a prefix');
  eq(saveSync.metadataUrl('', APP_ID), `/api/data/wine-saves-${APP_ID}/metadata`,
    'metadata hangs off the same key');
  eq(saveSync.loginUrl('http://h:1'), 'http://h:1/api/auth/login', 'the sign-in URL');
  rejects(() => saveSync.dataUrl('h:1', APP_ID), /must be an http\(s\) URL/,
    'a non-URL endpoint fails loudly instead of resolving relative to the page');
  rejects(() => saveSync.saveKey('../../etc/passwd'), /not a usable app id/,
    'an app id that is a path is refused');
}

// -------------------------------------------------------------------- sync

function startServer(dir, extraArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath,
      [path.join(__dirname, '..', 'tools', 'save-sync-server.js'),
        `--dir=${dir}`, '--port=0', '--host=127.0.0.1', ...(extraArgs || [])],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`save-sync server did not start: ${out}`));
    }, 15000);
    child.stdout.on('data', chunk => {
      out += chunk.toString();
      const m = /http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
      if (m) {
        clearTimeout(timer);
        resolve({ child, endpoint: `http://127.0.0.1:${m[1]}` });
      }
    });
    child.stderr.on('data', chunk => { out += chunk.toString(); });
    child.on('exit', code => {
      clearTimeout(timer);
      reject(new Error(`save-sync server exited with ${code}: ${out}`));
    });
  });
}

// Node's global fetch is fine, but going through http directly keeps this test
// working on any Node the repo still supports and makes the timeout ours.
function httpFetch(url, init) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      method: (init && init.method) || 'GET',
      headers: (init && init.headers) || {},
      timeout: 10000,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          arrayBuffer: async () => body.buffer.slice(
            body.byteOffset, body.byteOffset + body.byteLength),
          text: async () => body.toString('utf8'),
        });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('sync request timed out')); });
    req.on('error', reject);
    if (init && init.body) req.write(Buffer.from(init.body));
    req.end();
  });
}

async function testSync(exported) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-save-sync-'));
  const { child, endpoint } = await startServer(dir);
  try {
    const common = { endpoint, appId: APP_ID, fetchImpl: httpFetch, timeoutMs: 10000 };

    const user = await saveSync.getUser(common);
    ok(user && user.username, 'the auth probe names the signed-in user');
    eq(await saveSync.metadata(common), null, 'a fresh account has no record for this app');
    eq(await saveSync.pull(common), null, 'and nothing to pull');

    const first = await saveSync.sync(Object.assign({}, common, { bundle: exported.bytes }));
    eq(first.action, 'pushed', 'the first sync uploads the local bundle');

    const back = await saveSync.pull(common);
    eq(Buffer.from(back.bytes).toString('hex'),
      Buffer.from(exported.bytes).toString('hex'),
      'the data API returns the same bytes it was given');
    const meta = await saveSync.metadata(common);
    ok(meta && meta.updatedAt, 'the record carries an updatedAt');
    eq(meta.dataType, 'application/zip', 'the bundle keeps its content type');

    const same = await saveSync.sync(Object.assign({}, common, { bundle: exported.bytes }));
    eq(same.action, 'in-sync', 'an unchanged bundle moves nothing');

    // A newer local bundle wins; an older one loses and comes back as a pull.
    // Note which clock decides: the bundle's own capture time, not the record's
    // updatedAt — the older bundle below is uploaded *later* and must still lose.
    const newer = saveBundle.exportBundle({
      appId: APP_ID, vfs: exported.vfs, patterns: PATTERNS,
      createdAt: '2026-08-31T00:00:00.000Z', commit: 'deadbeef',
    });
    eq((await saveSync.sync(Object.assign({}, common, { bundle: newer }))).action, 'pushed',
      'a newer local bundle is pushed');
    const older = saveBundle.exportBundle({
      appId: APP_ID, vfs: exported.vfs, patterns: PATTERNS,
      createdAt: '2026-08-01T00:00:00.000Z', commit: 'deadbeef',
    });
    const pulled = await saveSync.sync(Object.assign({}, common, { bundle: older }));
    eq(pulled.action, 'pulled', 'an older local bundle pulls the remote instead');
    eq(pulled.manifest.createdAt, '2026-08-31T00:00:00.000Z', 'the newer manifest comes back');

    // Each app is its own key.
    eq(await saveSync.metadata(Object.assign({}, common, { appId: 'some_other_app' })), null,
      'another app id is another record');

    eq((await saveSync.remove(common)).removed, true, 'a record can be deleted');
    eq(await saveSync.pull(common), null, 'and is gone afterwards');
  } finally {
    child.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// A signed-out visitor must get a named, actionable failure with somewhere to
// send them — never a silent "no saves found", which is what a 401 looks like
// to any client that only branches on 404.
async function testSyncSignedOut(exported) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-save-noauth-'));
  const { child, endpoint } = await startServer(dir, ['--no-auth']);
  try {
    const common = { endpoint, appId: APP_ID, fetchImpl: httpFetch, timeoutMs: 10000 };
    eq(await saveSync.getUser(common), null, 'getUser reports signed-out as null');
    let caught = null;
    try {
      await saveSync.sync(Object.assign({}, common, { bundle: exported.bytes }));
    } catch (e) {
      caught = e;
    }
    ok(caught && caught.authRequired, 'a 401 surfaces as an auth-required error');
    eq(caught.loginUrl, `${endpoint}/api/auth/login`, 'and names where to sign in');
  } finally {
    child.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Responses may arrive immediately while their bodies never finish. Drive the
// request timer explicitly so this regression is deterministic even on a busy
// host, and check cleanup on success and every failure path.
async function testSyncDeadline() {
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const timers = new Map();
  let nextTimer = 0;
  global.setTimeout = callback => { timers.set(++nextTimer, callback); return nextTimer; };
  global.clearTimeout = timer => { timers.delete(timer); };
  const expire = () => {
    ok(timers.size === 1, 'the request deadline stays active while reading the body');
    for (const callback of Array.from(timers.values())) callback();
  };
  try {
    for (const [method, useText] of [['pull', true], ['metadata', true], ['getUser', true], ['getUser', false]]) {
      let signal;
      const body = () => {
        queueMicrotask(expire);
        return new Promise(() => {}); // Deliberately ignores abort like a custom transport.
      };
      let caught;
      try {
        await saveSync[method]({ appId: APP_ID, timeoutMs: 17,
          fetchImpl: async (_, init) => {
            signal = init.signal;
            return { status: 200, ok: true, text: useText ? body : undefined, arrayBuffer: body };
          } });
      } catch (error) { caught = error; }
      ok(caught && caught.name === 'TimeoutError', `${method}: a stalled body times out`);
      ok(signal.aborted, `${method}: timeout aborts the transport`);
      eq(timers.size, 0, `${method}: timeout clears its timer`);
    }
    for (const kind of ['success', 'fetch-failure', 'body-failure', 'abort', 'json-failure', 'http-failure', 'signed-out']) {
      let signal;
      let caught;
      let result;
      const failure = new Error(kind);
      if (kind === 'abort') failure.name = 'AbortError';
      try {
        result = await saveSync.getUser({ fetchImpl: async (_, init) => {
          signal = init.signal;
          if (kind === 'fetch-failure') throw failure;
          return {
            status: kind === 'http-failure' ? 500 : kind === 'signed-out' ? 401 : 200,
            ok: kind !== 'http-failure' && kind !== 'signed-out',
            text: async () => {
              if (kind === 'body-failure' || kind === 'abort') throw failure;
              return kind === 'json-failure' ? '{' : '{"username":"tester"}';
            },
          };
        } });
      } catch (error) { caught = error; }
      if (kind === 'success') eq(result.username, 'tester', 'completed bodies parse normally');
      else if (kind === 'signed-out') eq(result, null, 'signed-out status needs no body');
      else ok(caught, `${kind}: propagates the failure`);
      if (kind === 'fetch-failure' || kind === 'body-failure' || kind === 'abort') eq(caught, failure, 'transport errors keep their identity');
      eq(timers.size, 0, `${kind}: completion clears the deadline`);
      ok(!signal.aborted, `${kind}: no timer remains to abort a completed request`);
    }
  } finally {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }
}

// ---------------------------------------------------------------- the CLI

function testCli(exported) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-save-cli-'));
  try {
    const file = path.join(dir, 'bundle.zip');
    fs.writeFileSync(file, Buffer.from(exported.bytes));
    const out = execFileSync(process.execPath,
      [path.join(__dirname, '..', 'tools', 'save-bundle.js'), file, '--verify'],
      { encoding: 'utf8', timeout: 30000 });
    ok(out.includes(`app       ${APP_ID}`), 'the CLI names the app');
    ok(out.includes('c:\\save\\game00.sav'), 'the CLI lists the saves');
    ok(out.includes('every member matched its manifest hash'), 'the CLI verifies');

    const summary = JSON.parse(execFileSync(process.execPath,
      [path.join(__dirname, '..', 'tools', 'save-bundle.js'), file, '--json'],
      { encoding: 'utf8', timeout: 30000 }));
    eq(summary.files.length, 3, 'the JSON summary lists every save');

    // A corrupt bundle exits nonzero rather than printing a cheerful summary.
    const broken = Buffer.from(exported.bytes);
    broken[broken.length - 30] ^= 0xff;
    const brokenFile = path.join(dir, 'broken.zip');
    fs.writeFileSync(brokenFile, broken);
    let failed = false;
    try {
      execFileSync(process.execPath,
        [path.join(__dirname, '..', 'tools', 'save-bundle.js'), brokenFile],
        { encoding: 'utf8', timeout: 30000, stdio: 'pipe' });
    } catch (_) {
      failed = true;
    }
    ok(failed, 'the CLI exits nonzero on a corrupt bundle');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  testProviderResidency();
  const exported = testExportShape();
  testRoundTrip(exported);
  testMergeMode(exported);
  testTamper(exported);
  testUrls();
  await testSyncDeadline();
  await testSync(exported);
  await testSyncSignedOut(exported);
  testCli(exported);
  console.log(`PASS test-save-bundle (${checks} checks)`);
}

main().catch(e => {
  console.error(`FAIL test-save-bundle: ${e && e.stack ? e.stack : e}`);
  process.exit(1);
});
