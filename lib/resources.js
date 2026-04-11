// PE resource section parser — works with Buffer (Node) or Uint8Array (browser)
// Usage: parseResources(exeBytes) → { menus, dialogs, strings, icons, accelerators }

function parseResources(pe) {
  // Wrap in DataView for cross-environment LE reads
  const dv = new DataView(pe.buffer || pe, pe.byteOffset || 0, pe.byteLength || pe.length);
  const u8 = new Uint8Array(pe.buffer || pe, pe.byteOffset || 0, pe.byteLength || pe.length);

  const r16 = off => dv.getUint16(off, true);
  const r32 = off => dv.getUint32(off, true);
  const rs16 = off => dv.getInt16(off, true);
  const r8 = off => u8[off];

  const pe_off = r32(0x3c);
  const num_sec = r16(pe_off + 6);
  const opt_size = r16(pe_off + 20);

  // Find .rsrc section
  let rsrc_rva = 0, rsrc_off = 0;
  let sec = pe_off + 24 + opt_size;
  for (let i = 0; i < num_sec; i++) {
    let name = '';
    for (let j = 0; j < 8 && u8[sec + j]; j++) name += String.fromCharCode(u8[sec + j]);
    if (name === '.rsrc') {
      rsrc_rva = r32(sec + 12);
      rsrc_off = r32(sec + 20);
    }
    sec += 40;
  }

  if (!rsrc_rva) return { menus: {}, dialogs: {}, strings: {}, icons: {}, accelerators: {}, bitmaps: {} };

  // --- Resource directory walker ---
  function findEntry(off, id) {
    const named = r16(rsrc_off + off + 12);
    const ids = r16(rsrc_off + off + 14);
    let e = off + 16;
    for (let i = 0; i < named + ids; i++) {
      const eid = r32(rsrc_off + e);
      const doff = r32(rsrc_off + e + 4);
      if (eid === id) return doff;
      e += 8;
    }
    return null;
  }

  function getResData(typeId, nameId, langId) {
    let d = findEntry(0, typeId); if (d === null) return null;
    d = findEntry(d & 0x7FFFFFFF, nameId); if (d === null) return null;
    // If langId specified, try exact match; otherwise take first
    if (langId !== undefined) {
      d = findEntry(d & 0x7FFFFFFF, langId); if (d === null) return null;
    } else {
      // Take first language entry
      const langOff = d & 0x7FFFFFFF;
      const n = r16(rsrc_off + langOff + 12) + r16(rsrc_off + langOff + 14);
      if (n === 0) return null;
      d = r32(rsrc_off + langOff + 16 + 4); // first entry's data offset
    }
    const rva = r32(rsrc_off + d);
    const size = r32(rsrc_off + d + 4);
    const foff = rva - rsrc_rva + rsrc_off;
    return u8.subarray(foff, foff + size);
  }

  function listResIds(typeId) {
    const named = r16(rsrc_off + 12);
    const ids = r16(rsrc_off + 14);
    let e = 16;
    for (let i = 0; i < named + ids; i++) {
      const eid = r32(rsrc_off + e);
      const doff = r32(rsrc_off + e + 4);
      if (eid === typeId && (doff & 0x80000000)) {
        const nameOff = doff & 0x7FFFFFFF;
        const n2 = r16(rsrc_off + nameOff + 12) + r16(rsrc_off + nameOff + 14);
        const result = [];
        let e2 = nameOff + 16;
        for (let j = 0; j < n2; j++) {
          result.push(r32(rsrc_off + e2));
          e2 += 8;
        }
        return result;
      }
      e += 8;
    }
    return [];
  }

  // --- UTF-16LE helpers ---
  function readSz(buf, pos) {
    let s = '', p = pos;
    while (p + 1 < buf.length) {
      const ch = buf[p] | (buf[p + 1] << 8); p += 2;
      if (!ch) break;
      s += String.fromCharCode(ch);
    }
    return { str: s, pos: p };
  }

  function readOrdOrSz(buf, pos) {
    const w = buf[pos] | (buf[pos + 1] << 8);
    if (w === 0) return { val: null, pos: pos + 2 };
    if (w === 0xFFFF) return { val: buf[pos + 2] | (buf[pos + 3] << 8), pos: pos + 4 };
    const r = readSz(buf, pos);
    return { val: r.str, pos: r.pos };
  }

  function bufR16(buf, off) { return buf[off] | (buf[off + 1] << 8); }
  function bufR32(buf, off) { return buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24); }
  function bufRS16(buf, off) { const v = bufR16(buf, off); return v >= 0x8000 ? v - 0x10000 : v; }

  // (Menu parsing now lives entirely in WAT — see $menu_load in
  // src/09c5-menu.wat. JS keeps only a presence map of menu IDs so the
  // renderer can decide whether a given window has a menu resource.)

  // RT_DIALOG parsing now lives entirely in WAT — see $dlg_load in
  // src/10-helpers.wat. Dialog templates (including named entries like
  // freecell's "STATISTICS") are walked via $find_resource and stored
  // in WND_DLG_RECORDS. JS reads the resulting window state through
  // the dlg_* / ctrl_* exports when the renderer builds its mirror.

  // --- String table parser ---
  function parseStringBundle(buf, bundleId) {
    const strings = {};
    let p = 0;
    for (let i = 0; i < 16; i++) {
      if (p + 2 > buf.length) break;
      const len = bufR16(buf, p); p += 2;
      if (len) {
        let s = '';
        for (let j = 0; j < len && p + 1 < buf.length; j++) {
          s += String.fromCharCode(bufR16(buf, p)); p += 2;
        }
        strings[(bundleId - 1) * 16 + i] = s;
      }
    }
    return strings;
  }

  // --- Icon parser ---
  function parseGroupIcon(buf) {
    const count = bufR16(buf, 4);
    const icons = [];
    let p = 6;
    for (let i = 0; i < count; i++) {
      icons.push({
        width: buf[p] || 256,
        height: buf[p + 1] || 256,
        colors: buf[p + 2],
        bpp: bufR16(buf, p + 6),
        size: bufR32(buf, p + 8) >>> 0,
        id: bufR16(buf, p + 12),
      });
      p += 14;
    }
    return icons;
  }

  // --- Accelerator table parser ---
  function parseAccelerators(buf) {
    const accels = [];
    let p = 0;
    while (p + 8 <= buf.length) {
      const flags = bufR16(buf, p);
      const key = bufR16(buf, p + 2);
      const cmd = bufR16(buf, p + 4);
      accels.push({ flags, key, cmd, virtKey: !!(flags & 1) });
      p += 8;
      if (flags & 0x80) break;
    }
    return accels;
  }

  // --- DIB parser (4bpp and 8bpp paletted, plus 24bpp) ---
  function parseDIB(buf) {
    const biSize = bufR32(buf, 0);
    let w, h, bpp, numColors, paletteOff, palEntrySize;
    if (biSize === 12) {
      // OS/2 BITMAPCOREHEADER: 16-bit w/h, 3-byte palette entries
      w = bufR16(buf, 4);
      h = bufR16(buf, 6);
      bpp = bufR16(buf, 10);
      numColors = bpp <= 8 ? (1 << bpp) : 0;
      paletteOff = 12;
      palEntrySize = 3;
    } else if (biSize >= 40) {
      w = bufR32(buf, 4);
      h = bufR32(buf, 8);  // signed — positive = bottom-up
      bpp = bufR16(buf, 14);
      // biClrUsed (offset 32) overrides default palette length when nonzero
      const clrUsed = bufR32(buf, 32);
      numColors = clrUsed || (bpp <= 8 ? (1 << bpp) : 0);
      paletteOff = biSize;
      palEntrySize = 4;
    } else {
      return null;
    }
    const compression = (biSize >= 40) ? bufR32(buf, 16) : 0;  // BI_RGB=0, BI_RLE8=1, BI_RLE4=2
    const absH = Math.abs(h | 0);  // handle signed
    const bottomUp = (h | 0) > 0;
    const pixelOff = paletteOff + numColors * palEntrySize;
    const rowBytes = Math.ceil(w * bpp / 32) * 4;  // DWORD-aligned

    // RLE8 / RLE4 decompression — produce a flat per-row index buffer first,
    // then fall through to the normal palette → RGBA conversion below.
    let rleIndices = null;
    if (compression === 1 && bpp === 8) {
      rleIndices = new Uint8Array(w * absH);
      let p = pixelOff;
      let x = 0, y = 0;  // y measured from bottom (BMP row 0)
      while (p < buf.length) {
        const a = buf[p++], b = buf[p++];
        if (a === 0) {
          if (b === 0) { x = 0; y++; }                    // EOL
          else if (b === 1) break;                         // EOBMP
          else if (b === 2) { x += buf[p++]; y += buf[p++]; }  // delta
          else {
            // absolute run of `b` indices
            for (let i = 0; i < b; i++) {
              if (x < w && y < absH) rleIndices[(absH - 1 - y) * w + x] = buf[p + i];
              x++;
            }
            p += b;
            if (b & 1) p++;  // word-aligned
          }
        } else {
          // encoded run: a copies of index b
          for (let i = 0; i < a; i++) {
            if (x < w && y < absH) rleIndices[(absH - 1 - y) * w + x] = b;
            x++;
          }
        }
      }
    } else if (compression === 2 && bpp === 4) {
      // RLE4 — pack into per-pixel indices the same way
      rleIndices = new Uint8Array(w * absH);
      let p = pixelOff;
      let x = 0, y = 0;
      while (p < buf.length) {
        const a = buf[p++], b = buf[p++];
        if (a === 0) {
          if (b === 0) { x = 0; y++; }
          else if (b === 1) break;
          else if (b === 2) { x += buf[p++]; y += buf[p++]; }
          else {
            // absolute run: b nibbles, padded to word
            const nibbles = b;
            const bytes = (nibbles + 1) >> 1;
            for (let i = 0; i < nibbles; i++) {
              const byte = buf[p + (i >> 1)];
              const nib = (i & 1) ? (byte & 0xF) : (byte >> 4);
              if (x < w && y < absH) rleIndices[(absH - 1 - y) * w + x] = nib;
              x++;
            }
            p += bytes;
            if (bytes & 1) p++;  // word-aligned
          }
        } else {
          // encoded run: a pixels alternating high/low nibble of b
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
    // For 8bpp bitmaps, also keep the raw palette indices and BGRA palette
    // so GetDIBits/GetDIBColorTable can return real data to the skin loader.
    let indices = null, paletteBGRA = null;
    if (bpp === 8) {
      indices = new Uint8Array(w * absH);
      paletteBGRA = new Uint8Array(numColors * 4);
      for (let i = 0; i < numColors; i++) {
        paletteBGRA[i * 4]     = buf[paletteOff + i * palEntrySize];      // B
        paletteBGRA[i * 4 + 1] = buf[paletteOff + i * palEntrySize + 1];  // G
        paletteBGRA[i * 4 + 2] = buf[paletteOff + i * palEntrySize + 2];  // R
        paletteBGRA[i * 4 + 3] = 0;
      }
    }
    // Read palette
    const pal = [];
    for (let i = 0; i < numColors; i++) {
      const b = buf[paletteOff + i * palEntrySize], g = buf[paletteOff + i * palEntrySize + 1], r = buf[paletteOff + i * palEntrySize + 2];
      pal.push(r, g, b, 255);
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
          // RLE8 indices are already laid out top-down by the decoder, so
          // index by `row` (top-down) rather than `srcRow` (bottom-up).
          const idx = rleIndices ? rleIndices[row * w + x] : buf[srcOff + x];
          indices[row * w + x] = idx;
          pixels[dstOff + x * 4] = pal[idx * 4];
          pixels[dstOff + x * 4 + 1] = pal[idx * 4 + 1];
          pixels[dstOff + x * 4 + 2] = pal[idx * 4 + 2];
          pixels[dstOff + x * 4 + 3] = 255;
        }
      } else if (bpp === 4 && rleIndices) {
        for (let x = 0; x < w; x++) {
          const idx = rleIndices[row * w + x];
          pixels[dstOff + x * 4] = pal[idx * 4];
          pixels[dstOff + x * 4 + 1] = pal[idx * 4 + 1];
          pixels[dstOff + x * 4 + 2] = pal[idx * 4 + 2];
          pixels[dstOff + x * 4 + 3] = 255;
        }
      } else if (bpp === 24) {
        for (let x = 0; x < w; x++) {
          pixels[dstOff + x * 4] = buf[srcOff + x * 3 + 2];     // R
          pixels[dstOff + x * 4 + 1] = buf[srcOff + x * 3 + 1]; // G
          pixels[dstOff + x * 4 + 2] = buf[srcOff + x * 3];     // B
          pixels[dstOff + x * 4 + 3] = 255;
        }
      }
    }
    return { w, h: absH, bpp, pixels, indices, paletteBGRA };
  }

  // --- Build output ---
  const result = { menus: {}, strings: {}, icons: {}, accelerators: {}, bitmaps: {} };

  // Try language 1033 (English US) first, then any language
  const tryLangs = [1033, undefined];

  for (const id of listResIds(4)) {
    for (const lang of tryLangs) {
      const buf = getResData(4, id, lang);
      // Presence sentinel — WAT walks the PE resource directly via
      // $menu_load when the window is first painted, so JS only needs
      // to know which IDs exist.
      if (buf) { result.menus[id] = true; break; }
    }
  }

  for (const id of listResIds(6)) {
    for (const lang of tryLangs) {
      const buf = getResData(6, id, lang);
      if (buf) { Object.assign(result.strings, parseStringBundle(buf, id)); break; }
    }
  }

  for (const id of listResIds(14)) {
    for (const lang of tryLangs) {
      const buf = getResData(14, id, lang);
      if (buf) {
        const group = parseGroupIcon(buf);
        group.sort((a, b) => b.size - a.size);
        if (group.length) {
          const iconBuf = getResData(3, group[0].id, lang) || getResData(3, group[0].id, undefined);
          if (iconBuf) {
            // Convert to base64 for easy embedding
            let b64 = '';
            for (let i = 0; i < iconBuf.length; i++) b64 += String.fromCharCode(iconBuf[i]);
            if (typeof btoa !== 'undefined') b64 = btoa(b64);
            else if (typeof Buffer !== 'undefined') b64 = Buffer.from(iconBuf).toString('base64');
            result.icons[id] = { width: group[0].width, height: group[0].height, bpp: group[0].bpp, data: b64 };
          }
        }
        break;
      }
    }
  }

  for (const id of listResIds(9)) {
    for (const lang of tryLangs) {
      const buf = getResData(9, id, lang);
      if (buf) { result.accelerators[id] = parseAccelerators(buf); break; }
    }
  }

  // RT_BITMAP (type 2) — parse DIB data into RGBA pixel arrays
  for (const id of listResIds(2)) {
    for (const lang of tryLangs) {
      const buf = getResData(2, id, lang);
      if (buf) {
        const bmp = parseDIB(buf);
        if (bmp) {
          // Resolve named resource IDs to string names
          if (id & 0x80000000) {
            const strOff = rsrc_off + (id & 0x7FFFFFFF);
            const len = r16(strOff);
            let name = '';
            for (let k = 0; k < len; k++) name += String.fromCharCode(r16(strOff + 2 + k * 2));
            bmp.name = name;
          }
          result.bitmaps[id] = bmp;
        }
        break;
      }
    }
  }

  return result;
}

// Export for both Node and browser
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseResources };
} else if (typeof window !== 'undefined') {
  window.parseResources = parseResources;
}
