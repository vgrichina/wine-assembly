#!/usr/bin/env node
// PE header dump tool — analyzes Win98 test binaries
// Usage: node pe-dump.js <file.exe>

const fs = require('fs');
const path = require('path');

const file = process.argv[2];
if (!file) {
  console.error('Usage: node pe-dump.js <file.exe>');
  process.exit(1);
}

const buf = fs.readFileSync(file);
const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

function readStr(offset, maxLen = 256) {
  let s = '';
  for (let i = 0; i < maxLen && buf[offset + i] !== 0; i++) {
    s += String.fromCharCode(buf[offset + i]);
  }
  return s;
}

// DOS header
const dosSig = view.getUint16(0, true);
if (dosSig !== 0x5A4D) {
  console.error('Not a valid PE: bad MZ signature');
  process.exit(1);
}

const peOffset = view.getUint32(0x3C, true);
const peSig = view.getUint32(peOffset, true);
if (peSig !== 0x00004550) {
  console.error('Not a valid PE: bad PE signature');
  process.exit(1);
}

console.log(`=== PE Header Dump: ${path.basename(file)} ===`);
console.log(`File size: ${buf.length} bytes`);
console.log(`PE offset: 0x${peOffset.toString(16)}`);

// FILE HEADER (20 bytes at peOffset+4)
const fh = peOffset + 4;
const machine = view.getUint16(fh, true);
const numSections = view.getUint16(fh + 2, true);
const timestamp = view.getUint32(fh + 4, true);
const optHeaderSize = view.getUint16(fh + 16, true);
const characteristics = view.getUint16(fh + 18, true);

console.log(`\n--- File Header ---`);
console.log(`Machine: 0x${machine.toString(16)} (${machine === 0x14C ? 'i386' : 'unknown'})`);
console.log(`Sections: ${numSections}`);
console.log(`Timestamp: ${new Date(timestamp * 1000).toISOString()}`);
console.log(`Optional header size: ${optHeaderSize}`);
console.log(`Characteristics: 0x${characteristics.toString(16)}`);

// OPTIONAL HEADER
const oh = fh + 20;
const magic = view.getUint16(oh, true);
console.log(`\n--- Optional Header ---`);
console.log(`Magic: 0x${magic.toString(16)} (${magic === 0x10B ? 'PE32' : magic === 0x20B ? 'PE32+' : 'unknown'})`);

const entryRVA = view.getUint32(oh + 16, true);
const imageBase = view.getUint32(oh + 28, true);
const sectionAlign = view.getUint32(oh + 32, true);
const fileAlign = view.getUint32(oh + 36, true);
const imageSize = view.getUint32(oh + 56, true);
const headerSize = view.getUint32(oh + 60, true);

console.log(`Entry point RVA: 0x${entryRVA.toString(16)}`);
console.log(`Image base: 0x${imageBase.toString(16)}`);
console.log(`Entry point VA: 0x${(imageBase + entryRVA).toString(16)}`);
console.log(`Section alignment: 0x${sectionAlign.toString(16)}`);
console.log(`File alignment: 0x${fileAlign.toString(16)}`);
console.log(`Image size: 0x${imageSize.toString(16)}`);

// Data directories
const numDataDirs = view.getUint32(oh + 92, true);
const ddOff = oh + 96;

const dataDirectoryNames = [
  'Export', 'Import', 'Resource', 'Exception', 'Security',
  'Base Reloc', 'Debug', 'Architecture', 'Global Ptr', 'TLS',
  'Load Config', 'Bound Import', 'IAT', 'Delay Import', 'CLR', 'Reserved'
];

console.log(`\n--- Data Directories (${numDataDirs}) ---`);
for (let i = 0; i < Math.min(numDataDirs, 16); i++) {
  const rva = view.getUint32(ddOff + i * 8, true);
  const size = view.getUint32(ddOff + i * 8 + 4, true);
  if (rva || size) {
    console.log(`  ${dataDirectoryNames[i] || i}: RVA=0x${rva.toString(16)} Size=0x${size.toString(16)}`);
  }
}

// SECTIONS
const sectionOff = oh + optHeaderSize;
console.log(`\n--- Sections ---`);
for (let i = 0; i < numSections; i++) {
  const so = sectionOff + i * 40;
  const name = readStr(so, 8);
  const vsize = view.getUint32(so + 8, true);
  const vaddr = view.getUint32(so + 12, true);
  const rawSize = view.getUint32(so + 16, true);
  const rawOff = view.getUint32(so + 20, true);
  const chars = view.getUint32(so + 36, true);

  const flags = [];
  if (chars & 0x20) flags.push('CODE');
  if (chars & 0x40) flags.push('IDATA');
  if (chars & 0x80) flags.push('UDATA');
  if (chars & 0x20000000) flags.push('EXEC');
  if (chars & 0x40000000) flags.push('READ');
  if (chars & 0x80000000) flags.push('WRITE');

  console.log(`  ${name.padEnd(8)} VA=0x${vaddr.toString(16).padStart(8,'0')} VSize=0x${vsize.toString(16).padStart(8,'0')} Raw=0x${rawOff.toString(16).padStart(8,'0')} RawSize=0x${rawSize.toString(16).padStart(8,'0')} [${flags.join(' ')}]`);
}

// IMPORTS
const importRVA = view.getUint32(ddOff + 8, true);
const importSize = view.getUint32(ddOff + 12, true);

if (importRVA) {
  // Find the file offset for the import RVA
  function rvaToOffset(rva) {
    for (let i = 0; i < numSections; i++) {
      const so = sectionOff + i * 40;
      const vaddr = view.getUint32(so + 12, true);
      const rawSize = view.getUint32(so + 16, true);
      const rawOff = view.getUint32(so + 20, true);
      const vsize = view.getUint32(so + 8, true);
      if (rva >= vaddr && rva < vaddr + Math.max(vsize, rawSize)) {
        return rva - vaddr + rawOff;
      }
    }
    return -1;
  }

  console.log(`\n--- Imports ---`);
  let descOff = rvaToOffset(importRVA);
  if (descOff >= 0) {
    while (true) {
      const iltRVA = view.getUint32(descOff, true);
      const nameRVA = view.getUint32(descOff + 12, true);
      const iatRVA = view.getUint32(descOff + 16, true);
      if (!iltRVA && !nameRVA) break;

      const dllName = readStr(rvaToOffset(nameRVA));
      console.log(`\n  ${dllName}:`);

      let entryOff = rvaToOffset(iltRVA || iatRVA);
      let funcCount = 0;
      while (true) {
        const entry = view.getUint32(entryOff, true);
        if (!entry) break;

        if (entry & 0x80000000) {
          console.log(`    [ordinal ${entry & 0xFFFF}]`);
        } else {
          const hintOff = rvaToOffset(entry);
          const hint = view.getUint16(hintOff, true);
          const funcName = readStr(hintOff + 2);
          console.log(`    ${funcName} (hint: ${hint})`);
        }
        funcCount++;
        entryOff += 4;
      }
      console.log(`    (${funcCount} functions)`);
      descOff += 20;
    }
  }
}

console.log('\n=== Done ===');
