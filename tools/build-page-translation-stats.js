#!/usr/bin/env node
'use strict';

// Build an offline-only WASM artifact that counts which $g2w translation path
// real applications use. Production WAT remains branch-free: this tool patches
// the source closure in memory and writes a separately named module.

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
  'span_packed_hit',
  'span_packed_miss',
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
  const missMarker = '  (func $g2w_miss (param $ga i32) (result i32)';
  const helper = String.raw`  ;; Offline-only counters injected by
  ;; tools/build-page-translation-stats.js. TEST_SCRATCH is shared by every
  ;; WASM instance, so main and guest threads contribute to one process total.
  (func $g2w_stat_inc (param $slot i32)
    (drop (i32.atomic.rmw.add
      (i32.add (global.get $TEST_SCRATCH)
        (i32.shl (local.get $slot) (i32.const 2)))
      (i32.const 1))))

`;
  source = replaceOne(source, missMarker, helper + missMarker, '$g2w_miss marker');

  source = replaceOne(source,
    String.raw`    (if (i32.eqz (i32.or (i32.lt_s (local.get $wa) (i32.const 0))
                (i32.ge_u (local.get $wa) (region.end $DIRECT_WINDOW))))
      (then (return (local.get $wa))))`,
    String.raw`    (if (i32.eqz (i32.or (i32.lt_s (local.get $wa) (i32.const 0))
                (i32.ge_u (local.get $wa) (region.end $DIRECT_WINDOW))))
      (then
        (call $g2w_stat_inc (i32.const 0))
        (return (local.get $wa))))`,
    'direct return');

  source = replaceOne(source,
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

  source = replaceOne(source,
    String.raw`    (local.set $wa (call $guest_page_translate (local.get $ga)))
    (if (i32.ne (local.get $wa) (global.get $NULL_SENTINEL))
      (then (return (local.get $wa))))
    (call $g2w_miss (local.get $ga))`,
    String.raw`    (local.set $wa (call $guest_page_translate (local.get $ga)))
    (if (i32.ne (local.get $wa) (global.get $NULL_SENTINEL))
      (then
        (call $g2w_stat_inc (i32.const 2))
        (return (local.get $wa))))
    (call $g2w_stat_inc (i32.const 3))
    (call $g2w_miss (local.get $ga))`,
    'packed result');

  source = replaceOne(source,
    String.raw`    (call $guest_page_affine_span (local.get $ga) (local.get $len))
  )
  (func $w2g`,
    String.raw`    (local.set $wa
      (call $guest_page_affine_span (local.get $ga) (local.get $len)))
    (if (i32.eq (local.get $wa) (global.get $NULL_SENTINEL))
      (then (call $g2w_stat_inc (i32.const 5)))
      (else (call $g2w_stat_inc (i32.const 4))))
    (local.get $wa)
  )
  (func $w2g`,
    'packed affine result');

  return source;
}

function instrumentExports(source) {
  const marker = '  ;; --trace-esp wiring (test harness uses this). Pass hi=0 to disable';
  const bytes = STAT_NAMES.length * 4;
  const exports = String.raw`  ;; Offline-only page-translation census exports.
  (func (export "reset_guest_page_stats")
    (memory.fill (global.get $TEST_SCRATCH) (i32.const 0) (i32.const ${bytes})))
  (func (export "get_guest_page_stat_count") (result i32)
    (i32.const ${STAT_NAMES.length}))
  (func (export "get_guest_page_stat") (param $slot i32) (result i32)
    (if (result i32) (i32.lt_u (local.get $slot) (i32.const ${STAT_NAMES.length}))
      (then
        (i32.atomic.load
          (i32.add (global.get $TEST_SCRATCH)
            (i32.shl (local.get $slot) (i32.const 2)))))
      (else (i32.const 0))))
  (func (export "test_guest_page_map")
      (param $ga i32) (param $len i32) (result i32)
    (call $virtual_map_commit (local.get $ga) (local.get $len)))
  (func (export "test_guest_page_affine_span")
      (param $ga i32) (param $len i32) (result i32)
    (call $g2w_affine_span (local.get $ga) (local.get $len)))

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
  console.log(`run with: node test/run.js --no-build --wasm=${result.outPath} --guest-page-stats ...`);
}

if (require.main === module) {
  try { main(); }
  catch (err) { console.error(err && err.stack || err); process.exit(1); }
}

module.exports = { DEFAULT_OUT, STAT_NAMES, instrumentSource, buildInstrumented };
