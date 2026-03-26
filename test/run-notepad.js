const fs = require('fs');

// Parse args
const args = process.argv.slice(2);
const getArg = (name, def) => { const a = args.find(a => a.startsWith(`--${name}=`)); return a ? a.split('=')[1] : def; };
const hasFlag = name => args.includes(`--${name}`);

const MAX_BATCHES = parseInt(getArg('max-batches', '200'));
const BATCH_SIZE = parseInt(getArg('batch-size', '1000'));
const VERBOSE = hasFlag('verbose');
const EXE_PATH = getArg('exe', 'test/binaries/notepad.exe');

const hex = v => '0x' + (v >>> 0).toString(16).padStart(8, '0');
const hex16 = v => '0x' + (v >>> 0).toString(16).padStart(4, '0');

async function main() {
  const wasmBytes = fs.readFileSync('build/wine-assembly.wasm');
  const exeBytes = fs.readFileSync(EXE_PATH);

  const logs = [];
  let stopped = false;

  // Read a null-terminated string from wasm memory
  const readStr = (mem, ptr, maxLen = 512) => {
    let s = '';
    for (let i = ptr; i < ptr + maxLen; i++) {
      if (!mem[i]) break;
      s += String.fromCharCode(mem[i]);
    }
    return s;
  };

  const imports = { host: {
    log: (ptr, len) => {
      const b = new Uint8Array(instance.exports.memory.buffer, ptr, Math.min(len, 256));
      let t = '';
      for (let i = 0; i < b.length && b[i]; i++) t += String.fromCharCode(b[i]);
      logs.push('[API] ' + t);
    },
    log_i32: val => logs.push('[i32] ' + hex(val)),
    message_box: (h, t, c, u) => {
      const mem = new Uint8Array(instance.exports.memory.buffer);
      logs.push(`[MessageBox] "${readStr(mem, c)}": "${readStr(mem, t)}"`);
      return 1;
    },
    exit: code => { logs.push('[Exit] code=' + code); stopped = true; },
    draw_rect: () => {},
    read_file: () => 0,
  }};

  const { instance } = await WebAssembly.instantiate(wasmBytes, imports);
  const mem = new Uint8Array(instance.exports.memory.buffer);
  mem.set(exeBytes, instance.exports.get_staging());
  const entry = instance.exports.load_pe(exeBytes.length);
  console.log('PE loaded. Entry: ' + hex(entry));

  const regs = () => {
    const e = instance.exports;
    return `EIP=${hex(e.get_eip())} EAX=${hex(e.get_eax())} ECX=${hex(e.get_ecx())} EDX=${hex(e.get_edx())} EBX=${hex(e.get_ebx())} ESP=${hex(e.get_esp())} EBP=${hex(e.get_ebp())} ESI=${hex(e.get_esi())} EDI=${hex(e.get_edi())}`;
  };

  let prevEip = 0, stuckCount = 0;

  for (let batch = 0; batch < MAX_BATCHES && !stopped; batch++) {
    try {
      instance.exports.run(BATCH_SIZE);
    } catch (e) {
      // Flush logs before crash info
      while (logs.length) console.log(logs.shift());
      console.log(`\n*** CRASH at batch ${batch}: ${e.message}`);
      console.log('  ' + regs());
      // Try to read memory around ESP for stack trace
      try {
        const e2 = instance.exports;
        const esp = e2.get_esp();
        const dv = new DataView(instance.exports.memory.buffer);
        const GUEST_BASE = 0x400000;
        const WASM_BASE = 0x12000;
        const g2w = addr => addr - GUEST_BASE + WASM_BASE;
        console.log('  Stack around ESP:');
        for (let i = 0; i < 8; i++) {
          const addr = esp + i * 4;
          try {
            const val = dv.getUint32(g2w(addr), true);
            console.log(`    [${hex(addr)}] = ${hex(val)}`);
          } catch (_) { break; }
        }
      } catch (_) {}
      process.exit(1);
    }

    // Flush logs
    while (logs.length) console.log(logs.shift());

    const eip = instance.exports.get_eip();
    if (VERBOSE) {
      console.log(`[${batch}] ${regs()}`);
    } else if (eip !== prevEip) {
      console.log(`[${batch}] ${regs()}`);
      prevEip = eip;
      stuckCount = 0;
    } else {
      stuckCount++;
      if (stuckCount > 10) {
        console.log(`STUCK at EIP=${hex(eip)} after ${stuckCount} batches`);
        break;
      }
    }
  }

  if (!stopped) {
    console.log('\n--- Final state ---');
    console.log(regs());
  }
}

main().catch(e => console.error(e));
