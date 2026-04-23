// Test calc.exe's BigNum_Multiply by calling it directly with known inputs
// BigNum struct: [0]=sign(i32), [4]=digit_count(i32), [8]=exponent(i32), [12+]=digits[](i32[])
// Base 2^31 = 0x80000000. Digits are in range [0, 0x7FFFFFFF].
// BigNum_Multiply at 0x01011506: (ptr-to-ptr A, ptr B) → replaces *A with result, stdcall ret 8

const fs = require('fs');
const { createHostImports } = require('../lib/host-imports');
const { loadDlls, detectRequiredDlls } = require('../lib/dll-loader');

const BASE = 0x80000000; // 2^31

async function setup() {
  const wasmBytes = fs.readFileSync('build/wine-assembly.wasm');
  const exeBytes = fs.readFileSync('test/binaries/calc.exe');
  const memory = new WebAssembly.Memory({ initial: 2048, maximum: 2048, shared: true });
  const ctx = { getMemory: () => memory.buffer, onExit: () => {}, trace: new Set() };
  const base = createHostImports(ctx);
  const h = base.host;
  h.memory = memory;
  h.create_thread = () => 0; h.exit_thread = () => {};
  h.create_event = () => 0; h.set_event = () => 1; h.reset_event = () => 1; h.wait_single = () => 0;
  h.wait_multiple = () => 0;
  h.com_create_instance = () => 0x80004002;
  h.log = () => {}; h.log_i32 = () => {};

  const mod = await WebAssembly.compile(wasmBytes);
  const inst = await WebAssembly.instantiate(mod, { host: h });
  const e = inst.exports;

  new Uint8Array(memory.buffer).set(exeBytes, e.get_staging());
  e.load_pe(exeBytes.length);
  const dlls = detectRequiredDlls(exeBytes)
    .map(n => { try { return { name: n, bytes: fs.readFileSync('test/binaries/dlls/' + n) }; } catch (_) { return null; } })
    .filter(Boolean);
  if (dlls.length) loadDlls(e, memory.buffer, exeBytes, dlls, () => {});

  return { e, memory };
}

function makeBigNum(e, sign, digits) {
  // digits: array of base-2^31 limbs, least significant first
  const count = digits.length;
  const bn = e.guest_alloc(12 + count * 4);
  e.guest_write32(bn, sign);
  e.guest_write32(bn + 4, count);
  e.guest_write32(bn + 8, 0); // exponent
  for (let i = 0; i < count; i++) e.guest_write32(bn + 12 + i * 4, digits[i]);
  return bn;
}

function readBigNum(e, ptr) {
  const sign = e.guest_read32(ptr);
  const count = e.guest_read32(ptr + 4);
  const exp = e.guest_read32(ptr + 8);
  const digits = [];
  for (let i = 0; i < count; i++) digits.push(e.guest_read32(ptr + 12 + i * 4) >>> 0);
  return { sign, count, exp, digits };
}

function callMultiply(e, bnA, bnB) {
  const ptrA = e.guest_alloc(4);
  e.guest_write32(ptrA, bnA);
  // Save/restore registers since we're calling into guest code
  e.call_func(0x01011506, ptrA, bnB, 0, 0);
  e.run(100000);
  if (e.get_eip() !== 0) throw new Error('Multiply did not return, EIP=0x' + (e.get_eip() >>> 0).toString(16));
  return e.guest_read32(ptrA);
}

// Convert bignum digits to BigInt for verification
function toBigInt(bn) {
  let val = 0n;
  for (let i = bn.digits.length - 1; i >= 0; i--) {
    val = val * BigInt(BASE) + BigInt(bn.digits[i]);
  }
  if (bn.sign < 0) val = -val;
  return val;
}

// Convert BigInt to expected digits array
function fromBigInt(val) {
  if (val === 0n) return [0];
  const digits = [];
  let v = val < 0n ? -val : val;
  while (v > 0n) {
    digits.push(Number(v % BigInt(BASE)));
    v = v / BigInt(BASE);
  }
  return digits;
}

async function main() {
  const { e } = await setup();
  let pass = 0, fail = 0;

  function test(name, signA, digitsA, signB, digitsB) {
    const bnA = makeBigNum(e, signA, digitsA);
    const bnB = makeBigNum(e, signB, digitsB);

    const resultPtr = callMultiply(e, bnA, bnB);
    const result = readBigNum(e, resultPtr);
    const actual = toBigInt(result);

    const valA = toBigInt({ sign: signA, digits: digitsA });
    const valB = toBigInt({ sign: signB, digits: digitsB });
    const expected = valA * valB;

    // Normalize: strip trailing zero digits for comparison
    const expDigits = fromBigInt(expected < 0n ? -expected : expected);

    const ok = actual === expected;
    if (ok) {
      pass++;
      console.log(`  PASS: ${name}`);
    } else {
      fail++;
      console.log(`  FAIL: ${name}`);
      console.log(`    A = ${valA} (digits: [${digitsA.map(d => '0x' + d.toString(16))}])`);
      console.log(`    B = ${valB} (digits: [${digitsB.map(d => '0x' + d.toString(16))}])`);
      console.log(`    Expected: ${expected} (digits: [${expDigits.map(d => '0x' + d.toString(16))}])`);
      console.log(`    Got:      ${actual} (digits: [${result.digits.map(d => '0x' + d.toString(16))}] count=${result.count} sign=${result.sign})`);
    }
  }

  console.log('BigNum_Multiply tests (base 2^31):');
  console.log('');

  // --- Single digit ---
  console.log('Single digit:');
  test('10 * 10 = 100', 1, [10], 1, [10]);
  test('0x7FFFFFFF * 1', 1, [0x7FFFFFFF], 1, [1]);
  test('1 * 0x7FFFFFFF', 1, [1], 1, [0x7FFFFFFF]);
  test('2 * 0x40000000 (= 2^31, carries)', 1, [2], 1, [0x40000000]);
  test('0x7FFFFFFF * 2 (max single * 2)', 1, [0x7FFFFFFF], 1, [2]);
  test('0x7FFFFFFF * 0x7FFFFFFF (max*max)', 1, [0x7FFFFFFF], 1, [0x7FFFFFFF]);

  // --- Multi digit ---
  console.log('\nMulti digit:');
  // 2^31 in base 2^31 = [0, 1] (two digits)
  test('[0,1] * [1] = 2^31', 1, [0, 1], 1, [1]);
  test('[0,1] * [2] = 2^32', 1, [0, 1], 1, [2]);
  test('[0,1] * [0,1] = 2^62', 1, [0, 1], 1, [0, 1]);
  test('[1,1] * [1,1] = (2^31+1)^2', 1, [1, 1], 1, [1, 1]);
  // Larger: 3-digit numbers
  test('[0x12345678, 0x23456789, 0x1] * [0x11111111, 0x2]',
    1, [0x12345678, 0x23456789, 0x1], 1, [0x11111111, 0x2]);

  // --- Sign ---
  console.log('\nSign:');
  test('(-1) * 10 = -10', -1, [10], 1, [10]);  // actually sign=(-1)*1=-1
  test('(-1) * (-1) * digits', -1, [5], -1, [7]);

  // --- Carry propagation ---
  console.log('\nCarry propagation:');
  test('[0x7FFFFFFF] * [0x7FFFFFFF] (full carry)', 1, [0x7FFFFFFF], 1, [0x7FFFFFFF]);
  test('[0x7FFFFFFF, 0x7FFFFFFF] * [0x7FFFFFFF]', 1, [0x7FFFFFFF, 0x7FFFFFFF], 1, [0x7FFFFFFF]);
  test('[0x7FFFFFFF, 0x7FFFFFFF] * [0x7FFFFFFF, 0x7FFFFFFF]',
    1, [0x7FFFFFFF, 0x7FFFFFFF], 1, [0x7FFFFFFF, 0x7FFFFFFF]);
  // 5-digit * 5-digit (similar to what calc uses for 42-digit precision)
  test('5x5 digit multiply',
    1, [0x12345678, 0x23456789, 0x3456789A, 0x456789AB, 0x1],
    1, [0x11111111, 0x22222222, 0x33333333, 0x44444444, 0x1]);

  console.log(`\n${pass + fail} tests: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
