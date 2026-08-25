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

// Decode exactly one instruction at cs:ip. `rd` reads one physical byte.
// Returns { words, nextIp } or null if the opcode is not implemented yet --
// partial coverage is the honest state of this thing and callers report it.
function decodeOne(rd, cs, ip) {
  const start = ip;
  const at = (n) => rd((((cs << 4) + ((start + n) & 0xFFFF)) & 0xFFFFF));
  let n = 0;
  let segOverride = null;

  // Prefixes. Only segment overrides for now; rep/lock arrive with the string
  // and ALU groups.
  for (;;) {
    const b = at(n);
    if (SEG_PREFIX[b] === undefined) break;
    segOverride = SEG_PREFIX[b];
    n++;
    if (n > 8) return null;   // prefix soup, not something the corpus produces
  }

  const op = at(n); n++;
  const words = [];

  // --- ModRM, 16-bit addressing ---------------------------------------------
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

  switch (op) {
    // ADD r/m, r  (direction: memory or rm is the destination)
    case 0x00: case 0x01: {
      const m = modrm();
      const w16 = op === 0x01;
      if (m.isReg) {
        words.push(w16 ? H.add_r16_r16 : H.add_r8_r8, (m.rm & 7) | ((m.reg & 7) << 4));
      } else {
        words.push(w16 ? H.add_m16_r16 : H.add_m8_r8, packEa(m), m.disp);
      }
      break;
    }
    // ADD r, r/m
    case 0x02: case 0x03: {
      const m = modrm();
      const w16 = op === 0x03;
      if (m.isReg) {
        words.push(w16 ? H.add_r16_r16 : H.add_r8_r8, (m.reg & 7) | ((m.rm & 7) << 4));
      } else {
        words.push(w16 ? H.add_r16_m16 : H.add_r8_m8, packEa(m), m.disp);
      }
      break;
    }
    // ADD AL, imm8 / ADD AX, imm16
    case 0x04: { const imm = at(n); n++; words.push(H.add_r8_i8, 0, imm); break; }
    case 0x05: {
      const imm = at(n) | (at(n + 1) << 8); n += 2;
      words.push(H.add_r16_i16, 0, imm);
      break;
    }
    default:
      return null;
  }

  return { words, nextIp: (start + n) & 0xFFFF, length: n };
}

module.exports = { decodeOne, H };
