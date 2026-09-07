'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createHostImports } = require('../lib/host-imports');
const RegionMap = require('../lib/region-map.generated');
const { STAT_NAMES, buildInstrumented } = require('../tools/build-page-translation-stats');

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-page-stats-'));
  const artifact = path.join(tempDir, 'instrumented.wasm');
  let built;
  try {
    built = buildInstrumented(artifact);
    assert(fs.existsSync(artifact), 'instrumented build must write its requested artifact');

    const memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
    const context = {
      getMemory: () => memory.buffer,
      renderer: null,
      resourceJson: { menus: {}, dialogs: {}, strings: {}, bitmaps: {} },
      onExit: () => {},
    };
    const imports = createHostImports(context);
    imports.host.memory = memory;
    imports.host.create_thread = () => 0;
    imports.host.exit_thread = () => 0;
    imports.host.terminate_thread = () => 0;
    imports.host.create_event = () => 0;
    imports.host.set_event = () => 0;
    imports.host.reset_event = () => 0;
    imports.host.wait_single = () => 0;
    imports.host.wait_multiple = () => 0;
    imports.host.com_create_instance = () => 0x80004002;
    const { instance } = await WebAssembly.instantiate(built.wasm, imports);
    const e = instance.exports;
    context.exports = e;

    assert.strictEqual(e.get_guest_page_stat_count(), STAT_NAMES.length,
      'artifact and reporting code must agree on the counter schema');
    const stat = name => e.get_guest_page_stat(STAT_NAMES.indexOf(name)) >>> 0;
    const dv = new DataView(memory.buffer);

    e.reset_guest_page_stats();
    e.guest_to_wasm(e.get_image_base() >>> 0);
    e.guest_to_wasm(0x50000000);

    const guest = 0x40000000;
    const spanGuest = 0x41000000;
    dv.setUint32(RegionMap.BASE.VIRTUAL_MAP_STATE, 2, true);
    dv.setUint32(RegionMap.BASE.VIRTUAL_MAP_TABLE, guest, true);
    dv.setUint32(RegionMap.BASE.VIRTUAL_MAP_TABLE + 4, 0x2000, true);
    dv.setUint32(RegionMap.BASE.VIRTUAL_MAP_TABLE + 8,
      RegionMap.BASE.VIRTUAL_BACKING_BASE, true);
    dv.setUint32(RegionMap.BASE.VIRTUAL_MAP_TABLE + 16, spanGuest, true);
    dv.setUint32(RegionMap.BASE.VIRTUAL_MAP_TABLE + 20, 0x2000, true);
    dv.setUint32(RegionMap.BASE.VIRTUAL_MAP_TABLE + 24,
      RegionMap.BASE.VIRTUAL_BACKING_BASE + 0x4000, true);
    assert.strictEqual(e.guest_to_wasm(guest + 0x123) >>> 0,
      (RegionMap.BASE.VIRTUAL_BACKING_BASE + 0x123) >>> 0,
      'legacy scan must still resolve the synthetic sparse mapping');
    e.guest_to_wasm(guest + 0x456);
    e.guest_to_wasm(0x70000000);
    assert.strictEqual(e.test_guest_page_affine_span(spanGuest + 0xff0, 0x20) >>> 0,
      (RegionMap.BASE.VIRTUAL_BACKING_BASE + 0x4ff0) >>> 0,
      'legacy affine scan must validate a contiguous cross-page span');
    e.test_guest_page_affine_span(spanGuest + 0xff0, 0x20);
    e.test_guest_page_affine_span(0x70000000, 0x20);

    assert.strictEqual(stat('direct'), 1, 'direct-window access is counted');
    assert.strictEqual(stat('dib'), 1, 'DIB access is counted');
    assert.strictEqual(stat('legacy_cache_0'), 1, 'newest legacy cache hit is counted');
    assert.strictEqual(stat('legacy_scan_hit'), 1, 'record-scan hit is counted');
    assert.strictEqual(stat('legacy_scan_miss'), 1, 'record-scan miss is counted');
    assert.strictEqual(stat('legacy_scan_records'), 3,
      'scan depth totals every record examined on hits and misses');
    assert.strictEqual(stat('span_legacy_scan_hit'), 1,
      'legacy affine span records its initial table hit');
    assert.strictEqual(stat('span_legacy_cache_hit'), 1,
      'legacy affine span records its subsequent range-cache hit');
    assert.strictEqual(stat('span_legacy_scan_miss'), 1,
      'legacy affine span records an unmapped miss');
    assert.strictEqual(stat('span_legacy_scan_records'), 4,
      'legacy affine scan depth includes hit and miss records');

    e.set_guest_page_translation(1);
    e.reset_guest_page_stats();
    assert.strictEqual(e.guest_to_wasm(guest + 0x789) >>> 0,
      (RegionMap.BASE.VIRTUAL_BACKING_BASE + 0x789) >>> 0,
      'packed lookup must resolve the backfilled sparse mapping');
    assert.strictEqual(e.guest_to_wasm(0x70000000) >>> 0, 0xf0,
      'packed miss remains authoritative in the instrumented artifact');
    assert.strictEqual(e.test_guest_page_affine_span(spanGuest + 0xff0, 0x20) >>> 0,
      (RegionMap.BASE.VIRTUAL_BACKING_BASE + 0x4ff0) >>> 0,
      'packed affine lookup must prove a contiguous cross-page span');
    assert.strictEqual(e.test_guest_page_affine_span(spanGuest, 0) >>> 0,
      (RegionMap.BASE.VIRTUAL_BACKING_BASE + 0x4000) >>> 0,
      'packed affine lookup must preserve a mapped zero-length probe');
    assert.strictEqual(e.test_guest_page_affine_span(spanGuest + 0x1ff0, 0x20) >>> 0, 0xf0,
      'packed affine lookup must reject a span crossing into an unmapped page');
    assert.strictEqual(e.test_guest_page_affine_span(spanGuest, 0xc0000001) >>> 0, 0xf0,
      'packed affine lookup must reject a wrapping span');
    assert.strictEqual(stat('packed_hit'), 1, 'packed hit is counted');
    assert.strictEqual(stat('packed_miss'), 1, 'packed miss is counted');
    assert.strictEqual(stat('legacy_scan_hit') + stat('legacy_scan_miss'), 0,
      'packed lookup must not fall through to legacy scan instrumentation');
    assert.strictEqual(stat('span_packed_hit'), 2, 'packed affine hits are counted');
    assert.strictEqual(stat('span_packed_miss'), 2, 'packed affine misses are counted');
    assert.strictEqual(stat('span_legacy_cache_hit') + stat('span_legacy_scan_hit') +
      stat('span_legacy_scan_miss'), 0,
      'packed affine lookup must not fall through to legacy span instrumentation');

    console.log('PASS  offline page-translation artifact counts paths without instrumenting production');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
