#!/usr/bin/env node
'use strict';

// Build small RTF documents containing metafile pictures, for reproducing the
// "WordPad grinds while formatting" case without going through a save first.
//
// The bug this exists for: a document with ONE picture loads in well under a
// second, and so does a text-only document of any size — but a picture plus any
// substantial amount of other content (a second picture, or a few thousand
// characters of text) makes the load take minutes, at 100% CPU, with almost no
// Win32 API calls and no host-import traffic. Time per batch grows as it goes,
// which is what a layout or word-wrap loop looks like when it cannot converge.
//
//   node tools/make-rtf-probe.js --pics=2 --out=/tmp/two.rtf         # slow
//   node tools/make-rtf-probe.js --pics=1 --out=/tmp/one.rtf         # fast
//   node tools/make-rtf-probe.js --pics=1 --words=1200 --out=/tmp/mix.rtf  # slow
//   node tools/make-rtf-probe.js --pics=0 --words=1200 --out=/tmp/txt.rtf  # fast
//
// Then:
//   node test/run.js --exe=test/binaries/win98-apps/wordpad.exe --no-close \
//     --batch-size=2000 --max-batches=400 --quiet-api --quiet-blocks \
//     --repaint-every=100000 \
//     --input=60:vfs-import:p.rtf:/tmp/two.rtf,80:0x111:57601,140:open-dlg-pick:p.rtf
//
// The picture is a checkerboard DIB wrapped in a one-record Windows metafile,
// the same shape OLE hands a container for a static picture object.

const fs = require('fs');

const arg = (name, dflt) => {
  const hit = process.argv.slice(2).find(a => a.startsWith(`--${name}=`));
  return hit === undefined ? dflt : hit.slice(name.length + 3);
};

const WIDTH = parseInt(arg('width', '32'), 10);
const HEIGHT = parseInt(arg('height', '24'), 10);
const PICS = parseInt(arg('pics', '2'), 10);
const WORDS = parseInt(arg('words', '0'), 10);
const OUT = arg('out', null);

if (!OUT) {
  console.error('usage: make-rtf-probe.js --out=FILE [--pics=N] [--words=N] [--width=W] [--height=H]');
  process.exit(2);
}

// A packed 24-bpp bottom-up DIB: red/blue 8-pixel checks, so a rendered result
// is easy to tell from an empty box.
function dib(w, h) {
  const stride = (w * 3 + 3) & ~3;
  const head = Buffer.alloc(40);
  head.writeUInt32LE(40, 0);
  head.writeInt32LE(w, 4);
  head.writeInt32LE(h, 8);
  head.writeUInt16LE(1, 12);
  head.writeUInt16LE(24, 14);
  head.writeUInt32LE(stride * h, 20);
  const bits = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const red = (((x >> 3) + (y >> 3)) % 2) === 0;
      const p = y * stride + x * 3;
      bits[p] = red ? 0 : 255;        // B
      bits[p + 1] = 0;                // G
      bits[p + 2] = red ? 255 : 0;    // R
    }
  }
  return Buffer.concat([head, bits]);
}

// One META_STRETCHDIB record, plus the mapping-mode preamble a container needs
// to place it. Same layout CloseMetaFile produces.
function metafile(w, h) {
  const image = dib(w, h);
  const stretch = image.length + 28;
  const total = (image.length + 90 + 1) & ~1;
  const b = Buffer.alloc(total);
  b.writeUInt16LE(1, 0);          // memory metafile
  b.writeUInt16LE(9, 2);          // header size in words
  b.writeUInt16LE(0x0300, 4);     // version
  b.writeUInt32LE(total >> 1, 6);
  b.writeUInt32LE(stretch >> 1, 12);
  b.writeUInt32LE(4, 18); b.writeUInt16LE(0x0103, 22); b.writeUInt16LE(8, 24);   // SetMapMode ANISOTROPIC
  b.writeUInt32LE(5, 26); b.writeUInt16LE(0x020B, 30);                           // SetWindowOrg 0,0
  b.writeUInt32LE(5, 36); b.writeUInt16LE(0x020C, 40); b.writeUInt16LE(h, 42); b.writeUInt16LE(w, 44);
  b.writeUInt32LE(5, 46); b.writeUInt16LE(0x020E, 50); b.writeUInt16LE(h, 52); b.writeUInt16LE(w, 54);
  b.writeUInt32LE(stretch >> 1, 56);
  b.writeUInt16LE(0x0F43, 60);
  b.writeUInt32LE(0x00CC0020, 62);            // SRCCOPY
  b.writeUInt16LE(h, 68); b.writeUInt16LE(w, 70);
  b.writeUInt16LE(h, 76); b.writeUInt16LE(w, 78);
  image.copy(b, 84);
  b.writeUInt32LE(3, total - 6);              // META_EOF
  return b;
}

const mf = metafile(WIDTH, HEIGHT).toString('hex');
// picwgoal/pichgoal are twips: the display size, here the pixel size at 96dpi.
const goalW = Math.round(WIDTH * 1440 / 96);
const goalH = Math.round(HEIGHT * 1440 / 96);
const pic = `{\\pict\\wmetafile8\\picw${WIDTH}\\pich${HEIGHT}` +
            `\\picwgoal${goalW}\\pichgoal${goalH} ${mf}\n}`;

let body = '\\pard\\f0\\fs20 before ';
if (WORDS > 0) body += 'word '.repeat(WORDS);
body += pic.repeat(PICS);
body += '\\par\n';

const rtf = '{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0\\fnil Times New Roman;}}\n' + body + '}\n';
fs.writeFileSync(OUT, rtf, 'latin1');
console.log(`${OUT}: ${rtf.length} bytes, ${PICS} picture(s) ${WIDTH}x${HEIGHT}, ${WORDS} words`);
