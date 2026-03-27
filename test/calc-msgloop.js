// Check: does calc reach GetMessage/DispatchMessage, or is it stuck in init?
const fs = require('fs');

async function main() {
  const wasmBytes = fs.readFileSync('build/wine-assembly.wasm');
  const exeBytes = fs.readFileSync('test/binaries/calc.exe');

  const apiSeq = [];  // Track specific API calls
  const imports = { host: {
    log: (ptr, len) => {
      const bytes = new Uint8Array(mem.buffer, ptr, len);
      const text = new TextDecoder().decode(bytes);
      const name = text.replace(/\0.*/, '').replace(/[^\x20-\x7E]/g, '').split(/\s/)[0];
      apiSeq.push(name);
    },
    log_i32: () => {},
    message_box: () => 1, exit: () => {},
    draw_rect: () => {}, read_file: () => 0,
    create_window: (h) => { apiSeq.push('*CreateWindow*'); return h; },
    show_window: () => { apiSeq.push('*ShowWindow*'); },
    create_dialog: (h) => { apiSeq.push('*CreateDialog*'); return h; },
    load_string: () => { apiSeq.push('*LoadString*'); return 0; },
    set_window_text: () => { apiSeq.push('*SetWindowText*'); },
    invalidate: () => { apiSeq.push('*Invalidate*'); },
    set_menu: () => { apiSeq.push('*SetMenu*'); },
    draw_text: () => { apiSeq.push('*DrawText*'); },
    check_input: () => 0, check_input_lparam: () => 0, set_window_class: () => {},
  }};

  const { instance } = await WebAssembly.instantiate(wasmBytes, imports);
  const mem = instance.exports.memory;
  const e = instance.exports;
  new Uint8Array(mem.buffer, e.get_staging(), exeBytes.length).set(exeBytes);
  e.load_pe(exeBytes.length);

  for (let i = 0; i < 500; i++) e.run(1000);

  // Check for message loop APIs
  const interesting = ['GetMessageA', 'DispatchMessageA', 'TranslateMessage',
    'PeekMessageA', 'PostQuitMessage', 'RegisterClassExA', 'CreateWindowExA',
    'WaitForSingleObject', 'WaitForSingleObjectEx'];

  console.log('Message loop API presence:');
  for (const api of interesting) {
    const count = apiSeq.filter(a => a.startsWith(api.slice(0, 8))).length;
    console.log(`  ${api}: ${count}x`);
  }

  // Show the unique API sequence pattern
  const freq = {};
  for (const a of apiSeq) freq[a] = (freq[a] || 0) + 1;
  console.log('\nAll API call frequencies:');
  for (const [name, count] of Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 30)) {
    console.log(`  ${name}: ${count}x`);
  }

  // Show if WaitForSingleObject appears — calc uses it in its msg pump
  const waitIdx = apiSeq.findIndex(a => a.startsWith('WaitFor'));
  if (waitIdx >= 0) {
    console.log('\nFirst WaitFor* at index ' + waitIdx + ', context:');
    for (let i = Math.max(0, waitIdx - 3); i < Math.min(apiSeq.length, waitIdx + 10); i++) {
      console.log(`  [${i}] ${apiSeq[i]}`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
