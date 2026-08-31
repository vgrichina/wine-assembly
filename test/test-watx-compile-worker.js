#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// test-watx-compile-worker.js — Milestone 4 compiler-Worker plumbing.
//
// Compiles the REAL src/main.watx include closure inside a worker_threads
// Worker, in both dispatch modes, and checks the four properties the
// migration plan asks of that path:
//
//   1. the worker produces bytes that WebAssembly.validate accepts, in both
//      the tail-call and the compatibility mode;
//   2. the worker is TERMINATED on every path — a live compiler worker still
//      holding the 10 MB snapshot while Wine allocates 512 MB is exactly the
//      failure mode the plan's memory gate is about;
//   3. the cache key is stable for one snapshot and differs per mode;
//   4. editing ONE source byte changes the key (so a content-addressed cache
//      cannot serve a stale module), and so does touching the compiler.
//
// It also proves the failure path: a deliberately broken source is reported
// as a compile error rather than a hang or a bogus module, and the worker is
// still terminated.
//
// No build required — this drives lib/watx-launcher.js + the vendored
// compiler directly and writes no artifacts.
// ═══════════════════════════════════════════════════════════════
const path = require('path');
const assert = require('assert');

const launcher = require(path.join(__dirname, '..', 'lib', 'watx-launcher.js'));

// The snapshot holds UTF-8 bytes, not strings (lib/watx-launcher.js header):
// an "edit one file" fixture therefore appends bytes.
const append = (bytes, text) => Buffer.concat([Buffer.from(bytes), Buffer.from(text, 'utf8')]);

let checks = 0;
function check(label, cond, detail) {
  checks++;
  if (cond) {
    console.log(`  PASS  ${label}${detail ? ' — ' + detail : ''}`);
  } else {
    console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`);
    process.exitCode = 1;
  }
}

async function main() {
  console.log('== fetchSources (fetch-once snapshot) ==');
  const snapshot = await launcher.fetchSources();
  check('compiler bundle is the four vendored stages',
    snapshot.compiler.length === 4 &&
    snapshot.compiler.every(f => f.bytes instanceof Uint8Array && f.bytes.byteLength > 1000),
    snapshot.compiler.map(f => path.basename(f.name)).join(','));
  check('manifest parsed from src/main.watx', snapshot.manifest.length >= 50,
    `${snapshot.manifest.length} includes`);
  check('every include resolved to UTF-8 bytes (never a UTF-16 string)',
    snapshot.manifest.every(n => snapshot.sources[n] instanceof Uint8Array && snapshot.sources[n].byteLength),
    `${(snapshot.bytes / 1e6).toFixed(2)} MB total`);
  check('manifest order matches lib/compile-wat.js WAT_FILES',
    JSON.stringify(snapshot.manifest) ===
      JSON.stringify(require(path.join(__dirname, '..', 'lib', 'compile-wat.js')).WAT_FILES));

  console.log('== cache key ==');
  const keyTail = await launcher.cacheKey(snapshot, { tailCalls: true });
  const keyTail2 = await launcher.cacheKey(snapshot, { tailCalls: true });
  const keyCompat = await launcher.cacheKey(snapshot, { tailCalls: false });
  check('key is stable for one snapshot', keyTail === keyTail2);
  check('key shape is watx1:<compiler>:<sources>:<mode>',
    /^watx1:[0-9a-f]{64}:[0-9a-f]{64}:(tail|compat)$/.test(keyTail), keyTail.slice(0, 40) + '…');
  check('mode changes the key', keyTail !== keyCompat);

  const editedSource = {
    ...snapshot,
    sources: { ...snapshot.sources, [snapshot.manifest[0]]: append(snapshot.sources[snapshot.manifest[0]], '\n;; edit\n') },
  };
  check('a one-line source edit changes the key',
    (await launcher.cacheKey(editedSource, { tailCalls: true })) !== keyTail);

  const editedCompiler = {
    ...snapshot,
    compiler: snapshot.compiler.map((f, i) => (i === 0 ? { ...f, bytes: append(f.bytes, '\n// edit\n') } : f)),
  };
  check('a compiler edit changes the key',
    (await launcher.cacheKey(editedCompiler, { tailCalls: true })) !== keyTail);

  const editedEntry = { ...snapshot, entryBytes: append(snapshot.entryBytes, '\n;; edit\n') };
  check('a manifest edit changes the key',
    (await launcher.cacheKey(editedEntry, { tailCalls: true })) !== keyTail);

  // The digest is over UTF-8, so moving the snapshot from strings to bytes did
  // NOT renumber the key space: a hand-built text-form snapshot of the same
  // content still hashes to the same key, and any persisted cache survives.
  const asText = {
    ...snapshot,
    compiler: snapshot.compiler.map(f => ({ name: f.name, text: launcher.toText(f.bytes) })),
    entry: launcher.toText(snapshot.entryBytes),
    entryBytes: undefined,
    sources: Object.fromEntries(snapshot.manifest.map(n => [n, launcher.toText(snapshot.sources[n])])),
  };
  check('the key is unchanged by the bytes representation (text form hashes the same)',
    (await launcher.cacheKey(asText, { tailCalls: true })) === keyTail);

  const artifacts = {};
  for (const tailCalls of [true, false]) {
    const label = tailCalls ? 'tail-call' : 'compatibility';
    console.log(`== compile in a Worker: ${label} mode ==`);
    let handle = null;
    const result = await launcher.compileDetailed({ tailCalls }, {
      snapshot, noMemo: true, timeoutMs: 240000,
      onWorker: h => { handle = h; },
    });
    artifacts[label] = result;
    check(`${label}: compiled inside a worker_threads Worker`, result.byteLength > 500000,
      `${result.byteLength} B in ${result.timing.compileMs.toFixed(0)} ms`);
    check(`${label}: WebAssembly.validate accepted the bytes`, result.valid === true);
    check(`${label}: bytes start with the wasm magic`,
      result.bytes[0] === 0x00 && result.bytes[1] === 0x61 &&
      result.bytes[2] === 0x73 && result.bytes[3] === 0x6d);
    check(`${label}: cache key travelled with the result`,
      result.cacheKey === (tailCalls ? keyTail : keyCompat));
    check(`${label}: compiler reported no warnings`, result.warnings.length === 0,
      `${result.warnings.length} warning(s)`);
    // The plan's memory rule: the Worker must be gone before Wine's memory is
    // allocated. compileDetailed() terminates it in a finally, so by the time
    // it resolves the exit is already in flight.
    assert(handle, 'onWorker hook never fired');
    const code = await handle.exitPromise;
    check(`${label}: worker terminated after the compile`, handle.hasExited() === true,
      `exit code ${code}`);
  }

  console.log('== the snapshot survived being handed over ==');
  // The bytes are posted as TRANSFERABLE ArrayBuffers, which detach whatever
  // is transferred. The launcher therefore transfers per-attempt COPIES: if it
  // ever transferred the snapshot's own arrays, the second mode above would
  // have compiled from zero-length sources, and re-reading them here would
  // break the fetch-once rule. Prove the parent still owns its bytes.
  check('parent snapshot is not detached after two compiles',
    snapshot.entryBytes.byteLength > 0 &&
    snapshot.manifest.every(n => snapshot.sources[n].byteLength > 0) &&
    snapshot.compiler.every(f => f.bytes.byteLength > 0),
    `${(snapshot.bytes / 1e6).toFixed(2)} MB still resident`);
  check('both modes really compiled from the same snapshot',
    artifacts['tail-call'].sourceBytes === snapshot.bytes &&
    artifacts['compatibility'].sourceBytes === snapshot.bytes);

  console.log('== the two modes really differ ==');
  check('compatibility artifact is not byte-identical to the tail-call one',
    artifacts['tail-call'].byteLength !== artifacts['compatibility'].byteLength ||
    !Buffer.from(artifacts['tail-call'].bytes).equals(Buffer.from(artifacts['compatibility'].bytes)),
    `${artifacts['tail-call'].byteLength} vs ${artifacts['compatibility'].byteLength} B`);
  // Whether the compatibility artifact is genuinely free of return_call is
  // NOT decidable by a byte scan (an opcode byte is indistinguishable from an
  // immediate); tools/wasm-abi-diff.js --require-no-tailcalls is that gate and
  // tools/watx-matrix.js already runs it.

  console.log('== failure path ==');
  const broken = {
    ...snapshot,
    sources: {
      ...snapshot.sources,
      [snapshot.manifest[0]]: append(snapshot.sources[snapshot.manifest[0]],
        '\n(func $watx_m4_deliberately_broken (result i32) (i32.add (i32.const 1)))\n'),
    },
  };
  let brokenHandle = null;
  let failed = null;
  try {
    await launcher.compileDetailed({ tailCalls: true }, {
      snapshot: broken, noMemo: true, timeoutMs: 240000,
      onWorker: h => { brokenHandle = h; },
    });
  } catch (e) {
    failed = e;
  }
  check('a broken source rejects instead of returning a module', failed !== null,
    failed ? String(failed.message).slice(0, 80) : 'compiled anyway');
  if (brokenHandle) {
    await brokenHandle.exitPromise;
    check('worker is terminated on the failure path too', brokenHandle.hasExited() === true);
  } else {
    check('worker is terminated on the failure path too', false, 'no worker was spawned');
  }

  console.log('== the host.js path: the launcher reads its own snapshot ==');
  // With no `snapshot` option the launcher reads the closure itself, and then
  // nobody else can hold it — so it transfers its own buffers instead of
  // copying them. That is the browser path, and it must produce the same
  // module as the copied-snapshot path above, not merely a valid one.
  const owned = await launcher.compileDetailed({ tailCalls: true }, {
    noMemo: true, timeoutMs: 240000,
  });
  check('a launcher-owned snapshot compiles (buffers transferred, not copied)',
    owned.valid === true, `${owned.byteLength} B`);
  check('the transferred-snapshot build is byte-identical to the copied one',
    Buffer.from(owned.bytes).equals(Buffer.from(artifacts['tail-call'].bytes)));
  check('and lands on the same cache key', owned.cacheKey === keyTail);

  console.log('== memoisation and failed-promise reset ==');
  launcher._reset();
  const p1 = launcher.compileDetailed({ tailCalls: true }, { snapshot, timeoutMs: 240000 });
  const p2 = launcher.compileDetailed({ tailCalls: true }, { snapshot, timeoutMs: 240000 });
  check('two concurrent compiles share one in-flight promise',
    (await p1) === (await p2));
  launcher._reset();
  const bad = launcher.compileDetailed({ tailCalls: true }, { snapshot: broken, timeoutMs: 240000 });
  await bad.catch(() => {});
  await new Promise(r => setImmediate(r));
  check('a rejected compile is evicted from the memo (failed-promise reset)',
    launcher._inFlight.size === 0, `${launcher._inFlight.size} entr(ies) left`);
  launcher._reset();

  console.log(`\n${checks} checks, ${process.exitCode ? 'FAILURES' : 'all PASS'}`);
}

main().catch(e => {
  console.error('FATAL', e && e.stack || e);
  process.exit(1);
});
