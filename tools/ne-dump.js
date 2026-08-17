#!/usr/bin/env node
// Dump the structure of a 16-bit NE (New Executable) binary.
//
//   node tools/ne-dump.js <file.exe> [--segments] [--imports] [--entries]
//   node tools/ne-dump.js <file.exe> --relocs=N     one segment's fixup records
//   node tools/ne-dump.js <file.exe> --all
//
// The PE tools in this directory all assume a 32-bit image, so none of them
// can say anything about the Win16 binaries in test/binaries/win98-16bit.
// This prints the pieces a loader has to consume: the segment table with each
// segment's file position and flags, the module-reference and imported-name
// tables that name every DLL entry point the image calls, the entry table, and
// per-segment relocation records already resolved to "which import" or "which
// segment" so a fixup can be checked by eye.

const fs = require('fs');

const SEG_FLAGS = [
  [0x0001, 'DATA'], [0x0010, 'MOVEABLE'], [0x0020, 'SHAREABLE'],
  [0x0040, 'PRELOAD'], [0x0080, 'EXECUTEONLY/READONLY'], [0x0100, 'RELOCINFO'],
  [0x0200, 'DEBUGINFO'], [0x1000, 'DISCARDABLE'],
];

const RELOC_ADDR = ['LOBYTE', '?1', 'SEGMENT', 'FAR_ADDR', 'OFFSET', '?5', 'OFFSET32', '?7'];
const RELOC_TYPE = ['INTERNALREF', 'IMPORTORDINAL', 'IMPORTNAME', 'OSFIXUP'];

function pstr(buf, off) {
  const n = buf[off];
  return buf.toString('latin1', off + 1, off + 1 + n);
}

function parse(file) {
  const b = fs.readFileSync(file);
  if (b.readUInt16LE(0) !== 0x5a4d) throw new Error('not an MZ image');
  const ne = b.readUInt32LE(0x3c);
  if (b.readUInt16LE(ne) !== 0x454e) {
    throw new Error(`not an NE image (signature 0x${b.readUInt16LE(ne).toString(16)} at 0x${ne.toString(16)})`);
  }
  const h = {
    ne,
    linkVer: `${b[ne + 2]}.${b[ne + 3]}`,
    entryTableOff: ne + b.readUInt16LE(ne + 0x04),
    entryTableLen: b.readUInt16LE(ne + 0x06),
    flags: b.readUInt16LE(ne + 0x0c),
    autoDataSeg: b.readUInt16LE(ne + 0x0e),
    heapSize: b.readUInt16LE(ne + 0x10),
    stackSize: b.readUInt16LE(ne + 0x12),
    entryIP: b.readUInt16LE(ne + 0x14),
    entryCS: b.readUInt16LE(ne + 0x16),
    stackSP: b.readUInt16LE(ne + 0x18),
    stackSS: b.readUInt16LE(ne + 0x1a),
    segCount: b.readUInt16LE(ne + 0x1c),
    modRefCount: b.readUInt16LE(ne + 0x1e),
    nonResNameLen: b.readUInt16LE(ne + 0x20),
    segTableOff: ne + b.readUInt16LE(ne + 0x22),
    resTableOff: ne + b.readUInt16LE(ne + 0x24),
    resNameTableOff: ne + b.readUInt16LE(ne + 0x26),
    modRefTableOff: ne + b.readUInt16LE(ne + 0x28),
    impNameTableOff: ne + b.readUInt16LE(ne + 0x2a),
    nonResNameOff: b.readUInt32LE(ne + 0x2c),
    movEntryCount: b.readUInt16LE(ne + 0x30),
    alignShift: b.readUInt16LE(ne + 0x32),
    resSegCount: b.readUInt16LE(ne + 0x34),
    exeType: b[ne + 0x36],
  };
  const shift = h.alignShift || 9;

  h.segments = [];
  for (let i = 0; i < h.segCount; i++) {
    const o = h.segTableOff + i * 8;
    const sector = b.readUInt16LE(o);
    const len = b.readUInt16LE(o + 2);
    const flags = b.readUInt16LE(o + 4);
    const alloc = b.readUInt16LE(o + 6);
    h.segments.push({
      index: i + 1,
      filePos: sector << shift,
      length: len === 0 && sector !== 0 ? 0x10000 : len,
      flags,
      alloc: alloc === 0 ? 0x10000 : alloc,
      hasRelocs: !!(flags & 0x0100),
    });
  }

  h.modules = [];
  for (let i = 0; i < h.modRefCount; i++) {
    const nameOff = b.readUInt16LE(h.modRefTableOff + i * 2);
    h.modules.push(pstr(b, h.impNameTableOff + nameOff));
  }
  return { b, h };
}

function segRelocs(b, h, seg) {
  if (!seg.hasRelocs) return [];
  let o = seg.filePos + seg.length;
  const count = b.readUInt16LE(o);
  o += 2;
  const out = [];
  for (let i = 0; i < count; i++, o += 8) {
    const addrType = b[o] & 0x0f;
    const relType = b[o + 1] & 0x03;
    const additive = !!(b[o + 1] & 0x04);
    const offset = b.readUInt16LE(o + 2);
    const a = b.readUInt16LE(o + 4), c = b.readUInt16LE(o + 6);
    const r = {
      addrType: RELOC_ADDR[addrType] || String(addrType),
      relType: RELOC_TYPE[relType],
      additive, offset,
    };
    if (relType === 0) { r.target = `seg ${a}:0x${c.toString(16)}`; }
    else if (relType === 1) { r.target = `${h.modules[a - 1] || `mod${a}`}.#${c}`; }
    else if (relType === 2) { r.target = `${h.modules[a - 1] || `mod${a}`}.${pstr(b, h.impNameTableOff + c)}`; }
    else { r.target = `osfixup ${a}/${c}`; }
    out.push(r);
  }
  return out;
}

function entries(b, h) {
  let o = h.entryTableOff;
  const end = h.entryTableOff + h.entryTableLen;
  const out = [];
  let ordinal = 1;
  while (o < end) {
    const count = b[o], segIndicator = b[o + 1];
    o += 2;
    if (count === 0) break;
    if (segIndicator === 0) { ordinal += count; continue; }  // unused block
    for (let i = 0; i < count; i++) {
      if (segIndicator === 0xff) {          // moveable
        out.push({ ordinal: ordinal++, flags: b[o], seg: b[o + 3], offset: b.readUInt16LE(o + 4), moveable: true });
        o += 6;
      } else {                              // fixed
        out.push({ ordinal: ordinal++, flags: b[o], seg: segIndicator, offset: b.readUInt16LE(o + 1), moveable: false });
        o += 3;
      }
    }
  }
  return out;
}

// RT_* by number, as the loader ($win16_find_resource) asks for them. An NE
// resource table is a flat list of types, each with a run of NAMEINFO records;
// nothing about it resembles the PE resource tree.
const RES_TYPES = {
  1: 'RT_CURSOR', 2: 'RT_BITMAP', 3: 'RT_ICON', 4: 'RT_MENU', 5: 'RT_DIALOG',
  6: 'RT_STRING', 7: 'RT_FONTDIR', 8: 'RT_FONT', 9: 'RT_ACCELERATOR',
  10: 'RT_RCDATA', 11: 'RT_MESSAGETABLE', 12: 'RT_GROUP_CURSOR',
  14: 'RT_GROUP_ICON', 15: 'RT_NAMETABLE', 16: 'RT_VERSION',
};

// A name in the resource table is an offset from the table start to a Pascal
// string; the high bit instead marks a plain integer.
function resName(b, tableStart, value) {
  if (value & 0x8000) return String(value & 0x7fff);
  const p = tableStart + value;
  if (p < 0 || p >= b.length) return `<bad name 0x${value.toString(16)}>`;
  return `"${pstr(b, p)}"`;
}

function resources(b, h) {
  const out = [];
  const start = h.resTableOff;
  if (!start || start + 2 > b.length) return out;
  const shift = b.readUInt16LE(start);
  let p = start + 2;
  while (p + 8 <= b.length) {
    const type = b.readUInt16LE(p);
    if (!type) break;
    const count = b.readUInt16LE(p + 2);
    let q = p + 8;
    for (let i = 0; i < count && q + 12 <= b.length; i++, q += 12) {
      const id = b.readUInt16LE(q + 6);
      out.push({
        typeName: (type & 0x8000) ? (RES_TYPES[type & 0x7fff] || `type ${type & 0x7fff}`)
                                  : resName(b, start, type),
        idName: resName(b, start, id),
        offset: b.readUInt16LE(q) << shift,
        length: b.readUInt16LE(q + 2) << shift,
        flags: b.readUInt16LE(q + 4),
      });
    }
    p = p + 8 + count * 12;
  }
  return out;
}

// A 16-bit RT_MENU is the same MENUHEADER/MENUITEMTEMPLATE pair Win32 still
// accepts, with ANSI strings instead of UTF-16: WORD version(0), WORD
// headerSize(0), then items. An item is WORD flags; MF_POPUP (0x10) means a
// NUL-terminated name follows and then that popup's own item list, otherwise a
// WORD id comes before the name. MF_END (0x80) marks the last item of a list.
function menuItems(b, p, end) {
  const out = [];
  while (p + 2 <= end) {
    const flags = b.readUInt16LE(p); p += 2;
    let id = null;
    if (!(flags & 0x10)) { id = b.readUInt16LE(p); p += 2; }
    let s = p;
    while (p < end && b[p] !== 0) p++;
    const text = b.toString('latin1', s, p);
    p++;                                       // the NUL
    const item = { text: text || null, id, flags };
    if (flags & 0x10) {
      const sub = menuItems(b, p, end);
      item.children = sub.items;
      p = sub.next;
    } else if (id === 0 && !text) {
      item.text = null;                        // separator
    }
    out.push(item);
    if (flags & 0x80) break;
  }
  return { items: out, next: p };
}

function menus(b, h) {
  const out = {};
  for (const r of resources(b, h)) {
    if (r.typeName !== 'RT_MENU') continue;
    const p = r.offset;
    if (p + 4 > b.length) continue;
    out[r.idName] = menuItems(b, p + 4, Math.min(p + r.length, b.length)).items;
  }
  return out;
}

// A 16-bit DLGTEMPLATE, which shares no layout with the 32-bit one beyond the
// leading style DWORD: a byte item count, unaligned WORD coordinates, ANSI
// strings, and a predefined item class written as one byte >= 0x80 with no
// terminator. Everything is in dialog units, which is the point of printing it
// -- the pixel size a dialog comes out at is base units times these numbers.
const DLG_CLASSES = {
  0x80: 'BUTTON', 0x81: 'EDIT', 0x82: 'STATIC', 0x83: 'LISTBOX',
  0x84: 'SCROLLBAR', 0x85: 'COMBOBOX',
};

function dialog(b, p, end) {
  const sz = () => {
    const s = p;
    while (p < end && b[p] !== 0) p++;
    const out = b.toString('latin1', s, p);
    p++;
    return out;
  };
  const w = () => { const v = b.readUInt16LE(p); p += 2; return v; };
  const style = b.readUInt32LE(p); p += 4;
  const count = b[p]; p += 1;
  const d = { style, x: w(), y: w(), cx: w(), cy: w() };
  d.menu = sz(); d.class = sz(); d.caption = sz();
  if (style & 0x40) { d.pointSize = w(); d.typeface = sz(); }   // DS_SETFONT
  d.items = [];
  for (let i = 0; i < count && p < end; i++) {
    const it = { x: w(), y: w(), cx: w(), cy: w(), id: w() };
    it.style = b.readUInt32LE(p); p += 4;
    if (b[p] >= 0x80) { it.class = DLG_CLASSES[b[p]] || `0x${b[p].toString(16)}`; p += 1; }
    else it.class = sz();
    it.text = sz();
    p += 1 + b[p];                              // per-item extra data
    d.items.push(it);
  }
  return d;
}

function dialogs(b, h) {
  const out = {};
  for (const r of resources(b, h)) {
    if (r.typeName !== 'RT_DIALOG') continue;
    try {
      out[r.idName] = dialog(b, r.offset, Math.min(r.offset + r.length, b.length));
    } catch (e) {
      out[r.idName] = { error: e.message };
    }
  }
  return out;
}

function flagNames(flags) {
  return SEG_FLAGS.filter(([bit]) => flags & bit).map(([, n]) => n).join('|') || 'CODE';
}

function main() {
  const args = process.argv.slice(2);
  const file = args.find(a => !a.startsWith('--'));
  if (!file) {
    console.error('usage: node tools/ne-dump.js <file.exe> [--segments] [--imports] [--entries] [--relocs=N] [--all]');
    process.exit(2);
  }
  const all = args.includes('--all');
  const want = k => all || args.includes('--' + k);
  const relocArg = args.find(a => a.startsWith('--relocs='));
  const menuJsonArg = args.find(a => a.startsWith('--menus-json='));

  let b, h;
  try {
    ({ b, h } = parse(file));
  } catch (e) {
    console.error(`${file}: ${e.message}`);
    process.exit(1);
  }
  console.log(`${file}  NE@0x${h.ne.toString(16)}  linker ${h.linkVer}  flags=0x${h.flags.toString(16)}  align=2^${h.alignShift}`);
  console.log(`  entry ${h.entryCS}:0x${h.entryIP.toString(16)}   stack ${h.stackSS}:0x${h.stackSP.toString(16)}` +
              `   autoData=seg ${h.autoDataSeg}  heap=${h.heapSize}  stack=${h.stackSize}`);
  console.log(`  ${h.segCount} segments, ${h.modRefCount} module refs, ${h.movEntryCount} moveable entries`);

  if (want('segments')) {
    console.log('\nSegments:');
    for (const s of h.segments) {
      console.log(`  [${s.index}] file=0x${s.filePos.toString(16)} len=0x${s.length.toString(16)}` +
                  ` alloc=0x${s.alloc.toString(16)} flags=0x${s.flags.toString(16)} ${flagNames(s.flags)}` +
                  `${s.hasRelocs ? ` relocs=${segRelocs(b, h, s).length}` : ''}`);
    }
  }

  if (want('resources')) {
    console.log('\nResources:');
    const res = resources(b, h);
    if (!res.length) console.log('  (none)');
    for (const r of res) {
      console.log(`  ${r.typeName.padEnd(14)} id=${r.idName.padEnd(10)}` +
                  ` file=0x${r.offset.toString(16)} len=0x${r.length.toString(16)}` +
                  ` flags=0x${r.flags.toString(16)}`);
    }
  }

  if (want('menus') || menuJsonArg) {
    const m = menus(b, h);
    if (menuJsonArg) {
      fs.writeFileSync(menuJsonArg.split('=').slice(1).join('='),
        JSON.stringify({ menus: m }, null, 2));
    }
    if (want('menus')) {
      console.log('\nMenus:');
      const walk = (items, depth) => {
        for (const it of items) {
          const pad = '  '.repeat(depth + 1);
          if (it.text == null) { console.log(`${pad}---`); continue; }
          console.log(`${pad}${it.children ? '' : String(it.id).padStart(6) + '  '}${it.text}`);
          if (it.children) walk(it.children, depth + 1);
        }
      };
      for (const id of Object.keys(m)) { console.log(`  menu ${id}:`); walk(m[id], 1); }
      if (!Object.keys(m).length) console.log('  (none)');
    }
  }

  if (want('dialogs')) {
    console.log('\nDialogs:');
    const d = dialogs(b, h);
    if (!Object.keys(d).length) console.log('  (none)');
    for (const id of Object.keys(d)) {
      const t = d[id];
      if (t.error) { console.log(`  dialog ${id}: ${t.error}`); continue; }
      console.log(`  dialog ${id}: style=0x${t.style.toString(16)} ${t.x},${t.y} ${t.cx}x${t.cy}dlu` +
                  ` "${t.caption}"${t.typeface ? `  font="${t.typeface}" ${t.pointSize}pt` : ''}`);
      for (const it of t.items) {
        console.log(`    id=${String(it.id).padStart(5)} ${it.class.padEnd(9)}` +
                    ` ${it.x},${it.y} ${it.cx}x${it.cy}dlu style=0x${it.style.toString(16)}` +
                    `${it.text ? ` "${it.text}"` : ''}`);
      }
    }
  }

  if (want('imports')) {
    console.log('\nModule references:');
    h.modules.forEach((m, i) => console.log(`  [${i + 1}] ${m}`));
    const named = new Map();
    for (const s of h.segments) {
      for (const r of segRelocs(b, h, s)) {
        if (r.relType !== 'INTERNALREF') named.set(r.target, (named.get(r.target) || 0) + 1);
      }
    }
    console.log('\nImported entry points (fixup count):');
    for (const [k, n] of [...named].sort()) console.log(`  ${k}  x${n}`);
  }

  if (want('entries')) {
    console.log('\nEntry table:');
    for (const e of entries(b, h)) {
      console.log(`  #${e.ordinal} seg ${e.seg}:0x${e.offset.toString(16)}` +
                  ` ${e.moveable ? 'MOVEABLE' : 'FIXED'} flags=0x${e.flags.toString(16)}`);
    }
  }

  if (relocArg) {
    const n = parseInt(relocArg.split('=')[1], 10);
    const seg = h.segments.find(s => s.index === n);
    if (!seg) { console.error(`no segment ${n}`); process.exit(1); }
    console.log(`\nRelocations for segment ${n}:`);
    for (const r of segRelocs(b, h, seg)) {
      console.log(`  +0x${r.offset.toString(16).padStart(4, '0')} ${r.addrType.padEnd(9)} ${r.relType.padEnd(14)}` +
                  `${r.additive ? ' ADDITIVE' : '        '} ${r.target}`);
    }
  }
}

module.exports = { parse, segRelocs, entries, pstr };

if (require.main === module) main();
