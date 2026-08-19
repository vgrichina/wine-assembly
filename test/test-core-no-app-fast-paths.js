#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const exportsWat = fs.readFileSync(path.join(ROOT, 'src', '13-exports.wat'), 'utf8');
const decoderWat = fs.readFileSync(path.join(ROOT, 'src', '07-decoder.wat'), 'utf8');
// "Which file is this handler in" is not what these assertions are about — they
// are about the *WAT side* owning the geometry. Reading a fixed pair of files
// made them fail the moment CreatePolygonRgn moved from 09a-handlers.wat to
// 09a4-handlers-gdi.wat, which is a filing change, not a regression.
const allHandlerWat = fs.readdirSync(path.join(ROOT, 'src'))
  .filter(f => /^09a/.test(f) && f.endsWith('.wat'))
  .map(f => fs.readFileSync(path.join(ROOT, 'src', f), 'utf8'))
  .join('\n');
const handlersWat = allHandlerWat;
const gdiHandlersWat = allHandlerWat;
const hostImports = fs.readFileSync(path.join(ROOT, 'lib', 'host-imports.js'), 'utf8');

assert(!/\$?is_winamp\b|winamp_/i.test(exportsWat),
  'main run loop should not contain Winamp-specific helpers');

for (const eip of [
  '0x0040503d',
  '0x00402c47',
  '0x00406740',
  '0x00403b9b',
  '0x0040418a',
  '0x004040ff',
  '0x00403f50',
  '0x004073f0',
  '0x00407573',
]) {
  assert(!exportsWat.includes(eip), `main run loop should not trap Winamp guest EIP ${eip}`);
}

for (const marker of ['0xDEC0DE19', '0xDEC0B10C', '0x01009604', '0x010095f0', '0x01009620']) {
  assert(!exportsWat.includes(marker), `exports should not contain stale app debug marker ${marker}`);
  assert(!decoderWat.includes(marker), `decoder should not contain stale app debug marker ${marker}`);
}

// $decode_block runs for every block of every app, so a guest function address
// from one build of one game does not belong in it. The stack-packet prototype
// is armed from JS with an address and a variant; the decoder reads globals.
for (const eip of ['0x0049D9D1', '0x0049DD20']) {
  assert(!decoderWat.includes(eip),
    `decoder should not test literal guest EIP ${eip} — pass it in via set_stack_packet_enabled`);
}

assert(handlersWat.includes('(call $gdi_rgn_alloc_polygon'),
  'CreatePolygonRgn must route geometry into WAT');
assert(!hostImports.includes('gdi_create_polygon_rgn:'),
  'JavaScript must not own polygon-region geometry');
for (const helper of [
  'gdi_dc_clip_select',
  'gdi_dc_clip_ext_select',
  'gdi_dc_clip_intersect_rect',
  'gdi_dc_clip_exclude_rect',
  'gdi_dc_clip_offset',
  'gdi_dc_clip_get',
  'gdi_dc_clip_get_box',
  'gdi_dc_clip_point_visible',
  'gdi_dc_clip_rect_visible',
]) {
  assert(handlersWat.includes(`(call $${helper}`),
    `public clipping APIs must route through WAT helper ${helper}`);
}
assert(gdiHandlersWat.includes('(call $gdi_line_desc'),
  'LineTo must route its canonical surface descriptor through the WAT raster kernel');
assert(!gdiHandlersWat.includes('(call $host_gdi_line_to'),
  'LineTo must not retain a Canvas geometry fallback');
assert(handlersWat.includes('(call $gdi_polyline_try'),
  'Polyline APIs must try the atomic WAT path raster kernel first');
assert(!handlersWat.includes('(call $host_gdi_polyline'),
  'Polyline must not retain a Canvas geometry fallback');

console.log('PASS  core has no app-specific run-loop fast paths');
