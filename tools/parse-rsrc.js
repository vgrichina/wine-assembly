#!/usr/bin/env node
// Parse PE resource sections → JSON for web renderer
// Usage: node tools/parse-rsrc.js <exe> [--out=file.json]

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const exePath = args.find(a => !a.startsWith('--')) || 'test/binaries/notepad.exe';
const outArg = args.find(a => a.startsWith('--out='));
const outPath = outArg ? outArg.split('=')[1] : null;

const pe = fs.readFileSync(exePath);
const pe_off = pe.readUInt32LE(0x3c);
const num_sec = pe.readUInt16LE(pe_off + 6);
const opt_size = pe.readUInt16LE(pe_off + 20);
const image_base = pe.readUInt32LE(pe_off + 52);

// Find .rsrc section
let rsrc_rva = 0, rsrc_off = 0, rsrc_size = 0;
let sec = pe_off + 24 + opt_size;
for (let i = 0; i < num_sec; i++) {
  const name = pe.toString('ascii', sec, sec + 8).replace(/\0/g, '');
  if (name === '.rsrc') {
    rsrc_rva = pe.readUInt32LE(sec + 12);
    rsrc_off = pe.readUInt32LE(sec + 20);
    rsrc_size = pe.readUInt32LE(sec + 16);
  }
  sec += 40;
}

if (!rsrc_rva) {
  console.error('No .rsrc section found');
  process.exit(1);
}

// --- Resource directory walker ---
function getResData(typeId, nameId, langId) {
  function findEntry(off, id) {
    const named = pe.readUInt16LE(rsrc_off + off + 12);
    const ids = pe.readUInt16LE(rsrc_off + off + 14);
    let e = off + 16;
    for (let i = 0; i < named + ids; i++) {
      const eid = pe.readUInt32LE(rsrc_off + e);
      const doff = pe.readUInt32LE(rsrc_off + e + 4);
      if (eid === id) return doff;
      e += 8;
    }
    return null;
  }
  let d = findEntry(0, typeId);  if (d === null) return null;
  d = findEntry(d & 0x7FFFFFFF, nameId);  if (d === null) return null;
  d = findEntry(d & 0x7FFFFFFF, langId);  if (d === null) return null;
  const rva = pe.readUInt32LE(rsrc_off + d);
  const size = pe.readUInt32LE(rsrc_off + d + 4);
  const foff = rva - rsrc_rva + rsrc_off;
  return pe.subarray(foff, foff + size);
}

// List all resources of a given type
function listResIds(typeId) {
  const named = pe.readUInt16LE(rsrc_off + 12);
  const ids = pe.readUInt16LE(rsrc_off + 14);
  let e = 16;
  for (let i = 0; i < named + ids; i++) {
    const eid = pe.readUInt32LE(rsrc_off + e);
    const doff = pe.readUInt32LE(rsrc_off + e + 4);
    if (eid === typeId && (doff & 0x80000000)) {
      // Walk name level
      const nameOff = doff & 0x7FFFFFFF;
      const n2 = pe.readUInt16LE(rsrc_off + nameOff + 12);
      const i2 = pe.readUInt16LE(rsrc_off + nameOff + 14);
      const result = [];
      let e2 = nameOff + 16;
      for (let j = 0; j < n2 + i2; j++) {
        result.push(pe.readUInt32LE(rsrc_off + e2));
        e2 += 8;
      }
      return result;
    }
    e += 8;
  }
  return [];
}

// --- UTF-16LE string reader ---
function readSz(buf, pos) {
  let s = '', p = pos;
  while (p + 1 < buf.length) {
    const ch = buf.readUInt16LE(p); p += 2;
    if (!ch) break;
    s += String.fromCharCode(ch);
  }
  return { str: s, pos: p };
}

function readOrdOrSz(buf, pos) {
  const w = buf.readUInt16LE(pos);
  if (w === 0) return { val: null, pos: pos + 2 };
  if (w === 0xFFFF) return { val: buf.readUInt16LE(pos + 2), pos: pos + 4 };
  const r = readSz(buf, pos);
  return { val: r.str, pos: r.pos };
}

// --- Menu parser ---
function parseMenu(buf) {
  let pos = 4; // skip version + offset
  function parseItems() {
    const items = [];
    while (pos < buf.length) {
      const flags = buf.readUInt16LE(pos); pos += 2;
      const isPopup = !!(flags & 0x10);
      let id = 0;
      if (!isPopup) { id = buf.readUInt16LE(pos); pos += 2; }
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
      if (flags & 0x80) break; // MF_END
    }
    return items;
  }
  return parseItems();
}

// --- Dialog parser ---
function parseDialog(buf) {
  let p = 0;
  const sig = buf.readUInt16LE(0);
  const ver = buf.readUInt16LE(2);
  const isEx = (sig === 1 && ver === 0xFFFF);

  const dlg = { controls: [] };

  if (isEx) {
    p = 4;
    dlg.helpId = buf.readUInt32LE(p); p += 4;
    dlg.exStyle = buf.readUInt32LE(p); p += 4;
    dlg.style = buf.readUInt32LE(p); p += 4;
  } else {
    dlg.style = buf.readUInt32LE(p); p += 4;
    dlg.exStyle = buf.readUInt32LE(p); p += 4;
  }

  const count = buf.readUInt16LE(p); p += 2;
  dlg.x = buf.readInt16LE(p); p += 2;
  dlg.y = buf.readInt16LE(p); p += 2;
  dlg.cx = buf.readInt16LE(p); p += 2;
  dlg.cy = buf.readInt16LE(p); p += 2;

  let r;
  r = readOrdOrSz(buf, p); dlg.menu = r.val; p = r.pos;
  r = readOrdOrSz(buf, p); dlg.className = r.val; p = r.pos;
  r = readSz(buf, p); dlg.title = r.str; p = r.pos;

  if (dlg.style & 0x40) { // DS_SETFONT
    dlg.fontSize = buf.readUInt16LE(p); p += 2;
    if (isEx) {
      dlg.fontWeight = buf.readUInt16LE(p); p += 2;
      dlg.fontItalic = buf.readUInt8(p); p += 1;
      dlg.fontCharset = buf.readUInt8(p); p += 1;
    }
    r = readSz(buf, p); dlg.fontName = r.str; p = r.pos;
  }

  const CLASS_NAMES = { 0x80: 'Button', 0x81: 'Edit', 0x82: 'Static', 0x83: 'ListBox', 0x84: 'ScrollBar', 0x85: 'ComboBox' };

  for (let i = 0; i < count; i++) {
    p = (p + 3) & ~3; // DWORD align
    if (p + 18 > buf.length) break;

    const ctrl = {};
    if (isEx) {
      ctrl.helpId = buf.readUInt32LE(p); p += 4;
      ctrl.exStyle = buf.readUInt32LE(p); p += 4;
      ctrl.style = buf.readUInt32LE(p); p += 4;
    } else {
      ctrl.style = buf.readUInt32LE(p); p += 4;
      ctrl.exStyle = buf.readUInt32LE(p); p += 4;
    }
    ctrl.x = buf.readInt16LE(p); p += 2;
    ctrl.y = buf.readInt16LE(p); p += 2;
    ctrl.cx = buf.readInt16LE(p); p += 2;
    ctrl.cy = buf.readInt16LE(p); p += 2;
    ctrl.id = isEx ? buf.readUInt32LE(p) : buf.readUInt16LE(p);
    p += isEx ? 4 : 2;

    r = readOrdOrSz(buf, p);
    ctrl.className = (typeof r.val === 'number') ? (CLASS_NAMES[r.val] || '#' + r.val) : r.val;
    p = r.pos;

    r = readOrdOrSz(buf, p);
    ctrl.text = (typeof r.val === 'number') ? '#' + r.val : (r.val || '');
    p = r.pos;

    const extra = buf.readUInt16LE(p); p += 2;
    if (extra) p += extra;

    // Decode style bits for buttons
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
    const len = buf.readUInt16LE(p); p += 2;
    if (len) {
      let s = '';
      for (let j = 0; j < len && p + 1 < buf.length; j++) {
        s += String.fromCharCode(buf.readUInt16LE(p)); p += 2;
      }
      strings[(bundleId - 1) * 16 + i] = s;
    }
  }
  return strings;
}

// --- Icon parser (convert to PNG data URL) ---
function parseGroupIcon(buf) {
  const count = buf.readUInt16LE(4);
  const icons = [];
  let p = 6;
  for (let i = 0; i < count; i++) {
    icons.push({
      width: buf.readUInt8(p) || 256,
      height: buf.readUInt8(p + 1) || 256,
      colors: buf.readUInt8(p + 2),
      bpp: buf.readUInt16LE(p + 6),
      size: buf.readUInt32LE(p + 8),
      id: buf.readUInt16LE(p + 12),
    });
    p += 14;
  }
  return icons;
}

function getIconAsBmp(iconId) {
  const data = getResData(3, iconId, 1033);
  if (!data) return null;
  // Icon resource is a DIB without BITMAPFILEHEADER
  // Wrap in .ico format for easy use
  return Buffer.from(data).toString('base64');
}

// --- Accelerator table parser ---
function parseAccelerators(buf) {
  const accels = [];
  let p = 0;
  while (p + 8 <= buf.length) {
    const flags = buf.readUInt16LE(p);
    const key = buf.readUInt16LE(p + 2);
    const cmd = buf.readUInt16LE(p + 4);
    accels.push({ flags, key, cmd, virtKey: !!(flags & 1) });
    p += 8;
    if (flags & 0x80) break; // last entry
  }
  return accels;
}

// --- Build output ---
const result = {
  file: path.basename(exePath),
  imageBase: image_base,
  menus: {},
  dialogs: {},
  strings: {},
  icons: {},
  accelerators: {},
};

// Menus
for (const id of listResIds(4)) {
  const buf = getResData(4, id, 1033);
  if (buf) result.menus[id] = parseMenu(buf);
}

// Dialogs
for (const id of listResIds(5)) {
  const buf = getResData(5, id, 1033);
  if (buf) result.dialogs[id] = parseDialog(buf);
}

// Strings
for (const id of listResIds(6)) {
  const buf = getResData(6, id, 1033);
  if (buf) Object.assign(result.strings, parseStringBundle(buf, id));
}

// Icons (group icons → individual icon data)
for (const id of listResIds(14)) {
  const buf = getResData(14, id, 1033);
  if (buf) {
    const group = parseGroupIcon(buf);
    // Pick largest icon
    group.sort((a, b) => b.size - a.size);
    if (group.length) {
      const iconData = getIconAsBmp(group[0].id);
      if (iconData) {
        result.icons[id] = {
          width: group[0].width,
          height: group[0].height,
          bpp: group[0].bpp,
          data: iconData,
        };
      }
    }
  }
}

// Accelerators
for (const id of listResIds(9)) {
  const buf = getResData(9, id, 1033);
  if (buf) result.accelerators[id] = parseAccelerators(buf);
}

// Map string IDs to dialog control IDs for calc buttons
if (result.strings && result.dialogs) {
  for (const [dlgId, dlg] of Object.entries(result.dialogs)) {
    for (const ctrl of dlg.controls) {
      // Calc uses control ID - 80 as string index
      const strIdx = ctrl.id - 80;
      if (strIdx >= 0 && strIdx < 80 && result.strings[strIdx] && !ctrl.text) {
        ctrl.text = result.strings[strIdx];
      }
    }
  }
}

const json = JSON.stringify(result, null, 2);
if (outPath) {
  fs.writeFileSync(outPath, json);
  console.log('Wrote', outPath, '(' + json.length + ' bytes)');
} else {
  console.log(json.substring(0, 200) + '...');
  console.log('\nSummary:');
  console.log('  Menus:', Object.keys(result.menus).length);
  console.log('  Dialogs:', Object.keys(result.dialogs).length);
  console.log('  Strings:', Object.keys(result.strings).length);
  console.log('  Icons:', Object.keys(result.icons).length);
  console.log('  Accelerators:', Object.keys(result.accelerators).length);
}
