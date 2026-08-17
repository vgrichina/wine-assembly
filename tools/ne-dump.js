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
