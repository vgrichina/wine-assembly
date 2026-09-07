#!/usr/bin/env node
'use strict';

// Build an offline-only WASM artifact that counts which $g2w translation path
// real applications use. The canonical source and build artifacts deliberately
// contain no counter branch: this tool patches an in-memory WATX closure, then
// writes a separately named module for `test/run.js --guest-page-stats`.

const fs = require('fs');
const os = require('os');
const path = require('path');

const { compileSrcWasm } = require('../test/compile-src');
const { appendSection, hashOfLayout } = require('./region-layout-hash');

const DEFAULT_OUT = path.join(os.tmpdir(), 'wine-assembly-page-stats.wasm');
const STAT_NAMES = Object.freeze([
  'direct',
  'dib',
  'packed_hit',
  'packed_miss',
  'legacy_cache_0',
  'legacy_cache_1',
  'legacy_cache_2',
  'legacy_cache_3',
  'legacy_scan_hit',
  'legacy_scan_miss',
  'legacy_scan_records',
]);

function getArg(name, fallback) {
  const prefix = `--${name}=`;
  const hit = process.argv.find(arg => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

function replaceOne(source, needle, replacement, label) {
  const first = source.indexOf(needle);
  if (first < 0 || source.indexOf(needle, first + 1) >= 0) {
    throw new Error(`page-translation-stats: expected exactly one ${label}`);
  }
  return source.slice(0, first) + replacement + source.slice(first + needle.length);
}

function instrumentRegisters(source) {
  const helperMarker = '  (func $g2w_miss (param $ga i32) (result i32)';
  const helper = String.raw`  ;; Offline-only counters injected by tools/build-page-translation-stats.js.
  ;; TEST_SCRATCH is shared by every WASM instance, so worker and main-thread
  ;; translations contribute to one process total. This artifact is not used by
  ;; the test pool: those tests own the scratch region for their own fixtures.
  (func $g2w_stat_inc (param $slot i32)
    (drop (i32.atomic.rmw.add
      (i32.add (global.get $TEST_SCRATCH)
        (i32.shl (local.get $slot) (i32.const 2)))
      (i32.const 1))))

`;
  source = replaceOne(source, helperMarker, helper + helperMarker, '$g2w_miss marker');

  const startMarker = '  (func $g2w (param $ga i32) (result i32)';
  const endMarker = '\n  ;; Translate a complete guest span only when one affine mapping contains it.';
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error('page-translation-stats: cannot isolate $g2w');
  let body = source.slice(start, end);

  body = replaceOne(body,
    String.raw`    (if (i32.eqz (i32.or (i32.lt_s (local.get $wa) (i32.const 0))
                (i32.ge_u (local.get $wa) (region.end $DIRECT_WINDOW))))
      (then (return (local.get $wa))))`,
    String.raw`    (if (i32.eqz (i32.or (i32.lt_s (local.get $wa) (i32.const 0))
                (i32.ge_u (local.get $wa) (region.end $DIRECT_WINDOW))))
      (then
        (call $g2w_stat_inc (i32.const 0))
        (return (local.get $wa))))`,
    'direct return');
  body = replaceOne(body,
    String.raw`      (then
        (return (i32.add
          (global.get $DIB_BACKING_BASE)
          (i32.sub (local.get $ga) (global.get $DIB_GUEST_BASE))))))`,
    String.raw`      (then
        (call $g2w_stat_inc (i32.const 1))
        (return (i32.add
          (global.get $DIB_BACKING_BASE)
          (i32.sub (local.get $ga) (global.get $DIB_GUEST_BASE))))))`,
    'DIB return');
  body = replaceOne(body,
    String.raw`        (if (i32.ne (local.get $wa) (global.get $NULL_SENTINEL))
          (then (return (local.get $wa))))
        (return (call $g2w_miss (local.get $ga))))`,
    String.raw`        (if (i32.ne (local.get $wa) (global.get $NULL_SENTINEL))
          (then
            (call $g2w_stat_inc (i32.const 2))
            (return (local.get $wa))))
        (call $g2w_stat_inc (i32.const 3))
        (return (call $g2w_miss (local.get $ga))))`,
    'packed result');

  const cacheReturns = [
    ['(global.get $g2w_sparse_backing)', 4],
    ['(global.get $g2w_sparse_backing1)', 5],
    ['(global.get $g2w_sparse_backing2)', 6],
    ['(global.get $g2w_sparse_backing3)', 7],
  ];
  for (const [backing, slot] of cacheReturns) {
    const needle = `      (then\n        (return (i32.add ${backing} (local.get $off)))))`;
    const replacement = `      (then\n        (call $g2w_stat_inc (i32.const ${slot}))\n        (return (i32.add ${backing} (local.get $off)))))`;
    body = replaceOne(body, needle, replacement, `legacy cache rank ${slot - 4}`);
  }

  body = replaceOne(body,
    '      (br_if $mapped_done (i32.ge_u (local.get $i) (local.get $count)))',
    '      (br_if $mapped_done (i32.ge_u (local.get $i) (local.get $count)))\n' +
      '      (call $g2w_stat_inc (i32.const 10))',
    'legacy scan iteration');
  body = replaceOne(body,
    String.raw`          (global.set $g2w_sparse_backing (local.get $backing))
          (return (i32.add (local.get $backing) (i32.sub (local.get $ga) (local.get $base))))))`,
    String.raw`          (global.set $g2w_sparse_backing (local.get $backing))
          (call $g2w_stat_inc (i32.const 8))
          (return (i32.add (local.get $backing) (i32.sub (local.get $ga) (local.get $base))))))`,
    'legacy scan hit');
  body = replaceOne(body,
    String.raw`    ;; Nothing maps this address.
    (call $g2w_miss (local.get $ga))`,
    String.raw`    ;; Nothing maps this address.
    (call $g2w_stat_inc (i32.const 9))
    (call $g2w_miss (local.get $ga))`,
    'legacy scan miss');

  return source.slice(0, start) + body + source.slice(end);
}

function instrumentExports(source) {
  const marker = '  ;; --trace-esp wiring (test harness uses this). Pass hi=0 to disable';
  const exports = String.raw`  ;; Offline-only page-translation census exports. The instrumented
  ;; artifact stores eleven shared u32 counters at TEST_SCRATCH+0..43.
  (func (export "reset_guest_page_stats")
    (memory.fill (global.get $TEST_SCRATCH) (i32.const 0) (i32.const 44)))
  (func (export "get_guest_page_stat_count") (result i32) (i32.const 11))
  (func (export "get_guest_page_stat") (param $slot i32) (result i32)
    (if (result i32) (i32.lt_u (local.get $slot) (i32.const 11))
      (then
        (i32.atomic.load
          (i32.add (global.get $TEST_SCRATCH)
            (i32.shl (local.get $slot) (i32.const 2)))))
      (else (i32.const 0))))

`;
  return replaceOne(source, marker, exports + marker, 'debug export marker');
}

function instrumentSource(filename, source) {
  if (filename === '03-registers.wat') return instrumentRegisters(source);
  if (filename === '13-exports.wat') return instrumentExports(source);
  return source;
}

function buildInstrumented(outPath = DEFAULT_OUT) {
  const raw = compileSrcWasm(instrumentSource);
  const stamped = appendSection(raw, hashOfLayout());
  new WebAssembly.Module(stamped);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, stamped);
  return { outPath, bytes: stamped.length, wasm: stamped };
}

function main() {
  const outPath = path.resolve(getArg('out', DEFAULT_OUT));
  const result = buildInstrumented(outPath);
  console.log(`page-translation-stats: wrote ${result.outPath} (${result.bytes} bytes)`);
  console.log(`run with: node test/run.js --no-build --wasm=${result.outPath} --guest-page-stats [--guest-page-translation] ...`);
}

if (require.main === module) {
  try { main(); }
  catch (err) { console.error(err && err.stack || err); process.exit(1); }
}

module.exports = { DEFAULT_OUT, STAT_NAMES, instrumentSource, buildInstrumented };
