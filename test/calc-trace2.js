// Trace calc: show ALL log messages (not just "interesting" ones) after CreateWindow
const fs = require('fs');

async function main() {
  const wasmBytes = fs.readFileSync('build/wine-assembly.wasm');
  const exeBytes = fs.readFileSync('test/binaries/calc.exe');

  const allLogs = [];
  let windowCreated = false;
  const imports = { host: {
    log: (ptr, len) => {
      const bytes = new Uint8Array(mem.buffer, ptr, len);
      const text = new TextDecoder().decode(bytes);
      allLogs.push('LOG: ' + text);
    },
    log_i32: (v) => { allLogs.push('i32: 0x' + (v >>> 0).toString(16)); },
    message_box: () => 1,
    exit: (code) => { allLogs.push('EXIT: ' + code); },
    draw_rect: () => {}, read_file: () => 0,
    create_window: (hwnd, style, x, y, cx, cy, titlePtr, menuId) => {
      const bytes = new Uint8Array(mem.buffer);
      let t = ''; for (let i = titlePtr; bytes[i] && i < titlePtr + 200; i++) t += String.fromCharCode(bytes[i]);
      allLogs.push(`CreateWindow(0x${hwnd.toString(16)}, "${t}", ${cx}x${cy})`);
      windowCreated = true;
      return hwnd;
    },
    show_window: (h, c) => { allLogs.push(`ShowWindow(0x${h.toString(16)}, ${c})`); },
    create_dialog: (h, d) => { allLogs.push(`CreateDialog(0x${h.toString(16)}, ${d})`); return h; },
    load_string: () => 0,
    set_window_text: () => {}, invalidate: () => {}, set_menu: () => {},
    draw_text: () => {},
    check_input: () => 0, check_input_lparam: () => 0, set_window_class: () => {},
  }};

  const { instance } = await WebAssembly.instantiate(wasmBytes, imports);
  const mem = instance.exports.memory;
  const e = instance.exports;
  new Uint8Array(mem.buffer, e.get_staging(), exeBytes.length).set(exeBytes);
  e.load_pe(exeBytes.length);

  // Run until window is created, then show next 200 log entries
  const hex = v => '0x' + (v >>> 0).toString(16).padStart(8, '0');

  // Run in small batches
  for (let i = 0; i < 500; i++) {
    const before = allLogs.length;
    e.run(1000);
    if (windowCreated) {
      // Run a bit more to see what happens after
      for (let j = 0; j < 50; j++) e.run(1000);
      break;
    }
  }

  // Find CreateWindow in logs and show context
  const cwIdx = allLogs.findIndex(l => l.startsWith('CreateWindow'));
  if (cwIdx >= 0) {
    console.log('=== Logs around CreateWindow ===');
    const start = Math.max(0, cwIdx - 5);
    const end = Math.min(allLogs.length, cwIdx + 100);
    for (let i = start; i < end; i++) {
      console.log(`  [${i}] ${allLogs[i]}`);
    }
  }

  console.log(`\nEIP=${hex(e.get_eip())} ESP=${hex(e.get_esp())}`);
  console.log(`Total log entries: ${allLogs.length}`);

  // Show last 20 log entries to see what it's doing now
  console.log('\n=== Last 20 log entries ===');
  for (const l of allLogs.slice(-20)) console.log('  ' + l);
}

main().catch(e => { console.error(e); process.exit(1); });
