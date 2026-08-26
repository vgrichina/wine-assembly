'use strict';

// What is on the screen, read the way the VGA registers currently say to read
// it. Everything downstream -- the PNG a sweep writes, the pixel count that
// scores it, the frame hash the bench compares, and the canvas the report page
// paints -- goes through here, so none of them can disagree about what the
// screen is.
//
// No host in this file: it takes a memory array and hands back pixels. The PNG
// encoder stays in the Node driver, and the canvas blit stays in the page.

const isa = require('./isa');
const { vgaGeometry, VGA_BASE } = require('./dos');

// Chained mode 13h is the easy half: A000 is the picture, one byte per pixel.
// Unchained mode X is not addressable that way at all -- pixel (x, y) is byte
// `start + y*(stride/4) + (x>>2)` of plane `x & 3` -- and reading it linearly is
// what made those demos screenshot as a quarter of a picture stretched over the
// frame.
const LINEAR = { width: 320, height: 200, stride: 320, start: 0, planar: false };

// One 8-bit CGA attribute: low nibble foreground, high nibble background, and
// the top bit is blink -- which on a still frame is just a bright background.
const CGA_TEXT = [
  [0, 0, 0], [0, 0, 42], [0, 42, 0], [0, 42, 42],
  [42, 0, 0], [42, 0, 42], [42, 21, 0], [42, 42, 42],
  [21, 21, 21], [21, 21, 63], [21, 63, 21], [21, 63, 63],
  [63, 21, 21], [63, 21, 63], [63, 63, 21], [63, 63, 63],
];

function attrRgb(a, fg) {
  const i = fg ? (a & 0x0F) : ((a >> 4) & 0x07);
  const c = CGA_TEXT[i];
  return [c[0] * 255 / 63, c[1] * 255 / 63, c[2] * 255 / 63];
}

// Cells of the console grid that are not a blank on a black ground. A screen
// full of spaces coloured by a background is still a screen, so a cell counts
// when either its character or its attribute says something.
function conCells(con) {
  let n = 0;
  for (let i = 0; i < con.cells; i++) {
    const ch = con.getCh(i);
    if ((ch !== 0x20 && ch !== 0) || (con.getAt(i) & 0xF0) !== 0) n++;
  }
  return n;
}

// The console grid as plain text, trailing blank rows and columns trimmed.
function conText(con) {
  const rows = [];
  for (let y = 0; y < con.rows; y++) {
    let s = '';
    for (let x = 0; x < con.cols; x++) {
      const b = con.getCh(y * con.cols + x);
      s += (b >= 0x20 && b < 0x7F) ? String.fromCharCode(b) : (b === 0 || b === 0x20 ? ' ' : '·');
    }
    rows.push(s.replace(/\s+$/, ''));
  }
  while (rows.length && rows[rows.length - 1] === '') rows.pop();
  return rows.join('\n');
}

// Which of the two surfaces is this program's picture.
//
// `vga.bpp` is 0 until a graphics mode is established and 0 again once the
// guest goes back to text, which is the question worth asking -- the mode
// number alone is not, since a demo can reprogram the CRTC underneath mode 13h
// and still be in graphics. Two cases hang off the text answer: a program with
// something on the text page is photographed there, and a program with a blank
// text page that HAS been in graphics is photographed off its last frame, which
// is still sitting in A000 after the mode-3 restore a well-behaved demo does on
// its way out.
function screenSurface(machine) {
  if (machine.vga.bpp !== 0) return { text: false, geom: vgaGeometry(machine.vga) };
  if (conCells(machine.con) > 0 || !machine.vga.lastGraphics) return { text: true, geom: null };
  return { text: false, geom: machine.vga.lastGraphics };
}

function readFrame(mem, video = LINEAR) {
  // A chained program is read exactly the way it always was, even when its CRTC
  // says something other than 320x200. The register model is complete enough to
  // describe the mode X tweaks and no further: BAZIRRE.COM programs a genuine
  // 320x66 chunky mode by stretching each row over six scan lines, and reading
  // its 66 rows back at a 320-byte stride produces overlapping text -- so the
  // chained side of that model is not yet worth trusting over the assumption it
  // would replace.
  const g = video && video.planar ? { ...LINEAR, ...video } : LINEAR;
  const { width, height, stride, start, planar } = g;
  const out = new Uint8Array(width * height);
  if (!planar) {
    const n = Math.min(width * height, 0x10000);
    out.set(mem.subarray(VGA_BASE, VGA_BASE + n));
    return { width, height, pixels: out };
  }
  if (g.bpp === 4) {
    // EGA 16-colour: eight pixels per plane byte, one bit each, most
    // significant bit leftmost. The colour is the four bits assembled across
    // the planes, and that 0-15 value then indexes the attribute palette to
    // reach the DAC entry the hardware would have displayed.
    const rowBytes = stride >> 3;
    const attr = g.attr || null;
    for (let y = 0; y < height; y++) {
      const row = start + y * rowBytes;
      for (let x = 0; x < width; x++) {
        const at = (row + (x >> 3)) & 0xFFFF;
        const bit = 7 - (x & 7);
        let c = 0;
        for (let p = 0; p < 4; p++) {
          c |= ((mem[isa.VGA_PLANES + (p << 16) + at] >> bit) & 1) << p;
        }
        out[y * width + x] = attr ? (attr[c] & 0x3F) : c;
      }
    }
    return { width, height, pixels: out };
  }
  const rowBytes = stride >> 2;
  for (let y = 0; y < height; y++) {
    const row = start + y * rowBytes;
    for (let x = 0; x < width; x++) {
      out[y * width + x] =
        mem[isa.VGA_PLANES + ((x & 3) << 16) + ((row + (x >> 2)) & 0xFFFF)];
    }
  }
  return { width, height, pixels: out };
}

function nonBlack(mem, video) {
  const { pixels } = readFrame(mem, video);
  let n = 0;
  for (let i = 0; i < pixels.length; i++) if (pixels[i]) n++;
  return n;
}

// A cheap content signature over the frame buffer. Two variants that disagree
// here executed different code, and no timing comparison between them means
// anything -- so the bench checks it before it reports a ratio.
function frameHash(mem, video) {
  const { pixels } = readFrame(mem, video);
  let h = 0x811c9dc5;
  for (let i = 0; i < pixels.length; i++) h = Math.imul(h ^ pixels[i], 0x01000193);
  return (h >>> 0).toString(16).padStart(8, '0');
}

// --- RGBA, for anything that draws ------------------------------------------
// Palette entries are 6-bit, the way the DAC stores them. `into` lets a caller
// that repaints every frame reuse one buffer -- a canvas ImageData's own array,
// typically -- rather than allocating a screen per frame.
function rgbaFrame(mem, palette, video, into) {
  const { width, height, pixels } = readFrame(mem, video);
  const out = into && into.length >= width * height * 4 ? into
    : new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const c = pixels[i], o = i * 4;
    out[o] = Math.round(palette[c * 3] * 255 / 63);
    out[o + 1] = Math.round(palette[c * 3 + 1] * 255 / 63);
    out[o + 2] = Math.round(palette[c * 3 + 2] * 255 / 63);
    out[o + 3] = 255;
  }
  return { width, height, rgba: out };
}

// The console grid drawn with a real OEM strike. `font` is what fnt-read's
// pickStrike hands back (or null, which draws the attributes and no glyphs --
// still the right colours, which is most of an ANSI screen).
function rgbaConsole(con, font, into) {
  const cw = (font && (font.pixWidth || font.maxWidth)) || 8;
  const ch = (font && font.height) || 12;
  const width = con.cols * cw, height = con.rows * ch;
  const out = into && into.length >= width * height * 4 ? into
    : new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < con.rows; y++) {
    for (let x = 0; x < con.cols; x++) {
      const at = y * con.cols + x;
      const a = con.getAt(at);
      const bg = attrRgb(a, false), fgc = attrRgb(a, true);
      const g = font ? font.glyphs.get(con.getCh(at)) : null;
      for (let py = 0; py < ch; py++) {
        for (let px = 0; px < cw; px++) {
          const on = g && px < g.width && g.bits[py * g.width + px];
          const c = on ? fgc : bg;
          const o = ((y * ch + py) * width + x * cw + px) * 4;
          out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2]; out[o + 3] = 255;
        }
      }
    }
  }
  return { width, height, rgba: out };
}

module.exports = {
  LINEAR, CGA_TEXT, attrRgb, conCells, conText, screenSurface,
  readFrame, nonBlack, frameHash, rgbaFrame, rgbaConsole,
};
