#!/usr/bin/env node
// Verifies that a 16-bit NE task actually executes.
//
//   node test/test-win16-exec.js
//
// test-ne-loader.js proves the image is loaded and linked. This proves the
// next thing: that the decoder runs the segmented instruction stream, that the
// startup register state is the one a Win16 task is entitled to, and that far
// calls into the import thunk segment are recognised as API calls.
//
// The task is expected to stop, because the API layer is incomplete. What is
// asserted about where it stops is deliberately not a fixed ordinal — that
// moves every time an API lands — but that it stopped at an entry point the
// real module exports *under a name*, checked against the map generated from
// those modules. That invariant holds however far the task gets, and it fails
// loudly if a bad stack adjustment ever flings the task into a thunk slot at
// random, which is the failure mode worth catching here.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const WASM = path.join(ROOT, 'build', 'wine-assembly.wasm');
const BIN = path.join(ROOT, 'test', 'binaries', 'win98-16bit');

const SREG_ES = 0, SREG_CS = 1, SREG_SS = 2, SREG_DS = 3;
// Module ids as assigned by $win16_module_id in src/08c-ne-loader.wat.
const MODULE_NAMES = [
  null, 'KERNEL', 'USER', 'GDI', 'KEYBOARD',
  'SOUND', 'SHELL', 'MMSYSTEM', 'COMMDLG', 'CARDS',
];
const ORDINALS = require(path.join(ROOT, 'src', 'win16-ordinals.generated.json'));

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

  const dsSel = inst.exports.win16_sreg(SREG_DS);

  // ---- execute ----
  // The task runs until it reaches an API that is not implemented yet, which
  // traps. That trap is the assertion: it says the decoder carried the task
  // through everything before it, and it names the callee.
  let trapped = false;
  try {
    inst.exports.run(64);
  } catch (e) {
    trapped = e instanceof WebAssembly.RuntimeError;
    if (!trapped) throw e;
  }
  checkThat('stopped at an unimplemented API rather than running on', trapped);

  // InitTask ran: it is the only thing that builds a PSP and points ES at it.
  const esSel = inst.exports.win16_sreg(SREG_ES);
  checkThat('InitTask gave the task a PSP', esSel !== 0 && esSel !== dsSel,
    `es=${fmt(esSel)} ds=${fmt(dsSel)}`);
  checkThat('execution left the entry point', (inst.exports.get_eip() >>> 0) !== (csBase + entryIP),
    `eip=${fmt(inst.exports.get_eip())}`);

  // Whatever it stopped at, it must be a real exported entry point of a real
  // module. This is the invariant worth pinning: it stays true as ordinals get
  // implemented and the stopping point moves, and it fails loudly if a wrong
  // stack adjustment ever sends the task into a thunk slot at random.
  const mod = inst.exports.win16_last_module();
  const ord = inst.exports.win16_last_ordinal();
  const byName = inst.exports.win16_last_is_name();
  const modName = MODULE_NAMES[mod];
  checkThat('stopped in a module the loader identified', !!modName, `module id ${mod}`);
  if (byName) {
    // A name import carries an offset into the imported-name table instead of
    // an ordinal, so there is nothing to look up in the ordinal map. What must
    // hold is that the module was still identified — before the name flag
    // existed these all collapsed to module 0.
    console.log(`  stopped at ${modName}.<name+${ord}> (imported by name)`);
  } else {
    const apiName = modName && ORDINALS.modules[modName]
      && ORDINALS.modules[modName].ordinals[String(ord)];
    checkThat('stopped at an ordinal the real module exports by name', !!apiName,
      `${modName || mod}.${ord} is not a named export`);
    console.log(`  stopped at ${modName}.${ord} ${apiName || ''}`);
  }

  // The dispatcher logs marker, packed module/ordinal, return address.
  const marker = logged.indexOf(byName ? 0xca16a9f2 : 0xca16a9f1);
  checkThat('dispatch logged its marker', marker >= 0, `logged=${logged.map(fmt).join(' ')}`);
  if (marker >= 0) {
    check('logged key matches the reported module/ordinal', logged[marker + 1], (mod << 16) | ord);
    const ret = logged[marker + 2] >>> 0;
    // The far call must have pushed CS:IP, so the saved IP is on top of stack.
    const esp = inst.exports.get_esp() >>> 0;
    const view = new DataView(memory.buffer);
    const guestBase = inst.exports.get_guest_base();
    check('saved IP on the stack', view.getUint16(guestBase + esp, true), ret & 0xffff);
    checkThat('saved CS on the stack names a loaded segment',
      inst.exports.win16_seg_base(view.getUint16(guestBase + esp + 2, true) >> 3) !== 0,
      `cs=${fmt(view.getUint16(guestBase + esp + 2, true))}`);
  }
}

(async () => {
  // One instance per image, deliberately. The block cache is keyed by linear
  // address and loading a second NE does not invalidate it, so a shared
  // instance runs the *previous* app's decoded blocks at the same addresses —
  // which is exactly what happened here, and it made FREECELL stop somewhere
  // WINMINE's code had gone.
  for (const name of ['WINMINE.EXE', 'FREECELL.EXE', 'MSHEARTS.EXE', 'SOL.EXE']) {
    const { inst, memory, logged } = await instantiate();
    runOne(inst, memory, logged, name);
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
