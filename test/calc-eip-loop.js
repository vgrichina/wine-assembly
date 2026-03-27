// Sample EIP during the LocalAlloc loop to identify the function
const fs = require('fs');

async function main() {
  const wasmBytes = fs.readFileSync('build/wine-assembly.wasm');
  const exeBytes = fs.readFileSync('test/binaries/calc.exe');

  let allocCount = 0;
  let lastAllocEip = 0;
  const eipAtAlloc = [];
  const imports = { host: {
    log: (ptr, len) => {
      const bytes = new Uint8Array(mem.buffer, ptr, len);
      const name = new TextDecoder().decode(bytes).replace(/\0.*/, '').split(/\s/)[0];
      if (name === 'LocalAlloc') {
        allocCount++;
        // Record the return address (where the caller returns to)
        const esp = e.get_esp();
        const retAddr = new Uint32Array(mem.buffer, esp & ~3, 1)[0];
        if (eipAtAlloc.length < 200) eipAtAlloc.push(retAddr >>> 0);
      }
    },
    log_i32: () => {},
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

  for (let i = 0; i < 200; i++) e.run(1000);

  const hex = v => '0x' + v.toString(16).padStart(8, '0');

  // Analyze return addresses
  const freq = {};
  for (const addr of eipAtAlloc) freq[addr] = (freq[addr] || 0) + 1;
  console.log(`LocalAlloc return addresses (${eipAtAlloc.length} samples):`);
  for (const [addr, count] of Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.log(`  ${hex(+addr)}: ${count}x`);
  }

  // Also check what caller's ESP looks like (stack depth) to see if it's recursive
  console.log(`\nTotal allocCount: ${allocCount}`);
  console.log(`ESP now: ${hex(e.get_esp() >>> 0)}, EIP: ${hex(e.get_eip() >>> 0)}`);
  console.log(`EBP: ${hex(e.get_ebp() >>> 0)}`);

  // Walk the stack from current ESP/EBP
  const memView = new Uint32Array(mem.buffer);
  let ebp = e.get_ebp() >>> 0;
  const ib = e.get_image_base() >>> 0;
  console.log('\nStack trace (EBP chain):');
  for (let i = 0; i < 20 && ebp > ib && ebp < ib + 0x200000; i++) {
    const wasmOff = (ebp - ib + 0x12000) >> 2;
    if (wasmOff * 4 >= mem.buffer.byteLength) break;
    const savedEbp = memView[wasmOff];
    const retAddr = memView[wasmOff + 1];
    console.log(`  EBP=${hex(ebp)} ret=${hex(retAddr >>> 0)}`);
    if (savedEbp === 0 || savedEbp === ebp) break;
    ebp = savedEbp;
  }
}

main().catch(e => { console.error(e); process.exit(1); });
