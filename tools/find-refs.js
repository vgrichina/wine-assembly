#!/usr/bin/env node
// Find cross-references to a VA in a PE binary.
//
// Usage:
//   node tools/find-refs.js <pe-file> <VA> [options]
//
// Searches for:
//   - call rel32 / jmp rel32 targeting the VA
//   - Jcc rel32 (0F 80..8F) targeting the VA
//   - 4-byte absolute VA as data (vtable entries, IAT, pointers)
//
// Options:
//   --code-only    Only show call/jmp/jcc refs
//   --data-only    Only show data (absolute VA) refs
//   --context=N    Disassemble N instructions around each code ref (default: 3)
//   --base=0xADDR  Remap: treat the file as loaded at this address

const fs = require('fs');
const { disasmAt } = require('./disasm');

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
const vaArg = args.filter(a => !a.startsWith('--'))[1];
if (!file || !vaArg) {
  console.error('Usage: find-refs.js <pe-file> <VA> [--code-only] [--data-only] [--context=N]');
  process.exit(1);
}

const targetVA = parseInt(vaArg, 16);
const codeOnly = args.includes('--code-only');
const dataOnly = args.includes('--data-only');
const ctxArg = args.find(a => a.startsWith('--context='));
const context = ctxArg ? parseInt(ctxArg.split('=')[1]) : 3;
const baseArg = args.find(a => a.startsWith('--base='));

const buf = fs.readFileSync(file);
const peOff = buf.readUInt32LE(0x3c);
const numSect = buf.readUInt16LE(peOff + 6);
const optSize = buf.readUInt16LE(peOff + 20);
const imageBase = buf.readUInt32LE(peOff + 52);
const sectOff = peOff + 24 + optSize;
const loadBase = baseArg ? parseInt(baseArg.split('=')[1], 16) : imageBase;

// Build section map
const sections = [];
for (let i = 0; i < numSect; i++) {
  const s = sectOff + i * 40;
  let name = '';
  for (let j = 0; j < 8 && buf[s + j]; j++) name += String.fromCharCode(buf[s + j]);
  sections.push({
    name,
    va: buf.readUInt32LE(s + 12),
    vsize: buf.readUInt32LE(s + 8),
    rawOff: buf.readUInt32LE(s + 20),
    rawSize: buf.readUInt32LE(s + 16),
    flags: buf.readUInt32LE(s + 36),
  });
}

function rva2off(rva) {
  for (const s of sections) {
    if (rva >= s.va && rva < s.va + Math.max(s.vsize, s.rawSize))
      return rva - s.va + s.rawOff;
  }
  return -1;
}

function off2va(off) {
  for (const s of sections) {
    if (off >= s.rawOff && off < s.rawOff + s.rawSize)
      return imageBase + s.va + (off - s.rawOff);
  }
  return -1;
}

function sectionOf(rva) {
  for (const s of sections) {
    if (rva >= s.va && rva < s.va + Math.max(s.vsize, s.rawSize))
      return s;
  }
  return null;
}

// Build import name map for disasm context
const importRVA = buf.readUInt32LE(peOff + 24 + 104);
const importNames = {};
if (importRVA) {
  const importSect = sectionOf(importRVA);
  if (importSect) {
    let off = importSect.rawOff + (importRVA - importSect.va);
    while (off + 20 <= buf.length) {
      const nameRVA = buf.readUInt32LE(off + 12);
      if (nameRVA === 0) break;
      let dllName = '';
      const dnOff = importSect.rawOff + (nameRVA - importSect.va);
      for (let j = dnOff; j < buf.length && buf[j]; j++) dllName += String.fromCharCode(buf[j]);
      const iatRVA = buf.readUInt32LE(off + 16) || buf.readUInt32LE(off);
      let tOff = importSect.rawOff + (iatRVA - importSect.va), idx = 0;
      while (tOff + 4 <= buf.length) {
        const val = buf.readUInt32LE(tOff);
        if (val === 0) break;
        if (!(val & 0x80000000)) {
          let fnName = '';
          const fnOff = importSect.rawOff + (val - importSect.va) + 2;
          for (let j = fnOff; j < buf.length && buf[j]; j++) fnName += String.fromCharCode(buf[j]);
          importNames[imageBase + iatRVA + idx * 4] = dllName.replace(/\.dll$/i, '') + '!' + fnName;
        }
        tOff += 4; idx++;
      }
      off += 20;
    }
  }
}

const hex = v => '0x' + (v >>> 0).toString(16).padStart(8, '0');
const targetRVA = targetVA - imageBase;
const codeRefs = [];
const dataRefs = [];

// Scan all sections
for (const sect of sections) {
  const isCode = !!(sect.flags & 0x20000000); // IMAGE_SCN_MEM_EXECUTE
  const start = sect.rawOff;
  const end = sect.rawOff + sect.rawSize;

  for (let pos = start; pos < end - 4; pos++) {
    const va = imageBase + sect.va + (pos - sect.rawOff);

    if (!dataOnly) {
      // call rel32 (E8)
      if (buf[pos] === 0xE8 && pos + 5 <= end) {
        const rel = buf.readInt32LE(pos + 1);
        const dest = (va + 5 + rel) >>> 0;
        if (dest === targetVA) codeRefs.push({ type: 'call', va, off: pos });
      }
      // jmp rel32 (E9)
      if (buf[pos] === 0xE9 && pos + 5 <= end) {
        const rel = buf.readInt32LE(pos + 1);
        const dest = (va + 5 + rel) >>> 0;
        if (dest === targetVA) codeRefs.push({ type: 'jmp', va, off: pos });
      }
      // Jcc rel32 (0F 80..8F)
      if (buf[pos] === 0x0F && pos + 6 <= end) {
        const op2 = buf[pos + 1];
        if (op2 >= 0x80 && op2 <= 0x8F) {
          const rel = buf.readInt32LE(pos + 2);
          const dest = (va + 6 + rel) >>> 0;
          if (dest === targetVA) codeRefs.push({ type: 'jcc', va, off: pos });
        }
      }
    }

    if (!codeOnly) {
      // Absolute VA as dword
      if (buf.readUInt32LE(pos) === targetVA) {
        // Skip if this is part of a call/jmp rel32 we already found
        const isRel = (pos > start && (buf[pos - 1] === 0xE8 || buf[pos - 1] === 0xE9));
        if (!isRel) {
          dataRefs.push({ va, off: pos, section: sect.name });
        }
      }
    }
  }
}

// Print results
console.log(`Cross-references to ${hex(targetVA)} in ${file}`);
console.log(`imageBase=${hex(imageBase)}\n`);

if (codeRefs.length > 0) {
  console.log(`Code references (${codeRefs.length}):`);
  for (const ref of codeRefs) {
    console.log(`  ${hex(ref.va)}  ${ref.type} ${hex(targetVA)}`);
    if (context > 0) {
      // Disassemble a few instructions around the ref for context
      const startOff = Math.max(ref.off - 10, 0);
      const startVA = ref.va - (ref.off - startOff);
      const lines = disasmAt(buf, startOff, startVA, context + 3, importNames);
      for (const line of lines) {
        const lineVA = parseInt(line.trim().split(/\s/)[0], 16);
        const marker = lineVA === ref.va ? ' >>>' : '    ';
        console.log(`  ${marker} ${line}`);
      }
      console.log();
    }
  }
}

if (dataRefs.length > 0) {
  console.log(`Data references (${dataRefs.length}):`);
  for (const ref of dataRefs) {
    // Show surrounding bytes for context
    const ctxStart = Math.max(ref.off - 8, 0);
    const ctxEnd = Math.min(ref.off + 12, buf.length);
    const bytes = Array.from(buf.slice(ctxStart, ctxEnd)).map(b => b.toString(16).padStart(2, '0')).join(' ');
    const refOff = ref.off - ctxStart;
    console.log(`  ${hex(ref.va)}  [${ref.section}]  ...${bytes}...`);
  }
}

if (codeRefs.length === 0 && dataRefs.length === 0) {
  console.log('No references found.');
}

console.log(`\nTotal: ${codeRefs.length} code + ${dataRefs.length} data = ${codeRefs.length + dataRefs.length} refs`);
