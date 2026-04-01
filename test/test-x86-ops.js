#!/usr/bin/env node
// Test x86 instruction correctness for operations used in calc.exe's bignum multiply loop.
// Run: node test/test-x86-ops.js

const fs = require('fs');
const path = require('path');
const { createHostImports } = require(path.join(__dirname, '..', 'lib/host-imports'));

async function main() {
  // Build if needed
  const ROOT = path.join(__dirname, '..');
  const WASM_PATH = path.join(ROOT, 'build', 'wine-assembly.wasm');
  const srcDir = path.join(ROOT, 'src', 'parts');
  let wasmTime = 0;
  try { wasmTime = fs.statSync(WASM_PATH).mtimeMs; } catch (_) {}
  const watFiles = fs.readdirSync(srcDir).filter(f => f.endsWith('.wat'));
  if (watFiles.some(f => fs.statSync(path.join(srcDir, f)).mtimeMs > wasmTime)) {
    console.log('Building...');
    require('child_process').execSync('bash tools/build.sh', { cwd: ROOT, stdio: 'inherit' });
  }

  const wasmBytes = fs.readFileSync(WASM_PATH);
  const exeBytes = fs.readFileSync(path.join(__dirname, 'binaries', 'notepad.exe'));
  const ctx = { exports: null };
  const base = createHostImports(ctx);
  const h = base.host;
  h.exit = () => {};
  h.log = () => {};
  h.log_i32 = () => {};
  h.crash_unimplemented = () => {};

  const { instance } = await WebAssembly.instantiate(wasmBytes, { host: h });
  ctx.exports = instance.exports;
  const e = instance.exports;
  const dv = new DataView(e.memory.buffer);
  const mem = new Uint8Array(e.memory.buffer);
  mem.set(exeBytes, e.get_staging());
  e.load_pe(exeBytes.length);

  const imageBase = e.get_image_base();
  const g2w = addr => addr - imageBase + 0x12000;

  function le32(v) { return [v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF, (v >> 24) & 0xFF]; }

  // Each test gets a unique code address to avoid block cache collisions
  let codeOffset = 0;
  function runCode(bytes, setup) {
    const codeAddr = imageBase + 0x1000 + codeOffset;
    codeOffset += 256;
    const wa = g2w(codeAddr);
    for (let i = 0; i < bytes.length; i++) mem[wa + i] = bytes[i];
    mem[wa + bytes.length] = 0xC3; // ret

    const stackTop = imageBase + 0xD00000;
    e.set_esp(stackTop);
    dv.setUint32(g2w(stackTop), 0, true); // sentinel return addr
    if (setup) setup();
    e.set_eip(codeAddr);
    e.run(100000);
    if (e.get_eip() !== 0) {
      console.log(`  WARNING: code at +0x${(codeOffset-256).toString(16)} did not return (EIP=0x${e.get_eip().toString(16)})`);
    }
  }

  let pass = 0, fail = 0;
  function test(name, got, expected) {
    if ((got >>> 0) === (expected >>> 0)) {
      pass++;
    } else {
      console.log(`  FAIL ${name}: got 0x${(got>>>0).toString(16)} expected 0x${(expected>>>0).toString(16)}`);
      fail++;
    }
  }

  function memAt(addr) { return dv.getUint32(g2w(addr), true); }
  function setMem(addr, val) { dv.setUint32(g2w(addr), val, true); }

  // Helper: scratch memory addresses
  const scratch = imageBase + 0x2000;
  const scratchA = imageBase + 0x2100;
  const scratchB = imageBase + 0x2104;

  // ================================================================
  // Basic execution
  // ================================================================
  runCode([0xB8, ...le32(42)]); // mov eax, 42
  test('mov eax, imm32', e.get_eax(), 42);

  runCode([0x31, 0xC0]); // xor eax, eax
  test('xor eax, eax', e.get_eax(), 0);

  // ================================================================
  // MUL dword [mem] — unsigned 32×32→64 multiply
  // ================================================================
  setMem(scratch, 3);
  runCode([0xF7, 0x25, ...le32(scratch)], () => e.set_eax(7));
  test('MUL 7×3 lo', e.get_eax(), 21);
  test('MUL 7×3 hi', e.get_edx(), 0);

  setMem(scratch, 0xABCDEF01);
  runCode([0xF7, 0x25, ...le32(scratch)], () => e.set_eax(0x12345678));
  // Python: hex(0x12345678 * 0xABCDEF01) = 0xc379aaa55065e78
  test('MUL large lo', e.get_eax(), 0x55065E78);
  test('MUL large hi', e.get_edx(), 0x0C379AAA);

  setMem(scratch, 0xFFFFFFFF);
  runCode([0xF7, 0x25, ...le32(scratch)], () => e.set_eax(0xFFFFFFFF));
  // 0xFFFFFFFF^2 = 0xFFFFFFFE00000001
  test('MUL max lo', e.get_eax(), 0x00000001);
  test('MUL max hi', e.get_edx(), 0xFFFFFFFE);

  setMem(scratch, 0x7FFFFFFF);
  runCode([0xF7, 0x25, ...le32(scratch)], () => e.set_eax(0x7FFFFFFF));
  // 0x7FFFFFFF^2 = 0x3FFFFFFF00000001
  test('MUL 0x7FFFFFFF^2 lo', e.get_eax(), 0x00000001);
  test('MUL 0x7FFFFFFF^2 hi', e.get_edx(), 0x3FFFFFFF);

  // ================================================================
  // SHRD — double precision shift right
  // ================================================================
  runCode([0x0F, 0xAC, 0xD0, 0x1F], () => { e.set_eax(0x80000000); e.set_edx(0x12345678); });
  // shrd eax, edx, 31: eax = (eax>>31) | (edx<<1)
  test('SHRD eax,edx,31 result', e.get_eax(), 0x2468ACF1);
  test('SHRD edx unchanged', e.get_edx(), 0x12345678);

  runCode([0x0F, 0xAC, 0xD0, 0x01], () => { e.set_eax(0x00000001); e.set_edx(0x00000001); });
  // shrd eax, edx, 1: eax = (1>>1) | (1<<31) = 0x80000000
  test('SHRD by 1', e.get_eax(), 0x80000000);

  runCode([0x0F, 0xAC, 0xD0, 0x10], () => { e.set_eax(0x00000000); e.set_edx(0xFFFF0000); });
  // shrd eax, edx, 16: eax = (0>>16) | (0xFFFF0000 << 16) = 0x00000000
  test('SHRD by 16', e.get_eax(), 0x00000000);

  // ================================================================
  // SHLD — double precision shift left
  // ================================================================
  runCode([0x0F, 0xA4, 0xD0, 0x01], () => { e.set_eax(0x80000000); e.set_edx(0x00000001); });
  // shld eax, edx, 1: eax = (0x80000000<<1) | (0x00000001>>31) = 0 | 0 = 0
  test('SHLD eax,edx,1', e.get_eax(), 0x00000000);

  // ================================================================
  // STC + ADC — carry flag set/read
  // ================================================================
  runCode([0x31, 0xC0, 0xF9, 0x83, 0xD0, 0x00]); // xor eax,eax; stc; adc eax,0
  test('STC then ADC reads CF=1', e.get_eax(), 1);

  // ADC reg, reg with CF=1
  runCode([0xF9, 0x13, 0xD3], () => { e.set_edx(5); e.set_ebx(3); });
  test('ADC edx,ebx CF=1', e.get_edx(), 9);

  // ADC [mem], reg with CF=1
  setMem(scratchA, 0x10);
  runCode([0xF9, 0x11, 0x15, ...le32(scratchA)], () => e.set_edx(0x20));
  test('ADC [mem],reg CF=1', memAt(scratchA), 0x31);

  // ================================================================
  // ADD + ADC chain — carry propagation through memory
  // ================================================================
  setMem(scratchA, 0x80000000);
  setMem(scratchB, 5);
  runCode([
    0x01, 0x05, ...le32(scratchA), // add [A], eax
    0x11, 0x15, ...le32(scratchB), // adc [B], edx
  ], () => { e.set_eax(0x80000001); e.set_edx(3); });
  // 0x80000000 + 0x80000001 = 0x100000001 → [A]=1, CF=1
  // 5 + 3 + CF(1) = 9
  test('ADD+ADC chain [A]', memAt(scratchA), 1);
  test('ADD+ADC chain [B] carry', memAt(scratchB), 9);

  // Chain with no carry
  setMem(scratchA, 0x10);
  setMem(scratchB, 0x20);
  runCode([
    0x01, 0x05, ...le32(scratchA),
    0x11, 0x15, ...le32(scratchB),
  ], () => { e.set_eax(0x05); e.set_edx(0x03); });
  test('ADD+ADC no carry [A]', memAt(scratchA), 0x15);
  test('ADD+ADC no carry [B]', memAt(scratchB), 0x23);

  // ================================================================
  // INC/DEC [mem] must preserve CF
  // ================================================================
  const incAddr = imageBase + 0x2200;
  setMem(incAddr, 42);
  runCode([0xF9, 0xFF, 0x05, ...le32(incAddr), 0x83, 0xD0, 0x00], () => e.set_eax(0));
  test('INC [mem] value', memAt(incAddr), 43);
  test('INC preserves CF', e.get_eax(), 1);

  const decAddr = imageBase + 0x2300;
  setMem(decAddr, 10);
  runCode([0xF9, 0xFF, 0x0D, ...le32(decAddr), 0x83, 0xD0, 0x00], () => e.set_eax(0));
  test('DEC [mem] value', memAt(decAddr), 9);
  test('DEC preserves CF', e.get_eax(), 1);

  // ================================================================
  // SAHF/LAHF — flag load/store via AH
  // ================================================================
  // SAHF: load flags from AH. CF=bit0, ZF=bit6, SF=bit7
  runCode([0x9E], () => e.set_eax(0x0100)); // AH=0x01 → CF=1, ZF=0, SF=0
  // Read CF via adc
  runCode([0x9E, 0x83, 0xD0, 0x00], () => { e.set_eax(0x0100); }); // AH=01, then adc eax,0
  // After SAHF: CF=1. adc eax,0 → eax = 0x0100 + 0 + 1 = 0x0101
  // Wait, SAHF clobbers AH... let me restructure:
  // mov ah, 0x01; sahf; mov eax, 0; adc eax, 0
  runCode([
    0xB4, 0x41, // mov ah, 0x41 (CF=1, ZF=1)
    0x9E,       // sahf
    0xB8, ...le32(0), // mov eax, 0
    0x83, 0xD0, 0x00, // adc eax, 0
  ]);
  test('SAHF CF=1', e.get_eax(), 1);

  runCode([
    0xB4, 0x00, // mov ah, 0x00 (CF=0)
    0x9E,       // sahf
    0xB8, ...le32(0),
    0x83, 0xD0, 0x00,
  ]);
  test('SAHF CF=0', e.get_eax(), 0);

  // LAHF: store flags to AH
  runCode([
    0xF9,       // stc (CF=1)
    0x9F,       // lahf
  ]);
  test('LAHF after STC has CF', (e.get_eax() >> 8) & 1, 1);

  // ================================================================
  // Bignum multiply pattern (composite test)
  // ================================================================
  const mulSrc = imageBase + 0x2400;
  const accumLo = imageBase + 0x2410;
  const accumHi = imageBase + 0x2414;
  setMem(mulSrc, 0x7FFFFFFF);
  setMem(accumLo, 0);
  setMem(accumHi, 0);
  runCode([
    0xF7, 0x25, ...le32(mulSrc),          // mul dword [mulSrc]
    0x25, ...le32(0x7FFFFFFF),              // and eax, 0x7FFFFFFF
    0x33, 0xD2,                             // xor edx, edx
    0x33, 0xDB,                             // xor ebx, ebx
    0x03, 0xC6,                             // add eax, esi
    0x13, 0xD3,                             // adc edx, ebx
    0x01, 0x05, ...le32(accumLo),           // add [accumLo], eax
    0x11, 0x15, ...le32(accumHi),           // adc [accumHi], edx
  ], () => { e.set_eax(0x7FFFFFFF); e.set_esi(0x12345678); });
  test('Bignum pattern accumLo', memAt(accumLo), 0x12345679);
  test('Bignum pattern accumHi', memAt(accumHi), 0);

  // SHRD+SHR on mul result
  runCode([
    0x0F, 0xAC, 0xD0, 0x1F,  // shrd eax, edx, 31
    0xC1, 0xEA, 0x1F,         // shr edx, 31
  ], () => { e.set_eax(0x00000001); e.set_edx(0x3FFFFFFF); });
  test('Bignum shrd+shr eax', e.get_eax(), 0x7FFFFFFE);
  test('Bignum shrd+shr edx', e.get_edx(), 0);

  // ================================================================
  // Summary
  // ================================================================
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
