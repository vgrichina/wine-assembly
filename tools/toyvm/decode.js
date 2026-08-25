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

const SEG_PREFIX = { 0x26: 0, 0x2E: 1, 0x36: 2, 0x3E: 3 };

// x86 lays the ALU group out at 8*code + form. Only the six ops whose handlers
// exist are listed; ADC (2) and SBB (3) read CF as an input and are absent
// until that plumbing lands, so their opcodes decode as unimplemented rather
// than as something plausible-looking.
const ALU_BY_CODE = { 0: 'add', 1: 'or', 4: 'and', 5: 'sub', 6: 'xor', 7: 'cmp' };

// Decode exactly one instruction at cs:ip. `rd` reads one physical byte.
// Returns { words, nextIp } or null if the opcode is not implemented yet --
// partial coverage is the honest state of this thing and callers report it.
function decodeOne(rd, cs, ip) {
  const start = ip;
  const at = (n) => rd((((cs << 4) + ((start + n) & 0xFFFF)) & 0xFFFFF));
  let n = 0;
  let segOverride = null;

  // Prefixes. Only segment overrides for now; rep/lock arrive with the string
  // group.
  for (;;) {
    const b = at(n);
    if (SEG_PREFIX[b] === undefined) break;
    segOverride = SEG_PREFIX[b];
    n++;
    if (n > 8) return null;   // prefix soup, not something the corpus produces
  }

  const op = at(n); n++;
  const words = [];

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

  const packEa = (m) => (m.kind & 15) | ((m.seg & 3) << 4) | ((m.reg & 7) << 8);
  const imm8 = () => { const v = at(n); n++; return v; };
  const imm16 = () => { const v = at(n) | (at(n + 1) << 8); n += 2; return v; };
  const sx8to16 = (v) => (v & 0x80 ? v - 0x100 : v) & 0xFFFF;

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
      const w = (form & 1) ? 16 : 8;
      emitRmR(name, w, modrm(), form < 2);
    } else if (form === 4) {
      words.push(H[`${name}_ri8`], 0, imm8());          // AL
    } else {
      words.push(H[`${name}_ri16`], 0, imm16());        // AX
    }
  } else switch (op) {
    // --- ALU with immediate, group 80/81/83 ---------------------------------
    // The op comes from the ModRM reg field rather than the opcode. 83 is the
    // sign-extended-imm8 form, which is what compilers emit for small
    // constants and is therefore everywhere in real code.
    case 0x80: case 0x81: case 0x83: {
      const m = modrm();
      const name = ALU_BY_CODE[m.reg];
      if (name === undefined) return null;              // ADC/SBB
      if (op === 0x80) emitRmI(name, 8, m, imm8());
      else if (op === 0x81) emitRmI(name, 16, m, imm16());
      else emitRmI(name, 16, m, sx8to16(imm8()));
      break;
    }

    // --- MOV r/m, r and r, r/m ----------------------------------------------
    case 0x88: emitRmR('mov', 8, modrm(), true); break;
    case 0x89: emitRmR('mov', 16, modrm(), true); break;
    case 0x8A: emitRmR('mov', 8, modrm(), false); break;
    case 0x8B: emitRmR('mov', 16, modrm(), false); break;

    // --- MOV r/m, imm -------------------------------------------------------
    case 0xC6: { const m = modrm(); emitRmI('mov', 8, m, imm8()); break; }
    case 0xC7: { const m = modrm(); emitRmI('mov', 16, m, imm16()); break; }

    default:
      // MOV r8, imm8 (B0-B7) and MOV r16, imm16 (B8-BF) encode the register in
      // the opcode itself.
      if (op >= 0xB0 && op <= 0xB7) words.push(H.mov_ri8, op & 7, imm8());
      else if (op >= 0xB8 && op <= 0xBF) words.push(H.mov_ri16, op & 7, imm16());
      else return null;
  }

  return { words, nextIp: (start + n) & 0xFFFF, length: n };
}

module.exports = { decodeOne, H };
