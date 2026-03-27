// Trace calc.exe: detailed EIP + API call tracking
const fs = require('fs');

async function main() {
  const wasmBytes = fs.readFileSync('build/wine-assembly.wasm');
  const exeBytes = fs.readFileSync('test/binaries/calc.exe');

  const apiCalls = [];
  const imports = { host: {
    log: (ptr, len) => {
      const bytes = new Uint8Array(mem.buffer, ptr, len);
      const text = new TextDecoder().decode(bytes);
      apiCalls.push('LOG: ' + text.slice(0, 80));
    },
    log_i32: (v) => { apiCalls.push('i32: 0x' + (v >>> 0).toString(16)); },
    message_box: (h, tPtr, cPtr) => {
      const t = readStr(tPtr), c = readStr(cPtr);
      apiCalls.push(`MessageBox("${c}", "${t}")`);
      return 1;
    },
    exit: (code) => { apiCalls.push('ExitProcess(' + code + ')'); },
    draw_rect: (x, y, w, h, color) => { apiCalls.push(`draw_rect(${x},${y},${w},${h},0x${(color>>>0).toString(16)})`); },
    read_file: () => 0,
    create_window: (hwnd, style, x, y, cx, cy, titlePtr, menuId) => {
      const title = readStr(titlePtr);
      apiCalls.push(`CreateWindow(0x${hwnd.toString(16)}, "${title}", ${cx}x${cy}, menu=${menuId})`);
      return hwnd;
    },
    show_window: (hwnd, cmd) => { apiCalls.push(`ShowWindow(0x${hwnd.toString(16)}, ${cmd})`); },
    create_dialog: (hwnd, dlgId) => { apiCalls.push(`CreateDialog(0x${hwnd.toString(16)}, dlg=${dlgId})`); return hwnd; },
    load_string: (id, bufPtr, bufLen) => { apiCalls.push(`LoadString(${id})`); return 0; },
    set_window_text: (hwnd, textPtr) => { apiCalls.push(`SetWindowText(0x${hwnd.toString(16)}, "${readStr(textPtr)}")`); },
    invalidate: (hwnd) => { apiCalls.push(`Invalidate(0x${hwnd.toString(16)})`); },
    set_menu: (hwnd, menuResId) => { apiCalls.push(`SetMenu(0x${hwnd.toString(16)}, ${menuResId})`); },
    draw_text: (x, y, textPtr, textLen, color) => {
      const bytes = new Uint8Array(mem.buffer, textPtr, textLen);
      apiCalls.push(`DrawText(${x},${y},"${new TextDecoder().decode(bytes)}")`);
    },
    check_input: () => 0,
    check_input_lparam: () => 0, set_window_class: () => {},
  }};

  function readStr(ptr) {
    const bytes = new Uint8Array(mem.buffer);
    let s = '';
    for (let i = ptr; bytes[i] && i < ptr + 200; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }

  const { instance } = await WebAssembly.instantiate(wasmBytes, imports);
  const mem = instance.exports.memory;
  const e = instance.exports;

  new Uint8Array(mem.buffer, e.get_staging(), exeBytes.length).set(exeBytes);
  const entry = e.load_pe(exeBytes.length);
  console.log('Entry: 0x' + (entry >>> 0).toString(16));

  // Run with increasing batches, capturing API calls at each checkpoint
  const hex = v => '0x' + (v >>> 0).toString(16).padStart(8, '0');
  const checkpoints = [100, 500, 1000, 5000, 10000, 50000, 100000];

  let totalSteps = 0;
  for (const batch of checkpoints) {
    const callsBefore = apiCalls.length;
    try {
      e.run(batch);
    } catch (err) {
      console.log(`\nCRASH after ${totalSteps + batch} total steps: ${err.message}`);
      console.log(`  EIP=${hex(e.get_eip())} ESP=${hex(e.get_esp())} EAX=${hex(e.get_eax())}`);
      break;
    }
    totalSteps += batch;
    const newCalls = apiCalls.slice(callsBefore);
    const interesting = newCalls.filter(c => !c.startsWith('LOG:') && !c.startsWith('i32:'));

    console.log(`\n--- After ${totalSteps} steps: EIP=${hex(e.get_eip())} ESP=${hex(e.get_esp())} ---`);
    if (interesting.length) {
      console.log(`  New API calls (${interesting.length}):`);
      for (const c of interesting.slice(0, 20)) console.log('    ' + c);
      if (interesting.length > 20) console.log(`    ... (${interesting.length - 20} more)`);
    } else {
      console.log('  No new interesting API calls');
    }

    if (e.get_eip() === 0) { console.log('  EIP=0, halted'); break; }
  }

  // Summary of all unique API calls
  const allInteresting = apiCalls.filter(c => !c.startsWith('LOG:') && !c.startsWith('i32:'));
  console.log(`\n=== Total: ${totalSteps} steps, ${allInteresting.length} API calls ===`);
  const unique = [...new Set(allInteresting)];
  console.log('Unique API calls:');
  for (const c of unique) console.log('  ' + c);
}

main().catch(e => { console.error(e); process.exit(1); });
