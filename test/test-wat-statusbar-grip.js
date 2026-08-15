#!/usr/bin/env node

// The status bar's sizing grip, pixel for pixel.
//
// Ground truth is real Windows 98 under v86 (Paint's status bar, probed with
// `node tools/png-crop.js <shot> --probe=X,Y,W,H`). Counting back from the
// bar's bottom-right corner as dx/dy, the grip covers dx + dy <= 11 and its
// color cycles on (dx + dy) mod 4:
//
//   3 -> 3DHILIGHT   2 -> 3DSHADOW   1 -> 3DSHADOW   0 -> untouched
//
// giving three ribs of one highlight and two shadow pixels, four apart, each
// running from the bottom edge up to the right edge. We used to draw six
// isolated marks in #404040, a color the Win98 grip never contains.

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

(async () => {
  const { exports: wat, memory } = await bootRenderHarness();
  const bytes = new Uint8Array(memory.buffer);

  const W = 24;
  const H = 20;
  const bmi = wat.guest_alloc(40) >>> 0;
  const out = wat.guest_alloc(4) >>> 0;
  for (let offset = 0; offset < 40; offset += 4) wat.guest_write32(bmi + offset, 0);
  wat.guest_write32(out, 0);
  wat.guest_write32(bmi, 40);
  wat.guest_write32(bmi + 4, W);
  wat.guest_write32(bmi + 8, -H);
  wat.guest_write16(bmi + 12, 1);
  wat.guest_write16(bmi + 14, 32);
  const bitmap = wat.test_call_CreateDIBSection(0, bmi, out) >>> 0;
  const bitsGa = wat.guest_read32(out) >>> 0;
  const hdc = wat.test_call_CreateCompatibleDC(0) >>> 0;
  assert(bitmap && bitsGa && hdc, 'CreateDIBSection/DC failed');
  wat.test_call_SelectObject(hdc, bitmap);
  const bits = 0x1C000000 + (bitsGa - 0x50000000);
  const stride = W * 4;

  const FACE = 0xC0C0C0;
  const HILIGHT = 0xFFFFFF;
  const SHADOW = 0x808080;
  // Fill with face first so "untouched" is distinguishable from black.
  const rect = wat.guest_alloc(16) >>> 0;
  wat.guest_write32(rect, 0);
  wat.guest_write32(rect + 4, 0);
  wat.guest_write32(rect + 8, W);
  wat.guest_write32(rect + 12, H);
  assert(wat.test_call_FillRect(hdc, rect, 0x30011), 'FillRect(LTGRAY) failed'); // LTGRAY_BRUSH
  const at = (x, y) => {
    const p = bits + y * stride + x * 4;
    return bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16);
  };

  wat.test_statusbar_draw_size_grip(hdc, W, H);

  let passed = 0;
  let failed = 0;
  const fail = (message) => { failed += 1; console.log(`FAIL  ${message}`); };

  // Every pixel of the bar, checked against the rule — not just the ribs, so
  // a grip that bleeds outside its triangle fails too.
  let ribPixels = 0;
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const dx = W - 1 - x;
      const dy = H - 1 - y;
      const step = (dx + dy) % 4;
      let want = FACE;
      if (dx + dy <= 11) {
        if (step === 3) want = HILIGHT;
        else if (step === 1 || step === 2) want = SHADOW;
      }
      if (want !== FACE) ribPixels += 1;
      const got = at(x, y);
      if (got !== want) {
        fail(`pixel (${x},${y}) dx=${dx} dy=${dy} is #${got.toString(16).padStart(6, '0')}, `
          + `want #${want.toString(16).padStart(6, '0')}`);
        if (failed > 8) { console.log('  (stopping after 8)'); y = H; break; }
      }
    }
  }
  if (!failed) {
    passed += 1;
    console.log(`PASS  grip matches the Win98 rib pattern (${ribPixels} rib pixels)`);
  }

  // The ribs must reach both edges: three highlights along the bottom row and
  // three along the right column, which is what makes it read as a grip.
  const bottomHilights = [...Array(W).keys()].filter(x => at(x, H - 1) === HILIGHT).length;
  const rightHilights = [...Array(H).keys()].filter(y => at(W - 1, y) === HILIGHT).length;
  if (bottomHilights === 3 && rightHilights === 3) {
    passed += 1;
    console.log('PASS  three ribs meet the bottom edge and three meet the right edge');
  } else {
    fail(`ribs at the edges: bottom=${bottomHilights} right=${rightHilights}, want 3 and 3`);
  }

  console.log(`\n${passed}/${passed + failed} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch(error => { console.error(error); process.exit(1); });
