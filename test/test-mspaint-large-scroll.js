#!/usr/bin/env node

// Large-document Paint regression. Generate a 900x700 BMP, then replace this
// process with the emulator so the decoded bitmap does not coexist with a
// second Node runtime under constrained test environments.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const EXE = path.join(__dirname, 'binaries', 'mspaint.exe');
const OUT = path.join(ROOT, 'scratch', 'mspaint-large-scroll');
const bmpPath = path.join(OUT, 'paint-large.bmp');

if (!fs.existsSync(EXE)) {
  console.log('SKIP  mspaint.exe not found at', EXE);
  process.exit(0);
}

function makeBmp(width, height) {
  const stride = (width * 3 + 3) & ~3;
  const pixels = stride * height;
  const bmp = Buffer.alloc(54 + pixels);
  bmp.write('BM', 0, 'ascii');
  bmp.writeUInt32LE(bmp.length, 2);
  bmp.writeUInt32LE(54, 10);
  bmp.writeUInt32LE(40, 14);
  bmp.writeInt32LE(width, 18);
  bmp.writeInt32LE(height, 22);
  bmp.writeUInt16LE(1, 26);
  bmp.writeUInt16LE(24, 28);
  bmp.writeUInt32LE(pixels, 34);
  const colors = [
    [40, 40, 40], [30, 205, 205], [220, 50, 45], [45, 40, 220],
    [210, 45, 205], [25, 230, 25], [210, 220, 220], [225, 225, 20],
  ];
  for (let y = 0; y < height; y++) {
    const row = 54 + (height - 1 - y) * stride;
    for (let x = 0; x < width; x++) {
      const color = colors[(Math.floor(x / 31) + Math.floor(y / 29) * 3) % colors.length];
      const off = row + x * 3;
      bmp[off] = color[2];
      bmp[off + 1] = color[1];
      bmp[off + 2] = color[0];
    }
  }
  return bmp;
}

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(bmpPath, makeBmp(900, 700));
// Every coordinate here is derived from the live window, and every threshold
// from the bar's own page size. Paint scrolls a quarter page per arrow click,
// so the old pixel constants (70 and 53) were exactly page/4 for a 212x283
// view — and stopped being reachable the moment the frame chrome grew to its
// correct Win98 size and the view became 202x274. The behaviour never changed;
// only the arithmetic's input did. Percentages track it.
const input = [
  `10:vfs-import:paint-large.bmp:${bmpPath}`,
  '24:0x111:57601',
  '32:open-dlg-pick:paint-large.bmp',
  '50:scroll-click:v:hi',
  '52:assert-standard-scroll:v:24%:vertical-arrow',
  '54:scroll-click:h:hi',
  '56:assert-standard-scroll:h:24%:horizontal-arrow',
  '58:scroll-drag:h:58',
  '65:assert-standard-scroll:h:140%:horizontal-thumb',
  '68:caption-click:0x10001:max',
  // Maximizing grows the page, so the surviving position is a smaller share of
  // it than the quarter-page the arrow click produced. These two only assert
  // that the scroll offsets survived the resize rather than being reset.
  '78:assert-standard-scroll:v:15%:maximized-vertical',
  '79:assert-standard-scroll:h:50%:maximized-horizontal',
  '80:dump-windows:maximized',
  '81:stop',
].join(',');

const args = [
  process.execPath,
  RUN,
  `--exe=${EXE}`,
  `--input=${input}`,
  '--max-batches=85',
  '--batch-size=50000',
  '--no-close',
  '--quiet-api',
  '--quiet-blocks',
];

if (typeof process.execve !== 'function') {
  throw new Error('test requires process.execve to avoid a second resident Node runtime');
}
process.execve(process.execPath, args, process.env);
