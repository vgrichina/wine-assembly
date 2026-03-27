// Track EIP values in the loop to understand what code is running
const fs = require('fs');

async function main() {
  const wasmBytes = fs.readFileSync('build/wine-assembly.wasm');
  const exeBytes = fs.readFileSync('test/binaries/calc.exe');

  const imports = { host: {
    log: () => {}, log_i32: () => {},
    message_box: () => 1, exit: () => {},
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

  const hex = v => '0x' + (v >>> 0).toString(16).padStart(8, '0');

  // Run to get past init, into the loop
  for (let i = 0; i < 100; i++) e.run(1000);

  // Now sample EIP very frequently (every 1 step batch = 1 block)
  const samples = [];
  for (let i = 0; i < 500; i++) {
    e.run(1);
    samples.push(e.get_eip() >>> 0);
  }

  // Show unique EIP ranges
  const freq = {};
  for (const s of samples) freq[s] = (freq[s] || 0) + 1;
  console.log('EIP samples (1-block resolution, 500 samples):');
  for (const [addr, count] of Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 25)) {
    console.log(`  ${hex(+addr)}: ${count}x`);
  }

  // Show sequential pattern (first 50)
  console.log('\nFirst 50 EIPs:');
  for (let i = 0; i < 50; i++) {
    process.stdout.write(hex(samples[i]) + ' ');
    if ((i + 1) % 5 === 0) process.stdout.write('\n');
  }

  // Image base for reference
  console.log('\nimage_base=' + hex(e.get_image_base()));

  // Check what's at the hot EIPs by reading the bytes at those addresses
  const ib = e.get_image_base() >>> 0;
  const memBytes = new Uint8Array(mem.buffer);
  const top5 = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 5);
  console.log('\nBytes at top EIPs:');
  for (const [addr] of top5) {
    const a = +addr;
    const wasmOff = a - ib + 0x12000;
    if (wasmOff >= 0 && wasmOff + 16 < memBytes.length) {
      const bytes = Array.from(memBytes.slice(wasmOff, wasmOff + 16)).map(b => b.toString(16).padStart(2, '0')).join(' ');
      console.log(`  ${hex(a)}: ${bytes}`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
