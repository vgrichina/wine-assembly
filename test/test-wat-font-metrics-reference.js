#!/usr/bin/env node

// Our font metrics against real Windows 98's.
//
// "Liberation Sans is metric-compatible with Arial" is Red Hat's design intent
// until something measures it. test/fixtures/font-metrics.json is a capture of
// GetTextMetricsA, GetCharWidthA and GetTextExtentPoint32A from Windows 98
// running under v86 (tools/v86-reference/probes/font-metrics.c). This asks our
// GDI the same questions and gates the answer.
//
// What the capture established, and what this therefore gates:
//
//   * Advance widths are the compatibility claim, and they hold. Courier New
//     matches Windows 98 on every one of 1140 measured advances; Arial and
//     Times New Roman match on about four in five.
//
//   * The residual is hinting. Windows 98 ran each font's bytecode, which
//     snaps a stem to a whole pixel; ours scales the outline. Win98's 'i' in
//     Arial advances 3px at 10px, 2px at 11px and 3px at 12px — non-monotonic,
//     which no unhinted rasterizer reproduces and which docs/scalable-font-
//     design.md deliberately declines to implement a bytecode VM for. Strings
//     of repeated narrow glyphs are reported, not gated.
//
//   * Vertical metrics are NOT part of metric compatibility. Liberation keeps
//     its own OS/2 vertical values, so cell heights differ from Arial's by a
//     pixel or three at the same requested size. Reported, not gated.
//
//   * Tahoma is substituted by Wine's independently drawn tahoma.ttf, not by a
//     metric-compatible design, and measures like it. Reported, not gated —
//     gating it would only pin a mismatch in place.
//
// The gates are ratchets set just outside today's measurements: they cannot
// prove correctness, but they do catch the day something makes it worse.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { bootRenderHarness } = require('./render-helper');

const FIXTURE = path.join(__dirname, 'fixtures', 'font-metrics.json');
if (!fs.existsSync(FIXTURE)) {
  console.log('SKIP  font-metrics.json reference not captured');
  process.exit(0);
}
const reference = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

// Reference string indices, from the probe's own table.
const SENTENCES = [2, 5];      // what a dialog actually lays out
const REPEATED = [3, 4];       // 'iiiiiiiiii' / 'WWWWWWWWWW' — hinting probes

// Only advance widths are gated. String extents are reported because they are
// currently WRONG for a reason this reference itself uncovered: on the same DC
// with the same font selected, the sum of GetCharWidthA over a string does not
// equal GetTextExtentPoint32A of that string. The per-character path agrees
// with Windows 98 exactly for Courier New; the extent path does not agree with
// either. Gating the extents would pin that disagreement in place, so the test
// measures and prints it instead — see the SELF line in the output.
const BUDGETS = {
  Arial: { exactWidths: 0.80 },
  'Times New Roman': { exactWidths: 0.75 },
  'Courier New': { exactWidths: 0.99 },
};

(async () => {
  const { exports: wat, memory } = await bootRenderHarness();
  const bytes = new Uint8Array(memory.buffer);
  const view = new DataView(memory.buffer);
  const imageBase = wat.get_image_base() >>> 0;
  const wa = guest => (0x12000 + ((guest >>> 0) - imageBase)) >>> 0;
  const allocZero = size => {
    const pointer = wat.guest_alloc(size) >>> 0;
    bytes.fill(0, wa(pointer), wa(pointer) + size);
    return pointer;
  };
  const writeWide = value => {
    const pointer = allocZero((value.length + 1) * 2);
    [...value].forEach((character, index) =>
      wat.guest_write16(pointer + index * 2, character.charCodeAt(0)));
    return pointer;
  };
  const writeAnsi = value => {
    const pointer = allocZero(value.length + 1);
    bytes.set(Buffer.from(value, 'latin1'), wa(pointer));
    return pointer;
  };

  const WIDTH = 640;
  const HEIGHT = 64;
  const bmi = allocZero(40);
  wat.guest_write32(bmi, 40);
  wat.guest_write32(bmi + 4, WIDTH);
  wat.guest_write32(bmi + 8, -HEIGHT);
  wat.guest_write16(bmi + 12, 1);
  wat.guest_write16(bmi + 14, 32);
  const bitsOut = allocZero(4);
  const bitmap = wat.test_call_CreateDIBSection(0, bmi, bitsOut) >>> 0;
  const hdc = wat.test_call_CreateCompatibleDC(0) >>> 0;
  assert(bitmap && hdc, 'metric DC must exist');
  wat.test_call_SelectObject(hdc, bitmap);

  const tm = allocZero(64);
  const widths = allocZero(95 * 4);
  const size = allocZero(8);
  const strings = reference.strings.map(writeAnsi);

  let compared = 0;
  const failures = [];

  console.log('Windows 98 metric reference '
    + `(captured ${reference.provenance.capturedAt.slice(0, 10)})\n`);

  for (const face of reference.faces) {
    const faceName = writeWide(face.name);
    const budget = BUDGETS[face.name];
    let exact = 0;
    let total = 0;
    let worstSentence = 0;
    let worstShort = 0;
    let worstRepeated = 0;
    let worstHeight = 0;
    let worstSelf = 0;
    let selfSamples = 0;
    let selfDisagreements = 0;
    let sizes = 0;

    for (const [request, want] of Object.entries(face.sizes)) {
      // A height the reference itself did not resolve to this face proves
      // nothing about our mapping of it.
      if (want.actualFace !== face.name) continue;
      const font = wat.test_call_CreateFontW(Number(request), 400, 0, faceName) >>> 0;
      if (!font) continue;
      wat.test_call_SelectObject(hdc, font);
      sizes += 1;
      compared += 1;

      if (wat.test_call_GetTextMetricsA(hdc, tm)) {
        worstHeight = Math.max(worstHeight,
          Math.abs(view.getInt32(wa(tm), true) - want.tmHeight));
      }

      if (want.charWidths && wat.test_call_GetCharWidthA(hdc, 0x20, 0x7E, widths)) {
        for (let index = 0; index < want.charWidths.length; index += 1) {
          total += 1;
          if (view.getInt32(wa(widths) + index * 4, true) === want.charWidths[index]) {
            exact += 1;
          }
        }
      }

      for (let index = 0; index < (want.extents || []).length; index += 1) {
        const expected = want.extents[index];
        if (!expected) continue;
        const text = reference.strings[index];
        if (!wat.test_call_GetTextExtentPoint32A(hdc, strings[index], text.length, size)) {
          continue;
        }
        const cx = view.getInt32(wa(size), true);
        const absolute = Math.abs(cx - expected[0]);
        const relative = absolute / Math.max(1, expected[0]);
        if (REPEATED.includes(index)) {
          worstRepeated = Math.max(worstRepeated, relative);
        } else if (SENTENCES.includes(index)) {
          worstSentence = Math.max(worstSentence, relative);
          // The same string measured the other way, which must agree with
          // itself whatever Windows 98 says.
          let sum = 0;
          for (let at = 0; at < text.length; at += 1) {
            const code = text.charCodeAt(at);
            if (code < 0x20 || code > 0x7E) { sum = -1; break; }
            sum += view.getInt32(wa(widths) + (code - 0x20) * 4, true);
          }
          if (sum >= 0) {
            worstSelf = Math.max(worstSelf, Math.abs(sum - cx));
            selfSamples += 1;
            if (sum !== cx) selfDisagreements += 1;
          }
        } else {
          worstShort = Math.max(worstShort, absolute);
        }
      }
    }

    if (!sizes) continue;
    const fraction = total ? exact / total : 0;
    const gated = budget ? '' : '   (reported only)';
    console.log(`  ${face.name}${gated}`);
    console.log(`    advances exact   ${exact}/${total} `
      + `(${(fraction * 100).toFixed(1)}%)`);
    console.log(`    sentence extents within ${(worstSentence * 100).toFixed(1)}%, `
      + `short strings within ${worstShort}px`);
    console.log(`    repeated-glyph strings within ${(worstRepeated * 100).toFixed(1)}% `
      + `(hinting, not gated)`);
    console.log(`    cell height within ${worstHeight}px `
      + `(vertical metrics are not metric compatibility)`);
    console.log(`    SELF: sum(GetCharWidthA) vs GetTextExtentPoint32A differs on `
      + `${selfDisagreements}/${selfSamples} sentences, by up to ${worstSelf}px`);
    if (budget && fraction < budget.exactWidths) {
      failures.push(`${face.name}: ${(fraction * 100).toFixed(1)}% of advances exact, `
        + `budget ${(budget.exactWidths * 100).toFixed(0)}%`);
    }
  }

  assert(compared > 0, 'no face in the reference resolved to itself under Win98');
  if (failures.length) {
    console.log(`\n${failures.length} outside budget:`);
    for (const line of failures.slice(0, 20)) console.log(`  ${line}`);
    if (failures.length > 20) console.log(`  … and ${failures.length - 20} more`);
    console.log('\nFAIL  metrics drifted beyond the measured budget');
    process.exit(1);
  }
  console.log(`\nPASS  ${compared} size records match the Windows 98 reference `
    + 'within the measured budget');
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
