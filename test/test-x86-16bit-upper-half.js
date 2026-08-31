#!/usr/bin/env node
// A 16-bit operand-size op writes DI; the other half of EDI must survive
// exactly as x86 leaves it -- and MOVZX must clear it.
//
// WHY: RollerCoaster Tycoon hangs forever at 0x00433815 walking a paint-list
// that points at itself. The list is indexed by EDI, and RCT builds that index
// like this (paint_add_ps, 0x0043192a):
//
//     movzx edi, cx        ; EDI = 0x0000xxxx -- upper half CLEARED
//     add   di, ax         ; 16-bit add, upper half untouched
//     jns   ...
//     shr   di, 5
//     cmp   di, 0xff
//     xchg  [0x59f4cc+edi*4], ebx   ; <-- full 32-bit EDI addresses the table
//
// A hung session reported QuadrantBackIndex = 0xffff006b and FrontIndex =
// 0xffff007d: the low half is a perfectly good quadrant index, the upper half
// is 0xffff left over from the `mov edi,[0x8d8fc0]` two instructions earlier.
// So the list heads were written 0x3fff_xxxx bytes away from the table, the
// table stayed empty, and the arrange pass read garbage that happened to point
// at its own head node.
//
// Run: node test/test-x86-16bit-upper-half.js

const fs = require('fs');
const path = require('path');
const { createHostImports } = require(path.join(__dirname, '..', 'lib/host-imports'));
// $GUEST_BASE, from the map declared in src/00-regions.wat.
const RegionMap = require('../lib/region-map.generated.js');

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
  const memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
  const ctx = { exports: null, getMemory: () => memory.buffer };
  const h = createHostImports(ctx).host;
  h.memory = memory;
  h.exit = () => {};
  h.log = () => {};
  h.log_i32 = () => {};
  h.crash_unimplemented = () => {};
  h.wait_multiple = () => 0;

  const { instance } = await WebAssembly.instantiate(wasmBytes, { host: h });
  ctx.exports = instance.exports;
  const e = instance.exports;
  const dv = new DataView(e.memory.buffer);
  const mem = new Uint8Array(e.memory.buffer);
  mem.set(exeBytes, e.get_staging());
  e.load_pe(exeBytes.length);

  const imageBase = e.get_image_base();
  const g2w = addr => RegionMap.g2w(addr, imageBase);

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
  }

  let pass = 0, fail = 0;
  const hex = v => '0x' + (v >>> 0).toString(16).padStart(8, '0');
  function test(name, got, expected) {
    if ((got >>> 0) === (expected >>> 0)) { pass++; return; }
    console.log(`  FAIL ${name}: got ${hex(got)} expected ${hex(expected)}`);
    fail++;
  }

  // 1. MOVZX r32, r16 clears the upper half no matter what was in it.
  runCode([0x0F, 0xB7, 0xF9], () => { e.set_edi(0xFFFFFFFF); e.set_ecx(0x00000D40); });
  test('movzx edi, cx clears the upper half', e.get_edi(), 0x00000D40);

  // 2..5. The 16-bit forms leave the upper half exactly as they found it.
  runCode([0x66, 0x03, 0xF8], () => { e.set_edi(0xFFFF0D40); e.set_eax(0x11110020); });
  test('add di, ax keeps the upper half', e.get_edi(), 0xFFFF0D60);

  runCode([0x66, 0xC1, 0xEF, 0x05], () => { e.set_edi(0xFFFF0D60); });
  test('shr di, 5 keeps the upper half', e.get_edi(), 0xFFFF006B);

  runCode([0x66, 0x33, 0xFF], () => { e.set_edi(0xFFFFFFFF); });
  test('xor di, di keeps the upper half', e.get_edi(), 0xFFFF0000);

  runCode([0x66, 0xBF, 0xFF, 0x00], () => { e.set_edi(0xFFFFFFFF); });
  test('mov di, 0xff keeps the upper half', e.get_edi(), 0xFFFF00FF);

  // 6. RCT's actual index computation, upper half poisoned the way the game
  //    leaves it. The whole point of the leading MOVZX is that EDI ends up a
  //    small number, so the table index below is in range.
  runCode([
    0x0F, 0xB7, 0xF9,             // movzx edi, cx
    0x66, 0x03, 0xF8,             // add di, ax
    0x79, 0x03,                   // jns +3
    0x66, 0x33, 0xFF,             // xor di, di
    0x66, 0xC1, 0xEF, 0x05,       // shr di, 5
    0x66, 0x81, 0xFF, 0xFF, 0x00, // cmp di, 0xff
    0x76, 0x04,                   // jbe +4
    0x66, 0xBF, 0xFF, 0x00,       // mov di, 0xff
  ], () => { e.set_edi(0xFFFFFFFF); e.set_ecx(0x00000D40); e.set_eax(0x11110020); });
  test('RCT paint-quadrant index stays a small number', e.get_edi(), 0x0000006B);

  // 7. Same sequence, negative sum: the JNS falls through to `xor di,di`, so
  //    the index is 0 -- still with a clear upper half.
  runCode([
    0x0F, 0xB7, 0xF9,
    0x66, 0x03, 0xF8,
    0x79, 0x03,
    0x66, 0x33, 0xFF,
    0x66, 0xC1, 0xEF, 0x05,
  ], () => { e.set_edi(0xFFFFFFFF); e.set_ecx(0x00000010); e.set_eax(0x1111FF00); });
  test('negative sum zeroes the index, not just DI', e.get_edi(), 0x00000000);

  // 8. The same code as ONE block, the way the decoder actually sees it: a
  //    32-bit load that poisons EDI, the MOVZX, several 0x66-prefixed ops, and
  //    then an unprefixed 32-bit store of EDI. Running each instruction in its
  //    own block (cases 1-7) cannot catch a prefix that leaks from one
  //    instruction to the next, or a fused pair that only forms in context --
  //    and both would corrupt exactly the two values RCT's hung session shows.
  const poison = imageBase + 0x8200;   // 0xffffffff, like RCT's [0x8d8fc0]
  const outIdx = imageBase + 0x8204;   // 16-bit sink, like [ebp+0x14]
  const outFull = imageBase + 0x8208;  // 32-bit sink, like [0x59f8cc]
  const abs = a => [a & 0xFF, (a >> 8) & 0xFF, (a >> 16) & 0xFF, (a >> 24) & 0xFF];
  runCode([
    0x8B, 0x3D, ...abs(poison),        // mov edi, [poison]
    0x0F, 0xB7, 0xF9,                  // movzx edi, cx
    0x66, 0x03, 0xF8,                  // add di, ax
    0x79, 0x03,                        // jns +3
    0x66, 0x33, 0xFF,                  // xor di, di
    0x66, 0xC1, 0xEF, 0x05,            // shr di, 5
    0x66, 0x81, 0xFF, 0xFF, 0x00,      // cmp di, 0xff
    0x76, 0x04,                        // jbe +4
    0x66, 0xBF, 0xFF, 0x00,            // mov di, 0xff
    0x66, 0x89, 0x3D, ...abs(outIdx),  // mov [outIdx], di
    0x89, 0x3D, ...abs(outFull),       // mov [outFull], edi
  ], () => {
    e.set_edi(0x11111111); e.set_ecx(0x00000D40); e.set_eax(0x11110020);
    dv.setUint32(g2w(poison), 0xFFFFFFFF, true);
    dv.setUint32(g2w(outIdx), 0xFFFFFFFF, true);
    dv.setUint32(g2w(outFull), 0xFFFFFFFF, true);
  });
  test('in-block: EDI is a small index', e.get_edi(), 0x0000006B);
  test('in-block: 16-bit store touches 2 bytes', dv.getUint32(g2w(outIdx), true), 0xFFFF006B);
  test('in-block: 32-bit store after 0x66 ops writes 4 bytes',
    dv.getUint32(g2w(outFull), true), 0x0000006B);

  // 9. Every 16-bit form that writes DI, swept. The operands are chosen so the
  //    16-bit result has bit 15 set wherever that is possible: a handler that
  //    sign-extends its result into the full register looks perfectly correct
  //    until the result goes negative, and RCT's index arithmetic goes negative
  //    routinely (that is what its `jns` is for).
  const src = imageBase + 0x8300;
  const sweep = [
    ['add di, ax',      [0x66, 0x03, 0xF8]],
    ['sub di, ax',      [0x66, 0x2B, 0xF8]],
    ['and di, ax',      [0x66, 0x23, 0xF8]],
    ['or di, ax',       [0x66, 0x0B, 0xF8]],
    ['xor di, ax',      [0x66, 0x33, 0xF8]],
    ['adc di, ax',      [0x66, 0x13, 0xF8]],
    ['sbb di, ax',      [0x66, 0x1B, 0xF8]],
    ['add di, imm16',   [0x66, 0x81, 0xC7, 0x00, 0x90]],
    ['sub di, imm16',   [0x66, 0x81, 0xEF, 0x00, 0x90]],
    ['add di, [mem]',   [0x66, 0x03, 0x3D, ...abs(src)]],
    ['sub di, [mem]',   [0x66, 0x2B, 0x3D, ...abs(src)]],
    ['mov di, [mem]',   [0x66, 0x8B, 0x3D, ...abs(src)]],
    ['neg di',          [0x66, 0xF7, 0xDF]],
    ['not di',          [0x66, 0xF7, 0xD7]],
    ['inc di',          [0x66, 0x47]],
    ['dec di',          [0x66, 0x4F]],
    ['sar di, 1',       [0x66, 0xD1, 0xFF]],
    ['sar di, 3',       [0x66, 0xC1, 0xFF, 0x03]],
    ['shr di, 5',       [0x66, 0xC1, 0xEF, 0x05]],
    ['shl di, 1',       [0x66, 0xD1, 0xE7]],
    ['shl di, 4',       [0x66, 0xC1, 0xE7, 0x04]],
    ['rol di, 3',       [0x66, 0xC1, 0xC7, 0x03]],
    ['ror di, 3',       [0x66, 0xC1, 0xCF, 0x03]],
    ['imul di, ax',     [0x66, 0x0F, 0xAF, 0xF8]],
    ['xchg di, ax',     [0x66, 0x97]],
    ['movzx di, cl',    [0x66, 0x0F, 0xB6, 0xF9]],
    ['movsx di, cl',    [0x66, 0x0F, 0xBE, 0xF9]],
    // The memory forms take a different path through the decoder for each
    // addressing mode: absolute, [base+disp], and SIB -- and the SIB one is
    // fused into a 32-bit superinstruction, which must not fire under 0x66.
    ['movzx di, byte [mem]',      [0x66, 0x0F, 0xB6, 0x3D, ...abs(src)]],
    ['movsx di, byte [mem]',      [0x66, 0x0F, 0xBE, 0x3D, ...abs(src)]],
    ['movzx di, word [mem]',      [0x66, 0x0F, 0xB7, 0x3D, ...abs(src)]],
    ['movsx di, word [mem]',      [0x66, 0x0F, 0xBF, 0x3D, ...abs(src)]],
    ['movzx di, byte [ebx+1]',    [0x66, 0x0F, 0xB6, 0x7B, 0x01]],
    ['movsx di, byte [ebx+1]',    [0x66, 0x0F, 0xBE, 0x7B, 0x01]],
    ['movzx di, word [ebx]',      [0x66, 0x0F, 0xB7, 0x7B, 0x00]],
    ['movsx di, word [ebx]',      [0x66, 0x0F, 0xBF, 0x7B, 0x00]],
    ['movsx di, byte [ebx+esi]',  [0x66, 0x0F, 0xBE, 0x3C, 0x33]],
    ['movzx di, byte [ebx+esi]',  [0x66, 0x0F, 0xB6, 0x3C, 0x33]],
  ];
  for (const [name, bytes] of sweep) {
    runCode(bytes, () => {
      e.set_edi(0xAAAA8123);        // upper half is a marker, DI already negative
      e.set_eax(0x5555F00D);        // 16-bit source, also negative
      e.set_ecx(0x333300FE);
      e.set_ebx(src);               // base for the [base+disp] and SIB forms
      e.set_esi(0);                 // index, so [ebx+esi] is just [src]
      dv.setUint32(g2w(src), 0x7777F00D, true);
    });
    const got = e.get_edi() >>> 0;
    // xchg is the one that legitimately writes AX too; only DI's upper half is
    // under test here, in every case.
    if (((got & 0xFFFF0000) >>> 0) === 0xAAAA0000) { pass++; continue; }
    console.log(`  FAIL ${name} clobbered the upper half of EDI: got ${hex(got)} (want 0xaaaaXXXX)`);
    fail++;
  }

  // 10. The sweep only proves the upper half survived; these pin the value the
  //     low half is supposed to get, sign extension included. [src] is
  //     0x7777F00D, so byte [src] = 0x0D, byte [src+1] = 0xF0, word = 0xF00D.
  const memCase = (name, bytes, expected) => {
    runCode(bytes, () => {
      e.set_edi(0xAAAA8123);
      e.set_ebx(src);
      e.set_esi(0);
      dv.setUint32(g2w(src), 0x7777F00D, true);
    });
    test(name, e.get_edi(), expected);
  };
  memCase('movzx di, byte [mem]', [0x66, 0x0F, 0xB6, 0x3D, ...abs(src)], 0xAAAA000D);
  memCase('movsx di, byte [mem]', [0x66, 0x0F, 0xBE, 0x3D, ...abs(src)], 0xAAAA000D);
  memCase('movzx di, byte [ebx+1]', [0x66, 0x0F, 0xB6, 0x7B, 0x01], 0xAAAA00F0);
  memCase('movsx di, byte [ebx+1]', [0x66, 0x0F, 0xBE, 0x7B, 0x01], 0xAAAAFFF0);
  memCase('movsx di, byte [ebx+esi] (SIB, must not fuse)',
    [0x66, 0x0F, 0xBE, 0x3C, 0x33], 0xAAAA000D);
  memCase('movzx di, word [mem]', [0x66, 0x0F, 0xB7, 0x3D, ...abs(src)], 0xAAAAF00D);
  memCase('movsx di, word [mem]', [0x66, 0x0F, 0xBF, 0x3D, ...abs(src)], 0xAAAAF00D);
  memCase('movzx di, word [ebx]', [0x66, 0x0F, 0xB7, 0x7B, 0x00], 0xAAAAF00D);
  // The unprefixed forms must be untouched by all of the above.
  memCase('movzx edi, byte [mem] still writes 32 bits',
    [0x0F, 0xB6, 0x3D, ...abs(src)], 0x0000000D);
  memCase('movsx edi, byte [ebx+1] still writes 32 bits',
    [0x0F, 0xBE, 0x7B, 0x01], 0xFFFFFFF0);
  memCase('movsx edi, byte [ebx+esi] (fused SIB) still writes 32 bits',
    [0x0F, 0xBE, 0x3C, 0x33], 0x0000000D);
  memCase('movzx edi, word [mem] still writes 32 bits',
    [0x0F, 0xB7, 0x3D, ...abs(src)], 0x0000F00D);
  memCase('movsx edi, word [mem] still writes 32 bits',
    [0x0F, 0xBF, 0x3D, ...abs(src)], 0xFFFFF00D);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
