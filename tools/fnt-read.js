#!/usr/bin/env node
'use strict';

// Read the glyph bitmaps out of a Windows bitmap font (.fon / .fnt).
//
//   node tools/fnt-read.js fonts/Terminal.fon [--strikes] [--strike=N]
//                          [--show='Hello'] [--png=out.png] [--scale=N]
//
// A .fon is an NE executable whose RT_FONT resources are each one FNT strike --
// a fixed pixel size of one typeface. A bare .fnt is a single strike with no
// wrapper. Both land in the same reader.
//
// Why this exists: `fonts/Terminal.fon` is the OEM/CP437 font, which is the
// character set an MS-DOS text screen is drawn in, box-drawing glyphs and all.
// Anything that wants to render a DOS console -- tools/toyvm/run-dos.js does --
// needs those exact glyphs, and hand-authoring 256 of them is not an option
// when the real ones are already in the repo. `tools/ne-dump.js` can say that
// the resources are there; only this can say what is inside them.
//
// The FNT bitmap layout is the part worth knowing: glyphs are stored COLUMN
// major. A glyph `width` pixels wide is ceil(width/8) column-groups, each
// `height` bytes tall, and byte `[c*height + r]` holds row r of the 8 pixels
// starting at x = c*8, most significant bit leftmost. Reading it row-major
// produces a recognisable but sheared mess, which is the trap here.

const fs = require('fs');
const path = require('path');

// --- the FNT header ---------------------------------------------------------
// Offsets are from the Windows 3.1 FONTINFO struct. Only the fields a renderer
// needs are pulled out; the rest of the 118-byte header is skipped.
function parseFnt(b, base = 0) {
  const u8 = (o) => b[base + o];
  const u16 = (o) => b.readUInt16LE(base + o);
  const u32 = (o) => b.readUInt32LE(base + o);

  const version = u16(0x00);
  if (version !== 0x0200 && version !== 0x0300) return null;
  const height = u16(0x58);
  const firstChar = u8(0x5F), lastChar = u8(0x60);
  if (!height || lastChar < firstChar) return null;

  const f = {
    version,
    size: u32(0x02),
    points: u16(0x44),
    ascent: u16(0x4A),
    pixWidth: u16(0x56),          // 0 means proportional
    height,
    firstChar, lastChar,
    defaultChar: u8(0x61),
    maxWidth: u16(0x5D),
    bitsOffset: u32(0x71),
    glyphs: new Map(),
    skipped: [],
  };

  // The character table follows the header: one entry per character plus a
  // sentinel. v3 widened the bitmap offset from 16 to 32 bits, which also moves
  // the table start.
  const wide = version === 0x0300;
  const entry = wide ? 6 : 4;
  let p = wide ? 0x94 : 0x76;

  for (let c = firstChar; c <= lastChar; c++, p += entry) {
    if (base + p + entry > b.length) break;
    const w = b.readUInt16LE(base + p);
    const off = wide ? b.readUInt32LE(base + p + 2) : b.readUInt16LE(base + p + 2);
    if (!w || off === 0) { f.skipped.push([c, `w=${w} off=${off}`]); continue; }
    const cols = Math.ceil(w / 8);
    const at = base + off;
    if (at + cols * height > b.length) {
      f.skipped.push([c, `at=0x${at.toString(16)} past EOF`]);
      continue;
    }
    // Unpack to one byte per pixel, row major, so callers never meet the
    // column-major layout at all.
    const bits = new Uint8Array(w * height);
    for (let col = 0; col < cols; col++) {
      for (let row = 0; row < height; row++) {
        const byte = b[at + col * height + row];
        for (let bit = 0; bit < 8; bit++) {
          const x = col * 8 + bit;
          if (x >= w) break;
          bits[row * w + x] = (byte >> (7 - bit)) & 1;
        }
      }
    }
    f.glyphs.set(c, { width: w, height, bits });
  }
  return f.glyphs.size ? f : null;
}

// --- containers -------------------------------------------------------------
// An NE .fon carries its strikes as RT_FONT resources. Rather than depend on
// the NE header being well formed, fall back to scanning for FNT signatures --
// a .fon built by a font editor sometimes has resource offsets that do not
// survive a copy, and the strikes themselves are still intact.
function readStrikes(file) {
  const b = fs.readFileSync(file);
  const out = [];

  // A bare .fnt is just one strike at offset 0.
  const bare = parseFnt(b, 0);
  if (bare) return [bare];

  try {
    const { parse } = require('./ne-dump');
    const h = parse(file);              // ne-dump.parse takes a path, not a buffer
    if (h && h.resTableOff) {
      for (const r of neResources(b, h)) {
        if (r.typeName !== 'RT_FONT') continue;
        const f = parseFnt(b, r.offset);
        if (f) out.push(f);
      }
    }
  } catch { /* fall through to the scan */ }
  if (out.length) return out;

  // Scan: a strike starts with a version word followed by a plausible dfSize
  // that stays inside the file.
  //
  // The RT_FONTDIR resource is the trap here. A FONTDIRENTRY is an ordinal
  // followed by a COPY of the FNT header -- same metrics, same first/last char,
  // no glyph bitmaps behind it. It sits before the real strike, so a scan that
  // accepts the first thing that parses returns a font with correct-looking
  // dimensions and no glyphs. Requiring most of the declared character range to
  // actually resolve is what tells the copy from the original.
  for (let i = 0; i + 0x76 < b.length; i++) {
    const v = b.readUInt16LE(i);
    if (v !== 0x0200 && v !== 0x0300) continue;
    const size = b.readUInt32LE(i + 2);
    if (size < 0x76 || i + size > b.length) continue;
    const f = parseFnt(b, i);
    if (!f) continue;
    const want = (f.lastChar - f.firstChar + 1) / 2;
    if (f.glyphs.size < Math.max(2, want)) continue;
    out.push(f);
    i += Math.max(1, size - 1);
  }
  return out;
}

// The NE resource table, in the form ne-dump.js's own walker produces. Copied
// rather than imported because ne-dump does not export it.
function neResources(b, h) {
  const out = [];
  const start = h.resTableOff;
  if (!start || start + 2 > b.length) return out;
  const shift = b.readUInt16LE(start);
  let p = start + 2;
  while (p + 8 <= b.length) {
    const type = b.readUInt16LE(p);
    if (!type) break;
    const count = b.readUInt16LE(p + 2);
    let q = p + 8;
    for (let i = 0; i < count && q + 12 <= b.length; i++, q += 12) {
      out.push({
        typeName: (type & 0x8000) && (type & 0x7fff) === 8 ? 'RT_FONT' : 'other',
        offset: b.readUInt16LE(q) << shift,
        length: b.readUInt16LE(q + 2) << shift,
      });
    }
    p = p + 8 + count * 12;
  }
  return out;
}

// Pick the strike closest to a wanted cell height -- a console renderer wants
// a specific pixel size, not a point size.
function pickStrike(strikes, height) {
  let best = null, bestD = Infinity;
  for (const s of strikes) {
    const d = Math.abs(s.height - height);
    if (d < bestD) { best = s; bestD = d; }
  }
  return best;
}

module.exports = { readStrikes, parseFnt, pickStrike };

// --- CLI --------------------------------------------------------------------
function main() {
  const args = process.argv.slice(2);
  const file = args.find(a => !a.startsWith('--'));
  if (!file) {
    console.error('usage: node tools/fnt-read.js <font.fon|font.fnt> [--strikes] '
      + '[--strike=N] [--show=TEXT] [--png=out.png] [--scale=N]');
    process.exit(2);
  }
  const arg = (n, d) => {
    const h = args.find(a => a.startsWith(`--${n}=`));
    return h === undefined ? d : h.slice(n.length + 3);
  };
  const strikes = readStrikes(file);
  if (!strikes.length) { console.error(`no FNT strikes in ${file}`); process.exit(1); }

  console.log(`${path.basename(file)}: ${strikes.length} strike(s)`);
  for (const [i, s] of strikes.entries()) {
    console.log(`  [${i}] ${s.pixWidth || 'var'}x${s.height}  ${s.points}pt  `
      + `chars ${s.firstChar}-${s.lastChar} (${s.glyphs.size} present)  `
      + `ascent ${s.ascent}  v${(s.version >> 8).toString(16)}`);
  }
  if (args.includes('--table')) {
    const s0 = strikes[Number(arg('strike', 0))] || strikes[0];
    console.log(`  table: ${[...s0.glyphs.keys()].slice(0, 24).join(' ')}`
      + ` ... (${s0.glyphs.size} keys)`);
    console.log(`  skipped: ${s0.skipped.slice(0, 8).map(
      ([c, why]) => `${c}:${why}`).join(' ')}`);
  }
  if (args.includes('--strikes')) return;

  const s = strikes[Number(arg('strike', 0))] || strikes[0];
  const text = arg('show', null);
  if (text) {
    // ASCII art of the glyphs, which is how you check the column-major unpack
    // without opening an image viewer.
    for (let row = 0; row < s.height; row++) {
      let line = '';
      for (const ch of text) {
        const g = s.glyphs.get(ch.charCodeAt(0)) || s.glyphs.get(s.defaultChar);
        if (!g) continue;
        for (let x = 0; x < g.width; x++) line += g.bits[row * g.width + x] ? '#' : '.';
      }
      console.log(line);
    }
  }

  const png = arg('png', null);
  if (png) {
    const { PNG } = require(path.join(__dirname, '..', 'node_modules', 'pngjs'));
    const scale = Number(arg('scale', 2));
    const cw = s.maxWidth || s.pixWidth || 8;
    const cols = 32, rows = Math.ceil(256 / cols);
    const img = new PNG({ width: cols * cw * scale, height: rows * s.height * scale });
    img.data.fill(0);
    for (let c = 0; c < 256; c++) {
      const g = s.glyphs.get(c);
      if (!g) continue;
      const ox = (c % cols) * cw, oy = Math.floor(c / cols) * s.height;
      for (let y = 0; y < s.height; y++) {
        for (let x = 0; x < g.width; x++) {
          if (!g.bits[y * g.width + x]) continue;
          for (let sy = 0; sy < scale; sy++) {
            for (let sx = 0; sx < scale; sx++) {
              const o = (((oy + y) * scale + sy) * img.width + (ox + x) * scale + sx) * 4;
              img.data[o] = img.data[o + 1] = img.data[o + 2] = 255;
              img.data[o + 3] = 255;
            }
          }
        }
      }
    }
    fs.writeFileSync(png, PNG.sync.write(img));
    console.log(`wrote ${png}`);
  }
}

if (require.main === module) main();
