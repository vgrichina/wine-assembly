#!/usr/bin/env node
// Test x86 instruction correctness for operations used in calc.exe's bignum multiply loop.
// Run: node test/test-x86-ops.js

const fs = require('fs');
const path = require('path');
const { createHostImports } = require(path.join(__dirname, '..', 'lib/host-imports'));
// $GUEST_BASE, from the map declared in src/00-regions.wat.
const RegionMap = require('../lib/region-map.generated.js');

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
  const g2w = addr => RegionMap.g2w(addr, imageBase);

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
  const sseA = imageBase + 0x9000;
  const sseB = imageBase + 0x9020;
  const sseOut = imageBase + 0x9040;

  // ================================================================
  // Basic execution
  // ================================================================
  runCode([0xB8, ...le32(42)]); // mov eax, 42
  test('mov eax, imm32', e.get_eax(), 42);

  runCode([0x31, 0xC0]); // xor eax, eax
  test('xor eax, eax', e.get_eax(), 0);

  // PREFETCH instructions are non-faulting hints. The decoder must accept
  // them as NOPs while still consuming the complete ModRM/SIB/displacement.
  runCode([
    0x0F, 0x18, 0x84, 0x8D, ...le32(0x12345678), // prefetchnta [ebp+ecx*4+disp32]
    0xB8, ...le32(0x51A7C0DE),                    // mov eax, sentinel
  ]);
  test('prefetchnta consumes its full effective-address encoding', e.get_eax(), 0x51A7C0DE);

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

  // Jazz's CPUID-selected memcpy overlaps two exact qword payloads on the x87
  // stack and swaps them back into source order before storing. FXCH must move
  // the raw-i64 shadows too; otherwise both stores round through f64's 53-bit
  // significand and turn 0x0a0a0a0a0a0a0a0a into 0x0a0a0a0a0a0a0a00.
  const fpuCopyA = new Array(8).fill(0x0A);
  const fpuCopyB = [0x1B, 0x2C, 0x3D, 0x4E, 0x5F, 0x60, 0x71, 0x82];
  setBytes(scratch, [...fpuCopyA, ...fpuCopyB]);
  setBytes(scratchA, new Array(16).fill(0));
  runCode([
    0xDF, 0x2D, ...le32(scratch),      // fild qword ptr [scratch]
    0xDF, 0x2D, ...le32(scratch + 8),  // fild qword ptr [scratch+8]
    0xD9, 0xC9,                        // fxch st(1)
    0xDF, 0x3D, ...le32(scratchA),     // fistp qword ptr [scratchA]
    0xDF, 0x3D, ...le32(scratchA + 8), // fistp qword ptr [scratchA+8]
  ]);
  testBytes('FXCH preserves paired raw FILD/FISTP m64 payloads',
    bytesAt(scratchA, 16), [...fpuCopyA, ...fpuCopyB]);

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

  // Half-Life's software renderer reaches this indexed stack form during its
  // first active frame. Keep the exact D9 5C 35 DC encoding covered: the SIB
  // index is ESI, the base is EBP, and the signed displacement is -0x24.
  runCode([
    0xD9, 0x44, 0x35, 0xE8, // fld  dword ptr [ebp+esi-0x18]
    0xD9, 0x5C, 0x35, 0xDC, // fstp dword ptr [ebp+esi-0x24]
  ], () => {
    const frame = imageBase + 0xCFF000;
    e.set_ebp(frame);
    e.set_esi(1);
    dv.setFloat32(g2w(frame + 1 - 0x18), 17.25, true);
    dv.setFloat32(g2w(frame + 1 - 0x24), 0, true);
  });
  testFloat('x87 SIB stack FLD/FSTP preserves float32',
    dv.getFloat32(g2w(imageBase + 0xCFF000 + 1 - 0x24), true), 17.25);

  // VBRUN100 checks FXAM's C1 sign bit before evaluating a negative base.
  // The condition-code mask is C3:C2:C1:C0 at status bits 14,10,9,8.
  const fxamStatus = value => {
    setFloat(scratch, value);
    runCode([
      0xDD, 0x05, ...le32(scratch), // fld qword ptr [scratch]
      0xD9, 0xE5,                   // fxam
      0xDF, 0xE0,                   // fnstsw ax
      0xDD, 0xD8,                   // fstp st(0)
    ]);
    return e.get_eax() & 0x4700;
  };
  test('FXAM classifies positive normal', fxamStatus(10), 0x0400);
  test('FXAM preserves negative-normal sign in C1', fxamStatus(-10), 0x0600);
  test('FXAM classifies positive zero', fxamStatus(0), 0x4000);
  test('FXAM preserves negative-zero sign in C1', fxamStatus(-0), 0x4200);
  test('FXAM classifies positive infinity', fxamStatus(Infinity), 0x0500);

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

  // CLC/STC/CMC modify CF only. DOSBox's dynamic core uses this exact shape
  // when it checks available CauseWay pages: cmp; stc; pushfd; jz. STC used to
  // replace the entire lazy-flag state, turning the nonzero CMP into ZF=1.
  runCode([
    0xB8, ...le32(0),                    // mov eax,0 (failure result)
    0xBA, ...le32(0xFFFFFFFF),           // mov edx,-1
    0x81, 0xFA, ...le32(0),              // cmp edx,0 (ZF=0)
    0xF9,                                // stc (must preserve ZF=0)
    0x9C,                                // pushfd (must also preserve ZF)
    0x74, 0x08,                          // jz failure
    0x59,                                // pop ecx
    0xB8, ...le32(1),                    // mov eax,1
    0xEB, 0x06,                          // jmp done
    0x59,                                // failure: pop ecx
    0xB8, ...le32(0),                    // mov eax,0
  ]);
  test('CMP; STC; PUSHFD preserves clear ZF for JZ', e.get_eax(), 1);

  runCode([0x39, 0xD2, 0xF8, 0x9C, 0x58], () => e.set_edx(7));
  test('CLC preserves set ZF while clearing only CF', e.get_eax() & 0x41, 0x40);

  runCode([0x39, 0xD2, 0xF5, 0x9C, 0x58], () => e.set_edx(7));
  test('CMC preserves set ZF while toggling only CF', e.get_eax() & 0x41, 0x41);

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

  runCode([
    0xB4, 0x00,       // mov ah, 0x00 (PF=0)
    0x9E,             // sahf
    0x0F, 0x9A, 0xC0, // setp al
  ], () => e.set_eax(0));
  test('SAHF PF=0 is visible to JP/SETP', e.get_eax() & 0xFF, 0);

  runCode([
    0xB4, 0x04,       // mov ah, 0x04 (PF=1)
    0x9E,             // sahf
    0x0F, 0x9A, 0xC0, // setp al
  ], () => e.set_eax(0));
  test('SAHF PF=1 is visible to JP/SETP', e.get_eax() & 0xFF, 1);

  runCode([
    0xB4, 0x70,       // mov ah, 0x70 (ZF/TOP-like bits set, PF=0)
    0x9E,             // sahf
    0x0F, 0x9A, 0xC0, // setp al
  ], () => e.set_eax(0));
  test('SAHF PF=0 survives AH status bits', e.get_eax() & 0xFF, 0);

  runCode([
    0xB4, 0x40,       // mov ah, 0x40 (ZF=1, PF=0)
    0x9E,             // sahf
    0x0F, 0x94, 0xC0, // setz al
    0x0F, 0x9A, 0xC1, // setp cl
  ], () => { e.set_eax(0); e.set_ecx(0); });
  test('SAHF ZF=1 is independent of PF', e.get_eax() & 0xFF, 1);
  test('SAHF PF=0 is independent of ZF', e.get_ecx() & 0xFF, 0);

  runCode([
    0xB4, 0x04,       // mov ah, 0x04 (ZF=0, PF=1)
    0x9E,             // sahf
    0x0F, 0x94, 0xC0, // setz al
    0x0F, 0x9A, 0xC1, // setp cl
  ], () => { e.set_eax(0); e.set_ecx(0); });
  test('SAHF ZF=0 is independent of PF', e.get_eax() & 0xFF, 0);
  test('SAHF PF=1 is independent of ZF', e.get_ecx() & 0xFF, 1);

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
  // EFLAGS round trip through pushfd/popfd
  // ================================================================
  //
  // The interpreter models six flags lazily and used to synthesise EFLAGS from
  // those alone, so every other bit read back as zero. That silently breaks the
  // standard "do we have CPUID?" probe, which toggles bit 21 (ID), pushes the
  // flags and compares: the toggle never survived, so programs concluded the
  // CPU predates CPUID. Allegro does this, and it is why Liquid War never ran
  // the cpuid its own binary contains.

  // pushfd; pop eax; mov edx,eax; xor eax,0x200000; push eax; popfd;
  // pushfd; pop eax; xor eax,edx  — nonzero iff the ID bit toggled.
  runCode([0x9C, 0x58, 0x89, 0xC2, 0x35, ...le32(0x200000), 0x50, 0x9D,
           0x9C, 0x58, 0x31, 0xD0]);
  test('EFLAGS bit 21 (ID) survives a pushfd/popfd round trip',
    e.get_eax() >>> 0, 0x200000);

  // Same shape on an unmodelled bit that is not the ID bit: bit 18 (AC).
  runCode([0x9C, 0x58, 0x89, 0xC2, 0x35, ...le32(0x40000), 0x50, 0x9D,
           0x9C, 0x58, 0x31, 0xD0]);
  test('EFLAGS bit 18 (AC) survives a pushfd/popfd round trip',
    e.get_eax() >>> 0, 0x40000);

  // Restoring flags must still restore the ones we do model: stc; pushfd;
  // clc; popfd; setc al.
  runCode([0xF9, 0x9C, 0xF8, 0x9D, 0x0F, 0x92, 0xC0]);
  test('popfd restores CF from the pushed word', e.get_eax() & 0xFF, 1);

  // ...and the arithmetic flags must not be frozen by the extra-bit store:
  // popfd a word with ZF set, then add 1 to a non-zero register and check ZF
  // reflects the add, not the popped word. mov eax,0x40; push eax; popfd;
  // mov ecx,5; add ecx,1; setz al.
  runCode([0xB8, ...le32(0x40), 0x50, 0x9D, 0xB9, ...le32(5), 0x83, 0xC1, 0x01,
           0x0F, 0x94, 0xC0]);
  test('a later ALU op still owns ZF after popfd', e.get_eax() & 0xFF, 0);

  // PF is reported in the pushed word, and agrees with JP: 0x03 has two bits
  // set, so parity is even. mov al,1; add al,2; pushfd; pop eax; and eax,4.
  runCode([0xB0, 0x01, 0x04, 0x02, 0x9C, 0x58, 0x83, 0xE0, 0x04]);
  test('pushfd reports PF (even parity)', e.get_eax() >>> 0, 4);

  // 0x07 has three bits set — odd parity, PF clear.
  runCode([0xB0, 0x01, 0x04, 0x06, 0x9C, 0x58, 0x83, 0xE0, 0x04]);
  test('pushfd reports PF (odd parity)', e.get_eax() >>> 0, 0);

  // ================================================================
  // RDTSC and the CPUID feature word
  // ================================================================
  //
  // RDTSC used to be decoded as mov eax,0 / mov edx,0. The value itself is not
  // what matters -- the usual idiom is two reads subtracted, so a repeat is a
  // divide-by-zero or an infinite calibration spin. These assert the counter
  // moves, and that the feature word only claims instructions we execute.

  // rdtsc; mov esi,eax; mov edi,edx; rdtsc — second read into eax/edx.
  runCode([0x0F, 0x31, 0x89, 0xC6, 0x89, 0xD7, 0x0F, 0x31]);
  const tsc1 = e.get_esi() >>> 0, tsc1hi = e.get_edi() >>> 0;
  const tsc2 = e.get_eax() >>> 0, tsc2hi = e.get_edx() >>> 0;
  test('rdtsc advances between two reads',
    tsc2hi > tsc1hi || (tsc2hi === tsc1hi && tsc2 > tsc1), true);
  test('rdtsc is non-zero', tsc1 !== 0 || tsc1hi !== 0, true);

  // cpuid leaf 0 → "GenuineIntel" in EBX/EDX/ECX.
  runCode([0x31, 0xC0, 0x0F, 0xA2]);
  test('cpuid leaf 0 EBX = "Genu"', e.get_ebx() >>> 0, 0x756E6547);
  test('cpuid leaf 0 EDX = "ineI"', e.get_edx() >>> 0, 0x49656E69);
  test('cpuid leaf 0 ECX = "ntel"', e.get_ecx() >>> 0, 0x6C65746E);
  test('cpuid leaf 0 reports leaf 1 as the max', e.get_eax() >>> 0, 1);

  // cpuid leaf 1 → signature + features. Each asserted bit names something the
  // interpreter implements; SSE stays clear so the MMX-extension opcodes we do
  // not decode stay unreachable.
  runCode([0xB8, ...le32(1), 0x0F, 0xA2]);
  const feat = e.get_edx() >>> 0;
  const family = (e.get_eax() >>> 8) & 0xF;
  test('cpuid leaf 1 reports family 6 (CMOV is a family 6 addition)', family, 6);
  test('cpuid advertises FPU', feat & 1, 1);
  test('cpuid advertises TSC now that RDTSC is real', (feat >>> 4) & 1, 1);
  test('cpuid advertises CX8 (CMPXCHG8B)', (feat >>> 8) & 1, 1);
  test('cpuid advertises CMOV', (feat >>> 15) & 1, 1);
  test('cpuid advertises MMX', (feat >>> 23) & 1, 1);
  test('cpuid does not advertise SSE', (feat >>> 25) & 1, 0);

  // Extended leaves must stay absent — that is what denies 3DNow.
  runCode([0xB8, ...le32(0x80000000), 0x0F, 0xA2]);
  test('cpuid reports no extended leaves', e.get_eax() >>> 0, 0);

  // ================================================================
  // SSE base: MOVUPS/MOVAPS and XORPS
  // ================================================================
  // CPUID intentionally stays conservative above: SDL2 itself is compiled
  // with these baseline operations even when it does not select an SSE path.
  const sseBytesA = [
    0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77,
    0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff,
  ];
  const sseBytesB = [
    0xff, 0xee, 0xdd, 0xcc, 0xbb, 0xaa, 0x99, 0x88,
    0x77, 0x66, 0x55, 0x44, 0x33, 0x22, 0x11, 0x00,
  ];
  setBytes(sseA, sseBytesA);
  setBytes(sseB, sseBytesB);
  runCode([
    0x0f, 0x10, 0x05, ...le32(sseA),       // movups xmm0,[sseA]
    0x0f, 0x10, 0x0d, ...le32(sseB),       // movups xmm1,[sseB]
    0x0f, 0x57, 0xc1,                      // xorps xmm0,xmm1
    0x0f, 0x11, 0x05, ...le32(sseOut),     // movups [sseOut],xmm0
  ]);
  testBytes('MOVUPS + register XORPS preserves all 128 bits',
    bytesAt(sseOut, 16), sseBytesA.map((v, i) => v ^ sseBytesB[i]));

  setBytes(sseOut, new Array(16).fill(0xff));
  runCode([
    0x0f, 0x28, 0x05, ...le32(sseA),       // movaps xmm0,[sseA]
    0x0f, 0x57, 0x05, ...le32(sseA),       // xorps xmm0,[sseA]
    0x0f, 0x29, 0x05, ...le32(sseOut),     // movaps [sseOut],xmm0
  ]);
  testBytes('MOVAPS + memory XORPS clears all four lanes',
    bytesAt(sseOut, 16), new Array(16).fill(0));

  setBytes(sseOut, new Array(16).fill(0x7a));
  runCode([
    0x0f, 0x10, 0x05, ...le32(sseA),       // movups xmm0,[sseA]
    0xf3, 0x0f, 0x10, 0x05, ...le32(sseB), // movss xmm0,dword [sseB]
    0xf3, 0x0f, 0x11, 0x05, ...le32(sseOut), // movss dword [sseOut],xmm0
    0x0f, 0x11, 0x05, ...le32(sseOut + 16), // movups [sseOut+16],xmm0
  ]);
  testBytes('MOVSS absolute load/store changes only the low lane',
    bytesAt(sseOut, 4), sseBytesB.slice(0, 4));
  testBytes('MOVSS preserves the destination upper 96 bits',
    bytesAt(sseOut + 20, 12), sseBytesA.slice(4));

  runCode([
    0x0f, 0x10, 0x05, ...le32(sseA),       // movups xmm0,[sseA]
    0x0f, 0x10, 0x0d, ...le32(sseB),       // movups xmm1,[sseB]
    0x0f, 0x14, 0xc1,                      // unpcklps xmm0,xmm1
    0x0f, 0x11, 0x05, ...le32(sseOut),     // movups [sseOut],xmm0
  ]);
  testBytes('UNPCKLPS interleaves the low two 32-bit lanes',
    bytesAt(sseOut, 16), [
      ...sseBytesA.slice(0, 4), ...sseBytesB.slice(0, 4),
      ...sseBytesA.slice(4, 8), ...sseBytesB.slice(4, 8),
    ]);

  runCode([
    0x0f, 0x10, 0x05, ...le32(sseA),       // movups xmm0,[sseA]
    0x0f, 0x10, 0x0d, ...le32(sseB),       // movups xmm1,[sseB]
    0x0f, 0xc6, 0xc1, 0x1b,                // shufps xmm0,xmm1,0x1b
    0x0f, 0x11, 0x05, ...le32(sseOut),     // movups [sseOut],xmm0
  ]);
  testBytes('SHUFPS register form selects lanes from both original operands',
    bytesAt(sseOut, 16), [
      ...sseBytesA.slice(12, 16), ...sseBytesA.slice(8, 12),
      ...sseBytesB.slice(4, 8), ...sseBytesB.slice(0, 4),
    ]);

  runCode([
    0x0f, 0x10, 0x05, ...le32(sseA),       // movups xmm0,[sseA]
    0x0f, 0xc6, 0x05, ...le32(sseB), 0xaa, // shufps xmm0,[sseB],0xaa
    0x0f, 0x11, 0x05, ...le32(sseOut),     // movups [sseOut],xmm0
  ]);
  testBytes('SHUFPS memory form consumes imm8 after the effective address',
    bytesAt(sseOut, 16), [
      ...sseBytesA.slice(8, 12), ...sseBytesA.slice(8, 12),
      ...sseBytesB.slice(8, 12), ...sseBytesB.slice(8, 12),
    ]);

  [1, -2, 3.5, 4].forEach((v, i) => dv.setFloat32(g2w(sseA + i * 4), v, true));
  [2, 3, -4, 0.5].forEach((v, i) => dv.setFloat32(g2w(sseB + i * 4), v, true));
  runCode([
    0x0f, 0x10, 0x05, ...le32(sseA),       // movups xmm0,[sseA]
    0x0f, 0x10, 0x0d, ...le32(sseB),       // movups xmm1,[sseB]
    0x0f, 0x58, 0xc1,                      // addps xmm0,xmm1
    0x0f, 0x59, 0x05, ...le32(sseB),       // mulps xmm0,[sseB]
    0x0f, 0x11, 0x05, ...le32(sseOut),     // movups [sseOut],xmm0
  ]);
  [6, 3, 2, 2.25].forEach((expected, i) =>
    testFloat(`ADDPS register + MULPS memory lane ${i}`,
      dv.getFloat32(g2w(sseOut + i * 4), true), expected));
  setBytes(sseA, sseBytesA);
  setBytes(sseB, sseBytesB);

  runCode([
    0x0f, 0x10, 0x05, ...le32(sseA),       // movups xmm0,[sseA]
    0x0f, 0x16, 0x05, ...le32(sseB),       // movhps xmm0,qword [sseB]
    0x0f, 0x17, 0x05, ...le32(sseOut),     // movhps qword [sseOut],xmm0
    0x0f, 0x11, 0x05, ...le32(sseOut + 16), // movups [sseOut+16],xmm0
  ]);
  testBytes('MOVHPS memory load replaces and store selects the high 64 bits',
    bytesAt(sseOut, 8), sseBytesB.slice(0, 8));
  testBytes('MOVHPS preserves the destination low 64 bits',
    bytesAt(sseOut + 16, 16), [...sseBytesA.slice(0, 8), ...sseBytesB.slice(0, 8)]);

  runCode([
    0x0f, 0x10, 0x05, ...le32(sseA),       // movups xmm0,[sseA]
    0x0f, 0x10, 0x0d, ...le32(sseB),       // movups xmm1,[sseB]
    0x0f, 0x16, 0xc1,                      // movlhps xmm0,xmm1
    0x0f, 0x11, 0x05, ...le32(sseOut),     // movups [sseOut],xmm0
  ]);
  testBytes('MOVLHPS copies the source low 64 bits into the destination high half',
    bytesAt(sseOut, 16), [...sseBytesA.slice(0, 8), ...sseBytesB.slice(0, 8)]);

  dv.setFloat32(g2w(sseA), 19.875, true);
  dv.setFloat32(g2w(sseA + 4), -7.75, true);
  runCode([
    0x0f, 0x2c, 0x05, ...le32(sseA),       // cvttps2pi mm0,qword [sseA]
    0x0f, 0x7f, 0x05, ...le32(sseOut),     // movq [sseOut],mm0
    0xf3, 0x0f, 0x2c, 0x05, ...le32(sseA + 4), // cvttss2si eax,dword [sseA+4]
  ]);
  test('CVTTPS2PI truncates the low packed float', memAt(sseOut), 19);
  test('CVTTPS2PI truncates the high packed float', memAt(sseOut + 4), -7);
  test('CVTTSS2SI truncates a scalar float toward zero', e.get_eax(), -7);

  // ================================================================
  // Sized ALU with a memory operand — flags come from the operand width
  // ================================================================
  // The register forms mask the result to 8/16 bits before publishing flags;
  // the memory forms used to hand the full 32-bit result to the lazy-flag
  // machinery, so `add al,[edi]` never reported a carry out of the byte and
  // reported ZF=0 for a result that was zero in AL. Each case below is chosen
  // so the 32-bit answer and the sized answer disagree.
  const flagBuf = imageBase + 0x8600;
  const memByte = v => () => { e.set_edi(flagBuf); mem[g2w(flagBuf)] = v; };

  runCode([
    0xB0, 0xF0,             // mov al, 0xF0
    0x02, 0x07,             // add al, [edi]
    0x0F, 0x92, 0xC1,       // setc cl
  ], memByte(0x34));
  test('add al,[edi] result', e.get_eax() & 0xFF, 0x24);
  test('add al,[edi] sets CF on a byte carry', e.get_ecx() & 0xFF, 1);

  runCode([
    0xB0, 0xF0,             // mov al, 0xF0
    0x02, 0x07,             // add al, [edi]
    0x0F, 0x94, 0xC1,       // setz cl
  ], memByte(0x10));
  test('add al,[edi] wrapping to zero sets ZF', e.get_ecx() & 0xFF, 1);

  runCode([
    0xB0, 0x7F,             // mov al, 0x7F
    0x02, 0x07,             // add al, [edi]
    0x0F, 0x90, 0xC1,       // seto cl
  ], memByte(0x01));
  test('add al,[edi] sets OF on signed byte overflow', e.get_ecx() & 0xFF, 1);

  runCode([
    0xB0, 0x20,             // mov al, 0x20
    0x00, 0x07,             // add [edi], al
    0x0F, 0x92, 0xC1,       // setc cl
  ], memByte(0xF0));
  test('add [edi],al stores the byte result', mem[g2w(flagBuf)], 0x10);
  test('add [edi],al sets CF on a byte carry', e.get_ecx() & 0xFF, 1);

  // A sign-extended imm8 must be compared as a byte, not as 0xFFFFFF80.
  runCode([
    0x80, 0x3F, 0x80,       // cmp byte [edi], 0x80
    0x0F, 0x92, 0xC1,       // setc cl
  ], memByte(0x90));
  test('cmp byte [edi],0x80 compares within the byte', e.get_ecx() & 0xFF, 0);

  // ADC's carry has to come out of the operand width: 0xFF + CF does not wrap
  // 32 bits, which is the only wrap $do_alu32 could see.
  runCode([
    0xF9,                   // stc
    0xB0, 0x10,             // mov al, 0x10
    0x12, 0x07,             // adc al, [edi]
    0x0F, 0x92, 0xC1,       // setc cl
  ], memByte(0xFF));
  test('adc al,[edi] result', e.get_eax() & 0xFF, 0x10);
  test('adc al,[edi] sets CF when b+CF exceeds the byte', e.get_ecx() & 0xFF, 1);

  runCode([
    0xF9,                   // stc
    0xB0, 0x00,             // mov al, 0
    0x1A, 0x07,             // sbb al, [edi]
    0x0F, 0x92, 0xC1,       // setc cl
  ], memByte(0xFF));
  test('sbb al,[edi] result', e.get_eax() & 0xFF, 0x00);
  test('sbb al,[edi] sets CF when b+CF exceeds a', e.get_ecx() & 0xFF, 1);

  runCode([
    0x66, 0xB8, 0x00, 0xF0, // mov ax, 0xF000
    0x66, 0x03, 0x07,       // add ax, [edi]
    0x0F, 0x92, 0xC1,       // setc cl
  ], () => { e.set_edi(flagBuf); dv.setUint16(g2w(flagBuf), 0x2000, true); });
  test('add ax,[edi] result', e.get_eax() & 0xFFFF, 0x1000);
  test('add ax,[edi] sets CF on a word carry', e.get_ecx() & 0xFF, 1);

  runCode([
    0xF9,                   // stc
    0x66, 0xB8, 0x10, 0x00, // mov ax, 0x10
    0x66, 0x13, 0x07,       // adc ax, [edi]
    0x0F, 0x92, 0xC1,       // setc cl
  ], () => { e.set_edi(flagBuf); dv.setUint16(g2w(flagBuf), 0xFFFF, true); });
  test('adc ax,[edi] result', e.get_eax() & 0xFFFF, 0x0010);
  test('adc ax,[edi] sets CF when b+CF exceeds the word', e.get_ecx() & 0xFF, 1);

  // ================================================================
  // Summary
  // ================================================================
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
