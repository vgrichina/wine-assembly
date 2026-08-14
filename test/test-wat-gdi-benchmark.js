#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { bootRenderHarness } = require('./render-helper');

const SAMPLE_COUNT = Math.max(3, Number(process.env.GDI_BENCH_SAMPLES) || 5);
const SCALE = Math.max(0.1, Number(process.env.GDI_BENCH_SCALE) || 1);

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function formatNumber(value) {
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}k`;
  return value.toFixed(0);
}

(async () => {
  const fallbackCalls = { bind: 0, out: 0, ext: 0, draw: 0 };
  const harness = await bootRenderHarness({
    extraHostOverrides: {
      gdi_text_bind: () => { fallbackCalls.bind++; return 1; },
      gdi_text_out: () => { fallbackCalls.out++; return 1; },
      gdi_ext_text_out: () => { fallbackCalls.ext++; return 1; },
      gdi_draw_text: () => { fallbackCalls.draw++; return 1; },
    },
  });
  const { exports: wat, memory, hostCtx } = harness;
  const root = path.join(__dirname, '..');
  hostCtx.vfs.dirs.add('c:\\windows');
  hostCtx.vfs.dirs.add('c:\\windows\\fonts');
  for (const name of [
    'System.fon', 'MSSansSerif.fon', 'Fixedsys.fon', 'Courier.fon', 'Terminal.fon',
  ]) {
    hostCtx.vfs.files.set(`c:\\windows\\fonts\\${name.toLowerCase()}`, {
      data: new Uint8Array(fs.readFileSync(path.join(root, 'fonts', name))),
      attrs: 0x20,
    });
  }

  const bytes = new Uint8Array(memory.buffer);
  const imageBase = wat.get_image_base() >>> 0;
  const toWasm = guest => (0x12000 + ((guest >>> 0) - imageBase)) >>> 0;
  const dibToWasm = guest => (0x1C000000 + ((guest >>> 0) - 0x50000000)) >>> 0;
  const allocZero = size => {
    const pointer = wat.guest_alloc(size) >>> 0;
    bytes.fill(0, toWasm(pointer), toWasm(pointer) + size);
    return pointer;
  };
  const makeDib = (width, height) => {
    const bmi = allocZero(40);
    const bitsOut = allocZero(4);
    wat.guest_write32(bmi, 40);
    wat.guest_write32(bmi + 4, width);
    wat.guest_write32(bmi + 8, -height);
    wat.guest_write16(bmi + 12, 1);
    wat.guest_write16(bmi + 14, 32);
    const bitmap = wat.test_call_CreateDIBSection(0, bmi, bitsOut) >>> 0;
    const hdc = wat.test_call_CreateCompatibleDC(0) >>> 0;
    const bitsGuest = wat.guest_read32(bitsOut) >>> 0;
    assert(bitmap && hdc && bitsGuest, 'benchmark DIB allocation failed');
    assert.strictEqual(wat.test_call_SelectObject(hdc, bitmap) >>> 0, 0x30007);
    return { bitmap, hdc, bitsWa: dibToWasm(bitsGuest), width, height };
  };
  const pixel = (surface, x, y) => {
    const address = surface.bitsWa + (y * surface.width + x) * 4;
    return bytes[address] | (bytes[address + 1] << 8) | (bytes[address + 2] << 16);
  };
  const hashSurface = surface => {
    let hash = 0x811C9DC5;
    const end = surface.bitsWa + surface.width * surface.height * 4;
    for (let address = surface.bitsWa; address < end; address++) {
      hash = Math.imul(hash ^ bytes[address], 0x01000193) >>> 0;
    }
    return hash;
  };

  const source = makeDib(256, 256);
  const target = makeDib(256, 256);
  const redBrush = wat.test_call_CreateSolidBrush(0x000000FF) >>> 0;
  const greenBrush = wat.test_call_CreateSolidBrush(0x0000FF00) >>> 0;
  const bluePen = wat.test_call_CreatePen(0, 1, 0x00FF0000) >>> 0;
  assert(redBrush && greenBrush && bluePen);
  wat.test_call_SelectObject(source.hdc, redBrush);
  assert.strictEqual(wat.test_call_PatBlt(source.hdc, 0, 0, 256, 256, 0x00F00021), 1);
  wat.test_call_SelectObject(target.hdc, greenBrush);
  wat.test_call_SelectObject(target.hdc, bluePen);

  const textValue = Buffer.from('GDI benchmark 98', 'latin1');
  const text = allocZero(textValue.length + 1);
  bytes.set(textValue, toWasm(text));

  const workloads = [
    {
      name: 'SetPixel', count: 3000, pixels: 1, minRate: 5000,
      run(count) {
        for (let i = 0; i < count; i++) {
          wat.test_call_SetPixel(target.hdc, i & 255, (i >>> 8) & 255, 0x000000FF);
        }
      },
      verify() { assert.strictEqual(pixel(target, 1, 0), 0xFF0000); },
    },
    {
      name: 'LineTo 128px', count: 300, pixels: 128, minRate: 200,
      run(count) {
        for (let i = 0; i < count; i++) {
          const y = i & 127;
          wat.test_call_MoveToEx(target.hdc, 0, y);
          wat.test_call_LineTo(target.hdc, 128, 127 - y);
        }
      },
      verify() { assert.strictEqual(pixel(target, 64, 64), 0x0000FF); },
    },
    {
      name: 'Rectangle 64x48', count: 300, pixels: 64 * 48, minRate: 25, fastPath: 0,
      run(count) {
        for (let i = 0; i < count; i++) {
          const x = i & 31;
          const y = (i * 3) & 31;
          wat.test_call_Rectangle(target.hdc, x, y, x + 64, y + 48);
        }
      },
      verify() { assert.strictEqual(pixel(target, 32, 32), 0x00FF00); },
    },
    {
      name: 'PatBlt 64x64', count: 200, pixels: 64 * 64, minRate: 20, fastPath: 1,
      run(count) {
        for (let i = 0; i < count; i++) {
          wat.test_call_PatBlt(target.hdc, i & 31, (i * 5) & 31, 64, 64, 0x00F00021);
        }
      },
      verify() { assert.strictEqual(pixel(target, 32, 32), 0x00FF00); },
    },
    {
      name: 'BitBlt 128x128', count: 150, pixels: 128 * 128, minRate: 8, fastPath: 1,
      run(count) {
        for (let i = 0; i < count; i++) {
          wat.test_call_BitBlt(target.hdc, i & 31, (i * 3) & 31, 128, 128,
            source.hdc, 0, 0, 0x00CC0020);
        }
      },
      verify() { assert.strictEqual(pixel(target, 64, 64), 0xFF0000); },
    },
    {
      name: 'StretchBlt 64->128', count: 60, pixels: 128 * 128, minRate: 8, fastPath: 2,
      run(count) {
        for (let i = 0; i < count; i++) {
          wat.test_call_StretchBlt(target.hdc, 0, 0, 128, 128,
            source.hdc, 0, 0, 64, 64, 0x00CC0020);
        }
      },
      verify() { assert.strictEqual(pixel(target, 100, 100), 0xFF0000); },
    },
    {
      name: 'TextOut bitmap', count: 500, pixels: textValue.length * 8 * 16, minRate: 50,
      before() { this.beforeHash = hashSurface(target); },
      run(count) {
        for (let i = 0; i < count; i++) {
          wat.test_call_TextOutA(target.hdc, i & 63, (i * 13) & 223,
            text, textValue.length);
        }
      },
      verify() {
        assert(wat.test_gdi_bitmap_font_selected(target.hdc),
          'stock font benchmark must use the WAT bitmap-font path');
        assert.deepStrictEqual(fallbackCalls, { bind: 0, out: 0, ext: 0, draw: 0 },
          'stock text benchmark entered the Canvas fallback');
        assert.notStrictEqual(hashSurface(target), this.beforeHash,
          'bitmap-font benchmark did not change canonical surface pixels');
      },
    },
  ];

  const results = [];
  for (const workload of workloads) {
    const count = Math.max(1, Math.round(workload.count * SCALE));
    if (workload.before) workload.before();
    const fastBefore = workload.fastPath === undefined
      ? 0 : wat.test_gdi_fast_count(workload.fastPath);
    workload.run(Math.max(1, Math.round(count / 10)));
    const samples = [];
    for (let sample = 0; sample < SAMPLE_COUNT; sample++) {
      const started = process.hrtime.bigint();
      workload.run(count);
      samples.push(Number(process.hrtime.bigint() - started) / 1e6);
    }
    workload.verify();
    if (workload.fastPath !== undefined) {
      assert(wat.test_gdi_fast_count(workload.fastPath) > fastBefore,
        `${workload.name} did not enter its canonical 32-bpp fast path`);
    }
    const elapsedMs = median(samples);
    const rate = count * 1000 / elapsedMs;
    assert(rate >= workload.minRate,
      `${workload.name} catastrophic regression: ${rate.toFixed(1)} < ${workload.minRate} calls/s`);
    results.push({ ...workload, count, elapsedMs, rate });
  }

  const widths = { name: 20, calls: 8, ms: 10, rate: 12, pixels: 12 };
  console.log('+----------------------+----------+------------+--------------+--------------+');
  console.log('| Workload             | Calls    | Median ms  | Calls/sec    | Mpixels/sec  |');
  console.log('+----------------------+----------+------------+--------------+--------------+');
  for (const result of results) {
    const columns = [
      result.name.padEnd(widths.name),
      String(result.count).padStart(widths.calls),
      result.elapsedMs.toFixed(2).padStart(widths.ms),
      formatNumber(result.rate).padStart(widths.rate),
      (result.rate * result.pixels / 1e6).toFixed(2).padStart(widths.pixels),
    ];
    console.log(`| ${columns.join(' | ')} |`);
  }
  console.log('+----------------------+----------+------------+--------------+--------------+');
  console.log(`PASS  ${results.length} public-handler GDI workloads; ${SAMPLE_COUNT} samples, median reported`);
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
