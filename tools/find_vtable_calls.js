#!/usr/bin/env node
// Find vtable indirect call sites `call dword [reg+disp]` (FF /2) in a PE/DLL .text.
// Filters by displacement (slot byte offset). Useful for locating callers of a specific
// COM/C++ vtable slot — e.g. slot 32 of IDirect3DRMFrame is at offset 0x80.
//
// Usage: node tools/find_vtable_calls.js <exe> <selector> [options]
//   <selector>    Either --slot=N (slot index, byte-offset = N*4) or --disp=0xNN (raw disp)
//                 Bare numeric arg is treated as slot index (decimal) or 0x-prefixed disp.
//   --reg=R,...   Filter by base register: eax,ecx,edx,ebx,ebp,esi,edi (esp/SIB skipped)
//   --count       Print only count + per-section totals, no site list
//   --slots       Histogram every slot used — overrides selector
//
// Example:
//   node tools/find_vtable_calls.js test/binaries/screensavers/ROCKROLL.SCR 32
//   node tools/find_vtable_calls.js d3drm.dll --disp=0x80 --reg=eax,ecx
//   node tools/find_vtable_calls.js ROCKROLL.SCR --slots

const fs = require('fs');

const args = process.argv.slice(2);
const file = args[0];
if (!file) {
  console.error('Usage: find_vtable_calls.js <exe> <slot|--disp=0xNN|--slots> [--reg=R,...] [--count]');
  process.exit(1);
}

const slotsArg = args.includes('--slots');
let target = null;
const dispArg = args.find(a => a.startsWith('--disp='));
const slotArg = args.find(a => a.startsWith('--slot='));
if (!slotsArg) {
  if (dispArg) target = parseInt(dispArg.slice(7), 16);
  else if (slotArg) target = parseInt(slotArg.slice(7), 10) * 4;
  else if (args[1] && !args[1].startsWith('-')) {
    target = args[1].startsWith('0x') ? parseInt(args[1], 16) : parseInt(args[1], 10) * 4;
  } else {
    console.error('Specify slot index, --disp=0xNN, or --slots');
    process.exit(1);
  }
}
const regArg = args.find(a => a.startsWith('--reg='));
const regFilter = regArg ? new Set(regArg.slice(6).split(',')) : null;
const countOnly = args.includes('--count');
const regs32 = ['eax','ecx','edx','ebx','esp','ebp','esi','edi'];

const buf = fs.readFileSync(file);
const peOff = buf.readUInt32LE(0x3C);
const numSect = buf.readUInt16LE(peOff + 6);
const optSize = buf.readUInt16LE(peOff + 20);
const imageBase = buf.readUInt32LE(peOff + 52);
const sectOff = peOff + 24 + optSize;

const sections = [];
for (let i = 0; i < numSect; i++) {
  const s = sectOff + i * 40;
  let name = '';
  for (let j = 0; j < 8 && buf[s + j]; j++) name += String.fromCharCode(buf[s + j]);
  const vsize = buf.readUInt32LE(s + 8);
  const va = buf.readUInt32LE(s + 12) + imageBase;
  const rsize = buf.readUInt32LE(s + 16);
  const raw = buf.readUInt32LE(s + 20);
  const chars = buf.readUInt32LE(s + 36);
  const isCode = (chars & 0x20) !== 0 || /text|code/i.test(name);
  if (!isCode) continue;
  sections.push({ name, va, raw, size: Math.min(vsize, rsize) });
}

// Scan for FF /2 (call indirect mem) with disp8 or disp32.
function scanSection(sec) {
  const sites = [];
  const slotHist = {};
  const end = sec.size - 6;
  for (let off = 0; off < end; off++) {
    const b = buf[sec.raw + off];
    if (b !== 0xFF) continue;
    const mr = buf[sec.raw + off + 1];
    if (((mr >> 3) & 7) !== 2) continue; // not /2 = call indirect
    const mod = mr >> 6;
    const rm = mr & 7;
    let disp, len;
    if (mod === 0) { disp = 0; len = 2; }
    else if (mod === 1) { disp = buf.readInt8(sec.raw + off + 2); len = 3; }
    else if (mod === 2) { disp = buf.readInt32LE(sec.raw + off + 2); len = 6; }
    else continue;
    if (rm === 4) continue; // SIB — skip (would need extra byte)
    if (rm === 5 && mod === 0) continue; // disp32-absolute, not [reg]
    const reg = regs32[rm];
    if (regFilter && !regFilter.has(reg)) continue;
    if (slotsArg) {
      if (disp >= 0 && disp <= 0x1000 && (disp & 3) === 0) slotHist[disp/4] = (slotHist[disp/4]||0)+1;
      continue;
    }
    if (disp !== target) continue;
    sites.push({ va: sec.va + off, reg, disp, len });
  }
  return { sites, slotHist };
}

let totalSites = 0;
const slotHist = {};
for (const sec of sections) {
  const { sites, slotHist: sh } = scanSection(sec);
  if (slotsArg) {
    for (const k of Object.keys(sh)) slotHist[k] = (slotHist[k]||0) + sh[k];
    continue;
  }
  totalSites += sites.length;
  if (countOnly) {
    console.log(`[${sec.name.padEnd(8)}] ${sites.length} hits`);
    continue;
  }
  if (sites.length === 0) continue;
  console.log(`=== [${sec.name}]  ${sites.length} hits  call dword [reg+0x${target.toString(16)}] ===`);
  for (const s of sites) {
    console.log(`  0x${s.va.toString(16)}  call [${s.reg}+0x${s.disp.toString(16)}]`);
  }
}

if (slotsArg) {
  const keys = Object.keys(slotHist).map(Number).sort((a,b)=>a-b);
  let total = 0;
  console.log('slot  disp     count');
  for (const k of keys) {
    total += slotHist[k];
    console.log(`${String(k).padStart(4)}  0x${(k*4).toString(16).padStart(4,'0')}   ${slotHist[k]}`);
  }
  console.log(`-- total ${total} indirect calls across ${keys.length} distinct slots --`);
} else if (!countOnly) {
  console.log(`-- ${totalSites} site(s) total --`);
}
