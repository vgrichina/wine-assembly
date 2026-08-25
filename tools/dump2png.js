#!/usr/bin/env node
// Render a run.js `--dump` region as a picture.
//
//   node tools/dump2png.js <log-or-binary> --width=320 --out=sheet.png
//   node tools/dump2png.js run.log --addr=0xb9df84 --width=320 --mode=mask
//
// Every "the guest's buffer is wrong" investigation ends at the same question:
// is this run of bytes the picture it is supposed to be? A hexdump cannot
// answer that -- 100KB of 8bpp indices is legible only as an image -- and the
// png-*.js tools all start from a PNG, which is precisely what you do not have
// when the surface is still inside the emulator. So this takes `--dump`'s own
// output and draws it.
//
// Modes, because "is it right" has three different meanings:
//   gray    (default) byte value as luminance -- shows real structure, and
//           tells a near-black index apart from a zero one
//   mask    zero black, non-zero white. This is how a lot of guest code reads
//           an indexed surface ("not the paper index = ink"), so it shows what
//           the GUEST will make of the buffer rather than what it looks like
//   index   a repeating distinct-hue palette keyed on the byte. Use it to see
//           cell/tile boundaries and stride errors, where gray is too subtle
//
// A stride error is the most common finding here and each has a signature:
// glyphs sheared diagonally = stride off by a few; every other row blank =
// stride doubled; content squeezed into the top fraction = stride halved.
// Pass `--width` deliberately and try the neighbours before concluding the
// data is wrong.

'use strict';

const fs = require('fs');
const { PNG } = require('pngjs');

function usage(msg) {
  if (msg) console.error(`dump2png: ${msg}\n`);
  console.error(`usage: node tools/dump2png.js <log-or-binary> [options]

  --width=N        row width in PIXELS (required)
  --bpp=1|4|8      bits per pixel (default 8). 1 and 4 unpack MSB-first, and
                   the row stride is rounded up to 4 bytes, as every DIB is
  --height=N       rows to draw (default: all the bytes allow)
  --addr=0xADDR    pick one region when the log holds several hexdumps
  --nth=N          pick the Nth region (0-based) -- use when one address was
                   dumped repeatedly, e.g. the same buffer at several batches
  --skip=N         drop N bytes from the front of the region
  --mode=gray|mask|index      how a byte becomes a colour (default gray)
  --scale=N        integer upscale, for 20x20 glyph cells (default 1)
  --grid=N         draw a faint red rule every N pixels, both axes
  --flip           bottom-up DIB: buffer row 0 is the BOTTOM image row. A
                   positive biHeight means bottom-up, which is the default a
                   Windows app gets, so reach for this more often than not
  --out=FILE       output PNG (default: dump.png)
  --binary         read the input as raw bytes instead of hexdump text
  --list           just list the hexdump regions in the log and exit`);
  process.exit(msg ? 1 : 0);
}

const args = process.argv.slice(2);
if (!args.length || args.includes('--help') || args.includes('-h')) usage();

const flag = (name, dflt) => {
  const hit = args.find(a => a.startsWith(`--${name}=`));
  return hit === undefined ? dflt : hit.slice(name.length + 3);
};
const num = (name, dflt) => {
  const v = flag(name, null);
  if (v === null) return dflt;
  const n = /^0x/i.test(v) ? parseInt(v, 16) : parseInt(v, 10);
  if (!Number.isFinite(n)) usage(`--${name} is not a number: ${v}`);
  return n;
};

const file = args.find(a => !a.startsWith('--'));
if (!file) usage('no input file');
if (!fs.existsSync(file)) usage(`no such file: ${file}`);

// A hexdump region is the `Hexdump 0x… (N bytes):` banner plus the indented
// `  0xADDR  xx xx …  ascii` lines under it. Parsing the banner rather than
// just scraping every hex line matters: a log usually carries several dumps
// and an unrelated trace line can look a lot like a dump row.
function parseRegions(text) {
  const regions = [];
  let cur = null;
  for (const line of text.split('\n')) {
    const banner = /^Hexdump (0x[0-9a-fA-F]+) \((\d+) bytes\):/.exec(line);
    if (banner) {
      cur = { addr: parseInt(banner[1], 16) >>> 0, declared: +banner[2], bytes: [] };
      regions.push(cur);
      continue;
    }
    if (!cur) continue;
    const row = /^\s{2}0x[0-9a-fA-F]+\s{2}((?:[0-9a-fA-F]{2} )+)/.exec(line);
    if (!row) { cur = null; continue; }
    for (const b of row[1].trim().split(/\s+/)) cur.bytes.push(parseInt(b, 16));
  }
  return regions;
}

let data, origin = 0;
if (args.includes('--binary')) {
  data = fs.readFileSync(file);
} else {
  const regions = parseRegions(fs.readFileSync(file, 'utf8'));
  if (!regions.length) {
    usage(`no "Hexdump 0x… (N bytes):" region in ${file} — is this a run.js log? ` +
      `(pass --binary for a raw file)`);
  }
  if (args.includes('--list')) {
    for (const r of regions) {
      console.log(`0x${r.addr.toString(16)}  ${r.bytes.length} bytes` +
        (r.bytes.length !== r.declared ? `  (banner said ${r.declared} — truncated log?)` : ''));
    }
    process.exit(0);
  }
  const want = flag('addr', null);
  const nth = flag('nth', null);
  let region;
  if (nth !== null) {
    // A buffer dumped at several batches gives several same-address regions,
    // and which one is interesting is exactly the question when a scratch
    // buffer is being reused underneath you.
    const pool = want === null ? regions
      : regions.filter(r => r.addr === (parseInt(want, 16) >>> 0));
    region = pool[+nth];
    if (!region) usage(`--nth=${nth} but only ${pool.length} matching region(s)`);
  } else if (want !== null) {
    const wantAddr = parseInt(want, 16) >>> 0;
    region = regions.find(r => r.addr === wantAddr);
    if (!region) {
      usage(`no hexdump at 0x${wantAddr.toString(16)}; the log has ` +
        regions.map(r => `0x${r.addr.toString(16)}`).join(', '));
    }
  } else if (regions.length > 1) {
    usage(`the log holds ${regions.length} hexdumps — pick one with --addr= ` +
      `(--list shows them)`);
  } else {
    region = regions[0];
  }
  data = Buffer.from(region.bytes);
  origin = region.addr;
}

const skip = num('skip', 0);
if (skip) data = data.subarray(skip);

const width = num('width', 0);
if (width <= 0) usage('--width is required and must be positive');
const bpp = num('bpp', 8);
if (![1, 4, 8].includes(bpp)) usage(`--bpp must be 1, 4 or 8 (got ${bpp})`);
// DIB rows are DWORD-aligned whatever the depth, and getting that wrong is
// itself one of the shears this tool exists to make visible.
const stride = (Math.ceil(width * bpp / 8) + 3) & ~3;
// Sub-byte depths are unpacked MSB-first here so the caller only ever thinks
// in pixels. A monochrome font sheet read as 8bpp is the classic misreading:
// it looks like 8x-wide glyphs on every eighth scanline over an eighth of the
// buffer, which is easy to mistake for a rasterizer that gave up early.
const flip = args.includes('--flip');
const pixelAt = (x, yIn) => {
  const y = flip ? (height - 1 - yIn) : yIn;
  const row = y * stride;
  if (bpp === 8) return data[row + x];
  if (bpp === 4) {
    const b = data[row + (x >> 1)];
    return (x & 1) ? (b & 15) : (b >> 4);
  }
  return (data[row + (x >> 3)] >> (7 - (x & 7))) & 1;
};
const maxRows = Math.floor(data.length / stride);
const height = Math.min(num('height', maxRows), maxRows);
if (height <= 0) usage(`only ${data.length} bytes — not one full row of ${width} at ${bpp}bpp (stride ${stride})`);
const scale = Math.max(1, num('scale', 1));
const grid = num('grid', 0);
const mode = flag('mode', 'gray');
if (!['gray', 'mask', 'index'].includes(mode)) usage(`unknown --mode=${mode}`);

// Sixteen well-separated hues, so neighbouring indices never look alike. The
// point of index mode is to make a boundary visible, not to be pretty.
const HUES = [
  [0, 0, 0], [228, 26, 28], [55, 126, 184], [77, 175, 74],
  [152, 78, 163], [255, 127, 0], [255, 255, 51], [166, 86, 40],
  [247, 129, 191], [153, 153, 153], [102, 194, 165], [252, 141, 98],
  [141, 160, 203], [231, 138, 195], [166, 216, 84], [255, 217, 47],
];

function colorOf(b) {
  if (mode === 'gray') { const v = bpp === 8 ? b : Math.round(b * 255 / ((1 << bpp) - 1)); return [v, v, v]; }
  if (mode === 'mask') return b ? [255, 255, 255] : [0, 0, 0];
  return b === 0 ? [0, 0, 0] : HUES[b & 15];
}

const png = new PNG({ width: width * scale, height: height * scale });
let nonZero = 0;
const seen = new Set();
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const b = pixelAt(x, y);
    if (b) nonZero++;
    seen.add(b);
    const [r, g, bl] = colorOf(b);
    for (let sy = 0; sy < scale; sy++) {
      for (let sx = 0; sx < scale; sx++) {
        const i = ((y * scale + sy) * png.width + (x * scale + sx)) * 4;
        png.data[i] = r; png.data[i + 1] = g; png.data[i + 2] = bl; png.data[i + 3] = 255;
      }
    }
  }
}
if (grid > 0) {
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const onRule = (x % (grid * scale) === 0) || (y % (grid * scale) === 0);
      if (!onRule) continue;
      const i = (y * png.width + x) * 4;
      png.data[i] = Math.min(255, png.data[i] + 90);
      png.data[i + 1] = png.data[i + 1] >> 1;
      png.data[i + 2] = png.data[i + 2] >> 1;
    }
  }
}

const out = flag('out', 'dump.png');
fs.writeFileSync(out, PNG.sync.write(png));

const total = width * height;
console.log(`${out}: ${width}x${height} ${bpp}bpp (stride ${stride}) from 0x${origin.toString(16)}+${skip}` +
  (scale > 1 ? ` (scaled ${scale}x)` : ''));
console.log(`  ${nonZero}/${total} non-zero (${(nonZero / total * 100).toFixed(1)}%), ` +
  `${seen.size} distinct byte values`);
// Per-row occupancy in eighths, printed as one line. A stride error shows up
// here before you even open the PNG: an alternating run means the stride is
// doubled, and a cliff partway down means the source ran out early.
let bar = '';
const BLOCKS = ' ▁▂▃▄▅▆▇█';
const rowsShown = Math.min(height, 64);
for (let i = 0; i < rowsShown; i++) {
  const y = Math.floor(i * height / rowsShown);
  let n = 0;
  for (let x = 0; x < width; x++) if (data[y * width + x]) n++;
  bar += BLOCKS[Math.min(8, Math.round(n / width * 8))];
}
console.log(`  rows (top→bottom): ${bar}`);
