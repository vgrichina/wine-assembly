// Browser-side icon loader/extractor for the desktop. The normal path loads a
// tiny pre-extracted PNG from icons/apps/. If that asset is absent, it fetches
// the executable, finds its first RT_GROUP_ICON, pulls the matching RT_ICON
// DIB, decodes it via parseDIB, and encodes it to a data URL. Pure host code —
// does not touch WASM, so it runs before any guest is loaded.
//
// Two container formats, one decode. A 32-bit PE keeps resources in a tree
// under .rsrc; a 16-bit NE keeps a flat list of types, each with a run of
// NAMEINFO records, and nothing about it resembles the tree. What is *inside*
// is the same in both: a GRPICONDIR of 14-byte entries, and icons that are
// BITMAPINFOHEADER DIBs with the AND mask appended. So each container only has
// to enumerate its icon groups and retrieve an image by resource id; selection,
// decoding and guest HICON ownership stay shared. Hearts is an NE and spent its
// life on the desktop as a fallback glyph for want of these thirty lines.

// The flat NE resource table: WORD align shift, then TYPEINFO records until a
// zero type id. Offsets and lengths are stored shifted by that alignment.
function neResourceReader(u8, dv, neOff) {
  const r16 = (o) => dv.getUint16(o, true);
  if (neOff + 0x28 > u8.length || r16(neOff) !== 0x454E) return null;   // 'NE'
  const tableOff = neOff + r16(neOff + 0x24);
  // The resource table ends where the resident-name table begins; equal
  // offsets mean the module has no resources at all.
  if (r16(neOff + 0x24) === r16(neOff + 0x26)) return reader([]);
  if (tableOff + 2 > u8.length) return null;
  const shift = r16(tableOff);
  if (shift > 16) return null;

  const found = [];
  let p = tableOff + 2;
  for (let guard = 0; guard < 256; guard++) {
    if (p + 8 > u8.length) break;
    const typeId = r16(p);
    if (typeId === 0) break;
    const count = r16(p + 2);
    p += 8;
    for (let i = 0; i < count; i++) {
      if (p + 12 > u8.length) return reader(found);
      found.push({
        type: typeId,
        id: r16(p + 6),
        off: r16(p) << shift,
        len: r16(p + 2) << shift,
      });
      p += 12;
    }
  }
  return reader(found);

  function reader(entries) {
    const bytes = (e) => (e && e.off + e.len <= u8.length)
      ? u8.subarray(e.off, e.off + e.len) : null;
    return {
      // 0x8000 marks an integer id, which is what RT_* always are.
      groups: () => entries.filter(e => e.type === (0x8000 | 14))
        .map(e => ({ id: (e.id & 0x8000) ? (e.id & 0x7FFF) : null, bytes: bytes(e) }))
        .filter(e => !!e.bytes),
      firstGroup: () => bytes(entries.find(e => e.type === (0x8000 | 14))),
      iconById: (id) => bytes(entries.find(e =>
        e.type === (0x8000 | 3) && (e.id & 0x7FFF) === (id & 0x7FFF))),
    };
  }
}

function peResourceReader(u8, dv, peOff) {
  const r16 = (o) => dv.getUint16(o, true);
  const r32 = (o) => dv.getUint32(o, true);
  if (peOff + 24 > u8.length) return null;
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
  if (!rsrcRva) return emptyResourceReader();

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

  function leafBytesFromEntry(entryOff) {
    if (entryOff + 8 > u8.length) return null;
    let doff = r32(entryOff + 4);
    for (let guard = 0; guard < 8 && (doff & 0x80000000); guard++) {
      const sub = doff & 0x7FFFFFFF;
      if (rsrcOff + sub + 24 > u8.length) return null;
      const count = r16(rsrcOff + sub + 12) + r16(rsrcOff + sub + 14);
      if (!count) return null;
      doff = r32(rsrcOff + sub + 20);
    }
    if ((doff & 0x80000000) || rsrcOff + doff + 16 > u8.length) return null;
    const rva = r32(rsrcOff + doff);
    const size = r32(rsrcOff + doff + 4);
    const foff = rva - rsrcRva + rsrcOff;
    return foff >= 0 && foff + size <= u8.length
      ? u8.subarray(foff, foff + size) : null;
  }

  function groupEntries() {
    const dirOff = findType(14);
    if (dirOff == null || rsrcOff + dirOff + 16 > u8.length) return [];
    const count = r16(rsrcOff + dirOff + 12) + r16(rsrcOff + dirOff + 14);
    const out = [];
    for (let i = 0; i < count; i++) {
      const entryOff = rsrcOff + dirOff + 16 + i * 8;
      if (entryOff + 8 > u8.length) break;
      const eid = r32(entryOff);
      const bytes = leafBytesFromEntry(entryOff);
      if (bytes) out.push({ id: (eid & 0x80000000) ? null : eid, bytes });
    }
    return out;
  }

  return {
    groups: groupEntries,
    firstGroup: () => {
      const groups = groupEntries();
      return groups.length ? groups[0].bytes : null;
    },
    iconById: (id) => {
      const dir = findType(3);
      return dir == null ? null : findLeafBytes(dir, id, false);
    },
  };
}

function emptyResourceReader() {
  return { groups: () => [], firstGroup: () => null, iconById: () => null };
}

function iconChoice(entries, wantedSize) {
  let best = null;
  for (const entry of entries) {
    if (!entry.bytes || entry.bytes.length < 12) continue;
    // PNG icon images postdate Win98. The guest USER decoder intentionally
    // accepts only the classic DIB formats available to Win9x applications.
    if (entry.bytes.length >= 4 && entry.bytes[0] === 0x89 &&
        entry.bytes[1] === 0x50 && entry.bytes[2] === 0x4E && entry.bytes[3] === 0x47) continue;
    const w = entry.w || 256;
    const h = entry.h || 256;
    const distance = Math.abs(w - wantedSize) + Math.abs(h - wantedSize);
    const score = distance * 256 - Math.min(entry.bpp || 0, 32);
    if (!best || score < best.score) best = { score, bytes: entry.bytes };
  }
  return best && best.bytes;
}

function groupIconEntries(group, reader) {
  if (!group || !group.bytes || group.bytes.length < 6) return [];
  const bytes = group.bytes;
  const count = bytes[4] | (bytes[5] << 8);
  const out = [];
  for (let i = 0; i < count; i++) {
    const o = 6 + i * 14;
    if (o + 14 > bytes.length) break;
    const id = bytes[o + 12] | (bytes[o + 13] << 8);
    out.push({
      w: bytes[o] || 256,
      h: bytes[o + 1] || 256,
      bpp: bytes[o + 6] | (bytes[o + 7] << 8),
      bytes: reader.iconById(id),
    });
  }
  return out;
}

function icoResourceExtractor(u8, dv) {
  if (u8.length < 6 || dv.getUint16(0, true) !== 0 || dv.getUint16(2, true) !== 1) return null;
  const count = dv.getUint16(4, true);
  const entries = [];
  for (let i = 0; i < count; i++) {
    const o = 6 + i * 16;
    if (o + 16 > u8.length) return null;
    const size = dv.getUint32(o + 8, true);
    const offset = dv.getUint32(o + 12, true);
    if (offset + size > u8.length) continue;
    entries.push({
      w: u8[o] || 256,
      h: u8[o + 1] || 256,
      bpp: dv.getUint16(o + 6, true),
      bytes: u8.subarray(offset, offset + size),
    });
  }
  return {
    count: entries.length ? 1 : 0,
    groupIds: entries.length ? [null] : [],
    resource(index, wantedSize) {
      return index === 0 ? iconChoice(entries, wantedSize) : null;
    },
  };
}

// Container-only extraction shared by the desktop PNG path and the guest
// Shell APIs. The result is still a packed RT_ICON/ICO DIB; WAT materializes
// it into caller-owned mask/color planes and remains the sole HICON owner.
function createIconResourceExtractor(exeBytes) {
  const u8 = exeBytes instanceof Uint8Array ? exeBytes : new Uint8Array(exeBytes);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (u8.length >= 6 && u8[0] === 0 && u8[1] === 0) {
    const ico = icoResourceExtractor(u8, dv);
    if (ico) return ico;
  }
  if (u8.length < 64 || u8[0] !== 0x4D || u8[1] !== 0x5A) return null;
  const headerOff = dv.getUint32(0x3c, true);
  if (headerOff + 4 > u8.length) return null;
  const signature = dv.getUint32(headerOff, true);
  const reader = signature === 0x00004550
    ? peResourceReader(u8, dv, headerOff)
    : ((signature & 0xFFFF) === 0x454E ? neResourceReader(u8, dv, headerOff) : null);
  if (!reader) return null;
  const groups = reader.groups();
  return {
    count: groups.length,
    groupIds: groups.map(group => group.id),
    resource(index, wantedSize) {
      const group = index < 0
        ? groups.find(candidate => candidate.id === -index)
        : groups[index];
      return iconChoice(groupIconEntries(group, reader), wantedSize);
    },
  };
}

function extractIconRgba(exeBytes) {
  // Preserve the desktop's historical first-group choice exactly. Guest
  // ExtractIcon uses the size-aware selector above, but changing the desktop
  // policy would invalidate checked-in artwork for no API-fidelity benefit.
  const u8 = exeBytes instanceof Uint8Array ? exeBytes : new Uint8Array(exeBytes);
  if (u8.length < 64 || u8[0] !== 0x4D || u8[1] !== 0x5A) return null;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const headerOff = dv.getUint32(0x3c, true);
  if (headerOff + 4 > u8.length) return null;
  const reader = dv.getUint32(headerOff, true) === 0x00004550
    ? peResourceReader(u8, dv, headerOff) : neResourceReader(u8, dv, headerOff);
  if (!reader) return null;
  const groupBuf = reader.firstGroup();
  if (!groupBuf || groupBuf.length < 6) return null;
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
  const iconId = groupBuf[6 + bestIdx * 14 + 12] |
    (groupBuf[6 + bestIdx * 14 + 13] << 8);
  const iconBuf = reader.iconById(iconId);
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

  // lib/dib.js is a global in the page and a module under Node, where this
  // file is loaded by its test.
  const decode = (typeof parseDIB === 'function')
    ? parseDIB : require('./dib').parseDIB;
  const dib = decode(patched);
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

// The same extraction, for an executable we already hold the bytes of.
//
// Every path above assumes a URL to fetch, which an imported program does not
// have -- it came off a dropped zip, a mounted ISO, or the OPFS library
// (docs/design-byo-media.md). Its desktop icon has to come from the bytes in
// hand, and the walker itself never cared where they came from.
function iconDataURLFromBytes(exeBytes) {
  try {
    const icon = extractIconRgba(exeBytes);
    if (!icon) return null;
    return rgbaToDataURL(icon.w, icon.h, icon.pixels);
  } catch (e) {
    return null;
  }
}

function preExtractedIconUrl(appId) {
  return 'icons/apps/' + encodeURIComponent(appId) + '.png';
}

// What tools/extract-app-icons.js already learned about every registered app,
// fetched once for the whole desktop. Without it a missing PNG is ambiguous —
// "not generated yet" and "this executable genuinely has no icon" look the
// same from here — and the only safe reading of the ambiguity is to download
// the executable. That guess cost a cold load 39MB for quake2_demo_installer
// alone, every time, to rediscover that it has no RT_GROUP_ICON.
//
// A failed fetch resolves to null rather than rejecting: an old deploy or an
// ad-hoc host without the file must keep working, just without the shortcut.
let iconManifestPromise = null;
function iconManifest() {
  if (!iconManifestPromise) {
    iconManifestPromise = fetch('lib/app-icon-manifest.json')
      .then(r => (r.ok ? r.json() : null))
      .catch(() => null);
  }
  return iconManifestPromise;
}

// Keep the fallback glyph in place until an image has actually loaded, so an
// app the manifest does not cover shows the glyph rather than a gap while its
// executable downloads.
async function loadAppIcon(iconContainer, appId, exeUrl) {
  const manifest = await iconManifest().catch(() => null);
  const bucket = manifest
    ? (manifest.noIcon.includes(appId) ? 'noIcon'
      : manifest.runtime.includes(appId) ? 'runtime'
      : manifest.icons.includes(appId) ? 'icons' : null)
    : null;

  // The build opened this executable and found no icon in it. Downloading it
  // again cannot change that answer, so don't.
  if (bucket === 'noIcon') return null;

  return new Promise(resolve => {
    function tryImage(url, source, onError) {
      const img = document.createElement('img');
      img.style.width = '32px';
      img.style.height = '32px';
      img.style.imageRendering = 'pixelated';
      img.onload = () => {
        iconContainer.replaceChildren(img);
        iconContainer.style.background = 'transparent';
        iconContainer.style.border = '0';
        resolve(source);
      };
      img.onerror = onError;
      img.src = url;
    }

    async function fromExecutable() {
      if (!exeUrl) { resolve(null); return; }
      const dataUrl = await fetchIconDataURL(exeUrl);
      if (!dataUrl) { resolve(null); return; }
      tryImage(dataUrl, 'executable', () => resolve(null));
    }

    // preExtractIcon:false — the icon exists but may not be redistributed, so
    // there is no PNG to ask for and the 404 would be pure latency.
    if (bucket === 'runtime') { fromExecutable(); return; }
    tryImage(preExtractedIconUrl(appId), 'pre-extracted', fromExecutable);
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    extractIconRgba,
    createIconResourceExtractor,
    peResourceReader,
    neResourceReader,
    preExtractedIconUrl,
    loadAppIcon,
  };
} else if (typeof window !== 'undefined') {
  window.extractIconRgba = extractIconRgba;
  window.createIconResourceExtractor = createIconResourceExtractor;
  window.iconDataURLFromBytes = iconDataURLFromBytes;
  window.fetchIconDataURL = fetchIconDataURL;
  window.preExtractedIconUrl = preExtractedIconUrl;
  window.loadAppIcon = loadAppIcon;
}
