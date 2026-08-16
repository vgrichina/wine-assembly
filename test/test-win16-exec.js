#!/usr/bin/env node
// Verifies that a 16-bit NE task actually executes.
//
//   node test/test-win16-exec.js
//
// test-ne-loader.js proves the image is loaded and linked. This proves the
// next thing: that the decoder runs the segmented instruction stream, that
// the startup register state is the one a Win16 task is entitled to, and that
// the first far call into the import thunk segment is recognised as an API
// call and named correctly.
//
// Every one of these four images opens the same way — `xor bp,bp / push bp /
// call far KERNEL.INITTASK` — so reaching KERNEL ordinal 91 with the right
// return address on the stack is a precise statement about several separate
// pieces working: 16-bit operand defaults, the segmented stack, far-call
// encoding, and the thunk table the loader built.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const WASM = path.join(ROOT, 'build', 'wine-assembly.wasm');
const BIN = path.join(ROOT, 'test', 'binaries', 'win98-16bit');

const KERNEL = 1;
const INITTASK = 91;
const SREG_ES = 0, SREG_CS = 1, SREG_SS = 2, SREG_DS = 3;

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = got === want;
  if (ok) { pass++; } else { fail++; console.log(`  FAIL ${name}: got ${fmt(got)}, want ${fmt(want)}`); }
  return ok;
}
function checkThat(name, ok, detail) {
  if (ok) { pass++; } else { fail++; console.log(`  FAIL ${name}${detail ? ': ' + detail : ''}`); }
  return ok;
}
function fmt(v) { return typeof v === 'number' ? `0x${(v >>> 0).toString(16)}` : String(v); }

async function instantiate() {
  if (!fs.existsSync(WASM)) execSync('bash tools/build.sh', { cwd: ROOT, stdio: 'inherit' });
  const bytes = fs.readFileSync(WASM);
  const memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
  const mod = await WebAssembly.compile(bytes);
  const logged = [];
  const imports = { host: { memory }, env: { memory } };
  for (const imp of WebAssembly.Module.imports(mod)) {
    if (imp.kind === 'memory') continue;
    if (imp.kind !== 'function') continue;
    imports[imp.module] = imports[imp.module] || {};
    imports[imp.module][imp.name] = imp.name === 'log_i32'
      ? (v) => { logged.push(v >>> 0); return 0; }
      : () => 0;
  }
  const inst = await WebAssembly.instantiate(mod, imports);
  return { inst, memory, logged };
}

function runOne(inst, memory, logged, name) {
  const file = path.join(BIN, name);
  const bytes = fs.readFileSync(file);
  const mem = new Uint8Array(memory.buffer);
  const staging = inst.exports.get_staging();
  mem.fill(0, staging, staging + Math.max(bytes.length, 0x10000));
  mem.set(bytes, staging);
  logged.length = 0;

  const entry = inst.exports.load_pe(bytes.length);
  console.log(`\n${name}`);
  if (entry < 0) { fail++; console.log(`  FAIL load_pe returned ${entry}`); return; }

  // ---- startup state ----
  const csBase = inst.exports.win16_seg_base_of(SREG_CS);
  const ssBase = inst.exports.win16_seg_base_of(SREG_SS);
  const dsBase = inst.exports.win16_seg_base_of(SREG_DS);
  const entryIP = inst.exports.win16_entry_ip();

  check('code16 set', inst.exports.is_code16(), 1);
  check('CS selector is the entry CS', inst.exports.win16_sreg(SREG_CS), inst.exports.win16_entry_cs());
  check('EIP is CS base + entry IP', inst.exports.get_eip() >>> 0, (csBase + entryIP) >>> 0);
  check('DS is the auto-data segment', inst.exports.win16_sreg(SREG_DS),
    (inst.exports.win16_auto_data() << 3) | 7);
  check('ES starts equal to DS', inst.exports.win16_sreg(SREG_ES), inst.exports.win16_sreg(SREG_DS));
  check('SS is the auto-data segment', inst.exports.win16_sreg(SREG_SS), inst.exports.win16_sreg(SREG_DS));

  // Every segment base is 64KB aligned; the whole address scheme rests on it.
  checkThat('segment bases are 64KB aligned',
    (csBase & 0xffff) === 0 && (ssBase & 0xffff) === 0 && (dsBase & 0xffff) === 0,
    `cs=${fmt(csBase)} ss=${fmt(ssBase)} ds=${fmt(dsBase)}`);

  const esp0 = inst.exports.get_esp() >>> 0;
  checkThat('SP starts inside the stack segment',
    esp0 > ssBase && esp0 <= ssBase + 0xfffe, `esp=${fmt(esp0)} ss base=${fmt(ssBase)}`);

  // ---- execute ----
  // The task runs until it calls an API, which currently traps. The trap is
  // the assertion: it says the decoder got that far, and names the callee.
  let trapped = false;
  try {
    inst.exports.run(64);
  } catch (e) {
    trapped = e instanceof WebAssembly.RuntimeError;
    if (!trapped) throw e;
  }
  checkThat('stopped at an unimplemented API rather than running on', trapped);
  check('first API call is KERNEL', inst.exports.win16_last_module(), KERNEL);
  check('first API call is ordinal 91 (InitTask)', inst.exports.win16_last_ordinal(), INITTASK);

  // The dispatcher logs marker, packed module/ordinal, return address.
  const marker = logged.indexOf(0xca16a9f1);
  checkThat('dispatch logged its marker', marker >= 0, `logged=${logged.map(fmt).join(' ')}`);
  if (marker >= 0) {
    check('logged key is KERNEL:91', logged[marker + 1], (KERNEL << 16) | INITTASK);
    const ret = logged[marker + 2] >>> 0;
    checkThat('return address is in the entry code segment',
      (ret & 0xffff0000) === csBase, `ret=${fmt(ret)} cs base=${fmt(csBase)}`);
    // `xor bp,bp / push bp / call far` is 2 + 1 + 5 bytes, so the return
    // address is 8 past the entry point. Anything else means the decoder
    // consumed the wrong number of bytes somewhere in those three
    // instructions — the exact failure a 32-bit default would produce.
    check('return address is 8 bytes past the entry point', ret, (csBase + entryIP + 8) >>> 0);

    // The far call must have pushed CS:IP under the caller's own `push bp`.
    const esp = inst.exports.get_esp() >>> 0;
    const view = new DataView(memory.buffer);
    const guestBase = inst.exports.get_guest_base ? inst.exports.get_guest_base() : null;
    if (guestBase !== null) {
      check('saved IP on the stack', view.getUint16(guestBase + esp, true), ret & 0xffff);
      check('saved CS on the stack', view.getUint16(guestBase + esp + 2, true),
        inst.exports.win16_entry_cs());
    }
  }
}

(async () => {
  const { inst, memory, logged } = await instantiate();
  for (const name of ['WINMINE.EXE', 'FREECELL.EXE', 'MSHEARTS.EXE', 'SOL.EXE']) {
    runOne(inst, memory, logged, name);
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
