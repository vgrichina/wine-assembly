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
  const srcDir = path.join(ROOT, 'src');
  let wasmTime = 0;
  try { wasmTime = fs.statSync(WASM_PATH).mtimeMs; } catch (_) {}
  const watFiles = fs.readdirSync(srcDir).filter(f => f.endsWith('.wat'));
  if (watFiles.some(f => fs.statSync(path.join(srcDir, f)).mtimeMs > wasmTime)) {
    console.log('Building...');
    require('child_process').execSync('bash tools/build.sh', { cwd: ROOT, stdio: 'inherit' });
  }

  const wasmBytes = fs.readFileSync(WASM_PATH);
  const exeBytes = fs.readFileSync(path.join(__dirname, 'binaries', 'notepad.exe'));
  const memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
  const ctx = { exports: null, getMemory: () => memory.buffer };
  const base = createHostImports(ctx);
  const h = base.host;
  h.memory = memory;
  h.exit = () => {};
  h.log = () => {};
  h.log_i32 = () => {};
  h.crash_unimplemented = () => {};
  h.wait_multiple = () => 0;
  h.shell_execute = () => 33;

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
  function testFloat(name, got, expected, epsilon = 1e-9) {
    if (Number.isFinite(got) && Math.abs(got - expected) <= epsilon) {
      pass++;
    } else {
      console.log(`  FAIL ${name}: got ${got} expected ${expected}`);
      fail++;
    }
  }

  function memAt(addr) { return dv.getUint32(g2w(addr), true); }
  function setMem(addr, val) { dv.setUint32(g2w(addr), val, true); }
  function setFloat(addr, val) { dv.setFloat64(g2w(addr), val, true); }
  function setByte(addr, val) { mem[g2w(addr)] = val & 0xFF; }
  function setBytes(addr, bytes) { mem.set(bytes, g2w(addr)); }
  function bytesAt(addr, len) { return Array.from(mem.subarray(g2w(addr), g2w(addr) + len)); }
  function testBytes(name, got, expected) {
    const ok = got.length === expected.length && got.every((v, i) => v === expected[i]);
    if (ok) {
      pass++;
    } else {
      console.log(`  FAIL ${name}: got [${got.map(v => '0x' + v.toString(16).padStart(2, '0')).join(', ')}] expected [${expected.map(v => '0x' + v.toString(16).padStart(2, '0')).join(', ')}]`);
      fail++;
    }
  }

  // Helper: scratch memory addresses
  const scratch = imageBase + 0x8000;
  const scratchA = imageBase + 0x8100;
  const scratchB = imageBase + 0x8104;

  // ================================================================
  // Basic execution
  // ================================================================
  runCode([0xB8, ...le32(42)]); // mov eax, 42
  test('mov eax, imm32', e.get_eax(), 42);

  runCode([0x31, 0xC0]); // xor eax, eax
  test('xor eax, eax', e.get_eax(), 0);

  // MOVZX/MOVSX preserve EFLAGS. MFC relies on this exact sequence in its
  // WM_COMMAND routing: TEST button-id; MOVZX notification-code; JZ.
  runCode([
    0x85, 0xDB,             // test ebx,ebx (ZF=0)
    0x0F, 0xB7, 0xE8,       // movzx ebp,ax (source is zero)
    0x0F, 0x94, 0xC1,       // setz cl
  ], () => { e.set_eax(0); e.set_ebx(1); e.set_ecx(0); });
  test('MOVZX r32,r16 result', e.get_ebp(), 0);
  test('MOVZX r32,r16 preserves ZF', e.get_ecx() & 0xFF, 0);

  runCode([
    0xF9,                   // stc
    0x0F, 0xBF, 0xE8,       // movsx ebp,ax
    0x0F, 0x92, 0xC1,       // setc cl
  ], () => { e.set_eax(0x8000); e.set_ecx(0); });
  test('MOVSX r32,r16 result', e.get_ebp(), 0xFFFF8000);
  test('MOVSX r32,r16 preserves CF', e.get_ecx() & 0xFF, 1);

  runCode([0x54, 0x58]); // push esp; pop eax
  test('PUSH ESP stores original ESP', e.get_eax(), imageBase + 0xD00000);

  runCode([0x06, 0x58]); // push es; pop eax
  test('PUSH ES exposes conventional flat selector', e.get_eax(), 0x23);

  runCode([0x66, 0x06, 0x66, 0x58], () => e.set_eax(0xAAAA0000)); // push es; pop ax
  test('16-bit PUSH ES/POP AX preserves upper register', e.get_eax(), 0xAAAA0023);

  runCode([0x66, 0x06, 0x66, 0x07, 0x8B, 0xC4]); // push es; pop es; mov eax,esp
  test('16-bit PUSH/POP ES preserves stack width', e.get_eax(), imageBase + 0xD00000);

  // Delphi/VCL uses x87 FILD/FISTP qword pairs as a memcpy fast path. The
  // integer payload is often a string chunk, so preserving raw bytes matters.
  const fpuCopyBytes = [0x54, 0x4d, 0x41, 0x49, 0x4e, 0x46, 0x4f, 0x52]; // "TMAINFOR"
  setBytes(scratch, fpuCopyBytes);
  setBytes(scratchA, [0, 0, 0, 0, 0, 0, 0, 0]);
  runCode([
    0xDF, 0x2D, ...le32(scratch),  // fild qword ptr [scratch]
    0xDF, 0x3D, ...le32(scratchA), // fistp qword ptr [scratchA]
  ]);
  testBytes('FILD/FISTP m64 preserves raw qword bytes', bytesAt(scratchA, 8), fpuCopyBytes);

  // QuickBlackjack stores its $20,000 house limit as a real 80-bit extended
  // constant. FLD tword must decode the sign/exponent word, not treat the
  // first 8 bytes as an f64 payload.
  setBytes(scratch, [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x40, 0x9c, 0x0d, 0x40]);
  setBytes(scratchA, [0, 0, 0, 0, 0, 0, 0, 0]);
  runCode([
    0xDB, 0x2D, ...le32(scratch),  // fld tword ptr [scratch]
    0xDD, 0x1D, ...le32(scratchA), // fstp qword ptr [scratchA]
  ]);
  testFloat('FLD m80 decodes 80-bit extended 20000.0', dv.getFloat64(g2w(scratchA), true), 20000);

  setFloat(scratch, 20000);
  setBytes(scratchA, new Array(10).fill(0));
  runCode([
    0xDD, 0x05, ...le32(scratch),  // fld qword ptr [scratch]
    0xDB, 0x3D, ...le32(scratchA), // fstp tword ptr [scratchA]
  ]);
  testBytes('FSTP m80 stores real 80-bit extended 20000.0',
    bytesAt(scratchA, 10),
    [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x40, 0x9c, 0x0d, 0x40]);

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

  const sibTable = imageBase + 0x8500;
  setMem(sibTable, 0);
  setMem(sibTable + 4, 1855);
  runCode([0xF7, 0x3C, 0x8D, ...le32(sibTable)], () => {
    e.set_eax(9275);
    e.set_edx(0);
    e.set_ecx(1);
  });
  test('IDIV dword [disp+ecx*4] quotient', e.get_eax(), 5);
  test('IDIV dword [disp+ecx*4] remainder', e.get_edx(), 0);

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

  // Group-2 immediate shifts on absolute memory use a different threaded-op
  // layout from [base+disp]. WinHelp's drive scan depends on this exact word
  // form advancing 1 -> 2 -> ... -> 0x200 before its unsigned comparison.
  setByte(scratch, 0x40);
  runCode([0xD0, 0x25, ...le32(scratch)]); // shl byte ptr [scratch], 1
  test('SHL byte ptr [abs],1', mem[g2w(scratch)], 0x80);

  setMem(scratch, 1);
  runCode([0x66, 0xD1, 0x25, ...le32(scratch)]); // shl word ptr [scratch], 1
  test('SHL word ptr [abs],1', memAt(scratch) & 0xFFFF, 2);

  setMem(scratch, 0x40000000);
  runCode([0xD1, 0x25, ...le32(scratch)]); // shl dword ptr [scratch], 1
  test('SHL dword ptr [abs],1', memAt(scratch), 0x80000000);

  setMem(scratch, 0x200);
  runCode([
    0x66, 0x81, 0x3D, ...le32(scratch), 0x00, 0x01, // cmp word ptr [scratch],0x100
    0x0F, 0x97, 0xC0,                               // seta al
  ], () => e.set_eax(0));
  test('CMP word ptr [abs],0x100 + SETA', e.get_eax() & 0xFF, 1);

  // ================================================================
  // IMUL r32, r/m32 — signed two-operand multiply
  // ================================================================
  runCode([0x0F, 0xAF, 0xD6], () => { e.set_edx(10); e.set_esi(10); });
  test('IMUL edx,esi', e.get_edx(), 100);

  runCode([0x0F, 0xAF, 0xD6], () => { e.set_edx(0xFFFFFFFF); e.set_esi(7); });
  test('IMUL edx,esi signed negative', e.get_edx(), 0xFFFFFFF9);

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
  const incAddr = imageBase + 0x8200;
  setMem(incAddr, 42);
  runCode([0xF9, 0xFF, 0x05, ...le32(incAddr), 0x83, 0xD0, 0x00], () => e.set_eax(0));
  test('INC [mem] value', memAt(incAddr), 43);
  test('INC preserves CF', e.get_eax(), 1);

  const decAddr = imageBase + 0x8300;
  setMem(decAddr, 10);
  runCode([0xF9, 0xFF, 0x0D, ...le32(decAddr), 0x83, 0xD0, 0x00], () => e.set_eax(0));
  test('DEC [mem] value', memAt(decAddr), 9);
  test('DEC preserves CF', e.get_eax(), 1);

  // ================================================================
  // CMP r/m8, imm8 — opcode 0x80 must not sign-extend byte immediates
  // ================================================================
  const cmpByteAddr = imageBase + 0x8350;
  setByte(cmpByteAddr, 0xFF);
  runCode([
    0x80, 0x3D, ...le32(cmpByteAddr), 0xFF, // cmp byte [addr], 0xff
    0x75, 0x07,                             // jne fail
    0xB8, ...le32(1),                       // mov eax, 1
    0xEB, 0x05,                             // jmp done
    0xB8, ...le32(2),                       // fail: mov eax, 2
  ]);
  test('CMP byte [mem],0xff matches 0xff', e.get_eax(), 1);

  setByte(cmpByteAddr, 0xFE);
  runCode([
    0x80, 0x3D, ...le32(cmpByteAddr), 0xFF,
    0x75, 0x07,
    0xB8, ...le32(1),
    0xEB, 0x05,
    0xB8, ...le32(2),
  ]);
  test('CMP byte [mem],0xff rejects 0xfe', e.get_eax(), 2);

  // ================================================================
  // REP MOVS overlapping forward copies use x86 propagation semantics
  // ================================================================
  const movsBytes = imageBase + 0x8500;
  setBytes(movsBytes, [1, 2, 3, 4, 5, 6, 7, 8]);
  runCode([
    0xFC,                         // cld
    0xBE, ...le32(movsBytes),     // mov esi, src
    0xBF, ...le32(movsBytes + 1), // mov edi, src+1
    0xB9, ...le32(6),             // mov ecx, 6
    0xF3, 0xA4,                   // rep movsb
  ]);
  testBytes('REP MOVSB forward overlap propagates bytes', bytesAt(movsBytes, 8), [1, 1, 1, 1, 1, 1, 1, 8]);

  const movsDwords = imageBase + 0x8520;
  setMem(movsDwords, 0x11111111);
  setMem(movsDwords + 4, 0x22222222);
  setMem(movsDwords + 8, 0x33333333);
  setMem(movsDwords + 12, 0x44444444);
  setMem(movsDwords + 16, 0x55555555);
  runCode([
    0xFC,
    0xBE, ...le32(movsDwords),
    0xBF, ...le32(movsDwords + 4),
    0xB9, ...le32(3),
    0xF3, 0xA5,                   // rep movsd
  ]);
  test('REP MOVSD overlap dword 0', memAt(movsDwords), 0x11111111);
  test('REP MOVSD overlap dword 1', memAt(movsDwords + 4), 0x11111111);
  test('REP MOVSD overlap dword 2', memAt(movsDwords + 8), 0x11111111);
  test('REP MOVSD overlap dword 3', memAt(movsDwords + 12), 0x11111111);
  test('REP MOVSD overlap dword 4', memAt(movsDwords + 16), 0x55555555);

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
  const mulSrc = imageBase + 0x8400;
  const accumLo = imageBase + 0x8410;
  const accumHi = imageBase + 0x8414;
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
  // 0x67 address-size override (16-bit addressing in 32-bit code)
  // ================================================================
  // Borland-built apps read the TIB as `mov edx, fs:[4]` encoded
  // 64 67 8b 16 04 00 — a segment override plus a 16-bit ModRM whose rm=6
  // form is a bare 16-bit displacement. Decoding that as 32-bit ModRM reads
  // two bytes too many and lands on a wrong address, so the decoder used to
  // refuse the prefix outright. Runenlegen, Winarc and the mIRC installer all
  // died on it.
  //
  // Both checks below compare the addr16 encoding against the 32-bit encoding
  // of the same access, so they assert the effective address without needing
  // to know what the TIB actually holds.

  // mov edx, fs:[4] (addr16), then mov ecx, imm32. If the displacement were
  // read as 4 bytes instead of 2, the following instruction would be decoded
  // from the wrong offset and ecx would not survive.
  runCode([0x64, 0x67, 0x8B, 0x16, 0x04, 0x00, 0xB9, ...le32(0x11223344)]);
  const addr16Edx = e.get_edx();
  test('addr16 disp16 consumes exactly two displacement bytes', e.get_ecx(), 0x11223344);

  // The 32-bit spelling of the same access: mov edx, fs:[00000004]
  runCode([0x64, 0x8B, 0x15, 0x04, 0x00, 0x00, 0x00]);
  test('addr16 disp16 forms the same address as the 32-bit encoding',
    addr16Edx, e.get_edx());

  // mov eax, fs:[0] as a 16-bit moffs (64 67 a1 00 00) — here the prefix
  // shrinks the offset operand itself rather than a ModRM.
  runCode([0x64, 0x67, 0xA1, 0x00, 0x00, 0xB9, ...le32(0x55667788)]);
  const addr16Eax = e.get_eax();
  test('addr16 moffs consumes exactly two offset bytes', e.get_ecx(), 0x55667788);

  runCode([0x64, 0xA1, 0x00, 0x00, 0x00, 0x00]);
  test('addr16 moffs reads the same address as the 32-bit encoding',
    addr16Eax, e.get_eax());

  // ================================================================
  // Summary
  // ================================================================
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
