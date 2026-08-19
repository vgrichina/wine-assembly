#!/usr/bin/env node
// The JS side keeps a mirror of a region's bands, but only the compositor ever
// reads it, and only for windows given a shape via SetWindowRgn. Regions used
// for plain GDI clipping -- nearly all of them, since WAT clips its own
// rasterization -- must not push anything across the bridge.
//
// Before this contract existed, every region mirrored itself on creation and on
// every mutation: notepad made 1236 gdi_set_region_bands calls and mspaint 443,
// while gdi_set_window_rgn and get_update_rgn, the only two readers, were called
// zero times in both.

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

(async () => {
  const { exports: e, gdi } = await bootRenderHarness();
  const mirror = gdi.regionPresentations;
  const seen = hrgn => Object.prototype.hasOwnProperty.call(mirror, hrgn);

  // A region nobody has asked JS about stays on the WAT side.
  const clipRgn = e.test_gdi_rgn_alloc_rect(10, 20, 110, 220) >>> 0;
  assert.ok(clipRgn, 'region allocation should return a handle');
  assert.ok(!seen(clipRgn), 'a freshly created region must not be mirrored to JS');

  // Mutating it stays local too.
  e.test_gdi_rgn_set_rect(clipRgn, 0, 0, 50, 50);
  assert.ok(!seen(clipRgn), 'mutating an unmirrored region must not push bands to JS');

  // ...and so does destroying it.
  e.test_gdi_rgn_delete(clipRgn);
  assert.ok(!seen(clipRgn), 'deleting an unmirrored region must not touch JS');

  // A region the compositor needs is primed on demand, bands and all.
  const shapeRgn = e.test_gdi_rgn_alloc_rect(5, 6, 105, 206) >>> 0;
  assert.ok(!seen(shapeRgn), 'still lazy before anyone asks');
  e.gdi_rgn_mirror_ensure(shapeRgn);
  assert.ok(seen(shapeRgn), 'SetWindowRgn path must prime the mirror');
  const primed = mirror[shapeRgn];
  assert.strictEqual(primed.type, 'region', 'primed entry should be a region');
  assert.deepStrictEqual(
    { l: primed.bbox.l, t: primed.bbox.t, r: primed.bbox.r, b: primed.bbox.b },
    { l: 5, t: 6, r: 105, b: 206 },
    'primed mirror should carry the region bands, not an empty placeholder');

  // Once JS holds it, later edits have to keep it in step -- otherwise a shaped
  // window would composite against a stale outline.
  e.test_gdi_rgn_set_rect(shapeRgn, 0, 0, 40, 80);
  const updated = mirror[shapeRgn];
  assert.deepStrictEqual(
    { l: updated.bbox.l, t: updated.bbox.t, r: updated.bbox.r, b: updated.bbox.b },
    { l: 0, t: 0, r: 40, b: 80 },
    'a live mirror must follow mutations');

  // And releasing it tells JS to let go, so handles can be recycled safely.
  e.test_gdi_rgn_delete(shapeRgn);
  assert.ok(!seen(shapeRgn), 'deleting a mirrored region must clear the JS entry');

  console.log('PASS  regions stay WAT-side until the compositor asks for one');
  console.log('PASS  a primed mirror carries bands, follows edits, and is released');
})().catch(err => {
  console.error(err && err.stack || err);
  process.exit(1);
});
