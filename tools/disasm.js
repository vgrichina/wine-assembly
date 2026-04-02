#!/usr/bin/env node
// x86-32 disassembler for PE files
// Usage: node tools/disasm.js <exe> <VA> [count=20]
//   node tools/disasm.js <exe> <VA> <endVA>   (if endVA > 0x1000, disasm range)
//   node tools/disasm.js <exe> --base=0xLOADADDR <runtimeVA> [count=20]
//     --base remaps: runtimeVA is translated to file VA via (runtimeVA - loadAddr + imageBase)
//
// Library usage:
//   const { disasmAt } = require('./tools/disasm');
//   disasmAt(buf, offset, va, count, importNames) => string[]

const regs32 = ['eax','ecx','edx','ebx','esp','ebp','esi','edi'];
const regs16 = ['ax','cx','dx','bx','sp','bp','si','di'];
const regs8  = ['al','cl','dl','bl','ah','ch','dh','bh'];
const sregs  = ['es','cs','ss','ds','fs','gs'];
const cc = ['o','no','b','nb','z','nz','be','a','s','ns','p','np','l','ge','le','g'];
const aluOps = ['add','or','adc','sbb','and','sub','xor','cmp'];
const shiftOps = ['rol','ror','rcl','rcr','shl','shr','sal','sar'];

const _hex = v => '0x' + (v >>> 0).toString(16);
const _hex8 = v => '0x' + (v & 0xff).toString(16);
const _sx8 = v => (v & 0x80) ? v - 256 : v;

// Disassemble `count` instructions from buf starting at byte offset `offset`,
// with `va` as the virtual address for display / branch targets.
// importNames is optional: { va_number: 'dll!FuncName' }.
// Returns array of formatted strings.
function disasmAt(buf, offset, va, count, importNames) {
  const dv = buf.buffer
    ? new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    : new DataView(buf);
  let pos = offset;
  const rd8 = () => dv.getUint8(pos++);
  const rd16 = () => { const v = dv.getUint16(pos, true); pos += 2; return v; };
  const rd32 = () => { const v = dv.getUint32(pos, true); pos += 4; return v; };

  function modrm(sz) {
    const b = rd8();
    const mod = b >> 6, reg = (b >> 3) & 7, rm = b & 7;
    const rn = sz === 8 ? regs8 : sz === 16 ? regs16 : regs32;
    let ea;
    if (mod === 3) { ea = rn[rm]; }
    else {
      if (mod === 0 && rm === 5) { ea = `[${_hex(rd32())}]`; }
      else if (rm === 4) {
        const sib = rd8();
        const scale = 1 << (sib >> 6);
        const idx = (sib >> 3) & 7;
        const base = sib & 7;
        let s = '';
        if (mod === 0 && base === 5) { s = _hex(rd32()); }
        else { s = regs32[base]; }
        if (idx !== 4) s += '+' + regs32[idx] + (scale > 1 ? '*' + scale : '');
        if (mod === 1) { const d = _sx8(rd8()); s += d >= 0 ? '+' + _hex(d) : '-' + _hex(-d); }
        else if (mod === 2) { const d = rd32(); s += '+' + _hex(d); }
        ea = `[${s}]`;
      } else {
        let s = regs32[rm];
        if (mod === 1) { const d = _sx8(rd8()); s += d >= 0 ? '+' + _hex(d) : '-' + _hex(-d); }
        else if (mod === 2) { const d = rd32(); s += '+' + _hex(d); }
        ea = `[${s}]`;
      }
    }
    return { reg, rm: ea, mod, rn: rn[reg], rn32: regs32[reg] };
  }

  function readImm(sz) {
    if (sz === 8) return rd8();
    if (sz === 16) return rd16();
    return rd32();
  }
  function szName(sz) { return sz === 8 ? 'byte' : sz === 16 ? 'word' : 'dword'; }

  const lines = [];
  for (let n = 0; n < count; n++) {
    const curVA = va + (pos - offset);
    const startPos = pos;
    let insn = '??';

    try {
      let pfx66 = false, pfxF2 = false, pfxF3 = false, pfxSeg = '';
      let op;
      for (;;) {
        op = rd8();
        if (op === 0x66) pfx66 = true;
        else if (op === 0xF2) pfxF2 = true;
        else if (op === 0xF3) pfxF3 = true;
        else if (op === 0x26) pfxSeg = 'es:';
        else if (op === 0x2E) pfxSeg = 'cs:';
        else if (op === 0x36) pfxSeg = 'ss:';
        else if (op === 0x3E) pfxSeg = 'ds:';
        else if (op === 0x64) pfxSeg = 'fs:';
        else if (op === 0x65) pfxSeg = 'gs:';
        else break;
      }

      const osz = pfx66 ? 16 : 32;
      const rn = osz === 16 ? regs16 : regs32;
      const accum = osz === 16 ? 'ax' : 'eax';

      if (op <= 0x3F && op !== 0x0F) {
        const row = op >> 3, col = op & 7;
        if (col <= 5) {
          if (col === 0) { const m = modrm(8); insn = `${aluOps[row]} ${m.rm}, ${m.rn}`; }
          else if (col === 1) { const m = modrm(osz); insn = `${aluOps[row]} ${m.rm}, ${m.rn}`; }
          else if (col === 2) { const m = modrm(8); insn = `${aluOps[row]} ${m.rn}, ${m.rm}`; }
          else if (col === 3) { const m = modrm(osz); insn = `${aluOps[row]} ${m.rn}, ${m.rm}`; }
          else if (col === 4) { insn = `${aluOps[row]} al, ${_hex8(rd8())}`; }
          else if (col === 5) { insn = `${aluOps[row]} ${accum}, ${_hex(readImm(osz))}`; }
        }
        else if (col === 6 && row < 4) insn = `push ${sregs[row]}`;
        else if (col === 7 && row < 4) insn = `pop ${sregs[row]}`;
      }
      else if (op >= 0x40 && op <= 0x47) insn = `inc ${rn[op - 0x40]}`;
      else if (op >= 0x48 && op <= 0x4F) insn = `dec ${rn[op - 0x48]}`;
      else if (op >= 0x50 && op <= 0x57) insn = `push ${regs32[op - 0x50]}`;
      else if (op >= 0x58 && op <= 0x5F) insn = `pop ${regs32[op - 0x58]}`;
      else if (op === 0x60) insn = pfx66 ? 'pushaw' : 'pushad';
      else if (op === 0x61) insn = pfx66 ? 'popaw' : 'popad';
      else if (op === 0x68) insn = `push ${_hex(readImm(osz))}`;
      else if (op === 0x6A) insn = `push ${_hex8(rd8())}`;
      else if (op === 0x69) { const m = modrm(osz); insn = `imul ${m.rn}, ${m.rm}, ${_hex(readImm(osz))}`; }
      else if (op === 0x6B) { const m = modrm(osz); insn = `imul ${m.rn}, ${m.rm}, ${_hex8(rd8())}`; }
      else if (op >= 0x70 && op <= 0x7F) { const d = _sx8(rd8()); insn = `j${cc[op-0x70]} short ${_hex(curVA + (pos - startPos) + d)}`; }
      else if (op === 0x80) { const m = modrm(8); insn = `${aluOps[m.reg]} byte ${m.rm}, ${_hex8(rd8())}`; }
      else if (op === 0x81) { const m = modrm(osz); insn = `${aluOps[m.reg]} ${szName(osz)} ${m.rm}, ${_hex(readImm(osz))}`; }
      else if (op === 0x83) { const m = modrm(osz); const v = _sx8(rd8()); insn = `${aluOps[m.reg]} ${szName(osz)} ${m.rm}, ${v < 0 ? '-'+_hex(-v) : _hex(v)}`; }
      else if (op === 0x84) { const m = modrm(8); insn = `test ${m.rm}, ${m.rn}`; }
      else if (op === 0x85) { const m = modrm(osz); insn = `test ${m.rm}, ${m.rn}`; }
      else if (op === 0x86) { const m = modrm(8); insn = `xchg ${m.rm}, ${m.rn}`; }
      else if (op === 0x87) { const m = modrm(osz); insn = `xchg ${m.rm}, ${m.rn}`; }
      else if (op === 0x88) { const m = modrm(8); insn = `mov ${m.rm}, ${m.rn}`; }
      else if (op === 0x89) { const m = modrm(osz); insn = `mov ${m.rm}, ${m.rn}`; }
      else if (op === 0x8A) { const m = modrm(8); insn = `mov ${m.rn}, ${m.rm}`; }
      else if (op === 0x8B) { const m = modrm(osz); insn = `mov ${m.rn}, ${m.rm}`; }
      else if (op === 0x8C) { const m = modrm(16); insn = `mov ${m.rm}, ${sregs[m.reg] || '??'}`; }
      else if (op === 0x8D) { const m = modrm(32); insn = `lea ${m.rn32}, ${m.rm}`; }
      else if (op === 0x8E) { const m = modrm(16); insn = `mov ${sregs[m.reg] || '??'}, ${m.rm}`; }
      else if (op === 0x8F) { const m = modrm(osz); insn = `pop ${m.rm}`; }
      else if (op === 0x90) insn = 'nop';
      else if (op >= 0x91 && op <= 0x97) insn = `xchg ${accum}, ${rn[op - 0x90]}`;
      else if (op === 0x98) insn = pfx66 ? 'cbw' : 'cwde';
      else if (op === 0x99) insn = pfx66 ? 'cwd' : 'cdq';
      else if (op === 0x9C) insn = 'pushfd';
      else if (op === 0x9D) insn = 'popfd';
      else if (op === 0x9E) insn = 'sahf';
      else if (op === 0x9F) insn = 'lahf';
      else if (op === 0xA0) insn = `mov al, [${_hex(rd32())}]`;
      else if (op === 0xA1) insn = `mov ${accum}, [${_hex(rd32())}]`;
      else if (op === 0xA2) insn = `mov [${_hex(rd32())}], al`;
      else if (op === 0xA3) insn = `mov [${_hex(rd32())}], ${accum}`;
      else if (op === 0xA4) insn = (pfxF3 ? 'rep ' : '') + 'movsb';
      else if (op === 0xA5) insn = (pfxF3 ? 'rep ' : '') + (pfx66 ? 'movsw' : 'movsd');
      else if (op === 0xA6) insn = (pfxF3 ? 'repe ' : pfxF2 ? 'repne ' : '') + 'cmpsb';
      else if (op === 0xA7) insn = (pfxF3 ? 'repe ' : pfxF2 ? 'repne ' : '') + (pfx66 ? 'cmpsw' : 'cmpsd');
      else if (op === 0xA8) insn = `test al, ${_hex8(rd8())}`;
      else if (op === 0xA9) insn = `test ${accum}, ${_hex(readImm(osz))}`;
      else if (op === 0xAA) insn = (pfxF3 ? 'rep ' : '') + 'stosb';
      else if (op === 0xAB) insn = (pfxF3 ? 'rep ' : '') + (pfx66 ? 'stosw' : 'stosd');
      else if (op === 0xAC) insn = (pfxF3 ? 'rep ' : '') + 'lodsb';
      else if (op === 0xAD) insn = (pfxF3 ? 'rep ' : '') + (pfx66 ? 'lodsw' : 'lodsd');
      else if (op === 0xAE) insn = (pfxF3 ? 'repe ' : pfxF2 ? 'repne ' : '') + 'scasb';
      else if (op === 0xAF) insn = (pfxF3 ? 'repe ' : pfxF2 ? 'repne ' : '') + (pfx66 ? 'scasw' : 'scasd');
      else if (op >= 0xB0 && op <= 0xB7) insn = `mov ${regs8[op-0xB0]}, ${_hex8(rd8())}`;
      else if (op >= 0xB8 && op <= 0xBF) insn = `mov ${rn[op-0xB8]}, ${_hex(readImm(osz))}`;
      else if (op === 0xC0) { const m = modrm(8); insn = `${shiftOps[m.reg]} ${m.rm}, ${_hex8(rd8())}`; }
      else if (op === 0xC1) { const m = modrm(osz); insn = `${shiftOps[m.reg]} ${m.rm}, ${_hex8(rd8())}`; }
      else if (op === 0xC2) insn = `ret ${_hex(rd16())}`;
      else if (op === 0xC3) insn = 'ret';
      else if (op === 0xC6) { const m = modrm(8); insn = `mov byte ${m.rm}, ${_hex8(rd8())}`; }
      else if (op === 0xC7) { const m = modrm(osz); insn = `mov ${szName(osz)} ${m.rm}, ${_hex(readImm(osz))}`; }
      else if (op === 0xC9) insn = 'leave';
      else if (op === 0xCC) insn = 'int3';
      else if (op === 0xCD) insn = `int ${_hex8(rd8())}`;
      else if (op === 0xD0) { const m = modrm(8); insn = `${shiftOps[m.reg]} ${m.rm}, 1`; }
      else if (op === 0xD1) { const m = modrm(osz); insn = `${shiftOps[m.reg]} ${m.rm}, 1`; }
      else if (op === 0xD2) { const m = modrm(8); insn = `${shiftOps[m.reg]} ${m.rm}, cl`; }
      else if (op === 0xD3) { const m = modrm(osz); insn = `${shiftOps[m.reg]} ${m.rm}, cl`; }
      else if (op === 0xE0) { const d = _sx8(rd8()); insn = `loopnz ${_hex(curVA + (pos - startPos) + d)}`; }
      else if (op === 0xE1) { const d = _sx8(rd8()); insn = `loopz ${_hex(curVA + (pos - startPos) + d)}`; }
      else if (op === 0xE2) { const d = _sx8(rd8()); insn = `loop ${_hex(curVA + (pos - startPos) + d)}`; }
      else if (op === 0xE3) { const d = _sx8(rd8()); insn = `jecxz ${_hex(curVA + (pos - startPos) + d)}`; }
      else if (op === 0xE8) { const d = rd32(); insn = `call ${_hex((curVA + (pos - startPos) + (d | 0)) >>> 0)}`; }
      else if (op === 0xE9) { const d = rd32(); insn = `jmp ${_hex((curVA + (pos - startPos) + (d | 0)) >>> 0)}`; }
      else if (op === 0xEB) { const d = _sx8(rd8()); insn = `jmp short ${_hex(curVA + (pos - startPos) + d)}`; }
      else if (op === 0xF5) insn = 'cmc';
      else if (op === 0xF6) {
        const m = modrm(8);
        if (m.reg === 0) insn = `test ${m.rm}, ${_hex8(rd8())}`;
        else insn = `${['test','??','not','neg','mul','imul','div','idiv'][m.reg]} ${m.rm}`;
      }
      else if (op === 0xF7) {
        const m = modrm(osz);
        if (m.reg === 0) insn = `test ${m.rm}, ${_hex(readImm(osz))}`;
        else insn = `${['test','??','not','neg','mul','imul','div','idiv'][m.reg]} ${m.rm}`;
      }
      else if (op === 0xF8) insn = 'clc';
      else if (op === 0xF9) insn = 'stc';
      else if (op === 0xFC) insn = 'cld';
      else if (op === 0xFD) insn = 'std';
      else if (op === 0xFE) { const m = modrm(8); insn = m.reg === 0 ? `inc byte ${m.rm}` : `dec byte ${m.rm}`; }
      else if (op === 0xFF) {
        const m = modrm(osz);
        const ops = ['inc','dec','call','call far','jmp','jmp far','push'];
        const name = ops[m.reg] || '??';
        if (m.reg === 2 && m.rm.startsWith('[0x') && importNames) {
          const addr = parseInt(m.rm.slice(1, -1), 16);
          const fn = importNames[addr];
          insn = fn ? `call ${m.rm}  ; ${fn}` : `call ${m.rm}`;
        } else {
          insn = `${name} ${m.rm}`;
        }
      }
      else if (op === 0x0F) {
        const op2 = rd8();
        if (op2 >= 0x80 && op2 <= 0x8F) { const d = rd32(); insn = `j${cc[op2-0x80]} ${_hex((curVA + (pos - startPos) + (d | 0)) >>> 0)}`; }
        else if (op2 >= 0x90 && op2 <= 0x9F) { const m = modrm(8); insn = `set${cc[op2-0x90]} ${m.rm}`; }
        else if (op2 === 0xA3) { const m = modrm(osz); insn = `bt ${m.rm}, ${m.rn}`; }
        else if (op2 === 0xAB) { const m = modrm(osz); insn = `bts ${m.rm}, ${m.rn}`; }
        else if (op2 === 0xAF) { const m = modrm(osz); insn = `imul ${m.rn}, ${m.rm}`; }
        else if (op2 === 0xA4) { const m = modrm(osz); insn = `shld ${m.rm}, ${m.rn}, ${rd8()}`; }
        else if (op2 === 0xA5) { const m = modrm(osz); insn = `shld ${m.rm}, ${m.rn}, cl`; }
        else if (op2 === 0xAC) { const m = modrm(osz); insn = `shrd ${m.rm}, ${m.rn}, ${rd8()}`; }
        else if (op2 === 0xAD) { const m = modrm(osz); insn = `shrd ${m.rm}, ${m.rn}, cl`; }
        else if (op2 === 0xB1) { const m = modrm(osz); insn = `cmpxchg ${m.rm}, ${m.rn}`; }
        else if (op2 === 0xB6) { const m = modrm(32); insn = `movzx ${m.rn32}, byte ${m.rm}`; }
        else if (op2 === 0xB7) { const m = modrm(32); insn = `movzx ${m.rn32}, word ${m.rm}`; }
        else if (op2 === 0xBA) {
          const m = modrm(osz); const imm = rd8();
          const ops = ['??','??','??','??','bt','bts','btr','btc'];
          insn = `${ops[m.reg]} ${m.rm}, ${imm}`;
        }
        else if (op2 === 0xBE) { const m = modrm(32); insn = `movsx ${m.rn32}, byte ${m.rm}`; }
        else if (op2 === 0xBF) { const m = modrm(32); insn = `movsx ${m.rn32}, word ${m.rm}`; }
        else if (op2 === 0xC1) { const m = modrm(osz); insn = `xadd ${m.rm}, ${m.rn}`; }
        else if (op2 === 0xC8) insn = 'bswap eax';
        else if (op2 >= 0xC8 && op2 <= 0xCF) insn = `bswap ${regs32[op2 - 0xC8]}`;
        else if (op2 === 0x31) insn = 'rdtsc';
        else if (op2 >= 0x40 && op2 <= 0x4F) { const m = modrm(osz); insn = `cmov${cc[op2-0x40]} ${m.rn}, ${m.rm}`; }
        else insn = `db 0x0f, 0x${op2.toString(16)}`;
      }
      else { insn = `db ${_hex8(op)}`; }

      if (pfxSeg && insn !== '??') insn = pfxSeg + ' ' + insn;
    } catch (e) {
      insn = '<decode error>';
    }

    const len = pos - startPos;
    const rawBytes = Array.from(buf.slice(startPos, startPos + len)).map(b => b.toString(16).padStart(2, '0')).join(' ');
    lines.push(`${curVA.toString(16).padStart(8, '0')}  ${rawBytes.padEnd(28)} ${insn}`);

    if (insn === 'ret' || insn.startsWith('ret ') || (insn.startsWith('jmp ') && !insn.includes('short')) || insn === 'int3') break;
  }
  return lines;
}

module.exports = { disasmAt };

// --- CLI entry point ---
if (require.main === module) {
  const fs = require('fs');
  const args = process.argv.slice(2);
  let loadBase = null;
  const filtered = args.filter(a => {
    const m = a.match(/^--base=(?:0x)?([0-9a-fA-F]+)$/);
    if (m) { loadBase = parseInt(m[1], 16); return false; }
    return true;
  });
  const file = filtered[0];
  let startVA = parseInt(filtered[1], 16);
  let maxInsns = parseInt(filtered[2] || '20');
  let endVA = 0;
  if (maxInsns > 0x1000) { endVA = maxInsns; maxInsns = 100000; }

  if (!file || isNaN(startVA)) {
    console.error('Usage: node tools/disasm.js <exe> <VA> [count=20]');
    console.error('       node tools/disasm.js <exe> --base=0xLOADADDR <runtimeVA> [count=20]');
    process.exit(1);
  }

  const buf = fs.readFileSync(file);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  const peOff = dv.getUint32(0x3c, true);
  const numSect = dv.getUint16(peOff + 6, true);
  const optSize = dv.getUint16(peOff + 4 + 16, true);
  const imageBase = dv.getUint32(peOff + 4 + 20 + 28, true);
  const sectOff = peOff + 4 + 20 + optSize;

  // Build import name map: IAT address -> function name
  const importRVA = dv.getUint32(peOff + 4 + 20 + 104, true);
  const importNames = {};
  if (importRVA) {
    for (let i = 0; i < numSect; i++) {
      const so = sectOff + i * 40;
      const sva = dv.getUint32(so + 12, true);
      const svs = Math.max(dv.getUint32(so + 8, true), dv.getUint32(so + 16, true));
      const rawOff = dv.getUint32(so + 20, true);
      if (importRVA >= sva && importRVA < sva + svs) {
        let off = rawOff + (importRVA - sva);
        while (off + 20 <= buf.length) {
          const nameRVA = dv.getUint32(off + 12, true);
          if (nameRVA === 0) break;
          let dllName = '';
          const dnOff = rawOff + (nameRVA - sva);
          for (let j = dnOff; j < buf.length && buf[j]; j++) dllName += String.fromCharCode(buf[j]);
          const iatRVA = dv.getUint32(off + 16, true) || dv.getUint32(off, true);
          let tOff = rawOff + (iatRVA - sva), idx = 0;
          while (tOff + 4 <= buf.length) {
            const val = dv.getUint32(tOff, true);
            if (val === 0) break;
            if (!(val & 0x80000000)) {
              let fnName = '';
              const fnOff = rawOff + (val - sva) + 2;
              for (let j = fnOff; j < buf.length && buf[j]; j++) fnName += String.fromCharCode(buf[j]);
              importNames[imageBase + iatRVA + idx * 4] = dllName.replace(/\.dll$/i, '') + '!' + fnName;
            }
            tOff += 4; idx++;
          }
          off += 20;
        }
      }
    }
  }

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

  if (loadBase !== null) {
    if (endVA) endVA = endVA - loadBase + imageBase;
    startVA = startVA - loadBase + imageBase;
  }

  const rva0 = startVA - imageBase;
  const baseFileOff = rvaToFileOff(rva0);
  if (baseFileOff < 0) { console.error('VA not in any section'); process.exit(1); }

  const displayVA = loadBase !== null ? startVA - imageBase + loadBase : startVA;
  const lines = disasmAt(buf, baseFileOff, displayVA, endVA ? maxInsns : maxInsns, importNames);

  // If endVA specified, filter to range
  if (endVA) {
    const endDisplay = loadBase !== null ? endVA - imageBase + loadBase : endVA;
    for (const line of lines) {
      const lineVA = parseInt(line.trim().split(/\s/)[0], 16);
      if (lineVA >= endDisplay) break;
      console.log(line);
    }
  } else {
    lines.forEach(l => console.log(l));
  }
}
