// DIB → RGBA converter. The only piece of PE-resource handling still
// in JS — the rest (menus, dialogs, strings, accelerators, lookup)
// lives in WAT ($dlg_load, $menu_load, $string_load_a,
// $rsrc_find_data_wa). This runs on the raw RT_BITMAP payload pulled
// out of WASM linear memory via the rsrc_find_data_wa export; all it
// does is format conversion because <canvas> needs RGBA.

function parseDIB(buf) {
  const r16 = (o) => buf[o] | (buf[o + 1] << 8);
  const r32 = (o) => buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16) | (buf[o + 3] << 24);
  const biSize = r32(0);
  let w, h, bpp, numColors, paletteOff, palEntrySize;
  if (biSize === 12) {
    w = r16(4); h = r16(6); bpp = r16(10);
    numColors = bpp <= 8 ? (1 << bpp) : 0;
    paletteOff = 12; palEntrySize = 3;
  } else if (biSize >= 40) {
    w = r32(4); h = r32(8); bpp = r16(14);
    const clrUsed = r32(32);
    numColors = clrUsed || (bpp <= 8 ? (1 << bpp) : 0);
    paletteOff = biSize; palEntrySize = 4;
  } else {
    return null;
  }
  const compression = (biSize >= 40) ? r32(16) : 0;
  const absH = Math.abs(h | 0);
  const bottomUp = (h | 0) > 0;
  const pixelOff = paletteOff + numColors * palEntrySize;
  const rowBytes = Math.ceil(w * bpp / 32) * 4;

  let rleIndices = null;
  if (compression === 1 && bpp === 8) {
    rleIndices = new Uint8Array(w * absH);
    let p = pixelOff, x = 0, y = 0;
    while (p < buf.length) {
      const a = buf[p++], b = buf[p++];
      if (a === 0) {
        if (b === 0) { x = 0; y++; }
        else if (b === 1) break;
        else if (b === 2) { x += buf[p++]; y += buf[p++]; }
        else {
          for (let i = 0; i < b; i++) {
            if (x < w && y < absH) rleIndices[(absH - 1 - y) * w + x] = buf[p + i];
            x++;
          }
          p += b;
          if (b & 1) p++;
        }
      } else {
        for (let i = 0; i < a; i++) {
          if (x < w && y < absH) rleIndices[(absH - 1 - y) * w + x] = b;
          x++;
        }
      }
    }
  } else if (compression === 2 && bpp === 4) {
    rleIndices = new Uint8Array(w * absH);
    let p = pixelOff, x = 0, y = 0;
    while (p < buf.length) {
      const a = buf[p++], b = buf[p++];
      if (a === 0) {
        if (b === 0) { x = 0; y++; }
        else if (b === 1) break;
        else if (b === 2) { x += buf[p++]; y += buf[p++]; }
        else {
          const nibbles = b;
          const bytes = (nibbles + 1) >> 1;
          for (let i = 0; i < nibbles; i++) {
            const byte = buf[p + (i >> 1)];
            const nib = (i & 1) ? (byte & 0xF) : (byte >> 4);
            if (x < w && y < absH) rleIndices[(absH - 1 - y) * w + x] = nib;
            x++;
          }
          p += bytes;
          if (bytes & 1) p++;
        }
      } else {
        const hi = b >> 4, lo = b & 0xF;
        for (let i = 0; i < a; i++) {
          const nib = (i & 1) ? lo : hi;
          if (x < w && y < absH) rleIndices[(absH - 1 - y) * w + x] = nib;
          x++;
        }
      }
    }
  }
  const pixels = new Uint8Array(w * absH * 4);
  let indices = null, paletteBGRA = null;
  if (bpp === 8) {
    indices = new Uint8Array(w * absH);
    paletteBGRA = new Uint8Array(numColors * 4);
    for (let i = 0; i < numColors; i++) {
      paletteBGRA[i * 4]     = buf[paletteOff + i * palEntrySize];
      paletteBGRA[i * 4 + 1] = buf[paletteOff + i * palEntrySize + 1];
      paletteBGRA[i * 4 + 2] = buf[paletteOff + i * palEntrySize + 2];
      paletteBGRA[i * 4 + 3] = 0;
    }
  }
  const pal = [];
  for (let i = 0; i < numColors; i++) {
    const b = buf[paletteOff + i * palEntrySize], g = buf[paletteOff + i * palEntrySize + 1], rC = buf[paletteOff + i * palEntrySize + 2];
    pal.push(rC, g, b, 255);
  }
  for (let row = 0; row < absH; row++) {
    const srcRow = bottomUp ? (absH - 1 - row) : row;
    const srcOff = pixelOff + srcRow * rowBytes;
    const dstOff = row * w * 4;
    if (bpp === 1) {
      for (let x = 0; x < w; x++) {
        const byte = buf[srcOff + (x >> 3)];
        const idx = (byte >> (7 - (x & 7))) & 1;
        pixels[dstOff + x * 4] = pal[idx * 4];
        pixels[dstOff + x * 4 + 1] = pal[idx * 4 + 1];
        pixels[dstOff + x * 4 + 2] = pal[idx * 4 + 2];
        pixels[dstOff + x * 4 + 3] = 255;
      }
    } else if (bpp === 4) {
      for (let x = 0; x < w; x++) {
        const byte = buf[srcOff + (x >> 1)];
        const idx = (x & 1) ? (byte & 0xF) : (byte >> 4);
        pixels[dstOff + x * 4] = pal[idx * 4];
        pixels[dstOff + x * 4 + 1] = pal[idx * 4 + 1];
        pixels[dstOff + x * 4 + 2] = pal[idx * 4 + 2];
        pixels[dstOff + x * 4 + 3] = 255;
      }
    } else if (bpp === 8) {
      for (let x = 0; x < w; x++) {
        const idx = rleIndices ? rleIndices[row * w + x] : buf[srcOff + x];
        indices[row * w + x] = idx;
        pixels[dstOff + x * 4] = pal[idx * 4];
        pixels[dstOff + x * 4 + 1] = pal[idx * 4 + 1];
        pixels[dstOff + x * 4 + 2] = pal[idx * 4 + 2];
        pixels[dstOff + x * 4 + 3] = 255;
      }
    } else if (bpp === 24) {
      for (let x = 0; x < w; x++) {
        pixels[dstOff + x * 4] = buf[srcOff + x * 3 + 2];
        pixels[dstOff + x * 4 + 1] = buf[srcOff + x * 3 + 1];
        pixels[dstOff + x * 4 + 2] = buf[srcOff + x * 3];
        pixels[dstOff + x * 4 + 3] = 255;
      }
    } else if (bpp === 32) {
      for (let x = 0; x < w; x++) {
        pixels[dstOff + x * 4]     = buf[srcOff + x * 4 + 2];
        pixels[dstOff + x * 4 + 1] = buf[srcOff + x * 4 + 1];
        pixels[dstOff + x * 4 + 2] = buf[srcOff + x * 4];
        pixels[dstOff + x * 4 + 3] = buf[srcOff + x * 4 + 3];
      }
    }
  }
  return { w, h: absH, bpp, pixels, indices, paletteBGRA };
}

// Minimal PE resource walker that extracts the raw byte slice for every
// RT_BITMAP (type 2) entry. Used by host.js / test/run.js to pre-index
// DLL bitmaps by integer ID — WAT's $find_resource only knows about the
// main EXE's resource directory, so DLL bitmaps still need a JS-side
// fallback path until a per-module resource walker lands in WAT.
//
// Returns { id: Uint8Array } keyed by integer resource id (named
// entries are skipped since nothing currently looks them up by name on
// the DLL path).
function extractBitmapBytes(peBytes) {
  const pe = peBytes;
  const u8 = pe instanceof Uint8Array ? pe : new Uint8Array(pe.buffer || pe, pe.byteOffset || 0, pe.byteLength || pe.length);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const r16 = (o) => dv.getUint16(o, true);
  const r32 = (o) => dv.getUint32(o, true);
  const peOff = r32(0x3c);
  const numSec = r16(peOff + 6);
  const optSize = r16(peOff + 20);
  let rsrcRva = 0, rsrcOff = 0;
  let sec = peOff + 24 + optSize;
  for (let i = 0; i < numSec; i++) {
    let name = '';
    for (let j = 0; j < 8 && u8[sec + j]; j++) name += String.fromCharCode(u8[sec + j]);
    if (name === '.rsrc') { rsrcRva = r32(sec + 12); rsrcOff = r32(sec + 20); }
    sec += 40;
  }
  const out = {};
  if (!rsrcRva) return out;
  // L1: find type 2 (RT_BITMAP)
  const l1Named = r16(rsrcOff + 12), l1Ids = r16(rsrcOff + 14);
  let typeSub = 0;
  for (let i = 0; i < l1Named + l1Ids; i++) {
    const eid = r32(rsrcOff + 16 + i * 8);
    const doff = r32(rsrcOff + 16 + i * 8 + 4);
    if (eid === 2 && (doff & 0x80000000)) { typeSub = doff & 0x7FFFFFFF; break; }
  }
  if (!typeSub) return out;
  // L2: enumerate names
  const l2Named = r16(rsrcOff + typeSub + 12), l2Ids = r16(rsrcOff + typeSub + 14);
  for (let i = 0; i < l2Named + l2Ids; i++) {
    const eid = r32(rsrcOff + typeSub + 16 + i * 8);
    const doff = r32(rsrcOff + typeSub + 16 + i * 8 + 4);
    if (eid & 0x80000000) continue;  // skip named entries
    if (!(doff & 0x80000000)) continue;
    const langSub = doff & 0x7FFFFFFF;
    // L3: take first language entry
    const n = r16(rsrcOff + langSub + 12) + r16(rsrcOff + langSub + 14);
    if (n === 0) continue;
    const dataEntry = r32(rsrcOff + langSub + 16 + 4);
    const rva = r32(rsrcOff + dataEntry);
    const size = r32(rsrcOff + dataEntry + 4);
    const foff = rva - rsrcRva + rsrcOff;
    out[eid] = u8.subarray(foff, foff + size);
  }
  return out;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseDIB, extractBitmapBytes };
} else if (typeof window !== 'undefined') {
  window.parseDIB = parseDIB;
  window.extractBitmapBytes = extractBitmapBytes;
  window.dibLib = { parseDIB, extractBitmapBytes };
}
