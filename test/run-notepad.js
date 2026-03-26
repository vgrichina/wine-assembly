const fs = require('fs');
async function main() {
  const wasmBytes = fs.readFileSync('build/wine-assembly.wasm');
  const exeBytes = fs.readFileSync('test/binaries/notepad.exe');
  const logs = [];
  let stopped = false;
  const imports = { host: {
    log: (ptr, len) => { const b=new Uint8Array(instance.exports.memory.buffer,ptr,Math.min(len,256)); let t=''; for(let i=0;i<b.length&&b[i];i++) t+=String.fromCharCode(b[i]); logs.push('[API] '+t); },
    log_i32: (val) => { logs.push('[opcode?] 0x'+(val>>>0).toString(16)); },
    message_box: (h,t,c,u) => { const m=new Uint8Array(instance.exports.memory.buffer); const rs=p=>{let s='';for(let i=p;m[i]&&i<p+512;i++)s+=String.fromCharCode(m[i]);return s;}; logs.push(`[MessageBox] "${rs(c)}": "${rs(t)}"`); return 1; },
    exit: (code) => { logs.push('[Exit] code='+code); stopped=true; },
    draw_rect:()=>{}, read_file:()=>0 }};
  const {instance} = await WebAssembly.instantiate(wasmBytes, imports);
  const mem = new Uint8Array(instance.exports.memory.buffer);
  mem.set(exeBytes, instance.exports.get_staging());
  const entry = instance.exports.load_pe(exeBytes.length);
  console.log('Entry: 0x'+(entry>>>0).toString(16));
  const hex = v => '0x'+(v>>>0).toString(16).padStart(8,'0');
  let prevEip = 0, stuckCount = 0;
  for (let step = 0; step < 2000 && !stopped; step++) {
    try { instance.exports.run(1000); } catch(e) {
      while(logs.length) console.log(logs.shift());
      console.log(`CRASH at batch ${step}: ${e.message}`);
      console.log(`  EIP=${hex(instance.exports.get_eip())} ESP=${hex(instance.exports.get_esp())} EAX=${hex(instance.exports.get_eax())}`);
      break; }
    while(logs.length) console.log(logs.shift());
    const eip = instance.exports.get_eip();
    if (eip !== prevEip) { console.log(`batch ${step}: EIP=${hex(eip)} EAX=${hex(instance.exports.get_eax())} ESP=${hex(instance.exports.get_esp())}`); prevEip=eip; stuckCount=0; }
    else { stuckCount++; if(stuckCount>5) { console.log(`STUCK at EIP=${hex(eip)}`); break; } }
  }
}
main().catch(e=>console.error(e));
