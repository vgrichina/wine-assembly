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

// --- direct colour ----------------------------------------------------------
// A VBE mode above 8 bits per pixel carries the colour in the pixel itself and
// looks nothing up: 15bpp is 5-5-5 in a word with the top bit unused, 16bpp is
// 5-6-5, and 24bpp is three bytes in BLUE, GREEN, RED order -- the order the
// VESA spec gives and the one every DOS program writes. There is no palette in
// any of them, so a frame read out of one cannot be a byte per pixel: readFrame
// hands back `rgb`, three bytes each, and `direct` says which of the two fields
// the caller is looking at.
//
// Everything that scores, hashes or paints a frame therefore has to ask. That
// is why frameBytes() exists rather than each caller reaching for `.pixels` --
// a caller that forgets gets `undefined` and, before this, quietly measured a
// 24bpp screen as blank.
const DIRECT_BPP = new Set([15, 16, 24, 32]);
function bppBytes(bpp) {
  if (bpp === 24) return 3;
  if (bpp === 32) return 4;
  if (bpp === 15 || bpp === 16) return 2;
  return 1;
}

// The bytes a frame is made of, whichever kind it is. Hashing and counting are
// both "is this the same picture" questions and neither cares which.
function frameBytes(f) { return f.direct ? f.rgb : f.pixels; }

// 5- and 6-bit channels widened to 8 the way a DAC does, so a 15bpp white is
// 255 and not 248.
const C5 = Uint8Array.from({ length: 32 }, (_, i) => Math.round(i * 255 / 31));
const C6 = Uint8Array.from({ length: 64 }, (_, i) => Math.round(i * 255 / 63));

function readDirect(mem, g) {
  const { width, height, bpp } = g;
  const bytes = bppBytes(bpp);
  const stride = g.stride || width * bytes;
  const base = g.base === undefined ? VGA_BASE : g.base;
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    let at = base + (g.start || 0) + y * stride;
    let o = y * width * 3;
    for (let x = 0; x < width; x++, at += bytes, o += 3) {
      if (bpp === 24 || bpp === 32) {
        rgb[o] = mem[at + 2]; rgb[o + 1] = mem[at + 1]; rgb[o + 2] = mem[at];
      } else {
        const w = mem[at] | (mem[at + 1] << 8);
        if (bpp === 16) {
          rgb[o] = C5[(w >> 11) & 31]; rgb[o + 1] = C6[(w >> 5) & 63]; rgb[o + 2] = C5[w & 31];
        } else {
          rgb[o] = C5[(w >> 10) & 31]; rgb[o + 1] = C5[(w >> 5) & 31]; rgb[o + 2] = C5[w & 31];
        }
      }
    }
  }
  return { width, height, rgb, direct: true };
}

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
// The graphics answer has one exception, and it is the mirror of the text one
// below: an adapter sitting in a graphics mode with NOTHING drawn on it is not
// a picture, and if the console has something on it then the console is what
// this program has to show. Both BLIQ.EXE builds end this way -- they print
// "MIDAS Error: Out of conventional memory" and "Runtime error 200", never
// leave mode 13h, and never put a pixel down. Preferring the empty frame threw
// the message away and reported them as blank, which reads as "we have no idea
// what happened" for a program that said exactly what happened.
function screenSurface(machine) {
  // A VESA mode is its own answer and does not go through the CRTC at all: the
  // registers describe the 64KB window, not the picture. Flush first, because
  // the bank the guest drew last is still sitting in the window.
  if (machine.vesa && machine.vesa.mode) {
    machine.vesaFlush();
    const { width, height, bpp } = machine.vesa;
    // `stride` is BYTES, not pixels, and that is the whole difference a
    // direct-colour mode makes to the reader: 640 pixels of 24bpp is a
    // 1920-byte scan line, and reading it at 640 produces a third of a picture
    // sheared across the frame.
    const bytes = bppBytes(bpp || 8);
    return {
      text: false,
      geom: {
        width, height, stride: width * bytes,
        // Where in the picture the screen starts, as AX=4F07 last left it.
        // A program that page-flips through that call is showing a different
        // part of the same memory, and reading from 0 would photograph the
        // page it is drawing into rather than the one on screen.
        start: machine.vesa.start || 0, planar: false,
        bpp: bpp || 8, base: isa.VESA_FB,
      },
    };
  }
  if (machine.vga.bpp !== 0) {
    const geom = vgaGeometry(machine.vga);
    // Ordered so the walk is usually skipped. The console check is 2000 cells
    // against 64000 pixels, and a program that went to graphics without leaving
    // anything on the text page -- most of them -- never needs the second one.
    // When it does, anyLit stops at the first lit pixel instead of counting
    // them all, though it still pays readFrame's conversion either way. This
    // runs on every keepBest sample, which is every 32 handbacks.
    if (conCells(machine.con) === 0 || anyLit(machine.mem, geom)) {
      return { text: false, geom };
    }
    return { text: true, geom: null };
  }
  if (conCells(machine.con) > 0 || !machine.vga.lastGraphics) return { text: true, geom: null };
  return { text: false, geom: machine.vga.lastGraphics };
}

// CGA graphics. The buffer is at B800, two bits per pixel in modes 4 and 5 and
// one in mode 6, most significant bits leftmost -- and the scan lines are
// INTERLEAVED: even rows start at 0, odd rows at 0x2000. Reading it as a flat
// 80-byte-stride bitmap is what turns one picture into two half-height copies
// combed into each other.
//
// The four colours are not a palette in memory anywhere; they are wired to the
// mode. Mode 4 gets the cyan/magenta/white set (the palette-1 default the BIOS
// selects), mode 5 the CGA "high-intensity" one, and mode 6 is black and white.
// They come out as EGA colour numbers so the DAC lookup downstream is the same
// one every other mode goes through.
const VRAM_CGA = 0xB8000;
const CGA_PALETTE = {
  4: [0, 11, 13, 15],       // black, light cyan, light magenta, white
  5: [0, 10, 12, 15],       // black, light green, light red, white
  6: [0, 15],
};

function readCga(mem, g) {
  const { width, height } = g;
  const bpp = g.bpp === 1 ? 1 : 2;
  const colours = CGA_PALETTE[g.cga] || CGA_PALETTE[4];
  const out = new Uint8Array(width * height);
  const perByte = 8 / bpp, mask = (1 << bpp) - 1;
  for (let y = 0; y < height; y++) {
    // The interleave, and the whole reason this function exists.
    const row = VRAM_CGA + ((y & 1) ? 0x2000 : 0) + (y >> 1) * g.stride;
    for (let x = 0; x < width; x++) {
      const b = mem[row + Math.floor(x / perByte)];
      const shift = (perByte - 1 - (x % perByte)) * bpp;
      out[y * width + x] = colours[(b >> shift) & mask];
    }
  }
  return { width, height, pixels: out };
}

function readFrame(mem, video = LINEAR) {
  // A chained program is read exactly the way it always was, even when its CRTC
  // says something other than 320x200. The register model is complete enough to
  // describe the mode X tweaks and no further: BAZIRRE.COM programs a genuine
  // 320x66 chunky mode by stretching each row over six scan lines, and reading
  // its 66 rows back at a 320-byte stride produces overlapping text -- so the
  // chained side of that model is not yet worth trusting over the assumption it
  // would replace.
  if (video && video.cga) return readCga(mem, video);
  // A VESA surface is unchained like mode 13h but is neither 320x200 nor at
  // A000, so the non-planar side has to carry the caller's geometry too --
  // taking LINEAR wholesale read AQUAPHOB.EXE's 640x480 picture as the first
  // 64KB of the bank window and wrote a 320x200 PNG of it.
  const g = video && (video.planar || video.base !== undefined)
    ? { ...LINEAR, ...video } : LINEAR;
  if (DIRECT_BPP.has(g.bpp)) return readDirect(mem, g);
  const { width, height, stride, start, planar } = g;
  const out = new Uint8Array(width * height);
  if (!planar) {
    // `base` is set only by a VESA surface, which is a whole picture somewhere
    // outside the guest's address space. Everything else is the 64KB at A000,
    // and the cap is what keeps a CRTC that claims more than that from reading
    // past it.
    // A VESA surface is the only one with a `base`, and it is also the only
    // one whose `start` is a byte offset the guest chose (AX=4F07). Everything
    // else is the 64KB at A000 read from its own beginning.
    const base = (g.base === undefined ? VGA_BASE : g.base + (g.start || 0));
    const n = g.base === undefined ? Math.min(width * height, 0x10000) : width * height;
    out.set(mem.subarray(base, base + n));
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

// Is anything at all lit? nonBlack's question without the counting, so it can
// stop at the first hit instead of walking the whole frame every time.
function anyLit(mem, video) {
  const f = readFrame(mem, video);
  const b = frameBytes(f);
  for (let i = 0; i < b.length; i++) if (b[i]) return true;
  return false;
}

// A lit pixel is a non-zero one, and in a direct-colour frame that is three
// bytes rather than an index -- a pixel whose red is zero and whose blue is not
// is still lit, so the test is over the triple and the count is in PIXELS,
// which is what every caller reports.
function nonBlack(mem, video) {
  const f = readFrame(mem, video);
  let n = 0;
  if (f.direct) {
    for (let i = 0; i < f.rgb.length; i += 3) {
      if (f.rgb[i] || f.rgb[i + 1] || f.rgb[i + 2]) n++;
    }
    return n;
  }
  for (let i = 0; i < f.pixels.length; i++) if (f.pixels[i]) n++;
  return n;
}

// How much of a frame is worth photographing, which is not what nonBlack
// measures. A demo that flashes the screen for one frame fills every pixel with
// a single index and scores a perfect 64000 there, so a best-frame tracker that
// maximises coverage keeps the flash and throws the picture away. BLINKY.EXE is
// the corpus's example: its vector intro lights ~1100 pixels in four colours,
// and the moment a big enough budget let the run reach the end, a white fill
// outscored it 64000 to 1114 and the tile became a blank white square.
//
// Lit pixels that are all one index are a fill, not a picture. So rank in
// bands rather than on one continuous number, because the two comparisons a
// best-frame tracker makes are not the same question:
//
//   2e6  a real picture -- two or more indices lit
//   1e6  a single-index fill
//     0  the text console, scored in non-blank cells, and an unlit screen
//
// An unlit graphics screen sits at the bottom with the text page and not at the
// top of a band, because "the adapter is in mode 13h" is not something worth
// photographing on its own. Banding it above text cost AMBIENT.EXE its whole
// result: its best frame became a blank mode 13h screen, which carries no text,
// so the sweep read an empty `screen` string and never saw the program's own
// "MIDAS Error: NO GUS FOUND... USE \"AMBIENT /NO_SND\" FOR SILENT MODE" -- the
// message the retry rung exists to read a switch out of.
//
// Bands, and not a discount, because a discount answers the second comparison
// wrongly while fixing the first. Scaling a fill down far enough to lose to a
// picture also drops it below the text page: HEMATIE.EXE's 243-pixel frame
// scored 0 against 49 console cells and the sweep photographed its text, and
// ACME-VIC.EXE reported 62,251 lit pixels as "60". A fill outranking the text
// page is also what the sweep's own row scorer already says -- any graphics
// beats any text -- so the two agree here instead of disagreeing silently.
//
// `count` is the honest pixel total in every band. Callers that report a
// number to a human want that one; only the ordering wants `score`.
function frameScore(mem, video) {
  const f = readFrame(mem, video);
  let n = 0, distinct = 0;
  if (f.direct) {
    // The same two bands over a direct-colour frame. `distinct` stops at two
    // because that is the only question the band asks -- a Set over 307200
    // 24-bit colours would be the most expensive thing in a keepBest sample,
    // and every answer past "more than one" is thrown away.
    let first = -1;
    for (let i = 0; i < f.rgb.length; i += 3) {
      const c = (f.rgb[i] << 16) | (f.rgb[i + 1] << 8) | f.rgb[i + 2];
      if (!c) continue;
      n++;
      if (first < 0) { first = c; distinct = 1; } else if (distinct < 2 && c !== first) distinct = 2;
    }
  } else {
    const seen = new Uint8Array(256);
    for (let i = 0; i < f.pixels.length; i++) {
      const c = f.pixels[i] & 0xFF;
      if (!c) continue;
      n++;
      if (!seen[c]) { seen[c] = 1; distinct++; }
    }
  }
  return { count: n, distinct, score: n === 0 ? 0 : (distinct >= 2 ? 2e6 + n : 1e6 + n) };
}

// A cheap content signature over the frame buffer. Two variants that disagree
// here executed different code, and no timing comparison between them means
// anything -- so the bench checks it before it reports a ratio.
// The VBE picture is hashed the same way and by the same call: readFrame is
// what decides which surface and which depth, so a 24bpp screen is covered here
// exactly as mode 13h is, and a build that renders it differently fails the
// corpus diff rather than passing on a hash of a surface nobody looked at.
function frameHash(mem, video) {
  const b = frameBytes(readFrame(mem, video));
  let h = 0x811c9dc5;
  for (let i = 0; i < b.length; i++) h = Math.imul(h ^ b[i], 0x01000193);
  return (h >>> 0).toString(16).padStart(8, '0');
}

// --- RGBA, for anything that draws ------------------------------------------
// Palette entries are 6-bit, the way the DAC stores them. `into` lets a caller
// that repaints every frame reuse one buffer -- a canvas ImageData's own array,
// typically -- rather than allocating a screen per frame.
function rgbaFrame(mem, palette, video, into) {
  const f = readFrame(mem, video);
  const { width, height, pixels } = f;
  const out = into && into.length >= width * height * 4 ? into
    : new Uint8ClampedArray(width * height * 4);
  if (f.direct) {
    // No palette in a direct-colour mode: the pixel IS the colour, already at
    // 8 bits a channel from readDirect.
    for (let i = 0; i < width * height; i++) {
      const s = i * 3, o = i * 4;
      out[o] = f.rgb[s]; out[o + 1] = f.rgb[s + 1]; out[o + 2] = f.rgb[s + 2]; out[o + 3] = 255;
    }
    return { width, height, rgba: out };
  }
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
  readFrame, frameBytes, bppBytes, nonBlack, frameScore, frameHash, rgbaFrame, rgbaConsole,
};
