#!/usr/bin/env node
// Win16 KERNEL exposes __AHSHIFT/__AHINCR as absolute constants. OFFSET
// relocations must receive 3/8 directly; thunk offsets corrupt huge pointers
// as soon as their low word crosses 64KB.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'src', '08c-ne-loader.wat'), 'utf8');

assert(source.includes('(call $win16_import_constant (local.get $module) (local.get $c))'),
  'IMPORTORDINAL relocation path must consult the absolute-constant resolver');
assert(source.includes('(i32.eq (local.get $addr_type) (i32.const 5))'),
  'absolute imports must be limited to OFFSET/LOBYTE relocation sites');

(async () => {
  const wasm = fs.readFileSync(path.join(ROOT, 'build', 'wine-assembly.wasm'));
  const memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
  const mod = await WebAssembly.compile(wasm);
  const imports = { host: { memory }, env: { memory } };
  for (const imp of WebAssembly.Module.imports(mod)) {
    imports[imp.module] = imports[imp.module] || {};
    if (imp.kind === 'function') imports[imp.module][imp.name] = () => 0;
    else if (imp.kind === 'memory') imports[imp.module][imp.name] = memory;
    else if (imp.kind === 'global') imports[imp.module][imp.name] = 0;
  }
  const instance = await WebAssembly.instantiate(mod, imports);
  const resolve = instance.exports.win16_import_constant;
  assert.strictEqual(typeof resolve, 'function');
  assert.strictEqual(resolve(1, 113), 3, 'KERNEL.__AHSHIFT');
  assert.strictEqual(resolve(1, 114), 8, 'KERNEL.__AHINCR');
  assert.strictEqual(resolve(1, 112), -1, 'ordinary KERNEL ordinal stays callable');
  assert.strictEqual(resolve(2, 113), -1, 'same ordinal in USER stays callable');
  console.log('PASS  Win16 huge-pointer imports resolve to absolute constants 3/8');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
