#!/usr/bin/env node
// Static x86 idiom census for threaded-IR superinstruction candidates.
//
// This is intentionally approximate: it linearly decodes executable PE
// sections and may see data-in-code regions as instructions. The goal is not
// exact disassembly; it is to find broad, repeated instruction shapes worth
// profiling before adding threaded handlers.

const fs = require('fs');
const path = require('path');
const { disasmAt } = require('./disasm');

const regs32 = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi'];
const regs8 = ['al', 'cl', 'dl', 'bl', 'ah', 'ch', 'dh', 'bh'];
const ccNames = ['o', 'no', 'b', 'ae', 'z', 'nz', 'be', 'a', 's', 'ns', 'p', 'np', 'l', 'ge', 'le', 'g'];

function hex(v, width = 0) {
  return '0x' + (v >>> 0).toString(16).padStart(width, '0');
}

function sx8(v) {
  return (v & 0x80) ? v - 0x100 : v;
}

function sx32(v) {
  return v | 0;
}

function parsePe(file) {
  const buf = fs.readFileSync(file);
  const peOff = buf.readUInt32LE(0x3c);
  const optOff = peOff + 24;
  const imageBase = buf.readUInt32LE(optOff + 28);
  const numSections = buf.readUInt16LE(peOff + 6);
  const sectOff = optOff + buf.readUInt16LE(peOff + 20);
  const sections = [];
  for (let i = 0; i < numSections; i++) {
    const off = sectOff + i * 40;
    const name = buf.toString('ascii', off, off + 8).replace(/\0.*$/, '');
    const vsize = buf.readUInt32LE(off + 8);
    const vaddr = buf.readUInt32LE(off + 12);
    const rawSize = buf.readUInt32LE(off + 16);
    const rawOff = buf.readUInt32LE(off + 20);
    const characteristics = buf.readUInt32LE(off + 36);
    const executable = !!(characteristics & 0x20000000);
    const code = !!(characteristics & 0x20);
    if ((executable || code) && rawSize > 0) {
      sections.push({
        name,
        va: (imageBase + vaddr) >>> 0,
        rawOff,
        rawSize: Math.min(rawSize, Math.max(0, buf.length - rawOff)),
        vsize,
      });
    }
  }
  return { buf, imageBase, sections };
}

function fallbackLen(buf, off, va) {
  try {
    const line = disasmAt(buf, off, va >>> 0, 1)[0] || '';
    const m = line.match(/^\s*[0-9a-f]+\s+((?:[0-9a-f]{2}\s+)+)/i);
    if (m) return Math.max(1, m[1].trim().split(/\s+/).length);
  } catch (_) {}
  return 1;
}

function parseModrm(buf, pos, end) {
  if (pos >= end) return null;
  const start = pos;
  const b = buf[pos++];
  const mod = b >>> 6;
  const reg = (b >>> 3) & 7;
  const rm = b & 7;
  let mem = null;
  let rmReg = -1;
  if (mod === 3) {
    rmReg = rm;
  } else if (rm === 4) {
    if (pos >= end) return null;
    const sib = buf[pos++];
    const scale = 1 << (sib >>> 6);
    const index = (sib >>> 3) & 7;
    const baseBits = sib & 7;
    let base = baseBits;
    let disp = 0;
    if (mod === 0 && baseBits === 5) {
      if (pos + 4 > end) return null;
      base = -1;
      disp = buf.readUInt32LE(pos) >>> 0;
      pos += 4;
    } else if (mod === 1) {
      if (pos >= end) return null;
      disp = sx8(buf[pos++]);
    } else if (mod === 2) {
      if (pos + 4 > end) return null;
      disp = sx32(buf.readUInt32LE(pos));
      pos += 4;
    }
    mem = {
      base,
      index: index === 4 ? -1 : index,
      scale,
      disp,
    };
  } else {
    let base = rm;
    let disp = 0;
    if (mod === 0 && rm === 5) {
      if (pos + 4 > end) return null;
      base = -1;
      disp = buf.readUInt32LE(pos) >>> 0;
      pos += 4;
    } else if (mod === 1) {
      if (pos >= end) return null;
      disp = sx8(buf[pos++]);
    } else if (mod === 2) {
      if (pos + 4 > end) return null;
      disp = sx32(buf.readUInt32LE(pos));
      pos += 4;
    }
    mem = { base, index: -1, scale: 1, disp };
  }
  return { mod, reg, rm, rmReg, mem, len: pos - start };
}

function memText(mem) {
  if (!mem) return '';
  const parts = [];
  if (mem.base >= 0) parts.push(regs32[mem.base]);
  if (mem.index >= 0) parts.push(regs32[mem.index] + (mem.scale > 1 ? '*' + mem.scale : ''));
  if (mem.disp) {
    if (parts.length) parts.push(mem.disp < 0 ? '-' + hex(-mem.disp) : hex(mem.disp));
    else parts.push(hex(mem.disp));
  } else if (!parts.length) {
    parts.push('0x0');
  }
  let out = '';
  for (const part of parts) {
    if (!out) {
      out = part;
    } else if (part[0] === '-') {
      out += part;
    } else {
      out += '+' + part;
    }
  }
  return '[' + out + ']';
}

function simpleBase(mem) {
  return !!mem && mem.base >= 0 && mem.index < 0;
}

function espRelative(mem) {
  return !!mem && mem.base === 4 && mem.index < 0;
}

function regName(reg) {
  return regs32[reg] || ('r' + reg);
}

function byteLowRegMatchesFull(byteReg, fullReg) {
  return byteReg === fullReg && fullReg >= 0 && fullReg < 4;
}

function decodeAt(buf, off, va, end) {
  const start = off;
  let pos = off;
  let p66 = false;
  let segment = false;
  while (pos < end) {
    const p = buf[pos];
    if (p === 0x66) { p66 = true; pos++; continue; }
    if (p === 0x26 || p === 0x2e || p === 0x36 || p === 0x3e || p === 0x64 || p === 0x65) {
      segment = true;
      pos++;
      continue;
    }
    if (p === 0xf2 || p === 0xf3) { pos++; continue; }
    break;
  }
  if (pos >= end) return null;
  const opOff = pos;
  const op = buf[pos++];
  const mk = (kind, extra = {}) => ({
    kind,
    va: va >>> 0,
    len: pos - start,
    p66,
    segment,
    text: kind,
    ...extra,
  });

  if (!p66 && (op === 0x31 || op === 0x33)) {
    const m = parseModrm(buf, pos, end);
    if (!m) return mk('unknown', { len: fallbackLen(buf, start, va) });
    pos += m.len;
    if (m.mod === 3) {
      const dst = op === 0x33 ? m.reg : m.rmReg;
      const src = op === 0x33 ? m.rmReg : m.reg;
      if (dst === src) return mk('xor_zero', { reg: dst, len: pos - start, text: `xor ${regName(dst)}, ${regName(src)}` });
      return mk('xor_rr', { dst, src, len: pos - start });
    }
    pos = opOff + 1;
  }

  if (!p66 && (op === 0x8a || op === 0x88 || op === 0x8b || op === 0x89)) {
    const m = parseModrm(buf, pos, end);
    if (!m) return mk('unknown', { len: fallbackLen(buf, start, va) });
    pos += m.len;
    if (op === 0x8a) {
      return mk(m.mod === 3 ? 'mov_r8_r8' : 'mov_r8_m8', {
        dst: m.reg,
        src: m.mod === 3 ? m.rmReg : -1,
        mem: m.mem,
        len: pos - start,
        text: `mov ${regs8[m.reg]}, ${m.mod === 3 ? regs8[m.rmReg] : memText(m.mem)}`,
      });
    }
    if (op === 0x88) {
      return mk(m.mod === 3 ? 'mov_r8_r8' : 'mov_m8_r8', {
        dst: m.mod === 3 ? m.rmReg : -1,
        src: m.reg,
        mem: m.mem,
        len: pos - start,
        text: `mov ${m.mod === 3 ? regs8[m.rmReg] : memText(m.mem)}, ${regs8[m.reg]}`,
      });
    }
    if (op === 0x8b) {
      return mk(m.mod === 3 ? 'mov_r32_r32' : 'mov_r32_m32', {
        dst: m.reg,
        src: m.mod === 3 ? m.rmReg : -1,
        mem: m.mem,
        len: pos - start,
        text: `mov ${regName(m.reg)}, ${m.mod === 3 ? regName(m.rmReg) : memText(m.mem)}`,
      });
    }
    return mk(m.mod === 3 ? 'mov_r32_r32' : 'mov_m32_r32', {
      dst: m.mod === 3 ? m.rmReg : -1,
      src: m.reg,
      mem: m.mem,
      len: pos - start,
      text: `mov ${m.mod === 3 ? regName(m.rmReg) : memText(m.mem)}, ${regName(m.reg)}`,
    });
  }

  if (!p66 && op === 0x8d) {
    const m = parseModrm(buf, pos, end);
    if (!m) return mk('unknown', { len: fallbackLen(buf, start, va) });
    pos += m.len;
    return mk('lea', { dst: m.reg, mem: m.mem, len: pos - start, text: `lea ${regName(m.reg)}, ${memText(m.mem)}` });
  }

  if (!p66 && op === 0x85) {
    const m = parseModrm(buf, pos, end);
    if (!m) return mk('unknown', { len: fallbackLen(buf, start, va) });
    pos += m.len;
    const isReg = m.mod === 3;
    return mk(isReg ? 'test_r32_r32' : 'test_m32_r32', {
      dst: isReg ? m.rmReg : -1,
      src: m.reg,
      mem: isReg ? null : m.mem,
      len: pos - start,
      text: `test ${isReg ? regName(m.rmReg) : memText(m.mem)}, ${regName(m.reg)}`,
    });
  }

  if (!p66 && op <= 0x3f && ((op & 7) === 1 || (op & 7) === 3)) {
    const m = parseModrm(buf, pos, end);
    if (!m) return mk('unknown', { len: fallbackLen(buf, start, va) });
    pos += m.len;
    const isReg = m.mod === 3;
    const alu = op >>> 3;
    const aluNames = ['add', 'or', 'adc', 'sbb', 'and', 'sub', 'xor', 'cmp'];
    const dstText = (op & 7) === 3 ? regName(m.reg) : (isReg ? regName(m.rmReg) : memText(m.mem));
    const srcText = (op & 7) === 3 ? (isReg ? regName(m.rmReg) : memText(m.mem)) : regName(m.reg);
    if (alu === 7) {
      if ((op & 7) === 3) {
        return mk(isReg ? 'cmp_r32_r32' : 'cmp_r32_m32', {
          dst: m.reg,
          src: isReg ? m.rmReg : -1,
          mem: isReg ? null : m.mem,
          len: pos - start,
          text: `cmp ${regName(m.reg)}, ${isReg ? regName(m.rmReg) : memText(m.mem)}`,
        });
      }
      return mk(isReg ? 'cmp_r32_r32' : 'cmp_m32_r32', {
        dst: isReg ? m.rmReg : -1,
        src: m.reg,
        mem: isReg ? null : m.mem,
        len: pos - start,
        text: `cmp ${isReg ? regName(m.rmReg) : memText(m.mem)}, ${regName(m.reg)}`,
      });
    }
    if (alu === 0 || alu === 5) {
      return mk((op & 7) === 3 ? (alu === 0 ? 'add_r32_rm32' : 'sub_r32_rm32') : (alu === 0 ? 'add_rm32_r32' : 'sub_rm32_r32'), {
        alu,
        aluName: aluNames[alu],
        dst: (op & 7) === 3 ? m.reg : (isReg ? m.rmReg : -1),
        src: (op & 7) === 3 ? (isReg ? m.rmReg : -1) : m.reg,
        mem: isReg ? null : m.mem,
        len: pos - start,
        text: `${aluNames[alu]} ${dstText}, ${srcText}`,
      });
    }
    return mk((op & 7) === 3 ? (isReg ? 'alu_r32_r32' : 'alu_r32_m32') : (isReg ? 'alu_r32_r32' : 'alu_m32_r32'), {
      alu,
      aluName: aluNames[alu],
      dst: (op & 7) === 3 ? m.reg : (isReg ? m.rmReg : -1),
      src: (op & 7) === 3 ? (isReg ? m.rmReg : -1) : m.reg,
      mem: isReg ? null : m.mem,
      len: pos - start,
      text: `${aluNames[alu]} ${dstText}, ${srcText}`,
    });
  }

  if (!p66 && (op === 0xa1 || op === 0xa3)) {
    if (pos + 4 > end) return mk('unknown', { len: fallbackLen(buf, start, va) });
    const addr = buf.readUInt32LE(pos) >>> 0;
    pos += 4;
    return mk(op === 0xa1 ? 'mov_eax_moffs32' : 'mov_moffs32_eax', {
      dst: op === 0xa1 ? 0 : -1,
      src: op === 0xa3 ? 0 : -1,
      mem: { base: -1, index: -1, scale: 1, disp: addr },
      len: pos - start,
      text: op === 0xa1 ? `mov eax, [${hex(addr)}]` : `mov [${hex(addr)}], eax`,
    });
  }

  if (!p66 && op >= 0xb8 && op <= 0xbf) {
    if (pos + 4 > end) return mk('unknown', { len: fallbackLen(buf, start, va) });
    const imm = buf.readUInt32LE(pos) >>> 0;
    pos += 4;
    return mk('mov_r32_i32', {
      dst: op - 0xb8,
      imm,
      len: pos - start,
      text: `mov ${regName(op - 0xb8)}, ${hex(imm)}`,
    });
  }

  if (!p66 && op >= 0x50 && op <= 0x57) return mk('push_r32', { reg: op - 0x50, text: `push ${regName(op - 0x50)}` });
  if (!p66 && op >= 0x58 && op <= 0x5f) return mk('pop_r32', { reg: op - 0x58, text: `pop ${regName(op - 0x58)}` });

  if (!p66 && op === 0x83) {
    const m = parseModrm(buf, pos, end);
    if (!m || pos + m.len >= end) return mk('unknown', { len: fallbackLen(buf, start, va) });
    pos += m.len;
    const imm = sx8(buf[pos++]);
    const names = ['add', 'or', 'adc', 'sbb', 'and', 'sub', 'xor', 'cmp'];
    return mk(m.mod === 3 ? 'alu_r32_i8' : 'alu_m32_i8', {
      alu: m.reg,
      aluName: names[m.reg],
      dst: m.mod === 3 ? m.rmReg : -1,
      mem: m.mod === 3 ? null : m.mem,
      imm,
      len: pos - start,
    });
  }

  if (!p66 && op === 0xc1) {
    const m = parseModrm(buf, pos, end);
    if (!m || pos + m.len >= end) return mk('unknown', { len: fallbackLen(buf, start, va) });
    pos += m.len;
    const imm = buf[pos++];
    return mk(m.mod === 3 ? 'shift_r32_i8' : 'shift_m32_i8', {
      shift: m.reg,
      dst: m.mod === 3 ? m.rmReg : -1,
      mem: m.mod === 3 ? null : m.mem,
      imm,
      len: pos - start,
    });
  }

  if (!p66 && op >= 0x40 && op <= 0x47) return mk('inc_r32', { reg: op - 0x40 });
  if (!p66 && op >= 0x48 && op <= 0x4f) return mk('dec_r32', { reg: op - 0x48 });
  if (!p66 && op >= 0x70 && op <= 0x7f) {
    const disp = pos < end ? sx8(buf[pos]) : 0;
    const len = Math.min(2, end - start);
    return mk('jcc8', {
      cc: op & 0xf,
      len,
      fall: (va + len) >>> 0,
      target: (va + 2 + disp) >>> 0,
      text: `j${ccNames[op & 0xf]} ${hex((va + 2 + disp) >>> 0, 8)}`,
    });
  }

  if (op === 0x0f && pos < end) {
    const op2 = buf[pos++];
    if (!p66 && (op2 === 0xb6 || op2 === 0xbe || op2 === 0xb7 || op2 === 0xbf)) {
      const m = parseModrm(buf, pos, end);
      if (!m) return mk('unknown', { len: fallbackLen(buf, start, va) });
      pos += m.len;
      const sx = op2 === 0xbe || op2 === 0xbf;
      const bits = op2 === 0xb6 || op2 === 0xbe ? 8 : 16;
      return mk(`${sx ? 'movsx' : 'movzx'}${bits}`, {
        dst: m.reg,
        src: m.mod === 3 ? m.rmReg : -1,
        mem: m.mod === 3 ? null : m.mem,
        len: pos - start,
      });
    }
    if (op2 >= 0x80 && op2 <= 0x8f) {
      const disp = pos + 4 <= end ? sx32(buf.readUInt32LE(pos)) : 0;
      const len = Math.min(6, end - start);
      return mk('jcc32', {
        cc: op2 & 0xf,
        len,
        fall: (va + len) >>> 0,
        target: (va + 6 + disp) >>> 0,
        text: `j${ccNames[op2 & 0xf]} ${hex((va + 6 + disp) >>> 0, 8)}`,
      });
    }
  }

  return mk('unknown', { len: Math.min(fallbackLen(buf, start, va), end - start), op: buf[opOff] });
}

function addCount(map, key, n = 1) {
  map[key] = (map[key] || 0) + n;
}

function addExample(examples, key, item) {
  if (!examples[key]) examples[key] = [];
  if (examples[key].length < 5) examples[key].push(item);
}

function addHotCount(hot, key, weight) {
  hot.counts[key] = (hot.counts[key] || 0) + weight;
  hot.sites[key] = (hot.sites[key] || 0) + 1;
}

function usesRegInLeaMem(mem, reg) {
  return !!mem && (mem.base === reg || mem.index === reg);
}

function addUsesReg(ins, reg) {
  if (!ins) return false;
  if ((ins.kind === 'add_r32_rm32' || ins.kind === 'sub_r32_rm32') && ins.src === reg) return true;
  if ((ins.kind === 'add_rm32_r32' || ins.kind === 'sub_rm32_r32') && ins.src === reg) return true;
  if ((ins.kind === 'alu_r32_r32' || ins.kind === 'alu_r32_m32' || ins.kind === 'alu_m32_r32') && ins.src === reg) return true;
  return false;
}

function isJcc(ins) {
  return !!ins && (ins.kind === 'jcc8' || ins.kind === 'jcc32');
}

function isSignedJcc(ins) {
  return isJcc(ins) && ins.cc >= 12 && ins.cc <= 15;
}

function fullFlagWriter(ins) {
  if (!ins) return false;
  if (ins.kind === 'cmp_r32_r32' || ins.kind === 'cmp_r32_m32' || ins.kind === 'cmp_m32_r32') return true;
  if (ins.kind === 'test_r32_r32' || ins.kind === 'test_m32_r32') return true;
  if (ins.kind === 'xor_zero' || ins.kind === 'xor_rr') return true;
  if (ins.kind === 'add_r32_rm32' || ins.kind === 'add_rm32_r32') return true;
  if (ins.kind === 'sub_r32_rm32' || ins.kind === 'sub_rm32_r32') return true;
  if (ins.kind === 'alu_r32_r32' || ins.kind === 'alu_r32_m32' || ins.kind === 'alu_m32_r32') {
    return ins.alu !== 2 && ins.alu !== 3; // ADC/SBB read CF before writing flags.
  }
  if (ins.kind === 'alu_r32_i8' || ins.kind === 'alu_m32_i8') {
    return ins.alu !== 2 && ins.alu !== 3; // ADC/SBB read CF before writing flags.
  }
  return false;
}

function flagReaderBeforeWrite(ins) {
  if (!ins) return false;
  if (isJcc(ins)) return true;
  if ((ins.kind === 'alu_r32_r32' || ins.kind === 'alu_r32_m32' || ins.kind === 'alu_m32_r32') && (ins.alu === 2 || ins.alu === 3)) return true;
  if ((ins.kind === 'alu_r32_i8' || ins.kind === 'alu_m32_i8') && (ins.alu === 2 || ins.alu === 3)) return true;
  return false;
}

function isControlBoundary(ins) {
  return !ins || isJcc(ins) || ins.kind === 'unknown';
}

function flagPathState(ins, startIndex, maxInsns = 8) {
  if (startIndex < 0 || startIndex >= ins.length) return 'unknown';
  for (let i = startIndex; i < ins.length && i < startIndex + maxInsns; i++) {
    const cur = ins[i];
    if (flagReaderBeforeWrite(cur)) return 'read';
    if (fullFlagWriter(cur)) return 'dead';
    if (isControlBoundary(cur)) return 'unknown';
  }
  return 'unknown';
}

function classifyFlagPair(ins, i, byVa) {
  const b = ins[i + 1];
  const fallState = flagPathState(ins, i + 2);
  const targetIndex = byVa.has(b.target) ? byVa.get(b.target) : -1;
  const targetState = flagPathState(ins, targetIndex);
  return {
    fallState,
    targetState,
    flagsDead: fallState === 'dead' && targetState === 'dead',
  };
}

function addCmpMemJccCount(counts, examples, a, b, ins, i, byVa) {
  addCount(counts, 'seq.cmp-r-mem-jcc');
  if (simpleBase(a.mem)) addCount(counts, 'seq.cmp-r-mem-jcc-simple-base');
  if (isSignedJcc(b)) addCount(counts, 'seq.cmp-r-mem-signed-jcc');
  const cls = classifyFlagPair(ins, i, byVa);
  if (cls.flagsDead) {
    addCount(counts, 'seq.cmp-r-mem-jcc-flag-dead');
    if (simpleBase(a.mem) && isSignedJcc(b)) addCount(counts, 'seq.cmp-r-mem-signed-jcc-simple-base-flag-dead');
  }
  addExample(
    examples,
    'seq.cmp-r-mem-jcc',
    `${hex(a.va, 8)} ${a.text}; ${b.text}; fall=${cls.fallState} target=${cls.targetState}`
  );
}

function addTestRegJccCount(counts, examples, a, b, ins, i, byVa) {
  addCount(counts, 'seq.test-r-r-jcc');
  if (a.dst === a.src) addCount(counts, 'seq.test-r-self-jcc');
  const cls = classifyFlagPair(ins, i, byVa);
  if (cls.flagsDead) {
    addCount(counts, 'seq.test-r-r-jcc-flag-dead');
    if (a.dst === a.src) addCount(counts, 'seq.test-r-self-jcc-flag-dead');
  }
  addExample(
    examples,
    'seq.test-r-r-jcc',
    `${hex(a.va, 8)} test ${regName(a.dst)},${regName(a.src)}; ${b.text}; fall=${cls.fallState} target=${cls.targetState}`
  );
}

function analyzeHotBlocks(profile, allIns, byVa, examples, limit) {
  const top = profile && profile.handlerHistogram && profile.handlerHistogram.hotBlocks
    ? profile.handlerHistogram.hotBlocks.top || []
    : [];
  const totalBlocks = profile && profile.handlerHistogram && profile.handlerHistogram.hotBlocks
    ? profile.handlerHistogram.hotBlocks.totalBlocks || 0
    : 0;
  const hot = {
    profileFile: profile && profile.__file || '',
    totalBlocks,
    inputBlocks: top.length,
    usedBlocks: 0,
    skippedBlocks: 0,
    coveredWeight: 0,
    counts: Object.create(null),
    sites: Object.create(null),
    examples: Object.create(null),
  };
  for (const row of top.slice(0, limit)) {
    const va = row.addr >>> 0;
    if (!byVa.has(va)) {
      hot.skippedBlocks++;
      continue;
    }
    hot.usedBlocks++;
    hot.coveredWeight += row.count || 0;
    const start = byVa.get(va);
    for (let i = start; i < allIns.length && i < start + 48; i++) {
      const a = allIns[i];
      const b = allIns[i + 1];
      if (!a) break;
      if (a.kind === 'cmp_r32_m32' && isJcc(b)) {
        const cls = classifyFlagPair(allIns, i, byVa);
        addHotCount(hot, 'cmp-r-mem-jcc', row.count || 0);
        if (simpleBase(a.mem)) addHotCount(hot, 'cmp-r-mem-jcc-simple-base', row.count || 0);
        if (isSignedJcc(b)) addHotCount(hot, 'cmp-r-mem-signed-jcc', row.count || 0);
        if (cls.flagsDead) {
          addHotCount(hot, 'cmp-r-mem-jcc-flag-dead', row.count || 0);
          if (simpleBase(a.mem) && isSignedJcc(b)) addHotCount(hot, 'cmp-r-mem-signed-jcc-simple-base-flag-dead', row.count || 0);
        }
        addExample(
          hot.examples,
          'cmp-r-mem-jcc',
          `${hex(a.va, 8)} weight=${row.count} ${a.text}; ${b.text}; fall=${cls.fallState} target=${cls.targetState}`
        );
      }
      if (a.kind === 'test_r32_r32' && isJcc(b)) {
        const cls = classifyFlagPair(allIns, i, byVa);
        addHotCount(hot, 'test-r-r-jcc', row.count || 0);
        if (a.dst === a.src) addHotCount(hot, 'test-r-self-jcc', row.count || 0);
        if (cls.flagsDead) {
          addHotCount(hot, 'test-r-r-jcc-flag-dead', row.count || 0);
          if (a.dst === a.src) addHotCount(hot, 'test-r-self-jcc-flag-dead', row.count || 0);
        }
        addExample(
          hot.examples,
          'test-r-r-jcc',
          `${hex(a.va, 8)} weight=${row.count} test ${regName(a.dst)},${regName(a.src)}; ${b.text}; fall=${cls.fallState} target=${cls.targetState}`
        );
      }
      if (isControlBoundary(a)) break;
    }
  }
  return hot;
}

function scanFile(file, opts = {}) {
  const pe = parsePe(file);
  const counts = Object.create(null);
  const examples = Object.create(null);
  let instructionCount = 0;
  const sectionStats = [];
  const allIns = [];
  const allByVa = new Map();

  for (const sec of pe.sections) {
    const end = sec.rawOff + sec.rawSize;
    let off = sec.rawOff;
    let va = sec.va;
    const ins = [];
    while (off < end) {
      const decoded = decodeAt(pe.buf, off, va, end);
      if (!decoded || decoded.len <= 0) break;
      ins.push(decoded);
      allByVa.set(decoded.va, allIns.length);
      allIns.push(decoded);
      off += decoded.len;
      va = (va + decoded.len) >>> 0;
    }
    instructionCount += ins.length;
    sectionStats.push({ name: sec.name, instructions: ins.length });
    const byVa = new Map(ins.map((decoded, index) => [decoded.va, index]));

    for (let i = 0; i < ins.length; i++) {
      const a = ins[i];
      addCount(counts, 'kind.' + a.kind);

      if (a.kind === 'xor_zero') addCount(counts, 'xor-zero');
      if (a.mem && simpleBase(a.mem)) addCount(counts, 'simple-base-mem-op');
      if (a.mem && espRelative(a.mem)) addCount(counts, 'esp-relative-mem-op');
      if (a.kind === 'mov_r32_m32' && espRelative(a.mem)) addCount(counts, 'esp-load32');
      if (a.kind === 'mov_m32_r32' && espRelative(a.mem)) addCount(counts, 'esp-store32');
      if (a.kind === 'mov_r8_m8' && espRelative(a.mem)) addCount(counts, 'esp-load8');
      if (a.kind === 'mov_m8_r8' && espRelative(a.mem)) addCount(counts, 'esp-store8');
      if ((a.kind === 'add_r32_rm32' || a.kind === 'sub_r32_rm32' || a.kind === 'test_m32_r32') && espRelative(a.mem)) {
        addCount(counts, 'esp-alu-test');
      }
      if (a.kind === 'lea' && a.mem) {
        if (a.mem.index >= 0) {
          addCount(counts, 'lea-sib');
          if (!a.mem.disp) addCount(counts, 'lea-sib-no-disp');
        } else if (a.mem.base >= 0) {
          addCount(counts, 'lea-base-disp');
        }
      }

      const b = ins[i + 1];
      const c = ins[i + 2];
      const d = ins[i + 3];
      if (a.kind === 'xor_zero' && b && b.kind === 'mov_r8_m8' && byteLowRegMatchesFull(b.dst, a.reg)) {
        addCount(counts, 'seq.zero-load8');
        addExample(examples, 'seq.zero-load8', `${hex(a.va, 8)} ${a.text}; ${b.text}`);
        if (c && addUsesReg(c, a.reg)) {
          addCount(counts, 'seq.zero-load8-alu');
          addExample(examples, 'seq.zero-load8-alu', `${hex(a.va, 8)} ${a.text}; ${b.text}; ${c.kind}`);
        }
        if (c && c.kind === 'lea' && usesRegInLeaMem(c.mem, a.reg)) {
          addCount(counts, 'seq.zero-load8-lea');
          addExample(examples, 'seq.zero-load8-lea', `${hex(a.va, 8)} ${a.text}; ${b.text}; ${c.text}`);
        }
      }
      if (a.kind === 'mov_r8_m8' && b && b.kind === 'mov_m8_r8' && a.dst === b.src) {
        addCount(counts, 'seq.load8-store8');
        addExample(examples, 'seq.load8-store8', `${hex(a.va, 8)} ${a.text}; ${b.text}`);
      }
      if (a.kind === 'test_r32_r32' && a.dst === a.src &&
          b && b.kind === 'lea' && b.mem && b.mem.base === a.dst && b.mem.index < 0 && b.mem.disp === -1 &&
          c && c.kind === 'mov_m32_r32' && c.src === b.dst &&
          d && (d.kind === 'jcc8' || d.kind === 'jcc32')) {
        addCount(counts, 'seq.test-lea-store-jcc');
        addExample(examples, 'seq.test-lea-store-jcc', `${hex(a.va, 8)} test ${regName(a.dst)}, ${regName(a.src)}; ${b.text}; ${c.text}; ${d.kind}`);
      }
      if (a.kind === 'mov_r32_m32' && a.mem && espRelative(a.mem) &&
          b && (b.kind === 'add_r32_rm32' || b.kind === 'sub_r32_rm32' || b.kind === 'alu_r32_i8') && (b.dst === a.dst || b.src === a.dst)) {
        addCount(counts, 'seq.esp-load-alu');
        addExample(examples, 'seq.esp-load-alu', `${hex(a.va, 8)} ${a.text}; ${b.kind}`);
      }
      if (a.kind === 'cmp_r32_m32' && b && isJcc(b)) {
        addCmpMemJccCount(counts, examples, a, b, ins, i, byVa);
      }
      if (a.kind === 'test_r32_r32' && b && isJcc(b)) {
        addTestRegJccCount(counts, examples, a, b, ins, i, byVa);
      }
    }
  }

  const report = {
    file,
    imageBase: pe.imageBase,
    sections: sectionStats,
    instructionCount,
    counts,
    examples,
    hot: opts.profile ? analyzeHotBlocks(opts.profile, allIns, allByVa, examples, opts.hotLimit || 120) : null,
  };
  if (opts.includeInstructions) {
    report.instructions = allIns;
    report.byVa = allByVa;
  }
  return report;
}

function pct(part, whole) {
  if (!whole) return '0.0%';
  return (100 * part / whole).toFixed(1) + '%';
}

function lineCount(label, counts, key, total) {
  const v = counts[key] || 0;
  const suffix = total ? ` (${pct(v, total)})` : '';
  return `  ${label.padEnd(28)} ${String(v).padStart(7)}${suffix}`;
}

function hotLine(label, hot, key) {
  const v = hot.counts[key] || 0;
  const sites = hot.sites[key] || 0;
  const share = hot.coveredWeight ? ` (${pct(v, hot.coveredWeight)} of covered)` : '';
  return `  ${label.padEnd(34)} ${String(Math.round(v)).padStart(10)}  sites=${String(sites).padStart(4)}${share}`;
}

function printReport(report) {
  const c = report.counts;
  console.log(`\n${path.basename(report.file)} (${report.file})`);
  console.log(`  image base: ${hex(report.imageBase, 8)}`);
  console.log(`  decoded executable-section instructions: ${report.instructionCount}`);
  if (report.sections.length) {
    console.log('  sections: ' + report.sections.map(s => `${s.name}:${s.instructions}`).join(', '));
  }
  console.log('\nCandidate instruction families:');
  console.log(lineCount('xor zero reg', c, 'xor-zero', report.instructionCount));
  console.log(lineCount('simple base mem ops', c, 'simple-base-mem-op', report.instructionCount));
  console.log(lineCount('ESP-relative mem ops', c, 'esp-relative-mem-op', report.instructionCount));
  console.log(lineCount('ESP load32', c, 'esp-load32', report.instructionCount));
  console.log(lineCount('ESP store32', c, 'esp-store32', report.instructionCount));
  console.log(lineCount('LEA SIB', c, 'lea-sib', report.instructionCount));
  console.log(lineCount('LEA SIB no disp', c, 'lea-sib-no-disp', report.instructionCount));

  console.log('\nAdjacent sequence candidates:');
  console.log(lineCount('xor; mov low8,[mem]', c, 'seq.zero-load8'));
  console.log(lineCount('xor; mov low8; alu', c, 'seq.zero-load8-alu'));
  console.log(lineCount('xor; mov low8; lea', c, 'seq.zero-load8-lea'));
  console.log(lineCount('mov r8,[mem]; mov [mem],r8', c, 'seq.load8-store8'));
  console.log(lineCount('test; lea -1; store; jcc', c, 'seq.test-lea-store-jcc'));
  console.log(lineCount('ESP load32; ALU', c, 'seq.esp-load-alu'));
  console.log(lineCount('cmp r,[mem]; jcc', c, 'seq.cmp-r-mem-jcc'));
  console.log(lineCount('cmp r,[base+disp]; jcc', c, 'seq.cmp-r-mem-jcc-simple-base'));
  console.log(lineCount('cmp r,[mem]; signed jcc', c, 'seq.cmp-r-mem-signed-jcc'));
  console.log(lineCount('cmp r,[mem]; jcc flags dead', c, 'seq.cmp-r-mem-jcc-flag-dead'));
  console.log(lineCount('cmp r,[base]; signed dead', c, 'seq.cmp-r-mem-signed-jcc-simple-base-flag-dead'));
  console.log(lineCount('test r,r; jcc', c, 'seq.test-r-r-jcc'));
  console.log(lineCount('test r,r; jcc flags dead', c, 'seq.test-r-r-jcc-flag-dead'));
  console.log(lineCount('test r,r self; dead', c, 'seq.test-r-self-jcc-flag-dead'));

  for (const key of [
    'seq.zero-load8',
    'seq.zero-load8-alu',
    'seq.zero-load8-lea',
    'seq.load8-store8',
    'seq.test-lea-store-jcc',
    'seq.cmp-r-mem-jcc',
    'seq.test-r-r-jcc',
  ]) {
    const ex = report.examples[key] || [];
    if (!ex.length) continue;
    console.log(`\nExamples for ${key}:`);
    for (const line of ex) console.log('  ' + line);
  }

  if (report.hot) {
    const h = report.hot;
    console.log('\nHot-block weighted threaded-IR candidates:');
    console.log(`  profile: ${h.profileFile}`);
    console.log(`  hot blocks used: ${h.usedBlocks}/${h.inputBlocks}, skipped=${h.skippedBlocks}`);
    console.log(`  covered block entries: ${Math.round(h.coveredWeight)} of ${h.totalBlocks} (${pct(h.coveredWeight, h.totalBlocks)})`);
    console.log(hotLine('cmp r,[mem]; jcc', h, 'cmp-r-mem-jcc'));
    console.log(hotLine('cmp r,[base+disp]; jcc', h, 'cmp-r-mem-jcc-simple-base'));
    console.log(hotLine('cmp r,[mem]; signed jcc', h, 'cmp-r-mem-signed-jcc'));
    console.log(hotLine('cmp r,[mem]; jcc flags dead', h, 'cmp-r-mem-jcc-flag-dead'));
    console.log(hotLine('cmp r,[base]; signed dead', h, 'cmp-r-mem-signed-jcc-simple-base-flag-dead'));
    console.log(hotLine('test r,r; jcc', h, 'test-r-r-jcc'));
    console.log(hotLine('test r,r; jcc flags dead', h, 'test-r-r-jcc-flag-dead'));
    console.log(hotLine('test r,r self; dead', h, 'test-r-self-jcc-flag-dead'));
    for (const key of ['cmp-r-mem-jcc', 'test-r-r-jcc']) {
      const ex = h.examples[key] || [];
      if (!ex.length) continue;
      console.log(`\nHot examples for ${key}:`);
      for (const line of ex) console.log('  ' + line);
    }
  }
}

function main() {
  const args = process.argv.slice(2);
  const files = [];
  let profile = null;
  let hotLimit = 120;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--profile=')) {
      const file = arg.slice('--profile='.length);
      profile = JSON.parse(fs.readFileSync(file, 'utf8'));
      profile.__file = file;
      continue;
    }
    if (arg === '--profile' && i + 1 < args.length) {
      const file = args[++i];
      profile = JSON.parse(fs.readFileSync(file, 'utf8'));
      profile.__file = file;
      continue;
    }
    if (arg.startsWith('--hot-limit=')) {
      hotLimit = parseInt(arg.slice('--hot-limit='.length), 10) || hotLimit;
      continue;
    }
    files.push(arg);
  }
  const targets = files.length ? files : [
    'test/binaries/plugins/candidates/vis_w.dll',
    'test/binaries/plugins/in_mp3.dll',
  ];
  for (const file of targets) {
    printReport(scanFile(file, { profile, hotLimit }));
  }
}

if (require.main === module) main();

module.exports = { scanFile };
