// Find unhandled API calls hitting the fallback (48-byte log + 7 i32 dumps)
const fs = require('fs');

async function main() {
  const wasmBytes = fs.readFileSync('build/wine-assembly.wasm');
  const exeBytes = fs.readFileSync('test/binaries/calc.exe');

  const logs = [];
  const imports = { host: {
    log: (ptr, len) => {
      const bytes = new Uint8Array(mem.buffer, ptr, len);
      logs.push({ type: 'log', text: new TextDecoder().decode(bytes), len });
    },
    log_i32: (v) => { logs.push({ type: 'i32', val: v >>> 0 }); },
    message_box: () => 1, exit: (code) => { logs.push({ type: 'exit', code }); },
    draw_rect: () => {}, read_file: () => 0,
    create_window: (h) => h, show_window: () => {},
    create_dialog: (h) => h, load_string: () => 0,
    set_window_text: () => {}, invalidate: () => {}, set_menu: () => {},
    draw_text: () => {}, check_input: () => 0, check_input_lparam: () => 0, set_window_class: () => {},
  }};

  const { instance } = await WebAssembly.instantiate(wasmBytes, imports);
  const mem = instance.exports.memory;
  const e = instance.exports;
  new Uint8Array(mem.buffer, e.get_staging(), exeBytes.length).set(exeBytes);
  e.load_pe(exeBytes.length);

  // Run
  for (let i = 0; i < 300; i++) e.run(1000);

  // Find fallback patterns: a 48-byte log followed by 7 i32 entries
  const unhandled = new Set();
  for (let i = 0; i < logs.length; i++) {
    if (logs[i].type === 'log' && logs[i].len === 48) {
      // Check if next 7 are i32
      let isPattern = true;
      for (let j = 1; j <= 7 && i + j < logs.length; j++) {
        if (logs[i + j].type !== 'i32') { isPattern = false; break; }
      }
      if (isPattern) {
        const name = logs[i].text.replace(/\0.*/, '').replace(/[^\x20-\x7E]/g, '').trim();
        unhandled.add(name);
      }
    }
  }

  // Also look for 48-byte logs that contain API-like names after the 32-byte normal logs
  // Normal log is 32 bytes, fallback is 48 bytes
  console.log('Unhandled APIs hitting fallback (48-byte log + 7 i32 stack dump):');
  for (const name of unhandled) {
    console.log('  ' + name);
  }

  // Also just show distinct first-words from all 48-byte logs
  const names48 = {};
  for (const l of logs) {
    if (l.type === 'log' && l.len === 48) {
      const n = l.text.replace(/\0.*/, '').replace(/[^\x20-\x7E]/g, '').split(/\s/)[0];
      if (n) names48[n] = (names48[n] || 0) + 1;
    }
  }
  console.log('\nAll 48-byte log first words (potential fallback):');
  for (const [n, c] of Object.entries(names48).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${n}: ${c}x`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
