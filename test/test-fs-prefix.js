#!/usr/bin/env node
// Tests that FS-segment prefix (0x64) is honored across the memory-EA paths
// that previously bypassed `apply_seg_override` (TEST/CMP/MOVZX/CMPXCHG/XADD,
// plus baseline MOV). After centralizing seg adj inside $decode_modrm, every
// instruction with a memory operand should resolve FS:[disp] to fs_base+disp.

const fs = require('fs');
const path = require('path');
const { createHostImports } = require(path.join(__dirname, '..', 'lib/host-imports'));

async function main() {
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
  const memory = new WebAssembly.Memory({ initial: 2048, maximum: 2048, shared: true });
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
  const g2w = a => a - imageBase + 0x12000;
  const fsBase = e.get_fs_base();
  if (!fsBase) { console.log('FAIL fs_base not initialized'); process.exit(1); }

  function le32(v) { return [v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF, (v >> 24) & 0xFF]; }
  let codeOffset = 0;
  function runCode(bytes, setup) {
    const codeAddr = imageBase + 0x1000 + codeOffset;
    codeOffset += 256;
    const wa = g2w(codeAddr);
    for (let i = 0; i < bytes.length; i++) mem[wa + i] = bytes[i];
    mem[wa + bytes.length] = 0xC3;
    const stackTop = imageBase + 0xD00000;
    e.set_esp(stackTop);
    dv.setUint32(g2w(stackTop), 0, true);
    if (setup) setup();
    e.set_eip(codeAddr);
    e.run(100000);
    if (e.get_eip() !== 0) {
      console.log(`  WARNING did not return EIP=0x${e.get_eip().toString(16)}`);
    }
  }

  let pass = 0, fail = 0;
  function test(name, got, expected) {
    if ((got >>> 0) === (expected >>> 0)) pass++;
    else { console.log(`  FAIL ${name}: got 0x${(got>>>0).toString(16)} expected 0x${(expected>>>0).toString(16)}`); fail++; }
  }

  // Pick FS-relative offsets that are well past the TIB fields PE loader
  // initialized (TIB self-link at +0x18, etc.) — use 0x40+ to stay clear.
  const FS_OFF_A = 0x40;
  const FS_OFF_B = 0x44;
  const FS_OFF_BYTE = 0x48;

  const setFsDword = (off, v) => dv.setUint32(g2w(fsBase + off), v >>> 0, true);
  const getFsDword = off => dv.getUint32(g2w(fsBase + off), true);
  const setFsByte = (off, v) => { mem[g2w(fsBase + off)] = v & 0xFF; };

  // ----- Baseline: FS:[disp] mov works at all (already worked pre-fix) -----
  setFsDword(FS_OFF_A, 0xDEADBEEF);
  // 64 A1 disp32 — mov eax, FS:[disp32]
  runCode([0x64, 0xA1, ...le32(FS_OFF_A)]);
  test('FS mov eax,[disp]', e.get_eax(), 0xDEADBEEF);

  // 64 8B 05 disp32 — mov eax, FS:[disp32] (modrm form)
  runCode([0x64, 0x8B, 0x05, ...le32(FS_OFF_A)]);
  test('FS mov eax,[modrm]', e.get_eax(), 0xDEADBEEF);

  // ----- TEST FS:[disp], imm32 — previously dropped FS prefix -----
  // 64 F7 05 disp32 imm32 — test [disp], imm
  setFsDword(FS_OFF_A, 0x000000F0);
  runCode([0x64, 0xF7, 0x05, ...le32(FS_OFF_A), ...le32(0x0F)], () => { e.set_eax(0); });
  // ZF should be 1 (0xF0 & 0x0F == 0). Read flags via SETcc.
  // But simpler: rerun with non-zero AND
  runCode([0x64, 0xF7, 0x05, ...le32(FS_OFF_A), ...le32(0xF0), 0x0F, 0x94, 0xC0], () => { e.set_eax(0); });
  // setz al => al=1 if 0xF0&0xF0!=0 → ZF=0 → al=0
  test('FS test sets ZF=0', e.get_eax() & 0xFF, 0);

  setFsDword(FS_OFF_A, 0x000000F0);
  runCode([0x64, 0xF7, 0x05, ...le32(FS_OFF_A), ...le32(0x0F), 0x0F, 0x94, 0xC0], () => { e.set_eax(0); });
  test('FS test sets ZF=1', e.get_eax() & 0xFF, 1);

  // ----- CMP FS:[disp], reg — previously dropped FS prefix -----
  setFsDword(FS_OFF_A, 0x12345678);
  // 64 39 05 disp32 — cmp FS:[disp], eax. Then setz al.
  runCode([0x64, 0x39, 0x05, ...le32(FS_OFF_A), 0x0F, 0x94, 0xC0],
    () => { e.set_eax(0x12345678); });
  test('FS cmp equal', e.get_eax() & 0xFF, 1);

  runCode([0x64, 0x39, 0x05, ...le32(FS_OFF_A), 0x0F, 0x94, 0xC0],
    () => { e.set_eax(0x12345677); });
  test('FS cmp unequal', e.get_eax() & 0xFF, 0);

  // ----- MOVZX FS:[byte disp] — previously dropped FS prefix -----
  setFsByte(FS_OFF_BYTE, 0xAB);
  // 64 0F B6 05 disp32 — movzx eax, byte FS:[disp]
  runCode([0x64, 0x0F, 0xB6, 0x05, ...le32(FS_OFF_BYTE)]);
  test('FS movzx byte', e.get_eax(), 0xAB);

  // ----- MOVSX FS:[byte disp] -----
  setFsByte(FS_OFF_BYTE, 0xFF);
  runCode([0x64, 0x0F, 0xBE, 0x05, ...le32(FS_OFF_BYTE)]);
  test('FS movsx byte (sign extend)', e.get_eax(), 0xFFFFFFFF);

  // ----- CMPXCHG FS:[disp], reg — previously dropped FS prefix -----
  // cmpxchg [m32], r32 : if eax == [m] then [m]=r32, ZF=1 else eax=[m], ZF=0
  setFsDword(FS_OFF_A, 0x11111111);
  // 64 0F B1 1D disp32 — cmpxchg FS:[disp], ebx (success path)
  runCode([0x64, 0x0F, 0xB1, 0x1D, ...le32(FS_OFF_A), 0x0F, 0x94, 0xC0],
    () => { e.set_eax(0x11111111); e.set_ebx(0x22222222); });
  test('FS cmpxchg success ZF', e.get_eax() & 0xFF, 1);
  test('FS cmpxchg success store', getFsDword(FS_OFF_A), 0x22222222);

  // Fail path: write ZF result into ECX (setz cl), keep EAX intact for the load check.
  setFsDword(FS_OFF_A, 0x11111111);
  runCode([0x64, 0x0F, 0xB1, 0x1D, ...le32(FS_OFF_A), 0x0F, 0x94, 0xC1],
    () => { e.set_eax(0x99999999); e.set_ebx(0x22222222); e.set_ecx(0); });
  test('FS cmpxchg fail ZF', e.get_ecx() & 0xFF, 0);
  test('FS cmpxchg fail loads', e.get_eax(), 0x11111111);
  test('FS cmpxchg fail no-store', getFsDword(FS_OFF_A), 0x11111111);

  // ----- XADD FS:[disp], reg — previously dropped FS prefix -----
  // xadd [m], r : tmp = [m]+r ; r = [m] ; [m] = tmp
  setFsDword(FS_OFF_A, 0x100);
  runCode([0x64, 0x0F, 0xC1, 0x1D, ...le32(FS_OFF_A)],
    () => { e.set_ebx(0x5); });
  test('FS xadd new mem', getFsDword(FS_OFF_A), 0x105);
  test('FS xadd old to reg', e.get_ebx(), 0x100);

  console.log(`FS-prefix tests: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
