#!/usr/bin/env node
// Dump a PE's resource directory as a tree: type, name/id, language, RVA, size.
//
// parse-rsrc.js answers "what does this MENU say"; this answers the question
// underneath it -- "what resources are in here at all, and how big are they".
// RT_BITMAP, RT_RCDATA and every private type parse-rsrc.js skips show up here.
//
//   node tools/pe-resources.js <pe> [--type=2] [--id=126] [--extract=DIR]
//
// --extract writes each listed resource to DIR/type<T>-id<N>-lang<L>.bin, so a
// raw resource can go straight into a hexdump or an image viewer.

const fs = require('fs');
const path = require('path');
const { readPE } = require('../lib/pe');

const argv = process.argv.slice(2);
const file = argv.find(a => !a.startsWith('--'));
if (!file) {
  console.error('usage: node tools/pe-resources.js <pe> [--type=N] [--id=N] [--extract=DIR]');
  process.exit(2);
}
const opt = (name) => {
  const hit = argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const num = (s) => (s === null ? null : (s.startsWith('0x') ? parseInt(s, 16) : parseInt(s, 10)));
const wantType = num(opt('type'));
const wantId = num(opt('id'));
const extractDir = opt('extract');

const RT_NAMES = {
  1: 'CURSOR', 2: 'BITMAP', 3: 'ICON', 4: 'MENU', 5: 'DIALOG', 6: 'STRING',
  7: 'FONTDIR', 8: 'FONT', 9: 'ACCELERATOR', 10: 'RCDATA', 11: 'MESSAGETABLE',
  12: 'GROUP_CURSOR', 14: 'GROUP_ICON', 16: 'VERSION', 17: 'DLGINCLUDE',
  19: 'PLUGPLAY', 20: 'VXD', 21: 'ANICURSOR', 22: 'ANIICON', 23: 'HTML',
  24: 'MANIFEST',
};

const pe = readPE(file);
const buf = pe.buf;
const rsrc = pe.sections.find(s => s.name === '.rsrc');
if (!rsrc) {
  console.error('no .rsrc section');
  process.exit(1);
}
const base = rsrc.rawOff;

// Directory entries name resources either by string (high bit set, offset into
// the resource section) or by integer id.
function entryName(nameField) {
  if (!(nameField & 0x80000000)) return { id: nameField, label: String(nameField) };
  const off = base + (nameField & 0x7fffffff);
  const len = buf.readUInt16LE(off);
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(buf.readUInt16LE(off + 2 + i * 2));
  return { id: null, label: `"${s}"` };
}

function entries(dirOff) {
  const named = buf.readUInt16LE(dirOff + 12);
  const ided = buf.readUInt16LE(dirOff + 14);
  const out = [];
  for (let i = 0; i < named + ided; i++) {
    const e = dirOff + 16 + i * 8;
    const nameField = buf.readUInt32LE(e);
    const offField = buf.readUInt32LE(e + 4);
    out.push({
      name: entryName(nameField),
      isDir: !!(offField & 0x80000000),
      off: base + (offField & 0x7fffffff),
    });
  }
  return out;
}

if (extractDir) fs.mkdirSync(extractDir, { recursive: true });

let count = 0;
let bytes = 0;
for (const type of entries(base)) {
  const typeLabel = type.name.id !== null
    ? `${type.name.id}${RT_NAMES[type.name.id] ? ` (${RT_NAMES[type.name.id]})` : ''}`
    : type.name.label;
  if (wantType !== null && type.name.id !== wantType) continue;
  if (!type.isDir) continue;
  for (const res of entries(type.off)) {
    if (wantId !== null && res.name.id !== wantId) continue;
    if (!res.isDir) continue;
    for (const lang of entries(res.off)) {
      // Leaf: RVA + size + codepage + reserved.
      const dataRva = buf.readUInt32LE(lang.off);
      const size = buf.readUInt32LE(lang.off + 4);
      const raw = pe.va2off(pe.imageBase + dataRva);
      count++;
      bytes += size;
      console.log(`type=${typeLabel.padEnd(16)} id=${res.name.label.padEnd(10)} lang=${lang.name.label.padEnd(5)} rva=0x${dataRva.toString(16)} raw=0x${(raw >= 0 ? raw : 0).toString(16)} size=${size}`);
      if (extractDir && raw >= 0) {
        const out = path.join(extractDir, `type${type.name.id ?? type.name.label.replace(/"/g, '')}-id${res.name.label.replace(/"/g, '')}-lang${lang.name.label}.bin`);
        fs.writeFileSync(out, buf.subarray(raw, raw + size));
      }
    }
  }
}
console.log(`${count} resources, ${bytes} bytes`);
