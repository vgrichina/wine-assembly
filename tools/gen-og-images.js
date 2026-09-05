#!/usr/bin/env node
// One 1200x630 Open Graph card per app screenshot.
//
//   node tools/gen-og-images.js [--in=screenshots/apps] [--out=screenshots/og] [id ...]
//
// Every app page used to share icons/og-image.png, so a link to the
// Minesweeper page unfurled as a picture of Pinball. This puts the app's own
// (window-cropped) capture on Win98 teal at the 1200x630 the link previews
// want, so the card shows the program the page is about.
//
// Scaling is deliberate: a capture smaller than the card is enlarged by a
// whole number with nearest-neighbour, so a 170x251 Minesweeper becomes a
// crisp 2x, never a blurred 2.19x; a capture larger than the card is
// box-averaged down. Both keep the aspect ratio and sit centred over a soft
// shadow. No text is drawn: the unfurl already prints the page title beside
// the picture, and a bitmap-font caption would only repeat it worse.
//
// The cards are generated, not committed: tools/gen-site-pages.js calls
// ogCard() for each app page it writes, and tools/deploy-berrry.js uploads the
// directory. This CLI exists to run or inspect the step on its own.

const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

const W = 1200, H = 630, MARGIN = 40, SHADOW = 10;
const TEAL = [0, 128, 128];
const SHADOW_RGB = [0, 72, 72];

function fill(png, x0, y0, w, h, rgb) {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const o = (y * png.width + x) * 4;
      png.data[o] = rgb[0]; png.data[o + 1] = rgb[1]; png.data[o + 2] = rgb[2]; png.data[o + 3] = 255;
    }
  }
}

// Nearest-neighbour blow-up by an integer factor.
function upscale(src, k) {
  const out = new PNG({ width: src.width * k, height: src.height * k });
  for (let y = 0; y < out.height; y++) {
    const sy = (y / k) | 0;
    for (let x = 0; x < out.width; x++) {
      const si = (sy * src.width + ((x / k) | 0)) * 4, o = (y * out.width + x) * 4;
      out.data[o] = src.data[si]; out.data[o + 1] = src.data[si + 1]; out.data[o + 2] = src.data[si + 2]; out.data[o + 3] = 255;
    }
  }
  return out;
}

// Box-average shrink to w x h.
function downscale(src, w, h) {
  const out = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    const sy0 = Math.floor(y * src.height / h), sy1 = Math.max(sy0 + 1, Math.floor((y + 1) * src.height / h));
    for (let x = 0; x < w; x++) {
      const sx0 = Math.floor(x * src.width / w), sx1 = Math.max(sx0 + 1, Math.floor((x + 1) * src.width / w));
      let r = 0, g = 0, b = 0, n = 0;
      for (let sy = sy0; sy < sy1; sy++) for (let sx = sx0; sx < sx1; sx++) {
        const i = (sy * src.width + sx) * 4; r += src.data[i]; g += src.data[i + 1]; b += src.data[i + 2]; n++;
      }
      const o = (y * w + x) * 4;
      out.data[o] = r / n; out.data[o + 1] = g / n; out.data[o + 2] = b / n; out.data[o + 3] = 255;
    }
  }
  return out;
}

function fitted(shot) {
  const maxW = W - 2 * MARGIN, maxH = H - 2 * MARGIN;
  const k = Math.floor(Math.min(maxW / shot.width, maxH / shot.height));
  if (k >= 1) return k === 1 ? shot : upscale(shot, k);
  const s = Math.min(maxW / shot.width, maxH / shot.height);
  return downscale(shot, Math.max(1, Math.round(shot.width * s)), Math.max(1, Math.round(shot.height * s)));
}

function ogCard(shotFile, outFile) {
  const shot = PNG.sync.read(fs.readFileSync(shotFile));
  const img = fitted(shot);
  const card = new PNG({ width: W, height: H });
  fill(card, 0, 0, W, H, TEAL);
  const x = ((W - img.width) / 2) | 0, y = ((H - img.height) / 2) | 0;
  fill(card, x + SHADOW, y + SHADOW, img.width, img.height, SHADOW_RGB);
  PNG.bitblt(img, card, 0, 0, img.width, img.height, x, y);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, PNG.sync.write(card));
  return { from: `${shot.width}x${shot.height}`, placed: `${img.width}x${img.height}` };
}

module.exports = { ogCard, W, H };

if (require.main === module) {
  const args = process.argv.slice(2);
  const opt = (name, def) => { const a = args.find(s => s.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : def; };
  const inDir = opt('in', 'screenshots/apps'), outDir = opt('out', 'screenshots/og');
  const only = args.filter(a => !a.startsWith('--'));
  const ids = only.length ? only : fs.readdirSync(inDir).filter(f => f.endsWith('.png')).map(f => f.slice(0, -4));
  for (const id of ids) {
    const r = ogCard(path.join(inDir, `${id}.png`), path.join(outDir, `${id}.png`));
    console.log(`${id.padEnd(16)} ${r.from} -> ${r.placed} on ${W}x${H}`);
  }
}
