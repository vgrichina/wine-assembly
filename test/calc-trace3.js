// Trace: show the actual API name strings being resolved in the stuck loop
const fs = require('fs');

async function main() {
  const wasmBytes = fs.readFileSync('build/wine-assembly.wasm');
  const exeBytes = fs.readFileSync('test/binaries/calc.exe');

  let callCount = 0;
  const recentCalls = [];
  const imports = { host: {
    log: (ptr, len) => {
      const bytes = new Uint8Array(mem.buffer, ptr, len);
      const text = new TextDecoder().decode(bytes);
      callCount++;
      // Only track after we've seen lots of calls (in the stuck loop)
      if (callCount > 100) {
        recentCalls.push({ n: callCount, text: text.slice(0, 120) });
        if (recentCalls.length > 500) recentCalls.shift();
      }
    },
    log_i32: (v) => {},
    message_box: () => 1, exit: () => {},
    draw_rect: () => {}, read_file: () => 0,
    create_window: (h) => h,
    show_window: () => {}, create_dialog: (h) => h, load_string: () => 0,
    set_window_text: () => {}, invalidate: () => {}, set_menu: () => {},
    draw_text: () => {}, check_input: () => 0, check_input_lparam: () => 0, set_window_class: () => {},
  }};

  const { instance } = await WebAssembly.instantiate(wasmBytes, imports);
  const mem = instance.exports.memory;
  const e = instance.exports;
  new Uint8Array(mem.buffer, e.get_staging(), exeBytes.length).set(exeBytes);
  e.load_pe(exeBytes.length);

  // Run a lot
  for (let i = 0; i < 200; i++) e.run(1000);

  // Analyze the pattern
  console.log(`Total API dispatch calls: ${callCount}`);
  console.log(`\nLast 50 API dispatches:`);
  for (const c of recentCalls.slice(-50)) {
    console.log(`  [${c.n}] ${c.text}`);
  }

  // Extract unique API names from the log text (first word before whitespace/non-alpha)
  const apiNames = {};
  for (const c of recentCalls) {
    // The log text shows the thunk name - extract first API-like word
    const m = c.text.match(/^(\w+)/);
    if (m) apiNames[m[1]] = (apiNames[m[1]] || 0) + 1;
  }
  console.log('\nAPI frequency in recent loop:');
  for (const [name, count] of Object.entries(apiNames).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${name}: ${count}x`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
