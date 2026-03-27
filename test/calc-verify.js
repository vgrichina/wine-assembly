// Consolidated calc.exe verification test
const fs = require('fs');

async function main() {
  const wasmBytes = fs.readFileSync('build/wine-assembly.wasm');
  const exeBytes = fs.readFileSync('test/binaries/calc.exe');

  let createWindowCount = 0, showWindowCount = 0, lastApi = '';
  let apiCalls = [];
  const imports = { host: {
    log: (ptr, len) => {
      const b = new Uint8Array(mem.buffer, ptr, len);
      lastApi = new TextDecoder().decode(b).replace(/\0.*/, '').split(/\s/)[0];
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
    create_dialog: (h, d) => { console.log(`  CreateDialog hwnd=0x${h.toString(16)} dlg=${d}`); return h; },
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

  // Run in batches, report progress
  const BATCH = 500000;
  const start = Date.now();

  for (let i = 0; i < 200; i++) {
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
      console.log(`  lastAPI=${lastApi}`);
      break;
    }

    if ((i + 1) % 10 === 0) {
      console.log(`${(totalBlocks/1e6).toFixed(0)}M blocks (${elapsed}s): EIP=${hex(e.get_eip())} lastAPI=${lastApi} CW=${createWindowCount}`);
    }
  }

  if (createWindowCount <= 1) {
    console.log(`\nStill in init after ${((Date.now()-start)/1000).toFixed(1)}s, ${createWindowCount} windows`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
