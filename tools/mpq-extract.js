#!/usr/bin/env node
'use strict';

// Extract one named file out of an MPQ archive, fully decrypted and
// decompressed — host-side ground truth for what the guest's Storm decode is
// supposed to produce.
//
//   node tools/mpq-extract.js <file.mpq> --name='ui_art\logo.pcx' --out=logo.pcx
//   node tools/mpq-extract.js <file.mpq> --name='ui_art\logo.pcx' --png=logo.png
//   node tools/mpq-extract.js <file.mpq> --block=19 --out=raw.bin
//
// --png decodes an 8bpp RLE PCX (the common case for Diablo UI art: a single
// tall image the game slices into animation frames) and writes a PNG using the
// 769-byte palette appended after the pixel data.
//
// --frame-height=N slices that tall PCX into N-pixel frames and writes
// <png>.000.png, <png>.001.png, ... alongside the full image, so a per-frame
// comparison against the emulator's output does not need an image editor.

const fs = require('fs');
const path = require('path');
const mpq = require('./mpq');

function usage(code) {
  console.error(
    "usage: node tools/mpq-extract.js <file.mpq> (--name='dir\\file.ext' | --block=N | --verify)\n" +
    '                                 [--out=PATH] [--png=PATH] [--frame-height=N] [--palette]');
  process.exit(code);
}

// --- PCX -------------------------------------------------------------------

function decodePcx(buf) {
  if (buf[0] !== 0x0a) throw new Error(`not a PCX: magic 0x${buf[0].toString(16)}`);
  const version = buf[1];
  const encoding = buf[2];
  const bpp = buf[3];
  const xMin = buf.readUInt16LE(4), yMin = buf.readUInt16LE(6);
  const xMax = buf.readUInt16LE(8), yMax = buf.readUInt16LE(10);
  const planes = buf[65];
  const bytesPerLine = buf.readUInt16LE(66);
  const width = xMax - xMin + 1;
  const height = yMax - yMin + 1;
  if (encoding !== 1) throw new Error(`PCX encoding ${encoding} is not RLE`);
  if (bpp !== 8 || planes !== 1) {
    throw new Error(`only 8bpp/1-plane PCX is supported (got ${bpp}bpp x${planes})`);
  }

  const total = bytesPerLine * height;
  const pixels = Buffer.alloc(total);
  let src = 128, dst = 0;
  while (dst < total && src < buf.length) {
    const b = buf[src++];
    if ((b & 0xc0) === 0xc0) {
      const run = b & 0x3f;
      const value = buf[src++];
      pixels.fill(value, dst, Math.min(dst + run, total));
      dst += run;
    } else {
      pixels[dst++] = b;
    }
  }

  // A 256-colour PCX appends 0x0C followed by 768 palette bytes.
  let palette = null;
  if (buf.length >= 769 && buf[buf.length - 769] === 0x0c) {
    palette = buf.subarray(buf.length - 768);
  }

  return { version, bpp, planes, width, height, bytesPerLine, pixels, palette,
           rleEnd: src, trailing: buf.length - src };
}

function toRgba(pcx, y0, rows) {
  const { PNG } = require('pngjs');
  const png = new PNG({ width: pcx.width, height: rows });
  for (let y = 0; y < rows; y++) {
    const row = (y0 + y) * pcx.bytesPerLine;
    for (let x = 0; x < pcx.width; x++) {
      const idx = pcx.pixels[row + x];
      const o = (y * pcx.width + x) * 4;
      if (pcx.palette) {
        png.data[o] = pcx.palette[idx * 3];
        png.data[o + 1] = pcx.palette[idx * 3 + 1];
        png.data[o + 2] = pcx.palette[idx * 3 + 2];
      } else {
        png.data[o] = png.data[o + 1] = png.data[o + 2] = idx;
      }
      png.data[o + 3] = 255;
    }
  }
  return png;
}

// --- main ------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  const file = args.find(a => !a.startsWith('--'));
  if (!file) usage(2);
  const opt = name => {
    const a = args.find(x => x.startsWith(`--${name}=`));
    return a === undefined ? null : a.slice(name.length + 3);
  };
  const name = opt('name');
  const blockArg = opt('block');
  const outPath = opt('out');
  const pngPath = opt('png');
  const frameHeight = opt('frame-height') ? Number(opt('frame-height')) : null;
  if (name === null && blockArg === null && !args.includes('--verify')) usage(2);

  const a = mpq.openArchive(file);

  if (args.includes('--verify')) {
    // Decode every live block by index and check it against its fsize. Without
    // a name there is no key, so the sector-table key has to be guessed from
    // known plaintext — that guess is only a heuristic and does produce false
    // positives (spawn.mpq block 0 is one), so key failures are reported apart
    // from decode failures. Only the second column is evidence about explode.
    let ok = 0;
    const keyFail = [];
    const decodeFail = [];
    for (const e of a.blocks) {
      if ((e.flags & 0x80000000) === 0) continue;
      try {
        const d = mpq.extractBlock(a, e, null);
        if (d.length === e.fSize) ok++;
        else decodeFail.push([e.index, `${d.length} != ${e.fSize}`]);
      } catch (err) {
        (/sector-table key|sector table looks wrong/.test(err.message) ? keyFail : decodeFail)
          .push([e.index, err.message]);
      }
    }
    console.log(`  ${ok} blocks decoded to their exact fsize`);
    console.log(`  ${keyFail.length} could not have their key guessed (name unknown; not a decode bug)`);
    console.log(`  ${decodeFail.length} decoded wrong`);
    for (const [i, why] of decodeFail.slice(0, 20)) console.log(`    block ${i}: ${why}`);
    process.exit(0);
  }

  let entry, slot = null;
  if (name !== null) {
    const hit = mpq.lookupName(a, name);
    if (!hit) {
      console.error(`"${name}" is not in ${file}'s hash table`);
      process.exit(1);
    }
    entry = a.blocks[hit.blockIndex];
    slot = hit.slot;
  } else {
    entry = a.blocks[Number(blockArg)];
    if (!entry) { console.error(`no block ${blockArg}`); process.exit(1); }
  }

  console.log(`${file}`);
  console.log(`  ${name !== null ? `"${name}"  hash slot ${slot}  ` : ''}block ${entry.index}` +
    `  pos 0x${entry.filePos.toString(16)}  csize ${entry.cSize}  fsize ${entry.fSize}` +
    `  flags 0x${entry.flags.toString(16)} ${mpq.flagNames(entry.flags)}`);

  if (name !== null && (entry.flags & 0x00010000) !== 0) {
    // Printed so it can be matched against the key Storm computes in the guest.
    console.log(`  file key 0x${mpq.fileKey(name, entry).toString(16)}` +
      ` (sector table uses key-1, sector i uses key+i)`);
  }

  const data = mpq.extractBlock(a, entry, name);
  // Correctness gate: the archive says how long this file is; anything else
  // means the sector walk or the explode went wrong.
  if (data.length !== entry.fSize) {
    console.error(`  FAIL: decoded ${data.length} bytes, block table says ${entry.fSize}`);
    process.exit(1);
  }
  console.log(`  decoded ${data.length} bytes (matches fsize)`);

  if (outPath) {
    fs.writeFileSync(outPath, data);
    console.log(`  wrote ${outPath}`);
  }

  if (pngPath) {
    const pcx = decodePcx(data);
    console.log(`  PCX v${pcx.version}  ${pcx.width}x${pcx.height}  ${pcx.bpp}bpp x${pcx.planes}` +
      `  bytesPerLine ${pcx.bytesPerLine}  palette ${pcx.palette ? '256 colours' : 'none'}`);
    if (args.includes('--palette') && pcx.palette) {
      // Which index dominates tells you the colour key: Diablo's UI art uses a
      // bright-green surround that the blitter treats as transparent, so a
      // guest decode that renders "solid black" is either losing the palette or
      // losing the pixels, and this says which.
      const hist = new Uint32Array(256);
      for (const b of pcx.pixels) hist[b]++;
      const top = [...hist.keys()].sort((a, b) => hist[b] - hist[a]).slice(0, 8);
      console.log('  most common indices:');
      for (const i of top) {
        console.log(`    ${String(i).padStart(3)}  rgb(${pcx.palette[i * 3]},` +
          `${pcx.palette[i * 3 + 1]},${pcx.palette[i * 3 + 2]})  ` +
          `${(100 * hist[i] / pcx.pixels.length).toFixed(1)}%`);
      }
    }
    const { PNG } = require('pngjs');
    fs.writeFileSync(pngPath, PNG.sync.write(toRgba(pcx, 0, pcx.height)));
    console.log(`  wrote ${pngPath}`);
    if (frameHeight) {
      const frames = Math.floor(pcx.height / frameHeight);
      const dir = path.dirname(pngPath);
      const stem = path.basename(pngPath).replace(/\.png$/i, '');
      for (let f = 0; f < frames; f++) {
        const p = path.join(dir, `${stem}.${String(f).padStart(3, '0')}.png`);
        fs.writeFileSync(p, PNG.sync.write(toRgba(pcx, f * frameHeight, frameHeight)));
      }
      console.log(`  wrote ${frames} frames of ${pcx.width}x${frameHeight} as ${stem}.NNN.png`);
    }
  }

  if (!outPath && !pngPath) console.log('  (no --out= or --png=, nothing written)');
}

main();
