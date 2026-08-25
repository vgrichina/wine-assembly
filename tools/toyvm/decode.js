'use strict';

// x86-16 -> threaded code, in JS.
//
// The decoder is deliberately on the HOST side rather than in wasm. Every
// dispatch variant consumes the identical op stream produced here, so decode
// cost is outside the measurement entirely and the only thing differing between
// builds is how control moves from one handler to the next. That is a cleaner
// isolation than our production interpreter can offer, where decode and
// dispatch share a module.

const isa = require('./isa');
const { HANDLERS } = require('./emit');

const H = {};
for (const x of HANDLERS) H[x.name] = x.index;

const SEG_PREFIX = { 0x26: 0, 0x2E: 1, 0x36: 2, 0x3E: 3, 0x64: 4, 0x65: 5 };

// x86 lays the ALU group out at 8*code + form.
// Note the fast path below tests (op & 7) < 6, which is what keeps the
// non-ALU opcodes that share the 8*code block -- PUSH/POP seg at x6/x7 and
// DAA/AAA at x7 -- from being decoded as arithmetic.
const ALU_BY_CODE = {
  0: 'add', 1: 'or', 2: 'adc', 3: 'sbb', 4: 'and', 5: 'sub', 6: 'xor', 7: 'cmp',
};

// Jcc condition names in opcode order, 70..7F. Same order as x86's tttn field.
const CC_NAMES = ['o', 'no', 'b', 'ae', 'z', 'nz', 'be', 'a',
  's', 'ns', 'p', 'np', 'l', 'ge', 'le', 'g'];

// Which CPU the decoder is pretending to be. The SingleStepTests corpus is
// recorded off an 8088, so conformance runs must stay at 8086 level or they
// will "pass" instructions the real part does not have. Demos, on the other
// hand, routinely assume a 186 or later, so the runner raises it.
// Levels are the bare model numbers -- 86, 186, 386 -- so `cpuLevel < 186`
// reads the way it should. (Writing 8086 for the base level made that test
// false and let every 80186 encoding through.)
let cpuLevel = 86;
function setCpuLevel(n) { cpuLevel = n; }

// Decode exactly one instruction at cs:ip. `rd` reads one physical byte.
// Returns { words, nextIp } or null if the opcode is not implemented yet --
// partial coverage is the honest state of this thing and callers report it.
function decodeOne(rd, cs, ip) {
  const start = ip;
  const at = (n) => rd((((cs << 4) + ((start + n) & 0xFFFF)) & 0xFFFFF));
  let n = 0;
  let segOverride = null;
  let repPrefix = null;   // 'rep' (F3) or 'repne' (F2)
  // In a 16-bit code segment the default operand size is 16 and 0x66 flips it
  // to 32. Real-mode 386 demos use that constantly -- fixed-point maths in
  // 32-bit registers while addressing stays 16-bit.
  let opsize = 16;

  // Prefixes. A segment override and a repeat prefix can both be present, and
  // on this part the LAST one of each kind wins.
  for (;;) {
    const b = at(n);
    // FS/GS overrides only exist from the 386 on; on an 8088 those two bytes
    // are conditional-jump aliases, so consuming them as prefixes there would
    // swallow real instructions.
    if (SEG_PREFIX[b] !== undefined && (b < 0x64 || cpuLevel >= 386)) segOverride = SEG_PREFIX[b];
    else if (b === 0x66 && cpuLevel >= 386) opsize = 32;
    else if (b === 0x67 && cpuLevel >= 386) return null;   // 32-bit addressing: SIB, not modelled
    else if (b === 0xF3) repPrefix = 'rep';
    else if (b === 0xF2) repPrefix = 'repne';
    else if (b === 0xF0) { /* LOCK: no effect with one core */ }
    else break;
    n++;
    if (n > 8) return null;   // prefix soup, not something the corpus produces
  }

  const op = at(n); n++;
  // A repeat prefix on anything but a string op does something the 8086 defines
  // only by accident. Refusing the encoding keeps the gate honest instead of
  // silently executing the unprefixed instruction and calling it a pass.
  const repeatable = (op >= 0xA4 && op <= 0xAF && op !== 0xA8 && op !== 0xA9)
    || (cpuLevel >= 186 && op >= 0x6C && op <= 0x6F);
  if (repPrefix && !repeatable) return null;
  const words = [];
  // Arena addresses are not known until every block is laid out, so branch
  // handlers get a 0 placeholder and a fixup naming the guest IP it stands for.
  // tools/toyvm/compile.js resolves them; the gate leaves them 0, which the
  // handlers read as "hand control back".
  const fixups = [];
  let endsBlock = false;

  function modrm() {
    const m = at(n); n++;
    const mod = m >> 6, reg = (m >> 3) & 7, rm = m & 7;
    if (mod === 3) return { isReg: true, reg, rm };
    let kind = rm, disp = 0;
    if (mod === 0 && rm === 6) {
      kind = isa.EA.DISP;
      disp = at(n) | (at(n + 1) << 8); n += 2;
    } else if (mod === 1) {
      disp = at(n); n++;
      if (disp & 0x80) disp -= 0x100;          // disp8 is signed
    } else if (mod === 2) {
      disp = at(n) | (at(n + 1) << 8); n += 2;
    }
    const seg = segOverride === null ? isa.EA_DEFAULT_SEG[kind] : segOverride;
    return { isReg: false, reg, kind, disp: disp & 0xFFFF, seg };
  }

  // Bits 0-3 EA form, 4-6 segment (six of them once FS/GS exist), 8-10 the
  // ModRM reg field.
  const packEa = (m) => (m.kind & 15) | ((m.seg & 7) << 4) | ((m.reg & 7) << 8);
  const imm8 = () => { const v = at(n); n++; return v; };
  const imm16 = () => { const v = at(n) | (at(n + 1) << 8); n += 2; return v; };
  const imm32 = () => {
    const v = at(n) | (at(n + 1) << 8) | (at(n + 2) << 16) | (at(n + 3) << 24);
    n += 4; return v | 0;
  };
  const sx8to16 = (v) => (v & 0x80 ? v - 0x100 : v) & 0xFFFF;
  // The immediate that follows the operand size: two bytes normally, four
  // behind a 0x66 prefix. Every "imm16" in the 8086 manual is really this.
  const immW = () => (opsize === 32 ? imm32() : imm16());
  const sx8toW = (v) => (opsize === 32 ? ((v & 0x80 ? v - 0x100 : v) | 0) : sx8to16(v));

  // The ALU group and MOV share these five operand shapes exactly, so emitting
  // them goes through one place.
  function emitRmR(name, w, m, dstIsRm) {
    if (m.isReg) {
      words.push(H[`${name}_rr${w}`],
        dstIsRm ? (m.rm & 7) | ((m.reg & 7) << 4) : (m.reg & 7) | ((m.rm & 7) << 4));
    } else {
      words.push(H[`${name}_${dstIsRm ? 'mr' : 'rm'}${w}`], packEa(m), m.disp);
    }
  }
  function emitRmI(name, w, m, imm) {
    if (m.isReg) words.push(H[`${name}_ri${w}`], m.rm & 7, imm);
    else words.push(H[`${name}_mi${w}`], packEa(m), m.disp, imm);
  }

  // --- ALU group: 8*code + form, forms 0..5 ---------------------------------
  if (op < 0x40 && (op & 7) < 6 && ALU_BY_CODE[op >> 3] !== undefined) {
    const name = ALU_BY_CODE[op >> 3];
    const form = op & 7;
    if (form <= 3) {
      const w = (form & 1) ? opsize : 8;
      emitRmR(name, w, modrm(), form < 2);
    } else if (form === 4) {
      words.push(H[`${name}_ri8`], 0, imm8());          // AL
    } else {
      words.push(H[`${name}_ri${opsize}`], 0, immW());  // AX / EAX
    }
  } else switch (op) {
    // --- ALU with immediate, group 80/81/83 ---------------------------------
    // The op comes from the ModRM reg field rather than the opcode. 83 is the
    // sign-extended-imm8 form, which is what compilers emit for small
    // constants and is therefore everywhere in real code.
    // 0x82 is an undocumented alias of 0x80 -- same r/m8, imm8 encoding. Real
    // assemblers of the era emitted it, so the corpus contains it.
    case 0x80: case 0x82: case 0x81: case 0x83: {
      const m = modrm();
      const name = ALU_BY_CODE[m.reg];
      if (name === undefined) return null;
      if (op === 0x80 || op === 0x82) emitRmI(name, 8, m, imm8());
      else if (op === 0x81) emitRmI(name, opsize, m, immW());
      else emitRmI(name, opsize, m, sx8toW(imm8()));
      break;
    }

    // --- MOV r/m, r and r, r/m ----------------------------------------------
    case 0x88: emitRmR('mov', 8, modrm(), true); break;
    case 0x89: emitRmR('mov', opsize, modrm(), true); break;
    case 0x8A: emitRmR('mov', 8, modrm(), false); break;
    case 0x8B: emitRmR('mov', opsize, modrm(), false); break;

    // --- MOV r/m, imm -------------------------------------------------------
    case 0xC6: { const m = modrm(); emitRmI('mov', 8, m, imm8()); break; }
    case 0xC7: { const m = modrm(); emitRmI('mov', opsize, m, immW()); break; }

    // --- Conditional jumps, 70-7F ------------------------------------------
    // rel8 is measured from the END of the instruction, so the target can only
    // be computed after the displacement byte is consumed.
    // 0x60-0x6F alias to the same sixteen jumps on an 8088 -- it decodes the
    // condition from the low nibble and ignores bit 4. Those opcodes only
    // become PUSH/IMUL/INS/OUTS on an 80186, so which meaning applies is a
    // cpuLevel question, handled at the 0x68/0x6A cases below.
    case 0x60: case 0x61: case 0x62: case 0x63:
    case 0x64: case 0x65: case 0x66: case 0x67:
    case 0x69: case 0x6B:
    case 0x6C: case 0x6D: case 0x6E: case 0x6F:
    case 0x70: case 0x71: case 0x72: case 0x73:
    case 0x74: case 0x75: case 0x76: case 0x77:
    case 0x78: case 0x79: case 0x7A: case 0x7B:
    case 0x7C: case 0x7D: case 0x7E: case 0x7F: {
      if (op < 0x70 && cpuLevel >= 186) {
        // On a 186 and later these are the string I/O instructions.
        if (op >= 0x6C && op <= 0x6F) {
          const w = (op & 1) ? 16 : 8;
          const sfx = w === 8 ? 'b' : 'w';
          const nm = (op < 0x6E ? 'ins' : 'outs') + sfx;
          const hn = repPrefix ? `rep_${nm}` : nm;
          words.push(H[hn], segOverride === null ? 3 : segOverride);
          break;
        }
        if (op === 0x60 || op === 0x61) {
          words.push(H[`${op === 0x60 ? 'pusha' : 'popa'}${opsize}`]);
          break;
        }
        if (op === 0x69 || op === 0x6B) {
          const m = modrm();
          const imm = op === 0x69 ? immW() : sx8toW(imm8());
          if (m.isReg) words.push(H[`imul3_rr${opsize}`], (m.rm & 7) | ((m.reg & 7) << 4), imm);
          else words.push(H[`imul3_rm${opsize}`], packEa(m), m.disp, imm);
          break;
        }
        return null;   // 62 BOUND
      }
      const d = imm8();
      const fall = (start + n) & 0xFFFF;
      const target = (fall + (d & 0x80 ? d - 0x100 : d)) & 0xFFFF;
      words.push(H[`j${CC_NAMES[op & 15]}`], 0, target, 0, fall);
      fixups.push({ index: words.length - 4, ip: target },
        { index: words.length - 2, ip: fall });
      endsBlock = true;
      break;
    }

    case 0xE2: {   // LOOP rel8
      const d = imm8();
      const fall = (start + n) & 0xFFFF;
      const target = (fall + (d & 0x80 ? d - 0x100 : d)) & 0xFFFF;
      words.push(H.loop, 0, target, 0, fall);
      fixups.push({ index: words.length - 4, ip: target },
        { index: words.length - 2, ip: fall });
      endsBlock = true;
      break;
    }

    case 0xEB: {   // JMP rel8
      const d = imm8();
      const target = (((start + n) & 0xFFFF) + (d & 0x80 ? d - 0x100 : d)) & 0xFFFF;
      words.push(H.jmp, 0, target);
      fixups.push({ index: words.length - 2, ip: target });
      endsBlock = true;
      break;
    }

    case 0xE9: {   // JMP rel16
      const d = imm16();
      const target = (((start + n) & 0xFFFF) + (d & 0x8000 ? d - 0x10000 : d)) & 0xFFFF;
      words.push(H.jmp, 0, target);
      fixups.push({ index: words.length - 2, ip: target });
      endsBlock = true;
      break;
    }

    // --- TEST ---------------------------------------------------------------
    case 0x84: emitRmR('test', 8, modrm(), true); break;
    case 0x85: emitRmR('test', opsize, modrm(), true); break;
    case 0xA8: words.push(H.test_ri8, 0, imm8()); break;
    case 0xA9: words.push(H[`test_ri${opsize}`], 0, immW()); break;

    // --- LEA, XCHG, segment moves ------------------------------------------
    case 0x8D: { const m = modrm(); if (m.isReg) return null;
      words.push(H[opsize === 32 ? 'lea32' : 'lea'], packEa(m), m.disp); break; }
    case 0x86: case 0x87: {
      const m = modrm(); const w = op === 0x87 ? opsize : 8;
      if (m.isReg) words.push(H[`xchg_rr${w}`], (m.rm & 7) | ((m.reg & 7) << 4));
      else words.push(H[`xchg_mr${w}`], packEa(m), m.disp);
      break;
    }
    // 8C/8E name a segment register in the ModRM reg field. An 8088 decodes
    // only two bits of it, so reg 4-7 wrap back onto ES/CS/SS/DS -- and the
    // corpus exercises exactly that. A 386 decodes three bits, where 6 and 7
    // name nothing.
    case 0x8C: case 0x8E: {
      const m = modrm();
      const sr = cpuLevel >= 386 ? (m.reg & 7) : (m.reg & 3);
      if (sr > 5) return null;
      const [rf, mf] = op === 0x8C ? ['mov_r_sr', 'mov_m_sr'] : ['mov_sr_r', 'mov_sr_m'];
      if (m.isReg) words.push(H[rf], (m.rm & 7) | (sr << 4));
      else words.push(H[mf], (packEa(m) & ~0x700) | (sr << 8), m.disp);
      break;
    }

    // --- Stack --------------------------------------------------------------
    case 0x9C: words.push(H.pushf); break;
    case 0x9D: words.push(H.popf); break;
    case 0x8F: { const m = modrm();
      if (m.isReg) words.push(H[`pop_r${opsize}`], m.rm & 7);
      else words.push(H[`pop_m${opsize}`], packEa(m), m.disp);
      break; }
    // PUSH imm is 80186 and later. The 8088 corpus records whatever the real
    // part does with these bytes, which is not a push, so they stay unknown at
    // 8086 level and only decode when the caller says the guest is newer.
    case 0x68: case 0x6A: {
      if (cpuLevel < 186) {                 // 8088: JS rel8 / JP rel8
        const d = imm8();
        const fall = (start + n) & 0xFFFF;
        const target = (fall + (d & 0x80 ? d - 0x100 : d)) & 0xFFFF;
        words.push(H[`j${CC_NAMES[op & 15]}`], 0, target, 0, fall);
        fixups.push({ index: words.length - 4, ip: target },
          { index: words.length - 2, ip: fall });
        endsBlock = true;
        break;
      }
      words.push(H[`push_i${opsize}`], op === 0x68 ? immW() : sx8toW(imm8()));
      break;
    }

    // --- CALL / RET ---------------------------------------------------------
    case 0xE8: {
      const d = imm16();
      const ret = (start + n) & 0xFFFF;
      const target = (ret + (d & 0x8000 ? d - 0x10000 : d)) & 0xFFFF;
      // [arenaTarget][guestTarget][retIp][arenaRet]. The return point is a
      // fixup like the target is, so the compiler compiles it and the shadow
      // stack gets a real address to resume at.
      words.push(H.call_rel, 0, target, ret, 0);
      fixups.push({ index: words.length - 4, ip: target },
        { index: words.length - 1, ip: ret });
      endsBlock = true;
      break;
    }
    case 0xC8:
      if (cpuLevel < 186) return null;
      words.push(H.enter, imm16(), imm8());
      break;
    case 0xC9:
      if (cpuLevel < 186) return null;
      words.push(H.leave);
      break;
    case 0xC3: words.push(H.ret); endsBlock = true; break;
    case 0xC2: words.push(H.ret_imm, imm16()); endsBlock = true; break;

    // --- Sign extend, flag ops ----------------------------------------------
    case 0x98: words.push(opsize === 32 ? H.cwde : H.cbw); break;
    case 0x99: words.push(opsize === 32 ? H.cdq : H.cwd); break;
    case 0x9E: words.push(H.sahf); break;
    case 0x9F: words.push(H.lahf); break;
    case 0xF5: words.push(H.cmc); break;
    case 0xF8: words.push(H.clc); break;
    case 0xF9: words.push(H.stc); break;
    case 0xFA: words.push(H.cli); break;
    case 0xFB: words.push(H.sti); break;
    case 0xFC: words.push(H.cld); break;
    case 0xFD: words.push(H.std); break;

    // --- Remaining counted-loop terminators ---------------------------------
    case 0xE0: case 0xE1: case 0xE3: {
      const d = imm8();
      const fall = (start + n) & 0xFFFF;
      const target = (fall + (d & 0x80 ? d - 0x100 : d)) & 0xFFFF;
      words.push(op === 0xE3 ? H.jcxz : (op === 0xE1 ? H.loopz : H.loopnz),
        0, target, 0, fall);
      fixups.push({ index: words.length - 4, ip: target },
        { index: words.length - 2, ip: fall });
      endsBlock = true;
      break;
    }

    // --- String ops, A4-AF ---------------------------------------------------
    // The operand is the SOURCE segment index. The destination is always ES on
    // this part and is not overridable, so it never appears in the op stream.
    // A repeat prefix selects a different handler entirely rather than being a
    // flag the handler tests -- one dispatch runs the whole run, which is the
    // whole point of having a folded form.
    case 0xA4: case 0xA5: case 0xA6: case 0xA7:
    case 0xAA: case 0xAB: case 0xAC: case 0xAD:
    case 0xAE: case 0xAF: {
      const w = (op & 1) ? opsize : 8;
      const sfx = { 8: 'b', 16: 'w', 32: 'd' }[w];
      const name = { 0xA4: 'movs', 0xA6: 'cmps', 0xAA: 'stos', 0xAC: 'lods', 0xAE: 'scas' }[op & ~1];
      const src = segOverride === null ? 3 : segOverride;   // DS by default
      let hn = `${name}${sfx}`;
      if (repPrefix) {
        // REP and REPE are the same encoding; for MOVS/STOS/LODS there is only
        // the one repeat form, so F2 and F3 both land on it.
        const isCompare = name === 'cmps' || name === 'scas';
        hn = `${isCompare ? repPrefix : 'rep'}_${hn}`;
      }
      if (H[hn] === undefined) return null;
      words.push(H[hn], src);
      break;
    }

    // --- MOV to/from a direct address ---------------------------------------
    case 0xA0: case 0xA1: case 0xA2: case 0xA3: {
      const w = (op & 1) ? opsize : 8;
      const off = imm16();
      const seg = segOverride === null ? 3 : segOverride;
      words.push(H[op < 0xA2 ? `mov_acc_moffs${w}` : `mov_moffs_acc${w}`], off, seg);
      break;
    }

    case 0xD7: words.push(H.xlat, segOverride === null ? 3 : segOverride); break;

    // --- Shifts and rotates --------------------------------------------------
    // D0/D1 shift by one, D2/D3 by CL. -1 is the operand sentinel for "read CL
    // at run time"; a literal count of 0xFFFF cannot occur, since the decoder
    // only ever writes 1 or the C0/C1 immediate.
    case 0xD0: case 0xD1: case 0xD2: case 0xD3:
    case 0xC0: case 0xC1: {
      if ((op === 0xC0 || op === 0xC1) && cpuLevel < 186) return null;
      const w = (op & 1) ? opsize : 8;
      const m = modrm();
      if (m.reg > 7) return null;
      const count = (op === 0xC0 || op === 0xC1) ? imm8()
        : (op < 0xD2 ? 1 : -1);
      if (m.isReg) words.push(H[`sh${m.reg}_r${w}`], m.rm & 7, count);
      else words.push(H[`sh${m.reg}_m${w}`], packEa(m), m.disp, count);
      break;
    }

    // --- Port I/O ------------------------------------------------------------
    // -1 in the port operand means "take it from DX", the same sentinel trick.
    case 0xE4: words.push(H.in_8, imm8()); break;
    case 0xE5: words.push(H.in_16, imm8()); break;
    case 0xE6: words.push(H.out_8, imm8()); break;
    case 0xE7: words.push(H.out_16, imm8()); break;
    case 0xEC: words.push(H.in_8, -1); break;
    case 0xED: words.push(H.in_16, -1); break;
    case 0xEE: words.push(H.out_8, -1); break;
    case 0xEF: words.push(H.out_16, -1); break;

    // --- Far control transfer ------------------------------------------------
    // Every one of these leaves the trace: the target segment is not knowable
    // at compile time, so the handler writes the guest IP and hands back.
    case 0xEA: { const o = imm16(), s = imm16(); words.push(H.jmp_far, o, s); endsBlock = true; break; }
    case 0x9A: {
      const o = imm16(), s = imm16();
      words.push(H.call_far, o, s, (start + n) & 0xFFFF);
      endsBlock = true; break;
    }
    case 0xCB: words.push(H.retf); endsBlock = true; break;
    case 0xCA: words.push(H.retf_imm, imm16()); endsBlock = true; break;

    // --- LES / LDS -----------------------------------------------------------
    case 0xC4: case 0xC5: {
      const m = modrm();
      if (m.isReg) return null;   // undefined encoding
      words.push(H[op === 0xC4 ? 'les' : 'lds'], packEa(m), m.disp);
      break;
    }

    // --- 0F: the 80386 two-byte opcodes -------------------------------------
    case 0x0F: {
      if (cpuLevel < 386) return null;   // 0F is POP CS on an 8088
      const op2 = at(n); n++;
      if (op2 >= 0x80 && op2 <= 0x8F) {          // Jcc rel16
        const d = imm16();
        const fall = (start + n) & 0xFFFF;
        const target = (fall + (d & 0x8000 ? d - 0x10000 : d)) & 0xFFFF;
        words.push(H[`j${CC_NAMES[op2 & 15]}`], 0, target, 0, fall);
        fixups.push({ index: words.length - 4, ip: target },
          { index: words.length - 2, ip: fall });
        endsBlock = true;
        break;
      }
      if (op2 >= 0x90 && op2 <= 0x9F) {          // SETcc r/m8
        const m = modrm();
        const cc = CC_NAMES[op2 & 15];
        if (m.isReg) words.push(H[`set_${cc}_r8`], m.rm & 7);
        else words.push(H[`set_${cc}_m8`], packEa(m), m.disp);
        break;
      }
      if (op2 === 0xB6 || op2 === 0xBE || op2 === 0xB7 || op2 === 0xBF) {
        // MOVZX/MOVSX. Source width from the opcode, destination width from the
        // operand-size prefix. The 16-bit-source forms only make sense with a
        // 32-bit destination, but the encoding exists either way.
        const nm = (op2 === 0xB6 || op2 === 0xB7) ? 'movzx' : 'movsx';
        const sw = (op2 & 1) ? 16 : 8;
        const m = modrm();
        if (m.isReg) words.push(H[`${nm}${sw}_rr${opsize}`], (m.rm & 7) | ((m.reg & 7) << 4));
        else words.push(H[`${nm}${sw}_rm${opsize}`], packEa(m), m.disp);
        break;
      }
      if (op2 === 0xA4 || op2 === 0xA5 || op2 === 0xAC || op2 === 0xAD) {
        // SHLD/SHRD. The even opcode takes an imm8 count, the odd one takes CL,
        // which is passed as the -1 sentinel the single shifts already use.
        const nm = (op2 & 0x08) ? 'shrd' : 'shld';
        const m = modrm();
        const cnt = () => ((op2 & 1) ? -1 : imm8());
        if (m.isReg) words.push(H[`${nm}_r${opsize}`], (m.rm & 7) | ((m.reg & 7) << 4), cnt());
        else words.push(H[`${nm}_m${opsize}`], packEa(m), m.disp, cnt());
        break;
      }
      if (op2 === 0xA0 || op2 === 0xA8) { words.push(H.push_seg, op2 === 0xA0 ? 4 : 5); break; }
      if (op2 === 0xA1 || op2 === 0xA9) { words.push(H.pop_seg, op2 === 0xA1 ? 4 : 5); break; }
      return null;
    }

    // --- INT ----------------------------------------------------------------
    case 0xCD: { const v = imm8(); words.push(H.int_imm, v, (start + n) & 0xFFFF); endsBlock = true; break; }
    // INT3 is the one-byte breakpoint form of INT 3.
    case 0xCC: words.push(H.int_imm, 3, (start + n) & 0xFFFF); endsBlock = true; break;
    // INTO only takes the vector when OF is set, so it does not end the block:
    // the fall-through is the common case and stays in the same trace.
    case 0xCE: words.push(H.into, (start + n) & 0xFFFF); break;
    case 0xCF: words.push(H.iret); endsBlock = true; break;

    // --- BCD / ASCII adjust --------------------------------------------------
    case 0x27: words.push(H.daa); break;
    case 0x2F: words.push(H.das); break;
    case 0x37: words.push(H.aaa); break;
    case 0x3F: words.push(H.aas); break;
    case 0xD4: words.push(H.aam, imm8(), (start + n) & 0xFFFF); break;
    case 0xD5: words.push(H.aad, imm8()); break;
    // SALC: undocumented, no operands, sets AL from CF.
    case 0xD6: words.push(H.salc); break;

    // --- Unary group F6/F7 --------------------------------------------------
    // /0 and /1 are both TEST with an immediate; /2 NOT; /3 NEG; /4../7 the
    // widening multiply and divide.
    case 0xF6: case 0xF7: {
      const w = op === 0xF7 ? opsize : 8;
      const m = modrm();
      if (m.reg === 0 || m.reg === 1) {
        const imm = w === 8 ? imm8() : immW();
        emitRmI('test', w, m, imm);
      } else if (m.reg === 2 || m.reg === 3) {
        const nm = m.reg === 2 ? 'not' : 'neg';
        if (m.isReg) words.push(H[`${nm}_r${w}`], m.rm & 7);
        else words.push(H[`${nm}_m${w}`], packEa(m), m.disp);
      } else {
        const nm = ['mul', 'imul', 'div', 'idiv'][m.reg - 4];
        // DIV and IDIV can fault, and a fault pushes the address of the
        // instruction ITSELF, not the next one -- the 8086 restarts it.
        const faults = nm[nm.length - 1] === 'v';
        if (m.isReg) words.push(H[`${nm}_r${w}`], m.rm & 7);
        else words.push(H[`${nm}_m${w}`], packEa(m), m.disp);
        // Not endsBlock: a divide that does not fault falls through normally,
        // and one that does sets the step budget negative and returns before
        // the rest of the block can run.
        // The 8086 pushes the address of the NEXT instruction on a divide
        // error -- it does not restart the divide the way a 286 does.
        if (faults) words.push((start + n) & 0xFFFF);
      }
      break;
    }

    // --- INC/DEC and PUSH through ModRM, FE/FF ------------------------------
    case 0xFE: case 0xFF: {
      const w = op === 0xFF ? opsize : 8;
      const m = modrm();
      if (m.reg === 0 || m.reg === 1) {
        const nm = m.reg === 0 ? 'inc' : 'dec';
        if (m.isReg) words.push(H[`${nm}_r${w}`], m.rm & 7);
        else words.push(H[`${nm}_m${w}`], packEa(m), m.disp);
      } else if (m.reg === 6 && w !== 8) {
        if (m.isReg && m.rm === 4 && w === 16) words.push(H.push_sp);   // same 8086 quirk
        else if (m.isReg) words.push(H[`push_r${w}`], m.rm & 7);
        else words.push(H[`push_m${w}`], packEa(m), m.disp);
      } else if (w !== 8 && (m.reg === 2 || m.reg === 4)) {
        // Indirect near CALL (/2) and JMP (/4). The target is a runtime value,
        // so both end the trace and hand the guest IP back.
        const nm = m.reg === 2 ? 'call' : 'jmp';
        const ret = (start + n) & 0xFFFF;
        if (m.isReg) words.push(H[`${nm}_r16`], m.rm & 7);
        else words.push(H[`${nm}_m16`], packEa(m), m.disp);
        if (nm === 'call') {
          // [retIp][arenaRet], the same pair CALL rel16 carries, so the shadow
          // return stack works for an indirect call too.
          words.push(ret, 0);
          fixups.push({ index: words.length - 1, ip: ret });
        }
        endsBlock = true;
      } else if (w !== 8 && !m.isReg && (m.reg === 3 || m.reg === 5)) {
        // Far indirect. Only the memory form exists -- a far pointer does not
        // fit in a register, and the encoding with mod=11 is undefined.
        if (m.reg === 5) words.push(H.jmp_far_m, packEa(m), m.disp);
        else words.push(H.call_far_m, packEa(m), m.disp, (start + n) & 0xFFFF);
        endsBlock = true;
      } else return null;
      break;
    }

    default:
      // MOV r8, imm8 (B0-B7) and MOV r16, imm16 (B8-BF) encode the register in
      // the opcode itself; so do INC (40-47) and DEC (48-4F).
      if (op >= 0xB0 && op <= 0xB7) words.push(H.mov_ri8, op & 7, imm8());
      else if (op >= 0xB8 && op <= 0xBF) words.push(H[`mov_ri${opsize}`], op & 7, immW());
      else if (op >= 0x40 && op <= 0x47) words.push(H[`inc_r${opsize}`], op & 7);
      else if (op >= 0x48 && op <= 0x4F) words.push(H[`dec_r${opsize}`], op & 7);
      // PUSH SP pushes the already-decremented value on an 8088; the 32-bit
      // form is a 386 encoding and follows the 386's rule, so it does not need
      // the quirk.
      else if (op === 0x54 && opsize === 16) words.push(H.push_sp);
      else if (op >= 0x50 && op <= 0x57) words.push(H[`push_r${opsize}`], op & 7);
      else if (op >= 0x58 && op <= 0x5F) words.push(H[`pop_r${opsize}`], op & 7);
      // PUSH/POP segment sit at 0x06 + 8*idx and 0x07 + 8*idx, in ES/CS/SS/DS
      // order -- the same order isa.SEG uses. POP CS (0x0F) is deliberately
      // absent: it exists on the 8086 but nothing sane emits it.
      else if ((op & 0xE7) === 0x06) words.push(H.push_seg, (op >> 3) & 3);
      else if ((op & 0xE7) === 0x07 && op !== 0x0F) words.push(H.pop_seg, (op >> 3) & 3);
      // XCHG AX, r16. 0x90 is XCHG AX,AX, which is NOP -- emitted as NOP so the
      // op stream says what the code means.
      else if (op === 0x90) words.push(H.nop);
      else if (op > 0x90 && op <= 0x97) words.push(H[`xchg_rr${opsize}`], 0 | ((op & 7) << 4));
      else return null;
  }

  return { words, nextIp: (start + n) & 0xFFFF, length: n, fixups, endsBlock };
}

module.exports = { decodeOne, H, setCpuLevel };
