// One PE header/section reader for tools/.
//
// Eighteen tools plus several tests each re-derived this: read the e_lfanew at
// 0x3C, walk the section table, map VA<->file offset. The copies drifted, and
// two fixes that matter live in exactly one copy each:
//
//   * Borland puts real code in sections *flagged as data* and names them
//     CodeSeg/DataSeg, so an exec-only filter misses every branch in them
//     (only xrefs.js knew this).
//   * A VA inside a section's virtual size but past its raw size is BSS —
//     there are no bytes on disk, and reading there returns whatever follows
//     in the file, which looks exactly like initialized data (only dump_va.js
//     marked it).
//
// Both are folded in here, so every tool that reads a PE inherits them.

'use strict';

const fs = require('fs');

const IMAGE_SCN_CNT_CODE = 0x00000020;
const IMAGE_SCN_MEM_EXECUTE = 0x20000000;

// Borland-style: a section whose *name* says code even when its flags say data.
function nameLooksCode(name) {
  return /code|text|seg/i.test(name);
}

function readPE(fileOrBuffer) {
  const buf = Buffer.isBuffer(fileOrBuffer) ? fileOrBuffer : fs.readFileSync(fileOrBuffer);
  if (buf.length < 0x40 || buf.readUInt16LE(0) !== 0x5A4D) {
    throw new Error('not a PE image (no MZ signature)');
  }
  const peOff = buf.readUInt32LE(0x3C);
  if (buf.readUInt32LE(peOff) !== 0x00004550) {
    throw new Error('not a PE image (no PE signature at e_lfanew)');
  }
  const numSect = buf.readUInt16LE(peOff + 6);
  const optSize = buf.readUInt16LE(peOff + 20);
  const imageBase = buf.readUInt32LE(peOff + 52);
  const entryRva = buf.readUInt32LE(peOff + 40);
  const sectOff = peOff + 24 + optSize;

  const sections = [];
  for (let i = 0; i < numSect; i++) {
    const s = sectOff + i * 40;
    let name = '';
    for (let j = 0; j < 8 && buf[s + j]; j++) name += String.fromCharCode(buf[s + j]);
    const chr = buf.readUInt32LE(s + 36);
    const rva = buf.readUInt32LE(s + 12);
    sections.push({
      name,
      rva,
      va: imageBase + rva,
      vsize: buf.readUInt32LE(s + 8),
      rawOff: buf.readUInt32LE(s + 20),
      rawSize: buf.readUInt32LE(s + 16),
      chr,
      exec: (chr & IMAGE_SCN_MEM_EXECUTE) !== 0 || (chr & IMAGE_SCN_CNT_CODE) !== 0,
      // The flags-or-name rule. Use this, not `exec`, when deciding where
      // instructions can live.
      isCode: (chr & IMAGE_SCN_MEM_EXECUTE) !== 0 || (chr & IMAGE_SCN_CNT_CODE) !== 0 ||
              nameLooksCode(name),
    });
  }

  const sectionForVa = (va) => {
    const rva = va - imageBase;
    return sections.find(s => rva >= s.rva && rva < s.rva + Math.max(s.vsize, s.rawSize)) || null;
  };

  // VA -> { section, fileOff, secOff, hasRaw }. hasRaw:false means the address
  // is real but uninitialized (BSS) — there is nothing on disk to read, and
  // buf[fileOff] would return the next section's bytes.
  const va2offInfo = (va) => {
    const s = sectionForVa(va);
    if (!s) return null;
    const secOff = (va - imageBase) - s.rva;
    return { section: s, secOff, fileOff: s.rawOff + secOff, hasRaw: secOff < s.rawSize };
  };

  // VA -> file offset, or -1 when the address is outside the image or in BSS.
  const va2off = (va) => {
    const info = va2offInfo(va);
    return info && info.hasRaw ? info.fileOff : -1;
  };

  const off2va = (off) => {
    const s = sections.find(s => off >= s.rawOff && off < s.rawOff + s.rawSize);
    return s ? imageBase + s.rva + (off - s.rawOff) : -1;
  };

  return {
    buf, peOff, imageBase, entryRva, entryVa: imageBase + entryRva,
    sections, sectionForVa, va2off, va2offInfo, off2va,
    isCodeVa: (va) => { const s = sectionForVa(va); return !!(s && s.isCode); },
  };
}

module.exports = { readPE, nameLooksCode, IMAGE_SCN_CNT_CODE, IMAGE_SCN_MEM_EXECUTE };
