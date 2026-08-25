#!/usr/bin/env node
// Build one labelled contact sheet from a pile of app screenshots.
//
// Sweeping the app registry produces hundreds of PNGs across scratchpad
// directories with inconsistent names (`dx_ddex3-b.png`, `d_diablo_demo.png`,
// `sol2.png`), and the only way to judge "do all the apps still work" is to
// look at them all at once. This resolves each capture back to an app id from
// lib/apps.js, picks one per app, and tiles them into a single labelled image.
//
//   node tools/app-contact-sheet.js --dir=DIR [--dir=DIR2] [--out=sheet.png]
//        [--cols=N] [--cell=WxH] [--pick=largest|newest] [--ids=a,b,c]
//        [--include-unmatched] [--list] [--open]
//
// --pick=largest is the default and is deliberate: a failed capture is a flat
// desktop-teal 640x480 PNG that compresses to ~2KB, while a real frame is
// 50KB-400KB, so the biggest file for an app is almost always its best one.
// --pick=newest takes the most recent capture instead.
//
// Pure JS: pngjs only, same as every other tool here. No ImageMagick.
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

// ---- 5x7 bitmap font ------------------------------------------------------
// App ids are [a-z0-9_-] plus the odd dot, so that is all this covers.
// Uppercase folds to the lowercase glyph; anything unknown renders blank.
const FONT_ROWS = 7, FONT_COLS = 5;
const GLYPHS = {
  a: '.....|.###.|....#|.####|#...#|#...#|.####',
  b: '#....|#....|####.|#...#|#...#|#...#|####.',
  c: '.....|.....|.####|#....|#....|#....|.####',
  d: '....#|....#|.####|#...#|#...#|#...#|.####',
  e: '.....|.....|.###.|#...#|#####|#....|.####',
  f: '..##.|.#..#|.#...|####.|.#...|.#...|.#...',
  g: '.....|.####|#...#|#...#|.####|....#|.###.',
  h: '#....|#....|####.|#...#|#...#|#...#|#...#',
  i: '..#..|.....|.##..|..#..|..#..|..#..|.###.',
  j: '...#.|.....|..##.|...#.|...#.|#..#.|.##..',
  k: '#....|#....|#..#.|#.#..|##...|#.#..|#..#.',
  l: '.##..|..#..|..#..|..#..|..#..|..#..|.###.',
  m: '.....|.....|##.#.|#.#.#|#.#.#|#...#|#...#',
  n: '.....|.....|####.|#...#|#...#|#...#|#...#',
  o: '.....|.....|.###.|#...#|#...#|#...#|.###.',
  p: '.....|####.|#...#|#...#|####.|#....|#....',
  q: '.....|.####|#...#|#...#|.####|....#|....#',
  r: '.....|.....|#.##.|##..#|#....|#....|#....',
  s: '.....|.....|.####|#....|.###.|....#|####.',
  t: '.#...|.#...|####.|.#...|.#...|.#..#|..##.',
  u: '.....|.....|#...#|#...#|#...#|#..##|.##.#',
  v: '.....|.....|#...#|#...#|#...#|.#.#.|..#..',
  w: '.....|.....|#...#|#...#|#.#.#|#.#.#|.#.#.',
  x: '.....|.....|#...#|.#.#.|..#..|.#.#.|#...#',
  y: '.....|#...#|#...#|#...#|.####|....#|.###.',
  z: '.....|.....|#####|...#.|..#..|.#...|#####',
  0: '.###.|#...#|#..##|#.#.#|##..#|#...#|.###.',
  1: '..#..|.##..|..#..|..#..|..#..|..#..|.###.',
  2: '.###.|#...#|....#|...#.|..#..|.#...|#####',
  3: '#####|...#.|..#..|...#.|....#|#...#|.###.',
  4: '...#.|..##.|.#.#.|#..#.|#####|...#.|...#.',
  5: '#####|#....|####.|....#|....#|#...#|.###.',
  6: '..##.|.#...|#....|####.|#...#|#...#|.###.',
  7: '#####|....#|...#.|..#..|.#...|.#...|.#...',
  8: '.###.|#...#|#...#|.###.|#...#|#...#|.###.',
  9: '.###.|#...#|#...#|.####|....#|...#.|.##..',
  _: '.....|.....|.....|.....|.....|.....|#####',
  '-': '.....|.....|.....|#####|.....|.....|.....',
  '.': '.....|.....|.....|.....|.....|.##..|.##..',
};
for (const k of Object.keys(GLYPHS)) GLYPHS[k] = GLYPHS[k].split('|');

// ---- tiny RGBA canvas -----------------------------------------------------
const makeSurface = (w, h, rgb) => {
  const px = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    px[i * 4] = rgb[0]; px[i * 4 + 1] = rgb[1]; px[i * 4 + 2] = rgb[2]; px[i * 4 + 3] = 255;
  }
  return { w, h, px };
};

const drawText = (dst, text, x, y, scale, rgb) => {
  let cx = x;
  for (const rawCh of String(text)) {
    const ch = rawCh.toLowerCase();
    const glyph = GLYPHS[ch];
    if (glyph) {
      for (let gy = 0; gy < FONT_ROWS; gy++) {
        for (let gx = 0; gx < FONT_COLS; gx++) {
          if (glyph[gy][gx] !== '#') continue;
          for (let sy = 0; sy < scale; sy++) {
            const py = y + gy * scale + sy;
            if (py < 0 || py >= dst.h) continue;
            for (let sx = 0; sx < scale; sx++) {
              const pxx = cx + gx * scale + sx;
              if (pxx < 0 || pxx >= dst.w) continue;
              const o = (py * dst.w + pxx) * 4;
              dst.px[o] = rgb[0]; dst.px[o + 1] = rgb[1]; dst.px[o + 2] = rgb[2]; dst.px[o + 3] = 255;
            }
          }
        }
      }
    }
    cx += (FONT_COLS + 1) * scale;
  }
  return cx - x;
};

const textWidth = (text, scale) => String(text).length * (FONT_COLS + 1) * scale;

// Box-average resample. Captures are 640x480 into a 320x240 cell far more
// often than not, i.e. an exact 2x reduction, and averaging keeps the
// one-pixel UI detail that nearest-neighbour throws away.
const drawScaled = (dst, src, dx, dy, dw, dh) => {
  const sxScale = src.width / dw;
  const syScale = src.height / dh;
  for (let y = 0; y < dh; y++) {
    const sy0 = Math.floor(y * syScale);
    const sy1 = Math.max(sy0 + 1, Math.floor((y + 1) * syScale));
    for (let x = 0; x < dw; x++) {
      const sx0 = Math.floor(x * sxScale);
      const sx1 = Math.max(sx0 + 1, Math.floor((x + 1) * sxScale));
      let r = 0, g = 0, b = 0, n = 0;
      for (let sy = sy0; sy < sy1 && sy < src.height; sy++) {
        for (let sx = sx0; sx < sx1 && sx < src.width; sx++) {
          const o = (sy * src.width + sx) * 4;
          r += src.data[o]; g += src.data[o + 1]; b += src.data[o + 2]; n++;
        }
      }
      if (!n) continue;
      const px = dx + x, py = dy + y;
      if (px < 0 || px >= dst.w || py < 0 || py >= dst.h) continue;
      const o = (py * dst.w + px) * 4;
      dst.px[o] = r / n | 0; dst.px[o + 1] = g / n | 0; dst.px[o + 2] = b / n | 0; dst.px[o + 3] = 255;
    }
  }
};

// ---- capture -> app id ----------------------------------------------------
// Sweep captures are named by hand and by subagents, so accept the common
// decorations rather than demanding an exact match.
const idCandidates = (base) => {
  const stem = base.replace(/\.png$/i, '');
  return [
    stem,
    stem.replace(/-(?:a|b|c|\d+)$/, ''),      // dx_ddex3-b
    stem.replace(/^d_/, ''),                   // d_diablo_demo
    stem.replace(/_\d+$/, ''),                 // scr_jazz_18000
    stem.replace(/\d+$/, ''),                  // sol2
  ];
};

const walkPngs = (dir, out = []) => {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const ent of ents) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walkPngs(p, out);
    else if (/\.png$/i.test(ent.name)) out.push(p);
  }
  return out;
};

const loadAppIds = () => {
  const apps = require(path.join(__dirname, '..', 'lib', 'apps.js'));
  return [...new Set([
    ...Object.keys(apps.APPS || {}),
    ...Object.keys(apps.DEBUG_ONLY_APPS || {}),
    ...Object.keys(apps.LOCAL_CANDIDATE_APPS || {}),
  ])].filter(id => !/^\d+$/.test(id));
};

// ---- main -----------------------------------------------------------------
const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const hit = args.find(a => a.startsWith(`--${name}=`));
  return hit === undefined ? dflt : hit.slice(name.length + 3);
};
const has = name => args.includes(`--${name}`);

const dirs = args.filter(a => a.startsWith('--dir=')).map(a => a.slice(6));
if (!dirs.length || has('help')) {
  console.log('usage: node tools/app-contact-sheet.js --dir=DIR [--dir=DIR2] [--out=sheet.png]');
  console.log('       [--cols=N] [--cell=WxH] [--pick=largest|newest] [--ids=a,b,c]');
  console.log('       [--include-unmatched] [--list] [--open]');
  process.exit(dirs.length ? 0 : 1);
}

const outPath = path.resolve(flag('out', 'app-contact-sheet.png'));
const pick = flag('pick', 'largest');
const onlyIds = flag('ids', '') ? new Set(flag('ids', '').split(',').map(s => s.trim())) : null;
const [cellW, cellH] = flag('cell', '320x240').split('x').map(n => parseInt(n, 10) || 0);
const ids = loadAppIds();
const idSet = new Set(ids);

const best = new Map();
let scanned = 0;
for (const dir of dirs) {
  for (const p of walkPngs(path.resolve(dir))) {
    scanned++;
    let st;
    try { st = fs.statSync(p); } catch (_) { continue; }
    let id = null;
    for (const cand of idCandidates(path.basename(p))) {
      if (idSet.has(cand)) { id = cand; break; }
    }
    if (!id) {
      if (!has('include-unmatched')) continue;
      id = path.basename(p).replace(/\.png$/i, '');
    }
    if (onlyIds && !onlyIds.has(id)) continue;
    const rank = pick === 'newest' ? st.mtimeMs : st.size;
    const cur = best.get(id);
    if (!cur || rank > cur.rank) best.set(id, { p, rank, size: st.size });
  }
}

const order = [...(has('include-unmatched') ? best.keys() : ids.filter(id => best.has(id)))];
console.error(`[contact-sheet] scanned ${scanned} png(s), matched ${best.size} of ${ids.length} app ids (pick=${pick})`);

if (has('list')) {
  for (const id of order) console.log(`${id}\t${best.get(id).p}`);
  process.exit(0);
}
if (!order.length) {
  console.error('[contact-sheet] nothing to tile — no capture resolved to an app id');
  process.exit(1);
}

const cols = parseInt(flag('cols', String(Math.ceil(Math.sqrt(order.length * 1.4)))), 10);
const rows = Math.ceil(order.length / cols);
const PAD = 6;
const LABEL_SCALE = 2;
const LABEL_H = FONT_ROWS * LABEL_SCALE + 6;
const tileW = cellW + PAD * 2;
const tileH = cellH + LABEL_H + PAD * 2;
const HEADER = 44;
const sheet = makeSurface(cols * tileW, HEADER + rows * tileH, [0x10, 0x14, 0x18]);

drawText(sheet, `wine-assembly  ${order.length} apps`, PAD * 2, 14, 3, [0xd8, 0xe2, 0xea]);

order.forEach((id, i) => {
  const cx = (i % cols) * tileW;
  const cy = HEADER + Math.floor(i / cols) * tileH;
  let src;
  try { src = PNG.sync.read(fs.readFileSync(best.get(id).p)); } catch (err) {
    console.error(`[contact-sheet] skipping ${id}: ${err.message}`);
    return;
  }
  // Letterbox: keep the app's aspect ratio, centre it in the cell.
  const scale = Math.min(cellW / src.width, cellH / src.height);
  const dw = Math.max(1, Math.round(src.width * scale));
  const dh = Math.max(1, Math.round(src.height * scale));
  drawScaled(sheet, src, cx + PAD + ((cellW - dw) >> 1), cy + PAD + ((cellH - dh) >> 1), dw, dh);
  const tw = textWidth(id, LABEL_SCALE);
  drawText(sheet, id, cx + PAD + Math.max(0, (cellW - tw) >> 1), cy + PAD + cellH + 4,
    LABEL_SCALE, [0xa8, 0xc4, 0xd8]);
});

const png = new PNG({ width: sheet.w, height: sheet.h });
sheet.px.copy(png.data);
fs.writeFileSync(outPath, PNG.sync.write(png));
console.log(`Wrote ${outPath} (${sheet.w}x${sheet.h}, ${cols}x${rows} tiles, ${fs.statSync(outPath).size} bytes)`);

if (has('open') && process.platform === 'darwin') {
  require('child_process').spawnSync('open', ['-a', 'Preview', outPath]);
}
