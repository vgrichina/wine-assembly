#!/usr/bin/env node
// Test harness: boot a PE, then call arbitrary guest functions
// Usage: node test/call-func.js --exe=test/binaries/calc.exe --boot=8000 \
//        --call=0x01011506 --args=PTR1,PTR2  (BigNum_Multiply)
//
// Or for interactive bignum testing:
//   node test/call-func.js --exe=test/binaries/calc.exe --boot=8000 --bignum-test

const fs = require('fs');
const { parseResources } = require('../lib/resources');

const args = process.argv.slice(2);
const getArg = (name, def) => { const a = args.find(a => a.startsWith(`--${name}=`)); return a ? a.split('=')[1] : def; };
const hasFlag = name => args.includes(`--${name}`);

const EXE_PATH = getArg('exe', 'test/binaries/calc.exe');
const BOOT_BATCHES = parseInt(getArg('boot', '8000'));
const CALL_ADDR = getArg('call', null);
const CALL_ARGS = getArg('args', '0,0,0,0');
const BIGNUM_TEST = hasFlag('bignum-test');

const hex = v => '0x' + (v >>> 0).toString(16).padStart(8, '0');

async function main() {
  const wasmBytes = fs.readFileSync('build/wine-assembly.wasm');
  const exeBytes = fs.readFileSync(EXE_PATH);
  const resourceJson = parseResources(exeBytes);

  let apiLog = [];
  const imports = { host: {
    log: () => {}, log_i32: (v) => { apiLog.push(v); },
    message_box: () => 1, exit: (code) => { console.log('exit(' + code + ')'); },
    draw_rect: () => {}, read_file: () => 0,
    create_window: () => 0x10001, show_window: () => {},
    dialog_loaded: () => {},
    set_window_text: () => {}, invalidate: () => {}, draw_text: () => {},
    check_input: () => 0, check_input_lparam: () => 0, check_input_hwnd: () => 0,
    set_window_class: () => {}, set_menu: () => {},
    shell_about: () => 0,
    check_dlg_button: () => {}, check_radio_button: () => {},
    gdi_create_pen: () => 1, gdi_create_solid_brush: () => 1,
    gdi_create_compat_dc: () => 1, gdi_create_compat_bitmap: () => 1, gdi_create_bitmap: () => 1,
    gdi_select_object: () => 0, gdi_delete_object: () => 1, gdi_delete_dc: () => 1,
    gdi_text_out: () => 1, gdi_rectangle: () => 1, gdi_ellipse: () => 1,
    gdi_move_to: () => 1, gdi_line_to: () => 1, gdi_arc: () => 1, gdi_bitblt: () => 1,
    set_dlg_item_text: (h, c, tp) => {
      const mem = new Uint8Array(instance.exports.memory.buffer);
      let s = '';
      for (let i = tp; mem[i]; i++) s += String.fromCharCode(mem[i]);
      if (c === 403) console.log('[display] "' + s + '"');
    },
  }};

  const { instance } = await WebAssembly.instantiate(wasmBytes, imports);
  const e = instance.exports;
  const mem = new Uint8Array(e.memory.buffer);
  mem.set(exeBytes, e.get_staging());
  const entry = e.load_pe(exeBytes.length);
  console.log('PE loaded. Entry: ' + hex(entry));

  // Boot: run until message loop or specified batch count
  console.log(`Booting ${BOOT_BATCHES} batches...`);
  for (let i = 0; i < BOOT_BATCHES; i++) {
    e.run(10000);
    if (e.get_eip() === 0) { console.log('Halted at batch ' + i); break; }
  }
  console.log('Boot done. EIP=' + hex(e.get_eip()) + ' ESP=' + hex(e.get_esp()));

  const guestBase = e.get_guest_base();
  const imageBase = e.get_image_base();
  const dv = new DataView(mem.buffer);

  // Helper: read guest memory
  function gRead32(ga) { return e.guest_read32(ga); }
  function gWrite32(ga, v) { e.guest_write32(ga, v); }
  function gReadStr(ga) {
    const wa = ga - imageBase + guestBase;
    let s = '';
    for (let i = wa; mem[i]; i++) s += String.fromCharCode(mem[i]);
    return s;
  }

  // Helper: allocate guest memory via WASM — bump from a scratch area
  // Use high stack area that won't be touched
  let scratchPtr = 0x01900000; // well above stack, below 32MB limit
  function gAlloc(size) {
    const aligned = (size + 3) & ~3;
    const ptr = scratchPtr;
    scratchPtr += aligned;
    // Zero-fill
    const wa = ptr - imageBase + guestBase;
    mem.fill(0, wa, wa + aligned);
    return ptr;
  }

  // Helper: call guest function, returns EAX
  function gCall(addr, a0 = 0, a1 = 0, a2 = 0, a3 = 0, maxBatches = 5000) {
    const savedEsp = e.get_esp(), savedEbp = e.get_ebp();
    e.call_func(addr, a0, a1, a2, a3);
    for (let i = 0; i < maxBatches; i++) {
      e.run(10000);
      if (e.get_eip() === 0) break;
    }
    const result = e.get_eax();
    // Note: ESP may have been adjusted by callee (stdcall) or not (cdecl)
    return result;
  }

  // Helper: create a simple bignum with value
  function makeBigNum(value) {
    // BigNum struct: [+0]=sign(0=pos), [+4]=size(nDigits), [+8]=alloc, [+C...]=digits[]
    // For a small value, 1 digit suffices
    const ptr = gAlloc(0x14); // enough for 1-2 digits
    gWrite32(ptr, 0);         // sign = positive
    gWrite32(ptr + 4, 1);    // size = 1 digit
    gWrite32(ptr + 8, 2);    // alloc = 2 digits capacity
    gWrite32(ptr + 0xC, value & 0xFFFFFFFF); // digit[0]
    gWrite32(ptr + 0x10, 0); // digit[1] = 0
    return ptr;
  }

  // Helper: read bignum value (first few digits)
  function readBigNum(ptr) {
    const sign = gRead32(ptr);
    const size = gRead32(ptr + 4);
    const digits = [];
    for (let i = 0; i < Math.min(size, 8); i++) {
      digits.push(gRead32(ptr + 0xC + i * 4));
    }
    return { sign, size, digits, hex: digits.map(d => (d >>> 0).toString(16).padStart(8, '0')).reverse().join('_') };
  }

  if (BIGNUM_TEST) {
    console.log('\n=== BigNum Test ===');
    console.log('Address map:');
    console.log('  BigNum_Multiply: 0x01011506');
    console.log('  BigNum_IsZero:   0x0101145A');
    console.log('  BigNum_Compare:  0x01009549');
    console.log('  BigNum_Add:      0x01010C00');

    // Create test bignums
    const a = makeBigNum(500);
    const b = makeBigNum(9);
    console.log('\nA (500):', JSON.stringify(readBigNum(a)));
    console.log('B (9):  ', JSON.stringify(readBigNum(b)));

    // Test IsZero on B
    console.log('\nIsZero(B):');
    const isZeroB = gCall(0x0101145A, b);
    console.log('  result:', isZeroB, isZeroB ? 'IS ZERO (BUG!)' : 'not zero (correct)');

    // Test IsZero on a zero bignum
    const z = makeBigNum(0);
    const isZeroZ = gCall(0x0101145A, z);
    console.log('IsZero(0):', isZeroZ, isZeroZ ? 'IS ZERO (correct)' : 'not zero (BUG!)');

    // Test multiply: 500 * 9
    // BigNum_Multiply(pp_a, p_b): pp_a = &(ptr_to_bignum_a), p_b = ptr_to_bignum_b
    // Result is allocated; *pp_a may be updated? Or result in returned ptr.
    console.log('\nMultiply(500, 9):');
    const ppA = gAlloc(4);
    gWrite32(ppA, a);        // *ppA = ptr to bignum A
    const mulResult = gCall(0x01011506, ppA, b);
    console.log('  EAX:', hex(mulResult));
    // Check if result is at the alloc'd bignum
    const resultPtr = gRead32(ppA); // might have been updated
    console.log('  *ppA:', hex(resultPtr));
    if (mulResult > 0x01000000) {
      console.log('  result bignum:', JSON.stringify(readBigNum(mulResult)));
    }
    if (resultPtr > 0x01000000 && resultPtr !== a) {
      console.log('  ppA bignum:', JSON.stringify(readBigNum(resultPtr)));
    }

    // Test add: 5 + 9
    console.log('\nAdd(5, 9):');
    const a5 = makeBigNum(5);
    const b9 = makeBigNum(9);
    const ppA5 = gAlloc(4);
    gWrite32(ppA5, a5);
    const addResult = gCall(0x01010C00, ppA5, b9, 0, 0, 20000);
    console.log('  EAX:', hex(addResult));
    const addPtr = gRead32(ppA5);
    console.log('  *ppA:', hex(addPtr));
    if (addPtr > 0x01000000) {
      console.log('  result bignum:', JSON.stringify(readBigNum(addPtr)));
    }

    console.log('\n=== Registers ===');
    console.log('EAX=' + hex(e.get_eax()), 'ECX=' + hex(e.get_ecx()),
                'EDX=' + hex(e.get_edx()), 'EBX=' + hex(e.get_ebx()));
    console.log('ESP=' + hex(e.get_esp()), 'EBP=' + hex(e.get_ebp()),
                'ESI=' + hex(e.get_esi()), 'EDI=' + hex(e.get_edi()));

  } else if (CALL_ADDR) {
    const addr = parseInt(CALL_ADDR, 16);
    const cargs = CALL_ARGS.split(',').map(s => parseInt(s, 16) || 0);
    while (cargs.length < 4) cargs.push(0);
    console.log(`\nCalling ${hex(addr)}(${cargs.map(hex).join(', ')})...`);
    const savedEsp = e.get_esp();
    e.call_func(addr, ...cargs);
    for (let i = 0; i < 10000; i++) {
      e.run(10000);
      if (e.get_eip() === 0) break;
    }
    console.log('Result: EAX=' + hex(e.get_eax()));
    console.log('ESP delta:', e.get_esp() - savedEsp);
  }
}

main().catch(e => console.error(e));
