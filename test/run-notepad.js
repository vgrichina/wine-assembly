const fs = require('fs');

async function main() {
  const wasmBytes = fs.readFileSync('build/wine-assembly.wasm');
  const exeBytes = fs.readFileSync('test/binaries/notepad.exe');

  const logs = [];
  let stopped = false;
  const imports = {
    host: {
      log: (ptr, len) => {
        const buf = new Uint8Array(instance.exports.memory.buffer, ptr, Math.min(len, 256));
        let text = '';
        for (let i = 0; i < buf.length && buf[i] !== 0; i++) text += String.fromCharCode(buf[i]);
        logs.push('[API] ' + text);
      },
      log_i32: (val) => { logs.push('[opcode?] 0x' + (val >>> 0).toString(16)); },
      message_box: (h, t, c, u) => {
        const mem = new Uint8Array(instance.exports.memory.buffer);
        const rs = p => { let s=''; for(let i=p;mem[i]&&i<p+512;i++) s+=String.fromCharCode(mem[i]); return s; };
        logs.push(`[MessageBox] "${rs(c)}": "${rs(t)}"`);
        return 1;
      },
      exit: (code) => { logs.push('[Exit] ' + code); stopped = true; },
      draw_rect: () => {},
      read_file: () => 0,
    },
  };

  const { instance } = await WebAssembly.instantiate(wasmBytes, imports);
  const mem = new Uint8Array(instance.exports.memory.buffer);
  const staging = instance.exports.get_staging();
  mem.set(exeBytes, staging);
  const entry = instance.exports.load_pe(exeBytes.length);
  console.log('Entry: 0x' + (entry >>> 0).toString(16));

  const hex = v => '0x' + (v >>> 0).toString(16).padStart(8, '0');
  let prevEip = 0;
  let stuckCount = 0;

  for (let step = 0; step < 500 && !stopped; step++) {
    const eipBefore = instance.exports.get_eip();
    try {
      instance.exports.run(100);
    } catch(e) {
      while(logs.length) console.log(logs.shift());
      console.log(`CRASH at batch ${step}: ${e.message}`);
      console.log(`  EIP=${hex(instance.exports.get_eip())} ESP=${hex(instance.exports.get_esp())} EAX=${hex(instance.exports.get_eax())} EBX=${hex(instance.exports.get_ebx())} ECX=${hex(instance.exports.get_ecx())} ESI=${hex(instance.exports.get_esi())}`);
      console.log(`  EBP=${hex(instance.exports.get_ebp())} EDI=${hex(instance.exports.get_edi())}`);
      break;
    }
    while(logs.length) console.log(logs.shift());

    const eipAfter = instance.exports.get_eip();
    if (eipAfter !== prevEip) {
      console.log(`batch ${step}: EIP=${hex(eipAfter)} EAX=${hex(instance.exports.get_eax())} ESP=${hex(instance.exports.get_esp())}`);
      prevEip = eipAfter;
      stuckCount = 0;
    } else {
      stuckCount++;
      if (stuckCount > 3) {
        console.log(`STUCK at EIP=${hex(eipAfter)} for ${stuckCount} batches`);
        break;
      }
    }
  }
}
main().catch(e => console.error(e));
