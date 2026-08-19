#!/usr/bin/env node
// The shift/rotate helper, checked against an independent model.
//
// $do_shift32/16/8 used to be three ~80-line copies, and they did not differ
// only in constants: SAR sign-extends from a different bit, ROL/ROR take the
// count modulo the operand width, and RCL/RCR rotate through carry over 9, 17
// or 33 bits. They are now one width-parameterized $do_shift — the kind of
// rewrite that can silently change a flag in a corner nobody runs, so this
// walks every (width, op, count) with a spread of values and both carry-ins and
// compares result *and* CF/ZF/SF against the model below.
//
// The model deliberately reproduces two emulator conventions rather than the
// manual's:
//   * the shift count is masked to 5 bits for every width (x86 does this for
//     32-bit operands; 8- and 16-bit shifts mask the same way here),
//   * $set_flags_shift computes SF at 32-bit width regardless of operand size,
//     so SF is bit 31 of the result, not bit 7 or 15.
// If either of those is ever corrected, this model is where the expectation
// lives, and it should be corrected here in the same commit.

const fs = require('fs');

const ROL = 0, ROR = 1, RCL = 2, RCR = 3, SHL = 4, SHR = 5, SAL = 6, SAR = 7;
const NAMES = { [ROL]: 'ROL', [ROR]: 'ROR', [RCL]: 'RCL', [RCR]: 'RCR',
                [SHL]: 'SHL', [SHR]: 'SHR', [SAL]: 'SAL', [SAR]: 'SAR' };

// Returns { value, cf } for one shift, or null for "no flag change" (count 0).
function model(bits, type, val, count, cfIn) {
  const mask = bits === 32 ? 0xFFFFFFFF : ((1 << bits) - 1) >>> 0;
  const sign = 1 << (bits - 1);
  val = (val & mask) >>> 0;
  count = count & 31;
  if (count === 0) return { value: val, cf: null };

  const m = (x) => (x & mask) >>> 0;
  switch (type) {
    case SHL: case SAL: {
      const r = m(val << count);
      return { value: r, cf: (val >>> ((bits - count) & 31)) & 1 };
    }
    case SHR: {
      const r = val >>> count;
      return { value: r, cf: (val >>> ((count - 1) & 31)) & 1 };
    }
    case SAR: {
      let v = val;
      if (v & sign) v = (v | ~mask) >>> 0;
      const r = m(v >> count);
      return { value: r, cf: (v >>> ((count - 1) & 31)) & 1 };
    }
    case ROL: {
      const c = count % bits;
      if (c === 0) return { value: val, cf: null };
      const r = m((val << c) | (val >>> ((bits - c) & 31)));
      return { value: r, cf: r & 1 };
    }
    case ROR: {
      const c = count % bits;
      if (c === 0) return { value: val, cf: null };
      const r = m((val >>> c) | (val << ((bits - c) & 31)));
      return { value: r, cf: (r >>> (bits - 1)) & 1 };
    }
    case RCL: {
      let v = val, cf = cfIn, c = count % (bits + 1);
      while (c-- > 0) {
        const r = (m(v << 1) | cf) >>> 0;
        cf = (v >>> (bits - 1)) & 1;
        v = r;
      }
      return { value: v, cf };
    }
    case RCR: {
      let v = val, cf = cfIn, c = count % (bits + 1);
      while (c-- > 0) {
        const r = ((v >>> 1) | (cf << (bits - 1))) >>> 0;
        cf = v & 1;
        v = r;
      }
      return { value: v, cf };
    }
    default:
      return { value: val, cf: null };
  }
}

const VALUES = [
  0x00000000, 0x00000001, 0x00000002, 0x0000007F, 0x00000080, 0x000000FF,
  0x00007FFF, 0x00008000, 0x0000FFFF, 0x7FFFFFFF, 0x80000000, 0xFFFFFFFF,
  0xAAAAAAAA, 0x55555555, 0x12345678, 0xDEADBEEF, 0x00000081, 0x000000C3,
];

async function main() {
  const wasmBytes = fs.readFileSync('build/wine-assembly.wasm');
  const memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
  const mod = await WebAssembly.compile(wasmBytes);
  // Nothing here calls out to the host; the imports only have to exist.
  const imports = {};
  for (const imp of WebAssembly.Module.imports(mod)) {
    imports[imp.module] = imports[imp.module] || {};
    if (imp.kind === 'function') imports[imp.module][imp.name] = () => 0;
    else if (imp.kind === 'memory') imports[imp.module][imp.name] = memory;
    else if (imp.kind === 'global') imports[imp.module][imp.name] = 0;
  }
  const instance = await WebAssembly.instantiate(mod, imports);
  const { test_shift, test_shift_flags } = instance.exports;
  if (typeof test_shift !== 'function') {
    console.error('test_shift export missing');
    process.exit(1);
  }

  let cases = 0;
  const failures = [];
  for (const bits of [32, 16, 8]) {
    for (const type of [ROL, ROR, RCL, RCR, SHL, SHR, SAL, SAR]) {
      for (const val of VALUES) {
        for (let count = 0; count <= 33; count++) {
          for (const cfIn of [0, 1]) {
            const got = test_shift(bits, type, val | 0, count, cfIn) >>> 0;
            const flags = test_shift_flags() >>> 0;
            const want = model(bits, type, val >>> 0, count, cfIn);
            cases++;
            const where = `${NAMES[type]}${bits} val=0x${(val >>> 0).toString(16)} ` +
              `count=${count} cf=${cfIn}`;
            if (got !== want.value) {
              failures.push(`${where}: value 0x${got.toString(16)} != 0x${want.value.toString(16)}`);
              continue;
            }
            if (want.cf !== null) {
              const cf = flags & 1;
              const zf = (flags >> 1) & 1;
              const sf = (flags >> 2) & 1;
              if (cf !== want.cf) failures.push(`${where}: CF ${cf} != ${want.cf}`);
              else if (zf !== (want.value === 0 ? 1 : 0)) failures.push(`${where}: ZF ${zf}`);
              else if (sf !== ((want.value >>> 31) & 1)) failures.push(`${where}: SF ${sf}`);
            }
          }
        }
      }
    }
  }

  console.log(`checked ${cases} (width, op, value, count, carry) combinations`);
  if (failures.length) {
    for (const f of failures.slice(0, 20)) console.log('  FAIL  ' + f);
    if (failures.length > 20) console.log(`  ...and ${failures.length - 20} more`);
    console.log(`\ntest-shift-equivalence: ${failures.length} mismatches`);
    process.exit(1);
  }
  console.log('\ntest-shift-equivalence: $do_shift matches the model at all three widths');
}

main().catch(err => { console.error(err); process.exit(1); });
