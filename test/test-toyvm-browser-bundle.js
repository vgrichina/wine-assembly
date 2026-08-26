'use strict';

// The browser bundle is the same VM, or it is nothing.
//
// tools/toyvm/bundle-browser.js ships the toy VM's own source files verbatim
// behind a hand-written CommonJS `require`, so the risk is not that a module is
// wrong -- it is that the shim never loads it, or loads it and hands it a `fs`
// that lies. Both failures look like "the Run button does nothing" from a page
// and like nothing at all from Node.
//
// So this loads the generated bundle the way a browser would (a bare script in
// a global scope with `self` and `atob` and no `require` in sight), mounts a
// real program as its disk, builds the VM through it, and runs. The assertion
// is that a DOS program executes: same modules, same wasm, no Node behind it.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const BUNDLE = path.join(ROOT, 'docs', 'dos-corpus', 'live', 'toyvm-bundle.js');

// A .COM that draws: mov ah,9 / int 21h with a message, then int 20h. Written
// here rather than taken from the corpus so the test needs no downloads.
function helloCom() {
  const msg = 'HI$';
  const code = [
    0xB4, 0x09,                     // mov ah, 9
    0xBA, 0x09, 0x01,               // mov dx, 0x109  (message, PSP-relative)
    0xCD, 0x21,                     // int 21h
    0xCD, 0x20,                     // int 20h
  ];
  return Uint8Array.from([...code, ...[...msg].map(c => c.charCodeAt(0))]);
}

async function main() {
  assert.ok(fs.existsSync(BUNDLE),
    `${path.relative(ROOT, BUNDLE)} is missing -- run tools/toyvm/bundle-browser.js`);

  // A browser-shaped global: `self`, `atob`, `WebAssembly`, and deliberately no
  // `require`, `module`, `process` or `__dirname`. If the bundle reaches for a
  // Node facility it fails here rather than in someone's browser.
  const sandbox = {
    self: {},
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    WebAssembly,
    TextDecoder,
    TextEncoder,
    Uint8Array,
    console,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(BUNDLE, 'utf8'), sandbox, { filename: 'toyvm-bundle.js' });

  const ToyVM = sandbox.self.ToyVM;
  assert.ok(ToyVM && typeof ToyVM.require === 'function', 'bundle did not publish self.ToyVM');

  // Every module the page will ask for, loaded through the shim's own resolver.
  // isa first, because everything else hangs off its memory map.
  const isa = ToyVM.require('tools/toyvm/isa.js');
  assert.strictEqual(isa.GUEST_RAM_SIZE, 0x1000000, 'guest RAM is not 16MB');

  const { makeVm } = ToyVM.require('tools/toyvm/vm.js');
  const dos = ToyVM.require('tools/toyvm/dos.js');
  assert.ok(typeof dos.Machine === 'function', 'dos.js did not export Machine');
  assert.ok(typeof dos.loadExe === 'function', 'dos.js did not export loadExe');

  ToyVM.mount('HELLO.COM', helloCom());
  // Spread it first: the array comes from the sandbox realm, so its prototype
  // is not this file's Array and a deep-strict compare rejects it for that
  // alone, contents notwithstanding.
  assert.deepStrictEqual([...ToyVM.diskNames()], ['hello.com'],
    'mount did not reach the shim fs');

  const machine = new dos.Machine(new Uint8Array(0), { fileRoot: '.', autoKey: true });
  const v = await makeVm('tailcall', {
    portIn: (p, w) => machine.portIn(p, w),
    portOut: (p, val, w) => machine.portOut(p, val, w),
  });
  v.exports.set_cpu(386);
  machine.setMemory(v.mem, v.exports);
  machine.installIvt();
  machine.setTicks(0);
  machine.syncVga();

  const info = dos.loadExe(v.mem, helloCom());
  machine.installEnvironment('HELLO.COM');
  v.setAll({ cs: info.cs, ip: info.ip, ss: info.ss, sp: info.sp, ds: info.ds, es: info.es });

  // The ROM font came out of the bundled asset rather than the host disk. Read
  // it back out of guest memory: an all-zero table means `fs.readFileSync` fell
  // through to the ENOENT path and dos.js quietly used blanks.
  const romFont = v.mem.subarray(0xF4000, 0xF4000 + 0x1000);
  assert.ok(romFont.some(b => b !== 0), 'the ROM character generator is blank');

  // Run it. Two hundred slices is far more than a nine-instruction program
  // needs, and the loop stops on the exit either way.
  const { compileProgram } = ToyVM.require('tools/toyvm/compile.js');
  for (let i = 0; i < 200 && !machine.exited; i++) {
    const cs = v.get('cs'), ip = v.get('gip');
    if (cs === 0xF000) {                      // a serviced interrupt: IRET here
      const ss = v.get('ss'), sp = v.get('sp');
      const at = (of) => ((ss << 4) + ((sp + of) & 0xFFFF)) & 0xFFFFF;
      const rd = (of) => v.mem[at(of)] | (v.mem[at(of + 1)] << 8);
      machine.service(ip & 0xFF, {
        get: (n) => v.get(n), set: (n, val) => v.set(n, val),
        setResultCf: () => {}, setResultZf: () => {},
        ret: { cs: rd(2), ip: rd(0), sp: (sp + 6) & 0xFFFF },
      });
      v.set('gip', rd(0)); v.set('cs', rd(2)); v.set('flags', rd(4));
      v.set('sp', (sp + 6) & 0xFFFF);
      continue;
    }
    const prog = compileProgram((lin) => v.mem[lin], cs, ip,
      { arenaBase: isa.THREAD_BASE, maxWords: isa.THREAD_SIZE >> 2 });
    new Int32Array(v.mem.buffer, prog.arenaBase, prog.words.length).set(prog.words);
    v.exports.run(prog.entryAddr, 100000);
  }

  assert.ok(machine.exited, 'the program never reached its exit');
  const screen = machine.screenText().join('');
  assert.ok(screen.includes('HI'), `nothing was printed; screen was ${JSON.stringify(screen)}`);

  console.log('PASS test-toyvm-browser-bundle: '
    + `${Object.keys(sandbox.self.ToyVM).length} entry points, program ran and printed "HI"`);
}

main().catch((e) => { console.error(e.stack || String(e)); process.exit(1); });
