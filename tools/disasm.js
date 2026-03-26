#!/usr/bin/env node
// Simple x86 disassembler for PE files — enough to debug the decoder
// Usage: node tools/disasm.js <exe> <VA> [count=20]
// Example: node tools/disasm.js test/binaries/notepad.exe 0x4010cc 30

const fs = require('fs');
const file = process.argv[2];
const startVA = parseInt(process.argv[3], 16);
const maxInsns = parseInt(process.argv[4] || '20');

if (!file || isNaN(startVA)) {
  console.error('Usage: node tools/disasm.js <exe> <VA> [count=20]');
  process.exit(1);
}

const buf = fs.readFileSync(file);
const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

const peOff = dv.getUint32(0x3c, true);
const numSect = dv.getUint16(peOff + 6, true);
const optSize = dv.getUint16(peOff + 4 + 16, true);
const imageBase = dv.getUint32(peOff + 4 + 20 + 28, true);
const sectOff = peOff + 4 + 20 + optSize;

function rvaToFileOff(rva) {
  for (let i = 0; i < numSect; i++) {
    const so = sectOff + i * 40;
    const sva = dv.getUint32(so + 12, true);
    const svs = Math.max(dv.getUint32(so + 8, true), dv.getUint32(so + 16, true));
    const rawOff = dv.getUint32(so + 20, true);
    if (rva >= sva && rva < sva + svs) return rva - sva + rawOff;
  }
  return -1;
}

const rva0 = startVA - imageBase;
const baseFileOff = rvaToFileOff(rva0);
if (baseFileOff < 0) { console.error('VA not in any section'); process.exit(1); }

const regs32 = ['eax','ecx','edx','ebx','esp','ebp','esi','edi'];
const regs8 = ['al','cl','dl','bl','ah','ch','dh','bh'];
const regs16 = ['ax','cx','dx','bx','sp','bp','si','di'];
const cc = ['o','no','b','nb','z','nz','be','a','s','ns','p','np','l','ge','le','g'];

let pos = baseFileOff;
const rd8 = () => buf[pos++];
const rd16 = () => { const v = dv.getUint16(pos, true); pos += 2; return v; };
const rd32 = () => { const v = dv.getUint32(pos, true); pos += 4; return v; };
const sx8 = v => v > 127 ? v - 256 : v;

function modrm(wide) {
  const b = rd8();
  const mod = b >> 6, reg = (b >> 3) & 7, rm = b & 7;
  const rn = wide ? regs32 : regs8;
  let ea;
  if (mod === 3) { ea = rn[rm]; }
  else {
    if (mod === 0 && rm === 5) { ea = `[0x${rd32().toString(16)}]`; }
    else if (rm === 4) {
      const sib = rd8();
      const scale = 1 << (sib >> 6);
      const idx = (sib >> 3) & 7;
      const base = sib & 7;
      let s = '';
      if (mod === 0 && base === 5) { s = `0x${rd32().toString(16)}`; }
      else { s = regs32[base]; }
      if (idx !== 4) s += `+${regs32[idx]}${scale > 1 ? '*' + scale : ''}`;
      if (mod === 1) { const d = sx8(rd8()); s += d >= 0 ? `+0x${d.toString(16)}` : `-0x${(-d).toString(16)}`; }
      else if (mod === 2) { const d = rd32(); s += `+0x${d.toString(16)}`; }
      ea = `[${s}]`;
    } else {
      let s = regs32[rm];
      if (mod === 1) { const d = sx8(rd8()); s += d >= 0 ? `+0x${d.toString(16)}` : `-0x${(-d).toString(16)}`; }
      else if (mod === 2) { const d = rd32(); s += `+0x${d.toString(16)}`; }
      ea = `[${s}]`;
    }
  }
  return { reg, rm: ea, mod, regName: rn[reg], regName32: regs32[reg] };
}

const aluOps = ['add','or','adc','sbb','and','sub','xor','cmp'];
const shiftOps = ['rol','ror','rcl','rcr','shl','shr','sal','sar'];

for (let n = 0; n < maxInsns; n++) {
  const va = startVA + (pos - baseFileOff);
  const startPos = pos;
  let insn = '??';

  try {
    let prefix66 = false;
    let op = rd8();
    if (op === 0x66) { prefix66 = true; op = rd8(); }

    if (op === 0x55) insn = 'push ebp';
    else if (op === 0x5D) insn = 'pop ebp';
    else if (op >= 0x50 && op <= 0x57) insn = `push ${regs32[op - 0x50]}`;
    else if (op >= 0x58 && op <= 0x5F) insn = `pop ${regs32[op - 0x58]}`;
    else if (op >= 0x40 && op <= 0x47) insn = `inc ${regs32[op - 0x40]}`;
    else if (op >= 0x48 && op <= 0x4F) insn = `dec ${regs32[op - 0x48]}`;
    else if (op === 0x90) insn = 'nop';
    else if (op === 0xC3) { insn = 'ret'; }
    else if (op === 0xC2) { insn = `ret 0x${rd16().toString(16)}`; }
    else if (op === 0xC9) insn = 'leave';
    else if (op === 0xCC) insn = 'int3';
    else if (op === 0xEB) { const d = sx8(rd8()); insn = `jmp short 0x${(va + 2 + d).toString(16)}`; }
    else if (op === 0xE9) { const d = rd32(); insn = `jmp 0x${(va + 5 + (d | 0)).toString(16)}`; }
    else if (op === 0xE8) { const d = rd32(); insn = `call 0x${(va + 5 + (d | 0)).toString(16)}`; }
    else if (op >= 0x70 && op <= 0x7F) { const d = sx8(rd8()); insn = `j${cc[op-0x70]} short 0x${(va + 2 + d).toString(16)}`; }
    else if (op >= 0x00 && op <= 0x3F && (op & 6) !== 6) {
      const aluIdx = op >> 3;
      const dir = op & 2; // 0=r/m,r  2=r,r/m
      const wide = op & 1;
      const m = modrm(wide);
      if (dir) insn = `${aluOps[aluIdx]} ${m.regName}, ${m.rm}`;
      else insn = `${aluOps[aluIdx]} ${m.rm}, ${m.regName}`;
    }
    else if (op >= 0x04 && op <= 0x3D && (op & 7) === 4) { insn = `${aluOps[op >> 3]} al, 0x${rd8().toString(16)}`; }
    else if (op >= 0x05 && op <= 0x3D && (op & 7) === 5) { insn = `${aluOps[op >> 3]} eax, 0x${rd32().toString(16)}`; }
    else if (op === 0x68) insn = `push 0x${rd32().toString(16)}`;
    else if (op === 0x6A) insn = `push 0x${rd8().toString(16)}`;
    else if (op === 0x80) { const m = modrm(false); insn = `${aluOps[m.reg]} byte ${m.rm}, 0x${rd8().toString(16)}`; }
    else if (op === 0x81) { const m = modrm(true); insn = `${aluOps[m.reg]} dword ${m.rm}, 0x${rd32().toString(16)}`; }
    else if (op === 0x83) { const m = modrm(true); insn = `${aluOps[m.reg]} dword ${m.rm}, 0x${sx8(rd8()).toString(16)}`; }
    else if (op === 0x84) { const m = modrm(false); insn = `test ${m.rm}, ${m.regName}`; }
    else if (op === 0x85) { const m = modrm(true); insn = `test ${m.rm}, ${m.regName}`; }
    else if (op === 0x88) { const m = modrm(false); insn = `mov ${m.rm}, ${m.regName}`; }
    else if (op === 0x89) { const m = modrm(true); insn = `mov ${m.rm}, ${m.regName}`; }
    else if (op === 0x8A) { const m = modrm(false); insn = `mov ${m.regName}, ${m.rm}`; }
    else if (op === 0x8B) { const m = modrm(true); insn = `mov ${m.regName}, ${m.rm}`; }
    else if (op === 0x8D) { const m = modrm(true); insn = `lea ${m.regName32}, ${m.rm}`; }
    else if (op >= 0xB0 && op <= 0xB7) insn = `mov ${regs8[op-0xB0]}, 0x${rd8().toString(16)}`;
    else if (op >= 0xB8 && op <= 0xBF) insn = `mov ${regs32[op-0xB8]}, 0x${rd32().toString(16)}`;
    else if (op === 0xA1) insn = `mov eax, [0x${rd32().toString(16)}]`;
    else if (op === 0xA3) insn = `mov [0x${rd32().toString(16)}], eax`;
    else if (op === 0xC6) { const m = modrm(false); insn = `mov byte ${m.rm}, 0x${rd8().toString(16)}`; }
    else if (op === 0xC7) { const m = modrm(true); insn = `mov dword ${m.rm}, 0x${rd32().toString(16)}`; }
    else if (op === 0xD0 || op === 0xD1) { const m = modrm(op & 1); insn = `${shiftOps[m.reg]} ${m.rm}, 1`; }
    else if (op === 0xD2 || op === 0xD3) { const m = modrm(op & 1); insn = `${shiftOps[m.reg]} ${m.rm}, cl`; }
    else if (op === 0xC0) { const m = modrm(false); insn = `${shiftOps[m.reg]} ${m.rm}, 0x${rd8().toString(16)}`; }
    else if (op === 0xC1) { const m = modrm(true); insn = `${shiftOps[m.reg]} ${m.rm}, 0x${rd8().toString(16)}`; }
    else if (op === 0xF6) { const m = modrm(false); const ops = ['test','??','not','neg','mul','imul','div','idiv']; insn = m.reg === 0 ? `test ${m.rm}, 0x${rd8().toString(16)}` : `${ops[m.reg]} ${m.rm}`; }
    else if (op === 0xF7) { const m = modrm(true); const ops = ['test','??','not','neg','mul','imul','div','idiv']; insn = m.reg === 0 ? `test ${m.rm}, 0x${rd32().toString(16)}` : `${ops[m.reg]} ${m.rm}`; }
    else if (op === 0xFE) { const m = modrm(false); insn = m.reg === 0 ? `inc byte ${m.rm}` : `dec byte ${m.rm}`; }
    else if (op === 0xFF) {
      const m = modrm(true);
      const ops = ['inc','dec','call','call far','jmp','jmp far','push'];
      insn = `${ops[m.reg] || '??'} ${m.rm}`;
    }
    else if (op === 0x0F) {
      const op2 = rd8();
      if (op2 >= 0x80 && op2 <= 0x8F) { const d = rd32(); insn = `j${cc[op2-0x80]} 0x${(va + 6 + (d | 0)).toString(16)}`; }
      else if (op2 >= 0x90 && op2 <= 0x9F) { const m = modrm(true); insn = `set${cc[op2-0x90]} ${m.rm}`; }
      else if (op2 === 0xB6) { const m = modrm(true); insn = `movzx ${m.regName32}, byte ${m.rm}`; }
      else if (op2 === 0xB7) { const m = modrm(true); insn = `movzx ${m.regName32}, word ${m.rm}`; }
      else if (op2 === 0xBE) { const m = modrm(true); insn = `movsx ${m.regName32}, byte ${m.rm}`; }
      else if (op2 === 0xBF) { const m = modrm(true); insn = `movsx ${m.regName32}, word ${m.rm}`; }
      else if (op2 === 0xAF) { const m = modrm(true); insn = `imul ${m.regName32}, ${m.rm}`; }
      else if (op2 === 0xA4 || op2 === 0xAC) { const m = modrm(true); insn = `sh${op2 < 0xA8 ? 'l' : 'r'}d ${m.rm}, ${m.regName32}, ${rd8()}`; }
      else if (op2 === 0xA5 || op2 === 0xAD) { const m = modrm(true); insn = `sh${op2 < 0xA8 ? 'l' : 'r'}d ${m.rm}, ${m.regName32}, cl`; }
      else insn = `0F ${op2.toString(16).padStart(2,'0')} ??`;
    }
    else if (op === 0x69) { const m = modrm(true); insn = `imul ${m.regName32}, ${m.rm}, 0x${rd32().toString(16)}`; }
    else if (op === 0x6B) { const m = modrm(true); insn = `imul ${m.regName32}, ${m.rm}, 0x${sx8(rd8()).toString(16)}`; }
    else if (op === 0xF3 || op === 0xF2) { insn = `rep/repne prefix+${rd8().toString(16)}`; }
    else { insn = `db 0x${op.toString(16)}`; }
  } catch (e) {
    insn = `<error: ${e.message}>`;
  }

  const len = pos - startPos;
  const rawBytes = Array.from(buf.slice(startPos, pos)).map(b => b.toString(16).padStart(2, '0')).join(' ');
  console.log(`${va.toString(16).padStart(8, '0')}  ${rawBytes.padEnd(24)} ${insn}`);

  if (insn === 'ret' || insn.startsWith('jmp ') || insn === 'int3') break;
}
