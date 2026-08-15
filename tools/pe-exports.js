#!/usr/bin/env node
// pe-exports.js — dump a PE's export directory: ordinal, name, RVA.
//
// tools/ could read imports but not exports, and ordinal-only imports keep
// coming up: a DLL that imports KERNEL32.#00017 tells you nothing until you
// map that ordinal back to a name using the real DLL. The WSOCK32 ordinal
// table in src/08b-dll-loader.wat exists for exactly this reason.
//
// usage:
//   node tools/pe-exports.js <pe>                  list every export
//   node tools/pe-exports.js <pe> --ordinal=6,17   just these ordinals
//   node tools/pe-exports.js <pe> --name=Sleep     substring match on name
//   node tools/pe-exports.js <pe> --forwarders     only forwarded exports

const fs = require('fs');

function main() {
  const args = process.argv.slice(2);
  const file = args.find(a => !a.startsWith('--'));
  if (!file) {
    console.error('usage: pe-exports.js <pe> [--ordinal=N,...] [--name=SUBSTR] [--forwarders]');
    process.exit(2);
  }
  const ordArg = args.find(a => a.startsWith('--ordinal='));
  const nameArg = args.find(a => a.startsWith('--name='));
  const onlyForwarders = args.includes('--forwarders');
  const wantOrdinals = ordArg
    ? new Set(ordArg.slice('--ordinal='.length).split(',').map(s => parseInt(s, 10)))
    : null;
  const wantName = nameArg ? nameArg.slice('--name='.length).toLowerCase() : null;

  const buf = fs.readFileSync(file);
  const u32 = off => buf.readUInt32LE(off);
  const u16 = off => buf.readUInt16LE(off);

  const peOff = u32(0x3C);
  if (buf.readUInt16LE(peOff) !== 0x4550 && u32(peOff) !== 0x00004550) {
    console.error(`${file}: not a PE (no PE signature at 0x${peOff.toString(16)})`);
    process.exit(1);
  }
  const numSections = u16(peOff + 6);
  const optSize = u16(peOff + 20);
  const optOff = peOff + 24;
  const imageBase = u32(optOff + 28);
  const magic = u16(optOff);
  // Data directories sit after the optional header's fixed part; PE32 puts the
  // export directory first.
  const dirOff = optOff + (magic === 0x20b ? 112 : 96);
  const expRva = u32(dirOff);
  const expSize = u32(dirOff + 4);

  const sections = [];
  const secOff = optOff + optSize;
  for (let i = 0; i < numSections; i++) {
    const s = secOff + i * 40;
    sections.push({
      name: buf.toString('ascii', s, s + 8).replace(/\0+$/, ''),
      vaddr: u32(s + 12),
      vsize: u32(s + 8),
      raw: u32(s + 20),
      rawSize: u32(s + 16),
    });
  }
  const rvaToOff = rva => {
    for (const s of sections) {
      const end = s.vaddr + Math.max(s.vsize, s.rawSize);
      if (rva >= s.vaddr && rva < end) return s.raw + (rva - s.vaddr);
    }
    return -1;
  };
  const cstr = off => {
    if (off < 0 || off >= buf.length) return '';
    let e = off;
    while (e < buf.length && buf[e] !== 0) e++;
    return buf.toString('ascii', off, e);
  };

  if (!expRva) {
    console.log(`${file}: no export directory`);
    return;
  }
  const e = rvaToOff(expRva);
  if (e < 0) {
    console.error(`${file}: export RVA 0x${expRva.toString(16)} is outside every section`);
    process.exit(1);
  }
  const dllName = cstr(rvaToOff(u32(e + 12)));
  const ordinalBase = u32(e + 16);
  const numFuncs = u32(e + 20);
  const numNames = u32(e + 24);
  const funcsOff = rvaToOff(u32(e + 28));
  const namesOff = rvaToOff(u32(e + 32));
  const ordsOff = rvaToOff(u32(e + 36));

  // Ordinal -> name, via the parallel name/name-ordinal arrays. Exports with
  // no name entry are ordinal-only, which is exactly the interesting case.
  const nameByOrdinal = new Map();
  for (let i = 0; i < numNames; i++) {
    const nameRva = u32(namesOff + i * 4);
    const ord = u16(ordsOff + i * 2);
    nameByOrdinal.set(ord, cstr(rvaToOff(nameRva)));
  }

  console.log(`${file}  ${dllName}  imageBase=0x${imageBase.toString(16)}  ` +
    `${numFuncs} export(s), ${numNames} named, ordinalBase=${ordinalBase}`);

  let shown = 0;
  for (let i = 0; i < numFuncs; i++) {
    const rva = u32(funcsOff + i * 4);
    if (!rva) continue;                       // hole in the table
    const ordinal = ordinalBase + i;
    const name = nameByOrdinal.get(i) || '';
    // A forwarder's "RVA" points inside the export directory at "Dll.Entry".
    const forwarded = rva >= expRva && rva < expRva + expSize;
    const forwardTo = forwarded ? cstr(rvaToOff(rva)) : '';
    if (wantOrdinals && !wantOrdinals.has(ordinal)) continue;
    if (wantName && !name.toLowerCase().includes(wantName)) continue;
    if (onlyForwarders && !forwarded) continue;
    const label = name || '(ordinal only)';
    const target = forwarded
      ? `-> ${forwardTo}`
      : `RVA=0x${rva.toString(16)}  VA=0x${(imageBase + rva).toString(16)}`;
    console.log(`  #${String(ordinal).padStart(5)}  ${label.padEnd(40)} ${target}`);
    shown++;
  }
  if (!shown) console.log('  (no export matched)');
}

main();
