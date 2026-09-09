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
const crypto = require('crypto');
const isa = require('./isa');
const { emit } = require('./emit');
const { decodeOne } = require('./decode');
const { compileWat } = require(path.join(__dirname, '..', '..', 'lib', 'compile-wat.js'));

const REGS = [...isa.REG16, ...isa.SEG, 'gip', 'flags'];

// `opts.hist` selects the instrumented dispatch. It gets its own cacheKey --
// compileWat memoizes, and an instrumented build sharing the plain build's key
// would hand back whichever was compiled first, which is a census of nothing or
// a shipped build that counts.
// `opts.lazyFlags: false` builds the eager-flag arm, and it gets its own key for
// the same reason: the two differ only inside handler bodies, so a shared key
// would hand the A/B whichever module was compiled first and report a 0%.
async function buildModule(variant, opts = {}) {
  const wat = emit(variant, opts);
  // A JIT region is program-specific, so its module must never be handed to
  // another program: the key carries a hash of the region bodies themselves.
  // compileWat memoizes on cacheKey and would otherwise return the previous
  // program's compiled loop for this one, which reads as a wrong frame rather
  // than as a cache bug.
  const regionKey = (opts.regions && opts.regions.length)
    ? `-r${crypto.createHash('sha256').update(opts.regions.map(r => r.body).join('|'))
      .digest('hex').slice(0, 12)}` : '';
  const suffix = (opts.hist ? '-hist' : '')
    + (opts.lazyFlags === false ? '-eager' : '')
    + (opts.fuseCond === false ? '-genericcond' : '') + regionKey;
  const file = `toyvm-${variant}${suffix}.wat`;
  const bytes = await compileWat(
    (f) => { if (f !== file) throw new Error(`unexpected file ${f}`); return wat; },
    { files: [file], cacheKey: `toyvm:${variant}${suffix}` },
  );
  return { wat, bytes };
}

async function makeVm(variant, opts = {}) {
  // `opts.bytes` skips the build entirely and instantiates a module somebody
  // else compiled. That is how a LIVE region install avoids paying for the
  // whole VM twice: region-live.js's backend has already emitted and compiled
  // exactly this module -- possibly in a worker, where its ~1s does not touch
  // the page's thread -- and only the instance has to be made here.
  const { wat, bytes } = opts.bytes
    ? { wat: opts.wat || '', bytes: opts.bytes }
    : await buildModule(variant,
      { hist: !!opts.hist, lazyFlags: opts.lazyFlags !== false, fuseCond: opts.fuseCond !== false,
        regions: opts.regions || null });
  // WHERE THE REGIONS LANDED IN THE TABLE. Regions are appended after the
  // ordinary handlers, so their index is HANDLERS.length + n -- but only as
  // measured against the table THIS module was built with. HANDLERS is rebuilt
  // by prepareTables() and its length depends on the build options, so a caller
  // that read it before the build can be one out: the instrumented build has a
  // different count, and installing a region at a stale index puts an ordinary
  // handler where the loop should be. Measured as a region that silently never
  // ran while the run around it looked healthy.
  const regionBase = require('./emit').HANDLERS.length;
  const module = await WebAssembly.compile(bytes);
  // `opts.memory` reuses a Memory somebody else already owns. That is what a
  // LIVE region install needs: the guest's RAM, its arena of threaded code and
  // its shadow stack all live in linear memory, so a second module built around
  // a compiled region has to be instantiated over the SAME memory or the
  // program it is meant to speed up is left behind in the old one. Only the
  // wasm GLOBALS are per-instance, and region-live.js carries those across.
  const memory = opts.memory
    || new WebAssembly.Memory({ initial: isa.MEM_PAGES, maximum: isa.MEM_PAGES });
  // Ports are a host concern: the VM has no peripherals, and the few a demo
  // actually touches (VGA DAC, retrace) are modelled in tools/toyvm/dos.js.
  // The default reads 0xFF, which is what an empty ISA bus returns.
  const ports = {
    port_in: opts.portIn || ((_port, w) => (w === 16 ? 0xFFFF : 0xFF)),
    port_out: opts.portOut || (() => {}),
    // The transcendentals, by the selector emit.js bakes into each handler.
    // Keep this table and the `M(op, ...)` calls in genFpu in step.
    fmath: (op, a, b) => {
      switch (op) {
        case 0: return Math.sin(a);
        case 1: return Math.cos(a);
        case 2: return Math.tan(a);
        case 3: return Math.atan2(a, b);
        case 4: return Math.log2(a);
        case 5: return 2 ** a;
        default: return 0;
      }
    },
  };
  const instance = await WebAssembly.instantiate(module, { host: { memory, ...ports } });
  // `let`, and every accessor below re-reads it, because a live region install
  // swaps this vm onto a SECOND instance of a module built with the compiled
  // loop in its table (see rebind).
  let ex = instance.exports;
  const mem = new Uint8Array(memory.buffer);

  // Two of these are not 16-bit quantities and never were: the instruction
  // pointer in a 32-bit code segment, and the stack pointer on a 32-bit stack.
  // Masking them is not a view, it is a truncation -- the host loop reads
  // `gip` to decide what to compile next, so ACME-SYW.EXE's return to
  // 0x11c43 became a compile of 0x1c43, which is a text banner in its data,
  // and the demo "hung" 202 handbacks into a picture of its own logo. In real
  // mode both stay inside 16 bits on their own (see $spm and `wip`), so the
  // unmasked read is the same number there.
  const WIDE = new Set(['gip', 'sp']);
  // One closure per export, built once: the run loop reads a dozen globals
  // per handback, and building the export's name from the register's on
  // every read was 9.8% of a CYCLE profile (40k handbacks a guest second).
  // Names outside the export table (`smc`, `steps`, ...) resolve lazily so
  // the set of readable globals is still whatever the module exports.
  let getters = Object.create(null), setters = Object.create(null), raws = Object.create(null);
  const getter = (r) => getters[r] || (getters[r] = WIDE.has(r)
    ? (() => { const f = ex[`get_${r}`]; return () => f() >>> 0; })()
    : (() => { const f = ex[`get_${r}`]; return () => f() & 0xFFFF; })());
  const setter = (r) => setters[r] || (setters[r] = WIDE.has(r)
    ? ex[`set_${r}`]
    : (() => { const f = ex[`set_${r}`]; return (v) => f(v & 0xFFFF); })());
  const get = (r) => getter(r)();
  const set = (r, v) => setter(r)(v);
  // The masked view is what every 16-bit caller wants, but $steps/$left are
  // counters and the register file is 32 bits wide -- both need the whole word.
  const raw = (r) => (raws[r] || (raws[r] = ex[`get_${r}`]))();

  const self = {
    variant, wat, bytes, exports: ex, mem, memory, regionBase,
    get, set, raw,
    // Point this vm at a different instance, built over the SAME memory. Only
    // the wasm globals are lost by the move and the caller carries those (see
    // region-live.js `carryState`); everything the emulator holds -- the arena,
    // the shadow stack, the guest's RAM -- is in the memory both instances
    // import. The memoized accessor closures capture the old export table, so
    // they are thrown away rather than updated: a stale `get_ax` reads a
    // register that stopped moving, which is the quietest possible bug.
    rebind({ exports, regionBase: rb, wat: newWat, bytes: newBytes }) {
      ex = exports;
      getters = Object.create(null);
      setters = Object.create(null);
      raws = Object.create(null);
      self.exports = exports;
      if (rb !== undefined) self.regionBase = rb;
      if (newWat !== undefined) self.wat = newWat;
      if (newBytes !== undefined) self.bytes = newBytes;
      return self;
    },
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
  return self;
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
