#!/usr/bin/env node

'use strict';

const assert = require('assert');
const { bootRenderHarness } = require('./render-helper');

(async () => {
  const { exports: wat, memory, gdi } = await bootRenderHarness();
  const dv = new DataView(memory.buffer);
  const desc = 0x07EF1000;

  const screenDc = wat.test_call_GetDC(0) >>> 0;
  assert(screenDc, 'screen DC must exist for alias regression');
  assert.strictEqual(wat.test_call_SetPixel(screenDc, 1, 1, 0x00FF0000) >>> 0,
    0x00FF0000, 'screen seed pixel must be writable');

  const printerDc = wat.test_call_CreateDCA() >>> 0;
  assert(printerDc, 'CreateDCA must allocate a page DC');
  // The 30MB page raster is created on first use, not at CreateDC time: MFC
  // opens a printer DC during startup just to measure the page and usually
  // never draws to it, and an eager page left the DIB arena too full for a
  // screen-sized menu overlay.
  assert.strictEqual(wat.get_printer_bitmap() >>> 0, 0,
    'CreateDCA must not materialize the page raster before it is used');
  assert.strictEqual(wat.test_gdi_surface_descriptor(printerDc, desc), 1);
  const printerBitmap = wat.get_printer_bitmap() >>> 0;
  assert(printerBitmap, 'resolving the printer surface must materialize its page');
  assert.deepStrictEqual([
    dv.getInt32(desc + 4, true),
    dv.getInt32(desc + 8, true),
    dv.getInt32(desc + 16, true),
    dv.getUint32(desc + 68, true),
  ], [2400, 3150, 32, printerBitmap],
  'printer DC must resolve to its canonical 300-DPI printable page');
  assert(gdi.surfacePresentations.has(printerBitmap),
    'printer page may have only a derived Canvas presentation');
  assert.strictEqual(wat.test_call_GetPixel(printerDc, 0, 0) >>> 0, 0x00FFFFFF,
    'fresh printer page must be white');
  assert.strictEqual(wat.test_call_GetPixel(screenDc, 1, 1) >>> 0, 0x00FF0000,
    'printer allocation must not alias or clear the screen surface');

  assert.strictEqual(wat.test_call_StartPage(printerDc), -1,
    'StartPage must reject calls outside a document');
  assert.strictEqual(wat.test_call_StartDocA(printerDc), 1);
  assert.strictEqual(wat.test_call_StartPage(printerDc), 1);
  assert.strictEqual(wat.get_printer_doc_state(), 2);
  assert.strictEqual(wat.get_printer_page_count(), 1);

  const red = wat.test_call_CreateSolidBrush(0x000000FF) >>> 0;
  const rect = wat.guest_alloc(16) >>> 0;
  wat.guest_write32(rect, 10);
  wat.guest_write32(rect + 4, 10);
  wat.guest_write32(rect + 8, 30);
  wat.guest_write32(rect + 12, 25);
  assert.strictEqual(wat.test_call_FillRect(printerDc, rect, red), 1);
  assert.strictEqual(wat.test_call_GetPixel(printerDc, 15, 15) >>> 0, 0x000000FF,
    'printer geometry must write the canonical page');

  const text = wat.guest_alloc(6) >>> 0;
  wat.guest_write16(text, 0x6150); // Pa
  wat.guest_write16(text + 2, 0x6567); // ge
  wat.guest_write16(text + 4, 0);
  assert.strictEqual(wat.test_call_TextOutA(printerDc, 40, 40, text, 4), 1);
  let textInk = 0;
  for (let y = 35; y < 65 && !textInk; y++) {
    for (let x = 35; x < 90; x++) {
      if ((wat.test_call_GetPixel(printerDc, x, y) >>> 0) !== 0x00FFFFFF) {
        textInk++;
        break;
      }
    }
  }
  assert(textInk, 'printer text must commit back into canonical page pixels');

  assert.strictEqual(wat.test_call_EndPage(printerDc), 1);
  assert.strictEqual(wat.test_call_StartPage(printerDc), 1);
  assert.strictEqual(wat.get_printer_page_count(), 2);
  assert.strictEqual(wat.test_call_GetPixel(printerDc, 15, 15) >>> 0, 0x00FFFFFF,
    'each StartPage must reset the reusable canonical page to white');
  assert.strictEqual(wat.test_call_EndPage(printerDc), 1);
  assert.strictEqual(wat.test_call_EndDoc(printerDc), 1);
  assert.strictEqual(wat.get_printer_doc_state(), 0);

  assert.strictEqual(wat.test_call_DeleteDC(printerDc), 1);
  assert.strictEqual(wat.get_printer_bitmap(), 0);
  assert.strictEqual(wat.get_printer_page_count(), 2,
    'printer teardown must retain the completed job page count');
  assert.strictEqual(wat.test_gdi_surface_descriptor(printerDc, desc), 0,
    'DeleteDC must release printer DC state');
  assert.strictEqual(gdi.surfacePresentations.has(printerBitmap), false,
    'DeleteDC must discard the derived page presentation');
  assert.strictEqual(wat.test_call_GetPixel(screenDc, 1, 1) >>> 0, 0x00FF0000,
    'printer teardown must leave the independent screen surface intact');

  const metricsDc = wat.test_call_CreateDCA() >>> 0;
  assert(metricsDc, 'post-job printer metrics DC must remain available');
  assert.strictEqual(wat.get_printer_page_count(), 2,
    'creating a metrics DC must not erase the completed job count');
  assert.strictEqual(wat.test_call_StartDocA(metricsDc), 1);
  assert.strictEqual(wat.get_printer_page_count(), 0,
    'StartDoc must reset the page count for the new job');
  assert.strictEqual(wat.test_call_AbortDoc(metricsDc), 1);
  assert.strictEqual(wat.test_call_DeleteDC(metricsDc), 1);

  console.log('PASS  printer jobs render to an independent canonical WAT page');
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
