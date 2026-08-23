#!/usr/bin/env node
// The one SIMD opcode table: MMX / SSE / SSE2 / 3DNow!, keyed by the byte after
// the 0F escape.
//
// It lives here rather than inside tools/disasm.js because two tools need it and
// a second copy would drift -- the same reason lib/pe.js exists. tools/disasm.js
// renders instructions from it; tools/scan-simd.js uses it to decide which byte
// pairs are SIMD at all and how long each one is.
//
// Mnemonic selection depends on the mandatory prefix in front of the 0F: the
// packed-int block (60-7F, D0-FF) is MMX bare and SSE2 under 66, and the
// float block (10-17, 28-2F, 51-5F, C2) picks its ps/pd/ss/sd suffix from
// none/66/F3/F2 respectively. That prefix is not an operand-size override here,
// it is part of the opcode.
'use strict';

const MMX = ['mm0','mm1','mm2','mm3','mm4','mm5','mm6','mm7'];
const XMM = ['xmm0','xmm1','xmm2','xmm3','xmm4','xmm5','xmm6','xmm7'];

// dir: 'rm' = reg <- rm, 'mr' = rm <- reg.
// r/m: 'v' vector, 'g' general-purpose, 'q' 64-bit vector (mm even under 66).
// f: float op whose suffix comes from the prefix. i: packed-int op.
const T = {
  0x10: { f: 'movu', alt: { f3: 'movss', f2: 'movsd' }, dir: 'rm' },
  0x11: { f: 'movu', alt: { f3: 'movss', f2: 'movsd' }, dir: 'mr' },
  0x12: { n: 'movlps', n66: 'movlpd', dir: 'rm' },
  0x13: { n: 'movlps', n66: 'movlpd', dir: 'mr' },
  0x14: { f: 'unpckl', dir: 'rm' },
  0x15: { f: 'unpckh', dir: 'rm' },
  0x16: { n: 'movhps', n66: 'movhpd', dir: 'rm' },
  0x17: { n: 'movhps', n66: 'movhpd', dir: 'mr' },
  0x28: { f: 'mova', dir: 'rm' },
  0x29: { f: 'mova', dir: 'mr' },
  0x2a: { n: 'cvtpi2ps', n66: 'cvtpi2pd', nf3: 'cvtsi2ss', nf2: 'cvtsi2sd', dir: 'rm', rmKind: 'q', rmKindF: 'g' },
  0x2b: { f: 'movnt', dir: 'mr' },
  0x2c: { n: 'cvttps2pi', n66: 'cvttpd2pi', nf3: 'cvttss2si', nf2: 'cvttsd2si', dir: 'rm', regKind: 'q', regKindF: 'g' },
  0x2d: { n: 'cvtps2pi', n66: 'cvtpd2pi', nf3: 'cvtss2si', nf2: 'cvtsd2si', dir: 'rm', regKind: 'q', regKindF: 'g' },
  0x2e: { n: 'ucomiss', n66: 'ucomisd', dir: 'rm' },
  0x2f: { n: 'comiss', n66: 'comisd', dir: 'rm' },
  0x50: { n: 'movmskps', n66: 'movmskpd', dir: 'rm', regKind: 'g' },
  0x51: { f: 'sqrt', alt: { f3: 'sqrtss', f2: 'sqrtsd' }, dir: 'rm' },
  0x52: { n: 'rsqrtps', nf3: 'rsqrtss', dir: 'rm' },
  0x53: { n: 'rcpps', nf3: 'rcpss', dir: 'rm' },
  0x54: { f: 'and', psOnly: true, dir: 'rm' },
  0x55: { f: 'andn', psOnly: true, dir: 'rm' },
  0x56: { f: 'or', psOnly: true, dir: 'rm' },
  0x57: { f: 'xor', psOnly: true, dir: 'rm' },
  0x58: { f: 'add', alt: { f3: 'addss', f2: 'addsd' }, dir: 'rm' },
  0x59: { f: 'mul', alt: { f3: 'mulss', f2: 'mulsd' }, dir: 'rm' },
  0x5a: { n: 'cvtps2pd', n66: 'cvtpd2ps', nf3: 'cvtss2sd', nf2: 'cvtsd2ss', dir: 'rm' },
  0x5b: { n: 'cvtdq2ps', n66: 'cvtps2dq', nf3: 'cvttps2dq', dir: 'rm' },
  0x5c: { f: 'sub', alt: { f3: 'subss', f2: 'subsd' }, dir: 'rm' },
  0x5d: { f: 'min', alt: { f3: 'minss', f2: 'minsd' }, dir: 'rm' },
  0x5e: { f: 'div', alt: { f3: 'divss', f2: 'divsd' }, dir: 'rm' },
  0x5f: { f: 'max', alt: { f3: 'maxss', f2: 'maxsd' }, dir: 'rm' },
  0x60: { i: 'punpcklbw' }, 0x61: { i: 'punpcklwd' }, 0x62: { i: 'punpckldq' },
  0x63: { i: 'packsswb' }, 0x64: { i: 'pcmpgtb' }, 0x65: { i: 'pcmpgtw' },
  0x66: { i: 'pcmpgtd' }, 0x67: { i: 'packuswb' }, 0x68: { i: 'punpckhbw' },
  0x69: { i: 'punpckhwd' }, 0x6a: { i: 'punpckhdq' }, 0x6b: { i: 'packssdw' },
  0x6c: { i: 'punpcklqdq', need66: true }, 0x6d: { i: 'punpckhqdq', need66: true },
  0x6e: { n: 'movd', dir: 'rm', rmKind: 'g' },
  0x6f: { n: 'movq', n66: 'movdqa', nf3: 'movdqu', dir: 'rm' },
  0x70: { n: 'pshufw', n66: 'pshufd', nf3: 'pshufhw', nf2: 'pshuflw', dir: 'rm', imm8: true },
  0x71: { group: [null, null, 'psrlw', null, 'psraw', null, 'psllw', null], imm8: true },
  0x72: { group: [null, null, 'psrld', null, 'psrad', null, 'pslld', null], imm8: true },
  0x73: { group: [null, null, 'psrlq', 'psrldq', null, null, 'psllq', 'pslldq'], imm8: true },
  0x74: { i: 'pcmpeqb' }, 0x75: { i: 'pcmpeqw' }, 0x76: { i: 'pcmpeqd' },
  0x77: { n: 'emms', n66: 'emms', noModrm: true },
  0x7e: { n: 'movd', nf3: 'movq', dir: 'mr', rmKind: 'g', dirF3: 'rm', rmKindF3: 'v' },
  0x7f: { n: 'movq', n66: 'movdqa', nf3: 'movdqu', dir: 'mr' },
  0xc2: { f: 'cmp', alt: { f3: 'cmpss', f2: 'cmpsd' }, dir: 'rm', imm8: true },
  0xc6: { f: 'shuf', psOnly: true, dir: 'rm', imm8: true },
  0xd1: { i: 'psrlw' }, 0xd2: { i: 'psrld' }, 0xd3: { i: 'psrlq' },
  0xd4: { i: 'paddq' }, 0xd5: { i: 'pmullw' },
  0xd6: { i: 'movq', need66: true, dir: 'mr' },
  0xd7: { n: 'pmovmskb', dir: 'rm', regKind: 'g' },
  0xd8: { i: 'psubusb' }, 0xd9: { i: 'psubusw' }, 0xda: { i: 'pminub' },
  0xdb: { i: 'pand' }, 0xdc: { i: 'paddusb' }, 0xdd: { i: 'paddusw' },
  0xde: { i: 'pmaxub' }, 0xdf: { i: 'pandn' },
  0xe0: { i: 'pavgb' }, 0xe1: { i: 'psraw' }, 0xe2: { i: 'psrad' },
  0xe3: { i: 'pavgw' }, 0xe4: { i: 'pmulhuw' }, 0xe5: { i: 'pmulhw' },
  0xe7: { n: 'movntq', n66: 'movntdq', dir: 'mr' },
  0xe8: { i: 'psubsb' }, 0xe9: { i: 'psubsw' }, 0xea: { i: 'pminsw' },
  0xeb: { i: 'por' }, 0xec: { i: 'paddsb' }, 0xed: { i: 'paddsw' },
  0xee: { i: 'pmaxsw' }, 0xef: { i: 'pxor' },
  0xf1: { i: 'psllw' }, 0xf2: { i: 'pslld' }, 0xf3: { i: 'psllq' },
  0xf4: { i: 'pmuludq' }, 0xf5: { i: 'pmaddwd' }, 0xf6: { i: 'psadbw' },
  0xf7: { n: 'maskmovq', n66: 'maskmovdqu', dir: 'rm', mod3Only: true },
  0xf8: { i: 'psubb' }, 0xf9: { i: 'psubw' }, 0xfa: { i: 'psubd' },
  0xfb: { i: 'psubq' }, 0xfc: { i: 'paddb' }, 0xfd: { i: 'paddw' },
  0xfe: { i: 'paddd' },
};

// 3DNow! hides its real opcode in the imm8 after the ModRM. Only these exist,
// which is also what stops a `0f 0f 0f 0f` padding run from decoding as eight
// 3DNow! instructions.
const NOW3D = {
  0x0c: 'pi2fw', 0x0d: 'pi2fd', 0x1c: 'pf2iw', 0x1d: 'pf2id',
  0x8a: 'pfnacc', 0x8e: 'pfpnacc', 0x90: 'pfcmpge', 0x94: 'pfmin',
  0x96: 'pfrcp', 0x97: 'pfrsqrt', 0x9a: 'pfsub', 0x9e: 'pfadd',
  0xa0: 'pfcmpgt', 0xa4: 'pfmax', 0xa6: 'pfrcpit1', 0xa7: 'pfrsqit1',
  0xaa: 'pfsubr', 0xae: 'pfacc', 0xb0: 'pfcmpeq', 0xb4: 'pfmul',
  0xb6: 'pfrcpit2', 0xb7: 'pmulhrw', 0xbb: 'pswapd', 0xbf: 'pavgusb',
  0x0a: 'pf2iw', 0x0e: 'pi2fd', 0x86: 'pfrcpv', 0x87: 'pfrsqrtv',
  0x1b: 'pswapd',
};

const SUFFIX = { 0: 'ps', 0x66: 'pd', 0xf3: 'ss', 0xf2: 'sd' };

// op: byte after 0F. pfx: 0 | 0x66 | 0xf2 | 0xf3. reg: ModRM reg field (only
// needed for the 71/72/73 shift groups). Returns null when this is not a SIMD
// opcode, else { mnem, dir, regKind, rmKind, imm8, noModrm, mod3Only, isa }.
function decodeSimd(op, pfx, reg) {
  const e = T[op];
  if (!e) return null;
  if (e.need66 && pfx !== 0x66) return null;

  let mnem;
  if (e.group) {
    mnem = e.group[reg & 7];
    if (!mnem) return null;
    // psrldq/pslldq are the 66-only xmm forms.
    if ((mnem === 'psrldq' || mnem === 'pslldq') && pfx !== 0x66) return null;
  } else if (e.f) {
    const alt = e.alt && (pfx === 0xf3 ? e.alt.f3 : pfx === 0xf2 ? e.alt.f2 : null);
    mnem = alt || e.f + (e.psOnly ? 'ps' : SUFFIX[pfx] || 'ps');
  } else if (e.i) {
    mnem = e.i;
  } else {
    mnem = (pfx === 0x66 && e.n66) || (pfx === 0xf3 && e.nf3) || (pfx === 0xf2 && e.nf2) || e.n;
  }

  // Which register file each operand names. 'v' follows the prefix (mm bare,
  // xmm under 66/F2/F3); 'q' is always mm; 'g' is a general-purpose register.
  const wide = pfx === 0x66 || pfx === 0xf2 || pfx === 0xf3;
  let regKind = e.regKind || 'v';
  let rmKind = e.rmKind || 'v';
  if (wide && e.regKindF) regKind = e.regKindF;
  if (wide && e.rmKindF) rmKind = e.rmKindF;
  let dir = e.dir || 'rm';
  if (pfx === 0xf3 && e.dirF3) { dir = e.dirF3; rmKind = e.rmKindF3 || rmKind; }

  return {
    mnem, dir, regKind, rmKind,
    // The 71/72/73 shifts spend the ModRM reg field on the opcode itself, so
    // they have one register operand (the rm field) plus the imm8.
    isGroup: !!e.group,
    imm8: !!e.imm8, noModrm: !!e.noModrm, mod3Only: !!e.mod3Only,
    isa: isaOf(op, pfx),
  };
}

function isaOf(op, pfx) {
  if (op === 0x77) return pfx === 0x66 ? 'sse2' : 'mmx';
  const packedInt = (op >= 0x60 && op <= 0x7f) || op >= 0xd0;
  if (pfx === 0x66 || pfx === 0xf2 || pfx === 0xf3) return packedInt ? 'sse2' : 'sse';
  if (packedInt) return 'mmx';
  if (op === 0x2a || op === 0x2c || op === 0x2d) return 'sse-mmx';
  return 'sse';
}

function regName(kind, wide, i) {
  if (kind === 'g') return ['eax','ecx','edx','ebx','esp','ebp','esi','edi'][i & 7];
  if (kind === 'q') return MMX[i & 7];
  return (wide ? XMM : MMX)[i & 7];
}

module.exports = { decodeSimd, isaOf, regName, NOW3D, MMX, XMM };
