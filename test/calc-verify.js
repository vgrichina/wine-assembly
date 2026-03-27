// Consolidated calc.exe verification test
const fs = require('fs');

async function main() {
  const wasmBytes = fs.readFileSync('build/wine-assembly.wasm');
  const exeBytes = fs.readFileSync('test/binaries/calc.exe');

  let createWindowCount = 0, showWindowCount = 0, lastApi = '';
  let apiCalls = [], dialogCreated = false;
  const imports = { host: {
    log: (ptr, len) => {
      const b = new Uint8Array(mem.buffer, ptr, len);
      lastApi = new TextDecoder().decode(b).replace(/\0.*/, '').split(/\s/)[0];
      if (dialogCreated) apiCalls.push(lastApi);
    },
    log_i32: () => {},
    message_box: () => 1,
    exit: (code) => { console.log('EXIT code=' + code); },
    draw_rect: () => {}, read_file: () => 0,
    create_window: (h, s, x, y, cx, cy, tPtr, menuId) => {
      createWindowCount++;
      const bytes = new Uint8Array(mem.buffer);
      let t = ''; for (let i = tPtr; bytes[i] && i < tPtr + 100; i++) t += String.fromCharCode(bytes[i]);
      console.log(`  CreateWindow #${createWindowCount}: hwnd=0x${h.toString(16)} "${t}" ${cx}x${cy} menu=${menuId}`);
      return h;
    },
    show_window: (h, cmd) => { showWindowCount++; console.log(`  ShowWindow hwnd=0x${h.toString(16)} cmd=${cmd}`); },
    create_dialog: (h, d) => { console.log(`  CreateDialog hwnd=0x${h.toString(16)} dlg=${d}`); dialogCreated = true; return h; },
    load_string: () => 0,
    set_window_text: (h, tPtr) => {
      const bytes = new Uint8Array(mem.buffer);
      let t = ''; for (let i = tPtr; bytes[i] && i < tPtr + 100; i++) t += String.fromCharCode(bytes[i]);
      console.log(`  SetWindowText hwnd=0x${h.toString(16)} "${t}"`);
    },
    invalidate: () => {}, set_menu: (h, m) => { console.log(`  SetMenu hwnd=0x${h.toString(16)} menu=${m}`); },
    draw_text: () => {}, check_input: () => 0, check_input_lparam: () => 0, set_window_class: () => {},
  }};

  const { instance } = await WebAssembly.instantiate(wasmBytes, imports);
  const mem = instance.exports.memory;
  const e = instance.exports;
  new Uint8Array(mem.buffer, e.get_staging(), exeBytes.length).set(exeBytes);
  const entry = e.load_pe(exeBytes.length);

  const hex = v => '0x' + (v >>> 0).toString(16).padStart(8, '0');
  console.log(`Entry: ${hex(entry)}, image_base: ${hex(e.get_image_base())}`);

  // Check IAT entries for EnableWindow (0x1160) and GetDlgItem (0x1164)
  const ib = e.get_image_base() >>> 0;
  const gl32 = (ga) => { const off = ga - ib + 0x12000; return new Uint32Array(mem.buffer)[off >> 2]; };
  console.log(`IAT[0x1160] (EnableWindow) = ${hex(gl32(ib + 0x1160))}`);
  console.log(`IAT[0x1164] (GetDlgItem)   = ${hex(gl32(ib + 0x1164))}`);
  // Check a few more USER32 entries
  for (let j = 0; j < 5; j++) {
    const addr = ib + 0x10F8 + j * 4;
    console.log(`IAT[0x${(0x10F8+j*4).toString(16)}] = ${hex(gl32(addr))}`);
  }

  // Run in batches, report progress
  let BATCH = 500000, reportCount = 0;
  const start = Date.now();

  for (let i = 0; i < 200000; i++) {
    // After first window, use smaller batches to catch dialog creation
    if (createWindowCount > 0 && BATCH > 100) { BATCH = 100; }
    // After dialog created, switch to fine tracing
    if (dialogCreated && BATCH > 10) {
      console.log('\n--- Dialog created, switching to block-by-block trace ---');
      const eipTrace = [];
      for (let j = 0; j < 5000; j++) {
        const eipBefore = e.get_eip() >>> 0;
        if (eipBefore === 0) break;
        const ediBefore = e.get_edi() >>> 0;
        const espBefore = e.get_esp() >>> 0;
        try { e.run(1); } catch(err) { console.log(`CRASH: ${err.message}`); break; }
        const ediAfter = e.get_edi() >>> 0;
        const espAfter = e.get_esp() >>> 0;
        // Only log near the crash area (0x01005Dxx)
        if (eipBefore >= 0x01005d00 && eipBefore <= 0x01005dff) {
          const newApis = apiCalls.length > 0 ? ` API=${apiCalls.join(',')}` : '';
          apiCalls.length = 0;
          console.log(`  [${hex(eipBefore)}] ESP=${hex(espBefore)}→${hex(espAfter)} EDI=${hex(ediAfter)}${newApis}`);
        }
        eipTrace.push(eipBefore);
        if ((e.get_eip() >>> 0) === 0) {
          console.log(`EIP went to 0 after block at ${hex(eipBefore)}`);
          console.log(`Last 20 EIPs: ${eipTrace.slice(-20).map(hex).join(' ')}`);
          console.log(`EDI=${hex(e.get_edi())} EBX=${hex(e.get_ebx())} lastAPI=${lastApi}`);
          break;
        }
      }
      BATCH = 500000; // reset
      dialogCreated = false; // only trace once
    }
    try {
      e.run(BATCH);
    } catch (err) {
      console.log(`\nCRASH at ${(i+1)*BATCH} blocks: ${err.message}`);
      console.log(`  EIP=${hex(e.get_eip())} ESP=${hex(e.get_esp())} EAX=${hex(e.get_eax())}`);
      break;
    }

    const totalBlocks = (i + 1) * BATCH;
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);

    if (createWindowCount > 1 || showWindowCount > 0) {
      console.log(`\n*** UI PROGRESS at ${(totalBlocks/1e6).toFixed(1)}M blocks (${elapsed}s)!`);
      console.log(`  Windows: ${createWindowCount}, ShowWindow: ${showWindowCount}`);
      // Run more to see full init
      for (let j = 0; j < 20; j++) {
        try { e.run(BATCH); } catch(err) {
          console.log(`  CRASH: ${err.message}`);
          console.log(`  EIP=${hex(e.get_eip())} ESP=${hex(e.get_esp())}`);
          break;
        }
      }
      console.log(`  Final: EIP=${hex(e.get_eip())} CW=${createWindowCount} SW=${showWindowCount}`);
      return;
    }

    if (e.get_eip() === 0) {
      console.log(`\nHALTED at ${(totalBlocks/1e6).toFixed(1)}M blocks (${elapsed}s)`);
      console.log(`  EAX=${hex(e.get_eax())} ECX=${hex(e.get_ecx())} EDX=${hex(e.get_edx())}`);
      console.log(`  ESP=${hex(e.get_esp())} EBP=${hex(e.get_ebp())}`);
      console.log(`  ESI=${hex(e.get_esi())} EDI=${hex(e.get_edi())}`);
      console.log(`  lastAPI=${lastApi}`);
      // Dump stack
      const esp = e.get_esp() >>> 0;
      const ib = e.get_image_base() >>> 0;
      console.log('  Stack:');
      for (let j = 0; j < 10; j++) {
        const addr = esp + j * 4;
        const off = addr - ib + 0x12000;
        if (off >= 0 && off + 4 <= mem.buffer.byteLength) {
          const val = new Uint32Array(mem.buffer)[off >> 2];
          console.log(`    [ESP+${(j*4).toString(16)}] ${hex(val)}`);
        }
      }
      break;
    }

    if (Date.now() - start > (reportCount + 1) * 5000) { reportCount++;
      console.log(`${(totalBlocks/1e6).toFixed(0)}M blocks (${elapsed}s): EIP=${hex(e.get_eip())} lastAPI=${lastApi} CW=${createWindowCount}`);
    }
  }

  if (createWindowCount <= 1) {
    console.log(`\nStill in init after ${((Date.now()-start)/1000).toFixed(1)}s, ${createWindowCount} windows`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
