#!/usr/bin/env node
// Dump RT_DIALOG templates from a PE, decoded field by field.
//
// Usage: node tools/dlg-dump.js <pe> [--id=N] [--json]
//
// Every other resource tool here either renders a dialog (parse-rsrc.js emits
// menus/strings/icons and only *counts* dialogs) or works on 16-bit NE files.
// When the question is "what style dword does this template actually carry",
// this is the ground truth with no emulator in the loop -- the same bytes
// $dlg_load in src/10-helpers.wat reads.

const path = require('path');
const { readPE } = require(path.join(__dirname, '..', 'lib', 'pe.js'));

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
if (!file) {
  console.error('Usage: node tools/dlg-dump.js <pe> [--id=N] [--json]');
  process.exit(2);
}
const onlyArg = args.find(a => a.startsWith('--id='));
const only = onlyArg ? Number(onlyArg.slice(5)) : null;
const asJson = args.includes('--json');

const pe = readPE(file);
const buf = pe.buf;
const rsrc = pe.sections.find(s => s.name === '.rsrc');
if (!rsrc) { console.error('No .rsrc section'); process.exit(1); }
const base = rsrc.rawOff;

// --- resource directory walk (type -> name -> lang -> data entry) ---
function entries(off) {
  const named = buf.readUInt16LE(base + off + 12);
  const ids = buf.readUInt16LE(base + off + 14);
  const out = [];
  let e = off + 16;
  for (let i = 0; i < named + ids; i++) {
    out.push({
      id: buf.readUInt32LE(base + e),
      off: buf.readUInt32LE(base + e + 4),
      named: i < named,
    });
    e += 8;
  }
  return out;
}

const RT_DIALOG = 5;
const typeDir = entries(0).find(t => !t.named && t.id === RT_DIALOG);
if (!typeDir) { console.error('No RT_DIALOG resources'); process.exit(1); }

const templates = [];
for (const nameEnt of entries(typeDir.off & 0x7fffffff)) {
  const langEnt = entries(nameEnt.off & 0x7fffffff)[0];
  if (!langEnt) continue;
  const dataOff = langEnt.off & 0x7fffffff;
  const rva = buf.readUInt32LE(base + dataOff);
  const size = buf.readUInt32LE(base + dataOff + 4);
  const fileOff = pe.va2off(pe.imageBase + rva);
  if (fileOff < 0) continue;
  const name = nameEnt.named ? readResName(nameEnt.id & 0x7fffffff) : nameEnt.id;
  templates.push({ name, fileOff, size });
}

function readResName(off) {
  const len = buf.readUInt16LE(base + off);
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(buf.readUInt16LE(base + off + 2 + i * 2));
  return s;
}

// --- style bit names ---
const WS = [
  [0x80000000, 'WS_POPUP'], [0x40000000, 'WS_CHILD'], [0x20000000, 'WS_MINIMIZE'],
  [0x10000000, 'WS_VISIBLE'], [0x08000000, 'WS_DISABLED'], [0x04000000, 'WS_CLIPSIBLINGS'],
  [0x02000000, 'WS_CLIPCHILDREN'], [0x01000000, 'WS_MAXIMIZE'], [0x00C00000, 'WS_CAPTION'],
  [0x00800000, 'WS_BORDER'], [0x00400000, 'WS_DLGFRAME'], [0x00200000, 'WS_VSCROLL'],
  [0x00100000, 'WS_HSCROLL'], [0x00080000, 'WS_SYSMENU'], [0x00040000, 'WS_THICKFRAME'],
  [0x00020000, 'WS_MINIMIZEBOX'], [0x00010000, 'WS_MAXIMIZEBOX'],
];
const DS = [
  [0x0001, 'DS_ABSALIGN'], [0x0002, 'DS_SYSMODAL'], [0x0004, 'DS_3DLOOK'],
  [0x0008, 'DS_FIXEDSYS'], [0x0010, 'DS_NOFAILCREATE'], [0x0020, 'DS_LOCALEDIT'],
  [0x0040, 'DS_SETFONT'], [0x0080, 'DS_MODALFRAME'], [0x0100, 'DS_NOIDLEMSG'],
  [0x0200, 'DS_SETFOREGROUND'], [0x0400, 'DS_CONTROL'], [0x0800, 'DS_CENTER'],
  [0x1000, 'DS_CENTERMOUSE'], [0x2000, 'DS_CONTEXTHELP'],
];
function styleNames(v) {
  const out = [];
  // WS_CAPTION is BORDER|DLGFRAME; report it once when both are present.
  let hi = v & 0xffff0000;
  if ((hi & 0x00C00000) === 0x00C00000) { out.push('WS_CAPTION'); hi &= ~0x00C00000; }
  for (const [bit, name] of WS) {
    if (name === 'WS_CAPTION') continue;
    if ((hi & bit) === bit && bit) { out.push(name); hi &= ~bit; }
  }
  // Low word of a dialog style is DS_*; of a control style it is class-specific.
  for (const [bit, name] of DS) if ((v & bit) === bit) out.push(name);
  return out;
}

// --- template decoding ---
function align4(n) { return (n + 3) & ~3; }
function readSz(p) {
  let s = '';
  for (;;) {
    const c = buf.readUInt16LE(p); p += 2;
    if (!c) break;
    s += String.fromCharCode(c);
  }
  return [s, p];
}
function readOrdOrSz(p) {
  const w = buf.readUInt16LE(p);
  if (w === 0x0000) return [null, p + 2];
  if (w === 0xFFFF) return [buf.readUInt16LE(p + 2), p + 4];
  return readSz(p);
}
const CTRL_ORD = {
  0x80: 'Button', 0x81: 'Edit', 0x82: 'Static',
  0x83: 'ListBox', 0x84: 'ScrollBar', 0x85: 'ComboBox',
};

function decode(t) {
  let p = t.fileOff;
  const isEx = buf.readUInt16LE(p) === 1 && buf.readUInt16LE(p + 2) === 0xFFFF;
  let style, exStyle;
  if (isEx) {
    exStyle = buf.readUInt32LE(p + 8);
    style = buf.readUInt32LE(p + 12);
    p += 16;
  } else {
    style = buf.readUInt32LE(p);
    exStyle = buf.readUInt32LE(p + 4);
    p += 8;
  }
  const cdit = buf.readUInt16LE(p);
  const x = buf.readInt16LE(p + 2), y = buf.readInt16LE(p + 4);
  const cx = buf.readInt16LE(p + 6), cy = buf.readInt16LE(p + 8);
  p += 10;
  let menu, cls, title;
  [menu, p] = readOrdOrSz(p);
  [cls, p] = readOrdOrSz(p);
  [title, p] = readSz(p);
  let font = null;
  if (style & 0x0040) { // DS_SETFONT
    const pt = buf.readUInt16LE(p); p += 2;
    if (isEx) p += 4;
    let face;
    [face, p] = readSz(p);
    font = { pt, face };
  }
  const items = [];
  for (let i = 0; i < cdit; i++) {
    p = align4(p);
    let cstyle, cex, ix, iy, iw, ih, id;
    if (isEx) {
      cex = buf.readUInt32LE(p + 4);
      cstyle = buf.readUInt32LE(p + 8);
      ix = buf.readInt16LE(p + 12); iy = buf.readInt16LE(p + 14);
      iw = buf.readInt16LE(p + 16); ih = buf.readInt16LE(p + 18);
      id = buf.readUInt32LE(p + 20);
      p += 24;
    } else {
      cstyle = buf.readUInt32LE(p);
      cex = buf.readUInt32LE(p + 4);
      ix = buf.readInt16LE(p + 8); iy = buf.readInt16LE(p + 10);
      iw = buf.readInt16LE(p + 12); ih = buf.readInt16LE(p + 14);
      id = buf.readUInt16LE(p + 16);
      p += 18;
    }
    let cclass, ctext;
    [cclass, p] = readOrdOrSz(p);
    [ctext, p] = readOrdOrSz(p);
    const extra = buf.readUInt16LE(p); p += 2 + extra;
    items.push({
      cls: typeof cclass === 'number' ? (CTRL_ORD[cclass] || `#${cclass}`) : cclass,
      id, text: ctext, x: ix, y: iy, cx: iw, cy: ih,
      style: cstyle, exStyle: cex,
    });
  }
  return { name: t.name, isEx, style, exStyle, x, y, cx, cy, title, menu, cls, font, items };
}

const out = templates
  .filter(t => only === null || t.name === only)
  .map(decode);

if (asJson) {
  console.log(JSON.stringify(out, null, 2));
} else {
  for (const d of out) {
    console.log(`\nDialog ${d.name}${d.isEx ? ' (DIALOGEX)' : ''}  "${d.title}"`);
    console.log(`  style   0x${(d.style >>> 0).toString(16).padStart(8, '0')}  ${styleNames(d.style >>> 0).join(' | ')}`);
    console.log(`  exStyle 0x${(d.exStyle >>> 0).toString(16).padStart(8, '0')}`);
    console.log(`  rect    x=${d.x} y=${d.y} cx=${d.cx} cy=${d.cy} (dialog units)`);
    if (d.menu !== null) console.log(`  menu    ${d.menu}`);
    if (d.cls !== null) console.log(`  class   ${d.cls}`);
    if (d.font) console.log(`  font    ${d.font.pt}pt "${d.font.face}"`);
    for (const it of d.items) {
      console.log(`    ${String(it.cls).padEnd(12)} id=${String(it.id).padEnd(6)} ` +
        `${String(it.x).padStart(4)},${String(it.y).padStart(4)} ${it.cx}x${it.cy}  ` +
        `style=0x${(it.style >>> 0).toString(16).padStart(8, '0')}  "${it.text ?? ''}"`);
    }
  }
}
