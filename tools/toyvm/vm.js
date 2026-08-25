'use strict';

// Build and drive one variant of the toy VM.
//
// Compilation goes through the project's OWN lib/compile-wat.js rather than
// wat2wasm. Two reasons: no new dependency, and it makes the shootout a
// differential test of our compiler against wabt for free (tools/toyvm/gate.js
// --wabt cross-checks the same module bytes).
//
// compileWat memoizes on options.cacheKey, so every variant must pass a
// distinct one or the second variant silently gets the first one's bytes.

const path = require('path');
const isa = require('./isa');
const { emit } = require('./emit');
const { decodeOne } = require('./decode');
const { compileWat } = require(path.join(__dirname, '..', '..', 'lib', 'compile-wat.js'));

const REGS = [...isa.REG16, ...isa.SEG, 'gip', 'flags'];

async function buildModule(variant) {
  const wat = emit(variant);
  const file = `toyvm-${variant}.wat`;
  const bytes = await compileWat(
    (f) => { if (f !== file) throw new Error(`unexpected file ${f}`); return wat; },
    { files: [file], cacheKey: `toyvm:${variant}` },
  );
  return { wat, bytes };
}

async function makeVm(variant) {
  const { wat, bytes } = await buildModule(variant);
  const module = await WebAssembly.compile(bytes);
  const memory = new WebAssembly.Memory({ initial: isa.MEM_PAGES, maximum: isa.MEM_PAGES });
  const instance = await WebAssembly.instantiate(module, { host: { memory } });
  const ex = instance.exports;
  const mem = new Uint8Array(memory.buffer);

  const get = (r) => ex[`get_${r}`]() & 0xFFFF;
  const set = (r, v) => ex[`set_${r}`](v & 0xFFFF);

  return {
    variant, wat, bytes, exports: ex, mem,
    get, set,
    getAll() {
      const o = {};
      for (const r of REGS) o[r === 'gip' ? 'ip' : r] = get(r);
      return o;
    },
    setAll(regs) {
      for (const [k, v] of Object.entries(regs)) {
        const g = k === 'ip' ? 'gip' : k;
        if (REGS.includes(g)) set(g, v);
      }
    },
    // Decode one instruction at cs:ip into the thread arena, then run it to the
    // `end` op. Returns false when the opcode is not implemented.
    stepOne() {
      const cs = get('cs'), ip = get('gip');
      const d = decodeOne((lin) => mem[lin], cs, ip);
      if (!d) return false;
      // A branch writes the guest IP itself and stops, since both its arena
      // successors are 0 here. Appending `end` after it would overwrite that
      // with the fall-through address and silently pass every taken branch.
      const words = d.endsBlock
        ? d.words
        : [...d.words, require('./decode').H.end, d.nextIp];
      const view = new Int32Array(memory.buffer, isa.THREAD_BASE, words.length);
      view.set(words);
      ex.run(isa.THREAD_BASE, 1000);
      return true;
    },
  };
}

module.exports = { makeVm, buildModule, REGS };

// CLI: compile one variant with OUR compiler and write the bytes out, so the
// result can be diffed against wat2wasm's. Divergences here are compiler bugs,
// not VM bugs, and this is the shortest path to naming one.
//   node tools/toyvm/vm.js --variant=tailcall --out=/tmp/ours.wasm
if (require.main === module) {
  const a = (n, d) => {
    const hit = process.argv.slice(2).find(x => x.startsWith(`--${n}=`));
    return hit === undefined ? d : hit.slice(n.length + 3);
  };
  buildModule(a('variant', 'tailcall')).then(({ bytes }) => {
    const out = a('out');
    if (out) require('fs').writeFileSync(out, Buffer.from(bytes));
    process.stderr.write(`${bytes.length} bytes${out ? ` -> ${out}` : ''}\n`);
  }).catch(e => { process.stderr.write(String(e.stack || e) + '\n'); process.exit(1); });
}
