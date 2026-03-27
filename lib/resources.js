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

  if (!rsrc_rva) return { menus: {}, dialogs: {}, strings: {}, icons: {}, accelerators: {} };

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
    return readSz(buf, pos);
  }

  function bufR16(buf, off) { return buf[off] | (buf[off + 1] << 8); }
  function bufR32(buf, off) { return buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24); }
  function bufRS16(buf, off) { const v = bufR16(buf, off); return v >= 0x8000 ? v - 0x10000 : v; }

  // --- Menu parser ---
  function parseMenu(buf) {
    let pos = 4;
    function parseItems() {
      const items = [];
      while (pos < buf.length) {
        const flags = bufR16(buf, pos); pos += 2;
        const isPopup = !!(flags & 0x10);
        let id = 0;
        if (!isPopup) { id = bufR16(buf, pos); pos += 2; }
        const r = readSz(buf, pos); pos = r.pos;
        const item = {};
        if (!r.str && !isPopup && id === 0) {
          item.separator = true;
        } else {
          item.text = r.str;
          if (id) item.id = id;
          if (isPopup) item.children = parseItems();
        }
        if (flags & 0x08) item.checked = true;
        if (flags & 0x01) item.grayed = true;
        items.push(item);
        if (flags & 0x80) break;
      }
      return items;
    }
    return parseItems();
  }

  // --- Dialog parser ---
  function parseDialog(buf) {
    let p = 0;
    const sig = bufR16(buf, 0);
    const ver = bufR16(buf, 2);
    const isEx = (sig === 1 && ver === 0xFFFF);
    const dlg = { controls: [] };

    if (isEx) {
      p = 4;
      dlg.helpId = bufR32(buf, p) >>> 0; p += 4;
      dlg.exStyle = bufR32(buf, p) >>> 0; p += 4;
      dlg.style = bufR32(buf, p) >>> 0; p += 4;
    } else {
      dlg.style = bufR32(buf, p) >>> 0; p += 4;
      dlg.exStyle = bufR32(buf, p) >>> 0; p += 4;
    }

    const count = bufR16(buf, p); p += 2;
    dlg.x = bufRS16(buf, p); p += 2;
    dlg.y = bufRS16(buf, p); p += 2;
    dlg.cx = bufRS16(buf, p); p += 2;
    dlg.cy = bufRS16(buf, p); p += 2;

    let r;
    r = readOrdOrSz(buf, p); dlg.menu = r.val; p = r.pos;
    r = readOrdOrSz(buf, p); dlg.className = r.val; p = r.pos;
    r = readSz(buf, p); dlg.title = r.str; p = r.pos;

    if (dlg.style & 0x40) { // DS_SETFONT
      dlg.fontSize = bufR16(buf, p); p += 2;
      if (isEx) {
        dlg.fontWeight = bufR16(buf, p); p += 2;
        dlg.fontItalic = buf[p]; p += 1;
        dlg.fontCharset = buf[p]; p += 1;
      }
      r = readSz(buf, p); dlg.fontName = r.str; p = r.pos;
    }

    const CLASS_NAMES = { 0x80: 'Button', 0x81: 'Edit', 0x82: 'Static', 0x83: 'ListBox', 0x84: 'ScrollBar', 0x85: 'ComboBox' };

    for (let i = 0; i < count; i++) {
      p = (p + 3) & ~3;
      if (p + 18 > buf.length) break;

      const ctrl = {};
      if (isEx) {
        ctrl.helpId = bufR32(buf, p) >>> 0; p += 4;
        ctrl.exStyle = bufR32(buf, p) >>> 0; p += 4;
        ctrl.style = bufR32(buf, p) >>> 0; p += 4;
      } else {
        ctrl.style = bufR32(buf, p) >>> 0; p += 4;
        ctrl.exStyle = bufR32(buf, p) >>> 0; p += 4;
      }
      ctrl.x = bufRS16(buf, p); p += 2;
      ctrl.y = bufRS16(buf, p); p += 2;
      ctrl.cx = bufRS16(buf, p); p += 2;
      ctrl.cy = bufRS16(buf, p); p += 2;
      ctrl.id = isEx ? (bufR32(buf, p) >>> 0) : bufR16(buf, p);
      p += isEx ? 4 : 2;

      r = readOrdOrSz(buf, p);
      ctrl.className = (typeof r.val === 'number') ? (CLASS_NAMES[r.val] || '#' + r.val) : r.val;
      p = r.pos;

      r = readOrdOrSz(buf, p);
      ctrl.text = (typeof r.val === 'number') ? '#' + r.val : (r.val || '');
      p = r.pos;

      const extra = bufR16(buf, p); p += 2;
      if (extra) p += extra;

      if (ctrl.className === 'Button') {
        const bs = ctrl.style & 0x0F;
        if (bs === 0x00) ctrl.type = 'pushbutton';
        else if (bs === 0x01) ctrl.type = 'defpushbutton';
        else if (bs === 0x02) ctrl.type = 'checkbox';
        else if (bs === 0x03) ctrl.type = 'autocheckbox';
        else if (bs === 0x04 || bs === 0x09) ctrl.type = 'radiobutton';
        else if (bs === 0x07) ctrl.type = 'groupbox';
        else ctrl.type = 'button';
      }

      dlg.controls.push(ctrl);
    }

    return dlg;
  }

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

  // --- Build output ---
  const result = { menus: {}, dialogs: {}, strings: {}, icons: {}, accelerators: {} };

  // Try language 1033 (English US) first, then any language
  const tryLangs = [1033, undefined];

  for (const id of listResIds(4)) {
    for (const lang of tryLangs) {
      const buf = getResData(4, id, lang);
      if (buf) { result.menus[id] = parseMenu(buf); break; }
    }
  }

  for (const id of listResIds(5)) {
    for (const lang of tryLangs) {
      const buf = getResData(5, id, lang);
      if (buf) { result.dialogs[id] = parseDialog(buf); break; }
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

  // Map string IDs to dialog control text
  if (result.strings) {
    for (const dlg of Object.values(result.dialogs)) {
      for (const ctrl of dlg.controls) {
        const strIdx = ctrl.id - 80;
        if (strIdx >= 0 && strIdx < 80 && result.strings[strIdx] && !ctrl.text) {
          ctrl.text = result.strings[strIdx];
        }
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
