// Browser-side PE icon extractor for the desktop. Walks .rsrc directly,
// finds the first RT_GROUP_ICON, picks its best entry (32x32, highest
// bpp), pulls the matching RT_ICON DIB, decodes it via parseDIB from
// lib/dib.js, then encodes to a data URL. Pure host code — does not
// touch WASM, so it runs before any guest is loaded.

function extractIconRgba(peBytes) {
  const u8 = peBytes instanceof Uint8Array ? peBytes : new Uint8Array(peBytes);
  if (u8.length < 64 || u8[0] !== 0x4D || u8[1] !== 0x5A) return null;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const r16 = (o) => dv.getUint16(o, true);
  const r32 = (o) => dv.getUint32(o, true);

  const peOff = r32(0x3c);
  if (peOff + 24 > u8.length || r32(peOff) !== 0x00004550) return null;
  const numSec = r16(peOff + 6);
  const optSize = r16(peOff + 20);

  let rsrcRva = 0, rsrcOff = 0;
  let sec = peOff + 24 + optSize;
  for (let i = 0; i < numSec; i++) {
    let name = '';
    for (let j = 0; j < 8 && u8[sec + j]; j++) name += String.fromCharCode(u8[sec + j]);
    if (name === '.rsrc') { rsrcRva = r32(sec + 12); rsrcOff = r32(sec + 20); break; }
    sec += 40;
  }
  if (!rsrcRva) return null;

  // Find a type-level subdir entry by integer ID (L1 only uses int IDs).
  function findType(typeId) {
    const named = r16(rsrcOff + 12);
    const ids = r16(rsrcOff + 14);
    let e = 16 + named * 8;
    for (let i = 0; i < ids; i++) {
      if (r32(rsrcOff + e) === typeId) {
        const doff = r32(rsrcOff + e + 4);
        return (doff & 0x80000000) ? (doff & 0x7FFFFFFF) : null;
      }
      e += 8;
    }
    return null;
  }
  // Take the first entry under a directory (named or id), descend through
  // any further subdirectory levels to a leaf data entry, and return its bytes.
  function firstLeafBytes(dirOff) {
    const named = r16(rsrcOff + dirOff + 12);
    const ids = r16(rsrcOff + dirOff + 14);
    if (named + ids === 0) return null;
    let doff = r32(rsrcOff + dirOff + 16 + 4);
    while (doff & 0x80000000) {
      const sub = doff & 0x7FFFFFFF;
      const sn = r16(rsrcOff + sub + 12);
      const si = r16(rsrcOff + sub + 14);
      if (sn + si === 0) return null;
      doff = r32(rsrcOff + sub + 16 + 4);
    }
    const rva = r32(rsrcOff + doff);
    const size = r32(rsrcOff + doff + 4);
    const foff = rva - rsrcRva + rsrcOff;
    return u8.subarray(foff, foff + size);
  }
  // Find a specific name-or-id entry under a directory and return leaf bytes.
  function findLeafBytes(dirOff, idOrNameOff, isNamed) {
    const named = r16(rsrcOff + dirOff + 12);
    const ids = r16(rsrcOff + dirOff + 14);
    const start = isNamed ? 0 : named;
    const end = isNamed ? named : (named + ids);
    for (let i = start; i < end; i++) {
      const eid = r32(rsrcOff + dirOff + 16 + i * 8);
      const eoff = r32(rsrcOff + dirOff + 16 + i * 8 + 4);
      if (isNamed ? ((eid & 0x7FFFFFFF) === idOrNameOff) : (eid === idOrNameOff)) {
        let doff = eoff;
        while (doff & 0x80000000) {
          const sub = doff & 0x7FFFFFFF;
          const sn = r16(rsrcOff + sub + 12);
          const si = r16(rsrcOff + sub + 14);
          if (sn + si === 0) return null;
          doff = r32(rsrcOff + sub + 16 + 4);
        }
        const rva = r32(rsrcOff + doff);
        const size = r32(rsrcOff + doff + 4);
        const foff = rva - rsrcRva + rsrcOff;
        return u8.subarray(foff, foff + size);
      }
    }
    return null;
  }

  const groupDir = findType(14);
  if (groupDir == null) return null;
  const groupBuf = firstLeafBytes(groupDir);
  if (!groupBuf || groupBuf.length < 6) return null;

  const iconDir = findType(3);
  if (iconDir == null) return null;

  const count = groupBuf[4] | (groupBuf[5] << 8);
  let bestIdx = -1, bestScore = -1;
  for (let i = 0; i < count; i++) {
    const o = 6 + i * 14;
    if (o + 14 > groupBuf.length) break;
    const w = groupBuf[o] || 256;
    const bpp = groupBuf[o + 6] | (groupBuf[o + 7] << 8);
    const dimScore = (w === 32) ? 1000 : (w <= 48 ? w : (256 - w));
    const score = dimScore * 100 + bpp;
    if (score > bestScore) { bestScore = score; bestIdx = i; }
  }
  if (bestIdx < 0) return null;
  const iconId = groupBuf[6 + bestIdx * 14 + 12] | (groupBuf[6 + bestIdx * 14 + 13] << 8);

  const iconBuf = findLeafBytes(iconDir, iconId, false);
  if (!iconBuf || iconBuf.length < 40) return null;

  // Icon DIBs are stored with biHeight = 2 * realH because the AND mask
  // is appended below the colour rows. Patch height to the real value
  // so parseDIB walks the right number of rows, then apply the mask.
  const ibDv = new DataView(iconBuf.buffer, iconBuf.byteOffset, iconBuf.byteLength);
  const biSize = ibDv.getUint32(0, true);
  if (biSize < 40) return null;
  const realW = ibDv.getInt32(4, true);
  const storedH = ibDv.getInt32(8, true);
  const realH = Math.abs(storedH) >> 1;
  if (realW <= 0 || realH <= 0) return null;
  const patched = new Uint8Array(iconBuf);
  new DataView(patched.buffer).setInt32(8, storedH < 0 ? -realH : realH, true);

  const dib = parseDIB(patched);
  if (!dib) return null;
  const bpp = dib.bpp;

  // Locate AND mask in the original (unpatched) buffer.
  const numColors = (bpp <= 8) ? (1 << bpp) : 0;
  const palBytes = numColors * 4;
  const colorRow = Math.ceil(realW * bpp / 32) * 4;
  const maskRow = Math.ceil(realW / 32) * 4;
  const maskOff = biSize + palBytes + colorRow * realH;
  const haveMask = (maskOff + maskRow * realH) <= iconBuf.length;

  if (bpp === 32) {
    let anyAlpha = false;
    for (let i = 3; i < dib.pixels.length; i += 4) {
      if (dib.pixels[i]) { anyAlpha = true; break; }
    }
    if (!anyAlpha && haveMask) {
      for (let y = 0; y < realH; y++) {
        const srcRow = realH - 1 - y;
        for (let x = 0; x < realW; x++) {
          const byte = iconBuf[maskOff + srcRow * maskRow + (x >> 3)];
          const bit = (byte >> (7 - (x & 7))) & 1;
          dib.pixels[(y * realW + x) * 4 + 3] = bit ? 0 : 255;
        }
      }
    }
  } else if (haveMask) {
    for (let y = 0; y < realH; y++) {
      const srcRow = realH - 1 - y;
      for (let x = 0; x < realW; x++) {
        const byte = iconBuf[maskOff + srcRow * maskRow + (x >> 3)];
        const bit = (byte >> (7 - (x & 7))) & 1;
        if (bit) dib.pixels[(y * realW + x) * 4 + 3] = 0;
      }
    }
  }

  return { w: realW, h: realH, pixels: dib.pixels };
}

function rgbaToDataURL(w, h, pixels) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(w, h);
  img.data.set(pixels);
  ctx.putImageData(img, 0, 0);
  return cv.toDataURL('image/png');
}

async function fetchIconDataURL(exeUrl) {
  try {
    const resp = await fetch(exeUrl);
    if (!resp.ok) return null;
    const buf = new Uint8Array(await resp.arrayBuffer());
    const icon = extractIconRgba(buf);
    if (!icon) return null;
    return rgbaToDataURL(icon.w, icon.h, icon.pixels);
  } catch (e) {
    return null;
  }
}

if (typeof window !== 'undefined') {
  window.extractIconRgba = extractIconRgba;
  window.fetchIconDataURL = fetchIconDataURL;
}
