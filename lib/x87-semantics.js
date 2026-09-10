'use strict';

// Decode-only x87 semantics.  This module deliberately has no connection to the
// threaded-code decoder: it describes guest-visible effects for analysis tools,
// while execution continues to use the scalar handlers in src/06-fpu.wat.

const REGS32 = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi'];
const EA16 = ['bx+si', 'bx+di', 'bp+si', 'bp+di', 'si', 'di', 'bp', 'bx'];

function deps(overrides = {}) {
  return Object.assign({
    tagsRead: false, tagsWrite: false, rawRead: false, rawWrite: false,
    statusRead: false, statusWrite: false, controlRead: false, controlWrite: false,
    eflagsRead: false, eflagsWrite: false,
  }, overrides);
}

function stack(reads = [], writes = [], pushes = 0, pops = 0) {
  return { reads, writes, pushes, pops, delta: pushes - pops };
}

function effect(name, st, memory, dependencies, barrier = null) {
  return { name, stack: st, memory, dependencies, barrier };
}

const NONE = Object.freeze({ access: 'none', width: 0, format: null, shape: 'none' });
const arithmeticDeps = () => deps({ tagsRead: true, tagsWrite: true, statusWrite: true, controlRead: true });
const valueDeps = () => deps({ tagsRead: true, tagsWrite: true, rawRead: true, rawWrite: true });

function mem(access, width, format, address) {
  return { access, width, format, shape: address.shape, address };
}

function decodeAddress(buffer, at, modrm, addressBits) {
  const mod = modrm >>> 6;
  const rm = modrm & 7;
  let p = at;
  if (mod === 3) return { length: 0, shape: 'register', text: `st(${rm})` };
  if (addressBits === 16) {
    let displacement = 0;
    let displacementBytes = 0;
    let base = EA16[rm];
    if (mod === 0 && rm === 6) {
      if (p + 2 > buffer.length) throw new RangeError('truncated x87 disp16');
      displacement = buffer.readUInt16LE(p); p += 2; displacementBytes = 2; base = null;
    } else if (mod === 1) {
      if (p >= buffer.length) throw new RangeError('truncated x87 disp8');
      displacement = buffer.readInt8(p++); displacementBytes = 1;
    } else if (mod === 2) {
      if (p + 2 > buffer.length) throw new RangeError('truncated x87 disp16');
      displacement = buffer.readInt16LE(p); p += 2; displacementBytes = 2;
    }
    return {
      length: p - at,
      shape: base ? (displacementBytes ? `base16_disp${displacementBytes * 8}` : 'base16') : 'absolute16',
      base, index: null, scale: 1, displacement, displacementBytes,
    };
  }

  let base = rm === 5 && mod === 0 ? null : REGS32[rm];
  let index = null;
  let scale = 1;
  let sib = false;
  if (rm === 4) {
    if (p >= buffer.length) throw new RangeError('truncated x87 SIB');
    const b = buffer[p++]; sib = true;
    scale = 1 << (b >>> 6);
    const ii = (b >>> 3) & 7;
    const bb = b & 7;
    index = ii === 4 ? null : REGS32[ii];
    base = mod === 0 && bb === 5 ? null : REGS32[bb];
  }
  let displacement = 0;
  let displacementBytes = 0;
  if (mod === 0 && base === null) {
    if (p + 4 > buffer.length) throw new RangeError('truncated x87 disp32');
    displacement = buffer.readInt32LE(p); p += 4; displacementBytes = 4;
  } else if (mod === 1) {
    if (p >= buffer.length) throw new RangeError('truncated x87 disp8');
    displacement = buffer.readInt8(p++); displacementBytes = 1;
  } else if (mod === 2) {
    if (p + 4 > buffer.length) throw new RangeError('truncated x87 disp32');
    displacement = buffer.readInt32LE(p); p += 4; displacementBytes = 4;
  }
  let shape;
  if (!base && !index) shape = 'absolute32';
  else if (sib) shape = displacementBytes ? `sib_disp${displacementBytes * 8}` : 'sib';
  else shape = displacementBytes ? `base_disp${displacementBytes * 8}` : 'base';
  return { length: p - at, shape, base, index, scale, displacement, displacementBytes };
}

function unsupported(opcode, group, rm, memory, why = 'unsupported-form') {
  return effect(`x87_${opcode.toString(16)}_${group}_${rm}`, stack(), memory,
    deps(), why);
}

function arithmetic(name, destination, pop, memory) {
  const reads = memory.access === 'none' ? [0, destination] : [0];
  const writes = name.startsWith('fcom') || name.startsWith('fucom') ? [] : [destination];
  return effect(name, stack(reads, writes, 0, pop), memory, arithmeticDeps());
}

function registerEffect(opcode, group, rm) {
  const no = NONE;
  const arithNames = ['fadd', 'fmul', 'fcom', 'fcomp', 'fsub', 'fsubr', 'fdiv', 'fdivr'];
  if (opcode === 0xd8) return arithmetic(arithNames[group], 0, group === 3 ? 1 : 0, no);
  if (opcode === 0xdc) {
    if (group === 2 || group === 3) return unsupported(opcode, group, rm, no);
    const names = ['fadd', 'fmul', null, null, 'fsubr', 'fsub', 'fdivr', 'fdiv'];
    return arithmetic(names[group], rm, 0, no);
  }
  if (opcode === 0xde) {
    if (group === 3 && rm === 1)
      return effect('fcompp', stack([0, 1], [], 0, 2), no, arithmeticDeps());
    if (group === 2 || group === 3) return unsupported(opcode, group, rm, no);
    const names = ['faddp', 'fmulp', null, null, 'fsubrp', 'fsubp', 'fdivrp', 'fdivp'];
    return arithmetic(names[group], rm, 1, no);
  }
  if (opcode === 0xd9) {
    if (group === 0) return effect('fld_st', stack([rm], [0], 1, 0), no, valueDeps());
    if (group === 1) return effect('fxch', stack([0, rm], [0, rm]), no, valueDeps());
    if (group === 2) return rm === 0 ? effect('fnop', stack(), no, deps()) : unsupported(opcode, group, rm, no);
    if (group === 4) {
      if (rm === 0 || rm === 1) return effect(rm ? 'fabs' : 'fchs', stack([0], [0]), no, arithmeticDeps());
      if (rm === 4) return effect('ftst', stack([0]), no, arithmeticDeps());
      if (rm === 5) return effect('fxam', stack([0]), no, deps({ tagsRead: true, statusWrite: true }), 'tag-status-observe');
      return unsupported(opcode, group, rm, no);
    }
    if (group === 5) {
      const names = ['fld1', 'fldl2t', 'fldl2e', 'fldpi', 'fldlg2', 'fldln2', 'fldz'];
      return rm < 7 ? effect(names[rm], stack([], [0], 1), no, valueDeps()) : unsupported(opcode, group, rm, no);
    }
    if (group === 6) {
      const names = ['f2xm1', 'fyl2x', 'fptan', 'fpatan', 'fxtract', 'fprem1', 'fincstp', 'fdecstp'];
      if (rm >= 6) return effect(names[rm], stack(), no, deps({ tagsRead: true, tagsWrite: true }), 'top-mutation');
      const pops = rm === 1 || rm === 3 ? 1 : 0;
      const pushes = rm === 2 || rm === 4 ? 1 : 0;
      return effect(names[rm], stack(rm === 0 ? [0] : [0, 1], [0], pushes, pops), no,
        arithmeticDeps(), 'external-math');
    }
    if (group === 7) {
      const names = ['fprem', 'fyl2xp1', 'fsqrt', 'fsincos', 'frndint', 'fscale', 'fsin', 'fcos'];
      const pop = rm === 1 ? 1 : 0;
      const push = rm === 3 ? 1 : 0;
      return effect(names[rm], stack(rm === 0 || rm === 1 || rm === 5 ? [0, 1] : [0], [0], push, pop), no,
        arithmeticDeps(), rm === 4 ? 'control-dependent-rounding' : 'external-math');
    }
  }
  if (opcode === 0xda) {
    if (group <= 2) return effect('fcmov', stack([0, rm], [0]), no,
      deps({ tagsRead: true, tagsWrite: true, rawRead: true, rawWrite: true, eflagsRead: true }), 'eflags-read');
    if (group === 5 && rm === 1) return effect('fucompp', stack([0, 1], [], 0, 2), no, arithmeticDeps());
    return unsupported(opcode, group, rm, no);
  }
  if (opcode === 0xdb) {
    if (group <= 2) return effect('fcmovn', stack([0, rm], [0]), no,
      deps({ tagsRead: true, tagsWrite: true, rawRead: true, rawWrite: true, eflagsRead: true }), 'eflags-read');
    if (group === 4) {
      if (rm <= 1) return effect('feni_fdisi', stack(), no, deps());
      if (rm === 2) return effect('fnclex', stack(), no, deps({ statusWrite: true }), 'status-control');
      if (rm === 3) return effect('fninit', stack(), no, deps({ tagsWrite: true, statusWrite: true, controlWrite: true }), 'environment-reset');
      return unsupported(opcode, group, rm, no);
    }
    if (group === 5 || group === 6) return effect(group === 5 ? 'fucomi' : 'fcomi', stack([0, rm]), no,
      deps({ tagsRead: true, statusWrite: true, eflagsWrite: true }), 'eflags-write');
    return unsupported(opcode, group, rm, no);
  }
  if (opcode === 0xdd) {
    if (group === 0) return effect('ffree', stack([], [rm]), no, deps({ tagsWrite: true }), 'tag-only-mutation');
    if (group === 2) return effect('fst_st', stack([0], [rm]), no, valueDeps());
    if (group === 3) return effect('fstp_st', stack([0], [rm], 0, 1), no, valueDeps());
    if (group === 4 || group === 5) return effect(group === 4 ? 'fucom' : 'fucomp', stack([0, rm], [], 0, group === 5 ? 1 : 0), no, arithmeticDeps());
  }
  if (opcode === 0xdf) {
    if (group === 4 && rm === 0) return effect('fnstsw_ax', stack(), no, deps({ statusRead: true }), 'status-observe');
    if (group === 5 || group === 6) return effect(group === 5 ? 'fucomip' : 'fcomip', stack([0, rm], [], 0, 1), no,
      deps({ tagsRead: true, statusWrite: true, eflagsWrite: true }), 'eflags-write');
  }
  return unsupported(opcode, group, rm, no);
}

function memoryEffect(opcode, group, address) {
  const arithNames = ['fadd', 'fmul', 'fcom', 'fcomp', 'fsub', 'fsubr', 'fdiv', 'fdivr'];
  if (opcode === 0xd8 || opcode === 0xdc || opcode === 0xda || opcode === 0xde) {
    const format = opcode === 0xd8 ? 'float32' : opcode === 0xdc ? 'float64' : opcode === 0xda ? 'int32' : 'int16';
    const width = opcode === 0xd8 || opcode === 0xda ? 4 : opcode === 0xdc ? 8 : 2;
    const names = opcode === 0xda || opcode === 0xde
      ? ['fiadd', 'fimul', 'ficom', 'ficomp', 'fisub', 'fisubr', 'fidiv', 'fidivr']
      : arithNames;
    return arithmetic(names[group], 0, group === 3 ? 1 : 0, mem('read', width, format, address));
  }
  if (opcode === 0xd9 || opcode === 0xdd) {
    const width = opcode === 0xd9 ? 4 : 8;
    const format = opcode === 0xd9 ? 'float32' : 'float64';
    if (group === 0) return effect('fld', stack([], [0], 1), mem('read', width, format, address), valueDeps());
    if (group === 2 || group === 3) return effect(group === 2 ? 'fst' : 'fstp', stack([0], [], 0, group === 3 ? 1 : 0), mem('write', width, format, address), valueDeps());
    if (opcode === 0xd9 && group === 4) return effect('fldenv', stack(), mem('read', 28, 'env', address), deps({ tagsWrite: true, statusWrite: true, controlWrite: true }), 'environment-load');
    if (opcode === 0xd9 && group === 5) return effect('fldcw', stack(), mem('read', 2, 'control', address), deps({ controlWrite: true }), 'control-write');
    if (opcode === 0xd9 && group === 6) return effect('fnstenv', stack(), mem('write', 28, 'env', address), deps({ tagsRead: true, statusRead: true, controlRead: true, controlWrite: true }), 'environment-store');
    if (opcode === 0xd9 && group === 7) return effect('fnstcw', stack(), mem('write', 2, 'control', address), deps({ controlRead: true }), 'control-observe');
    if (opcode === 0xdd && group === 4) return effect('frstor', stack(), mem('read', 108, 'state', address), deps({ tagsWrite: true, statusWrite: true, controlWrite: true }), 'environment-load');
    if (opcode === 0xdd && group === 6) return effect('fnsave', stack(), mem('write', 108, 'state', address), deps({ tagsRead: true, statusRead: true, controlRead: true, tagsWrite: true, statusWrite: true, controlWrite: true }), 'environment-store-reset');
    if (opcode === 0xdd && group === 7) return effect('fnstsw', stack(), mem('write', 2, 'status', address), deps({ statusRead: true }), 'status-observe');
    return unsupported(opcode, group, address.rm, mem('none', 0, null, address));
  }
  if (opcode === 0xdb) {
    if (group === 0) return effect('fild', stack([], [0], 1), mem('read', 4, 'int32', address), valueDeps());
    if (group === 2 || group === 3) return effect(group === 2 ? 'fist' : 'fistp', stack([0], [], 0, group === 3 ? 1 : 0), mem('write', 4, 'int32', address), arithmeticDeps());
    if (group === 5) return effect('fld80', stack([], [0], 1), mem('read', 10, 'float80', address), valueDeps());
    if (group === 7) return effect('fstp80', stack([0], [], 0, 1), mem('write', 10, 'float80', address), valueDeps());
    return unsupported(opcode, group, address.rm, mem('none', 0, null, address));
  }
  if (opcode === 0xdf) {
    const names = ['fild16', null, 'fist16', 'fistp16', 'fbld', 'fild64', 'fbstp', 'fistp64'];
    const widths = [2, 0, 2, 2, 10, 8, 10, 8];
    const formats = ['int16', null, 'int16', 'int16', 'bcd80', 'int64', 'bcd80', 'int64'];
    if (!names[group]) return unsupported(opcode, group, address.rm, mem('none', 0, null, address));
    const isLoad = group === 0 || group === 4 || group === 5;
    const pop = group === 3 || group === 6 || group === 7 ? 1 : 0;
    return effect(names[group], isLoad ? stack([], [0], 1) : stack([0], [], 0, pop),
      mem(isLoad ? 'read' : 'write', widths[group], formats[group], address),
      valueDeps());
  }
  return unsupported(opcode, group, address.rm, mem('none', 0, null, address));
}

function decodeX87(input, offset = 0, options = {}) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input.buffer || input, input.byteOffset || 0, input.byteLength);
  const bits = options.bits || 32;
  let p = offset;
  let addressBits = bits;
  const prefixes = [];
  while (p < buffer.length) {
    const b = buffer[p];
    if (b === 0x67) { addressBits = bits === 16 ? 32 : 16; prefixes.push(b); p++; }
    else if (b === 0x66 || b === 0x9b || b === 0x26 || b === 0x2e || b === 0x36 || b === 0x3e || b === 0x64 || b === 0x65) { prefixes.push(b); p++; }
    else break;
  }
  if (p + 2 > buffer.length || buffer[p] < 0xd8 || buffer[p] > 0xdf) return null;
  const opcode = buffer[p++];
  const modrm = buffer[p++];
  const mod = modrm >>> 6;
  const group = (modrm >>> 3) & 7;
  const rm = modrm & 7;
  const address = decodeAddress(buffer, p, modrm, addressBits);
  address.mod = mod; address.rm = rm;
  p += address.length;
  const semantic = mod === 3 ? registerEffect(opcode, group, rm) : memoryEffect(opcode, group, address);
  return Object.assign({
    offset, length: p - offset, bytes: buffer.subarray(offset, p), prefixes,
    opcode, modrm, mod, group, rm, addressBits, supported: semantic.barrier !== 'unsupported-form',
  }, semantic);
}

module.exports = { decodeX87, decodeAddress, deps, stack };
