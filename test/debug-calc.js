// Debug script to analyze calc.exe loading
const fs = require('fs');
const d = fs.readFileSync('test/binaries/calc.exe');

const p = d.readUInt32LE(0x3C);
const ns = d.readUInt16LE(p + 6);
const os = d.readUInt16LE(p + 20);
const ib = d.readUInt32LE(p + 52);
const er = d.readUInt32LE(p + 40);
const si = d.readUInt32LE(p + 80);

console.log('=== calc.exe PE Analysis ===');
console.log('image_base = 0x' + ib.toString(16));
console.log('entry_rva  = 0x' + er.toString(16));
console.log('entry_point= 0x' + (ib + er).toString(16));
console.log('SizeOfImage= 0x' + si.toString(16));
console.log('sections   =', ns);

const so = p + 24 + os;
for (let i = 0; i < ns; i++) {
  const o = so + i * 40;
  const n = d.slice(o, o + 8).toString('ascii').replace(/\0/g, '');
  const va = d.readUInt32LE(o + 12);
  const vs = d.readUInt32LE(o + 8);
  const rs = d.readUInt32LE(o + 16);
  const ro = d.readUInt32LE(o + 20);
  const wdst = 0x12000 + va;
  console.log(`  ${n}: va=0x${va.toString(16)} vs=0x${vs.toString(16)} rs=0x${rs.toString(16)} ro=0x${ro.toString(16)} -> wasm[0x${wdst.toString(16)}..0x${(wdst+rs).toString(16)}]`);
  if (er >= va && er < va + vs) {
    const foff = ro + er - va;
    console.log(`    ** ENTRY in this section, file_off=0x${foff.toString(16)}, first bytes: ${d.slice(foff, foff+16).toString('hex')}`);
  }
}

// heap_ptr g2w
console.log('\nheap_ptr(guest)=0x' + (ib+si).toString(16) + ' -> g2w=0x' + (si + 0x12000).toString(16));
console.log('WASM mem limit = 0x' + (512*65536).toString(16));

// Now load and check if data is at the right place
async function testLoad() {
  const wasmBytes = fs.readFileSync('build/wine-assembly.wasm');
  const imports = { host: {
    log: () => {}, log_i32: () => {}, message_box: () => 1, exit: () => {},
    draw_rect: () => {}, read_file: () => 0, create_window: () => 0,
    show_window: () => {}, create_dialog: () => 0, load_string: () => 0,
    set_window_text: () => {}, invalidate: () => {}, draw_text: () => {},
    check_input: () => 0,
    check_input_lparam: () => 0,
  }};
  const { instance } = await WebAssembly.instantiate(wasmBytes, imports);
  const mem = new Uint8Array(instance.exports.memory.buffer);
  mem.set(d, instance.exports.get_staging());
  const entry = instance.exports.load_pe(d.length);
  console.log('\nAfter load_pe, entry=0x' + (entry>>>0).toString(16));

  // Check bytes at entry using correct g2w from WAT
  const ib2 = instance.exports.get_eax ? 0 : 0; // can't get image_base, compute it
  // g2w = addr - image_base + 0x12000
  const eip = entry >>> 0;
  const wasm_eip = eip - ib + 0x12000;
  console.log('WASM offset of entry = 0x' + wasm_eip.toString(16));
  const bytes = mem.slice(wasm_eip, wasm_eip + 16);
  console.log('Bytes at entry (WASM): ' + Buffer.from(bytes).toString('hex'));

  // Also check what the WRONG g2w would give
  const wrong_wasm = eip - 0x400000 + 0x12000;
  console.log('Wrong g2w offset = 0x' + wrong_wasm.toString(16));
  if (wrong_wasm < mem.length) {
    console.log('Bytes at wrong offset: ' + Buffer.from(mem.slice(wrong_wasm, wrong_wasm+16)).toString('hex'));
  } else {
    console.log('Wrong offset OUT OF BOUNDS (beyond WASM memory)');
  }
}
testLoad().catch(e => console.error(e));
