#!/usr/bin/env node

'use strict';

// Render a specimen sheet of every substituted scalable face, drawn by the
// emulator itself.
//
//   node tools/font-specimen.js [--out=path.png] [--text="..."] [--open]
//
// Every glyph on the sheet goes through the real path: the WAT TrueType parser
// reads the mounted font, rasterizes it into an FNT strike, and the bitmap text
// renderer blits it onto a GDI memory DC. Nothing here draws with Canvas, so
// what you see is what a guest sees.
//
// Useful as an eyeball check that a font change did not break a face - the
// automated gates check advances and metrics, which is exactly the kind of
// correctness that can hold while the glyphs come out as boxes.

const fs = require('fs');
const path = require('path');
const { bootRenderHarness } = require('../test/render-helper');
const { fontMounts } = require('../lib/font-substitutions');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const hit = args.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const OUT = path.resolve(argOf('out', path.join(ROOT, 'test', 'output', 'font-specimen.png')));
const TEXT = argOf('text', 'The quick brown fox jumps over the lazy dog 0123456789');
const OPEN = args.includes('--open');

// Every printable byte, which is what a symbol face has to show instead of a
// pangram: Wingdings has no idea what a fox is.
const SYMBOL_TEXT = Array.from({ length: 0x5F }, (_, i) =>
  String.fromCharCode(0x20 + i)).join('');

const WIDTH = 900;
const ROW_PAD = 6;
const LABEL_WIDTH = 210;
const SIZES = [11, 16, 24];

let PNG;
try { ({ PNG } = require('pngjs')); } catch (_) {
  console.error('pngjs is required: npm install pngjs');
  process.exit(1);
}

(async () => {
  const { exports: wat, memory, hostCtx } = await bootRenderHarness();
  const mem = () => new Uint8Array(memory.buffer);
  const imageBase = wat.get_image_base() >>> 0;
  const wa = guest => (0x12000 + ((guest >>> 0) - imageBase)) >>> 0;

  const manifest = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'fonts', 'substitutions.json'), 'utf8'));
  hostCtx.vfs.dirs.add('c:\\windows');
  hostCtx.vfs.dirs.add('c:\\windows\\fonts');
  // The stock strikes draw the labels, so the sheet needs no host font either.
  for (const name of ['System.fon', 'MSSansSerif.fon', 'Fixedsys.fon',
    'Courier.fon', 'Terminal.fon']) {
    hostCtx.vfs.files.set(`c:\\windows\\fonts\\${name.toLowerCase()}`, {
      data: new Uint8Array(fs.readFileSync(path.join(ROOT, 'fonts', name))),
      attrs: 0x20,
    });
  }
  for (const mount of fontMounts(manifest, { subset: true })) {
    hostCtx.vfs.files.set(mount.vfsPath, {
      data: new Uint8Array(fs.readFileSync(path.join(ROOT, 'fonts', mount.file))),
      attrs: 0x20,
    });
  }

  const allocZero = size => {
    const pointer = wat.guest_alloc(size) >>> 0;
    mem().fill(0, wa(pointer), wa(pointer) + size);
    return pointer;
  };
  const allocStr = text => {
    const pointer = allocZero(text.length + 1);
    mem().set(Buffer.from(text, 'latin1'), wa(pointer));
    return pointer;
  };
  const allocFaceW = text => {
    const pointer = allocZero(text.length * 2 + 2);
    [...text].forEach((ch, i) => wat.guest_write16(pointer + i * 2, ch.charCodeAt(0)));
    return pointer;
  };

  // One DC per row, sized to the row: GetPixel is a per-call trip into the
  // emulator, so the sheet is assembled row by row rather than as one tall
  // surface that would be mostly empty.
  const makeDc = (width, height) => {
    const bmi = allocZero(40);
    wat.guest_write32(bmi, 40);
    wat.guest_write32(bmi + 4, width);
    wat.guest_write32(bmi + 8, -height);
    wat.guest_write16(bmi + 12, 1);
    wat.guest_write16(bmi + 14, 32);
    const bitsOut = allocZero(4);
    const bitmap = wat.test_call_CreateDIBSection(0, bmi, bitsOut) >>> 0;
    const hdc = wat.test_call_CreateCompatibleDC(0) >>> 0;
    wat.test_call_SelectObject(hdc, bitmap);
    wat.test_call_PatBlt(hdc, 0, 0, width, height, 0x00FF0062); // WHITENESS
    return hdc;
  };

  const rows = [];
  const addRow = (label, face, weight, italic, size, text) => {
    const height = Math.max(Math.ceil(size * 1.6), 16) + ROW_PAD;
    const hdc = makeDc(WIDTH, height);

    // Label in the stock System face, so a broken substitute cannot also
    // break the caption that says which face it is.
    wat.test_call_SelectObject(hdc, 0x3001D);
    wat.test_call_TextOutA(hdc, 4, 2, allocStr(label), label.length);

    if (face) {
      const font = wat.test_call_CreateFontW(
        -size, weight, italic, allocFaceW(face)) >>> 0;
      wat.test_call_SelectObject(hdc, font);
      wat.test_call_TextOutA(hdc, LABEL_WIDTH, 2, allocStr(text), text.length);
    }
    rows.push({ hdc, height });
  };

  const faces = manifest.faces.filter(f => f.win98Files);
  for (const face of faces) {
    const symbol = face.charset === 'SYMBOL';
    const body = symbol ? SYMBOL_TEXT : TEXT;
    for (const style of Object.keys(face.win98Files)) {
      const weight = style.startsWith('bold') ? 700 : 400;
      const italic = style.endsWith('talic') ? 1 : 0;
      addRow(`${face.win98} ${style} 16`, face.win98, weight, italic, 16, body);
    }
    if (!symbol) {
      for (const size of SIZES) {
        if (size === 16) continue;
        addRow(`${face.win98} regular ${size}`, face.win98, 400, 0, size, body);
      }
    }
  }

  const total = rows.reduce((sum, row) => sum + row.height, 0);
  const png = new PNG({ width: WIDTH, height: total });
  let y0 = 0;
  for (const row of rows) {
    for (let y = 0; y < row.height; y += 1) {
      for (let x = 0; x < WIDTH; x += 1) {
        const colour = wat.test_call_GetPixel(row.hdc, x, y) >>> 0;
        const at = ((y0 + y) * WIDTH + x) * 4;
        // COLORREF is 0x00BBGGRR.
        png.data[at] = colour & 0xFF;
        png.data[at + 1] = (colour >> 8) & 0xFF;
        png.data[at + 2] = (colour >> 16) & 0xFF;
        png.data[at + 3] = 0xFF;
      }
    }
    y0 += row.height;
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, PNG.sync.write(png));
  console.log(`${rows.length} specimens, ${WIDTH}x${total} -> ${OUT}`);
  if (OPEN) require('child_process').spawn('open', [OUT], { detached: true });
  process.exit(0);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
