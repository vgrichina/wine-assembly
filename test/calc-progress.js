// Diagnostic: Run calc.exe and sample EIP to detect if stuck or making progress
const fs = require('fs');

async function main() {
  const wasmBytes = fs.readFileSync('build/wine-assembly.wasm');
  const exeBytes = fs.readFileSync('test/binaries/calc.exe');

  const logs = [];
  const imports = { host: {
    log: (ptr, len) => {
      const bytes = new Uint8Array(mem.buffer, ptr, len);
      logs.push(new TextDecoder().decode(bytes));
    },
    log_i32: (v) => { logs.push('i32: 0x' + (v >>> 0).toString(16)); },
    message_box: () => 1, exit: (code) => { console.log('EXIT code=' + code); },
    draw_rect: () => {}, read_file: () => 0, create_window: (...a) => { console.log('CreateWindow hwnd=0x'+a[0].toString(16)+' menu='+a[7]); return a[0]; },
    show_window: () => {}, create_dialog: (h) => h, load_string: () => 0,
    set_window_text: () => {}, invalidate: () => {}, set_menu: () => {},
    draw_text: () => {}, check_input: () => 0, check_input_lparam: () => 0, set_window_class: () => {},
  }};

  const { instance } = await WebAssembly.instantiate(wasmBytes, imports);
  const mem = instance.exports.memory;
  const e = instance.exports;

  // Load PE
  const staging = e.get_staging();
  new Uint8Array(mem.buffer, staging, exeBytes.length).set(exeBytes);
  const entry = e.load_pe(exeBytes.length);
  console.log('Entry: 0x' + (entry >>> 0).toString(16));

  // Run in small batches and sample EIP
  const BATCH = 1000;
  const SAMPLES = 200;
  const eipHistory = [];
  const hex = v => '0x' + (v >>> 0).toString(16).padStart(8, '0');

  for (let i = 0; i < SAMPLES; i++) {
    const eipBefore = e.get_eip();
    try {
      e.run(BATCH);
    } catch (err) {
      console.log(`\nCRASH at sample ${i}: ${err.message}`);
      console.log(`  EIP=${hex(e.get_eip())} ESP=${hex(e.get_esp())} EAX=${hex(e.get_eax())} ECX=${hex(e.get_ecx())}`);
      console.log(`  EBX=${hex(e.get_ebx())} EDX=${hex(e.get_edx())} ESI=${hex(e.get_esi())} EDI=${hex(e.get_edi())} EBP=${hex(e.get_ebp())}`);
      break;
    }
    const eipAfter = e.get_eip();
    eipHistory.push(eipAfter >>> 0);

    if (eipAfter === 0) {
      console.log(`EIP became 0 at sample ${i} (exit or halt)`);
      break;
    }
  }

  // Analyze EIP history
  console.log(`\nSampled ${eipHistory.length} EIP values after ${BATCH}-step batches:`);

  // Find unique EIPs and count frequencies
  const freq = {};
  for (const eip of eipHistory) freq[eip] = (freq[eip] || 0) + 1;
  const sorted = Object.entries(freq).sort((a, b) => b[1] - a[1]);

  console.log('\nTop EIP frequencies (likely loop targets):');
  for (const [eip, count] of sorted.slice(0, 15)) {
    console.log(`  ${hex(+eip)}: ${count}x (${(count/eipHistory.length*100).toFixed(1)}%)`);
  }

  const unique = Object.keys(freq).length;
  console.log(`\nUnique EIPs: ${unique} / ${eipHistory.length} samples`);
  if (unique <= 5 && eipHistory.length > 20) {
    console.log('>>> STUCK: EIP cycling between very few addresses');
  } else if (unique < eipHistory.length * 0.1) {
    console.log('>>> LIKELY STUCK: Low EIP diversity, tight loop');
  } else {
    console.log('>>> MAKING PROGRESS: Good EIP diversity');
  }

  // Show first/last 10 EIPs for trajectory
  console.log('\nFirst 10 EIPs:', eipHistory.slice(0, 10).map(hex).join(' '));
  console.log('Last 10 EIPs:', eipHistory.slice(-10).map(hex).join(' '));

  // Print host logs
  if (logs.length) {
    console.log('\nHost logs (' + logs.length + '):');
    for (const l of logs.slice(0, 30)) console.log('  ' + l);
    if (logs.length > 30) console.log('  ... (' + (logs.length - 30) + ' more)');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
