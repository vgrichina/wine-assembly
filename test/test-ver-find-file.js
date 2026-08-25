#!/usr/bin/env node
'use strict';

// InstallShield uses VerFindFileA before replacing a versioned payload. Keep
// its eight-argument stdcall ABI, directory recommendation, length reporting,
// and truncation flags covered independently of the 50 MB Uplink installer.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createHostImports } = require('../lib/host-imports');
const { compileWat } = require('../lib/compile-wat');
const apiTable = require('../src/api_table.json');

const ROOT = path.join(__dirname, '..');
const extraWat = String.raw`
  ;; Build one synthetic import thunk so x86 can exercise the generated
  ;; dispatcher exactly as an imported VerFindFileA call does.
  (func (export "test_make_api_thunk") (param $api_id i32) (result i32)
    (local $addr i32)
    (local.set $addr (i32.add (global.get $THUNK_BASE)
      (i32.mul (global.get $num_thunks) (i32.const 8))))
    (i32.store (local.get $addr) (i32.const 0))
    (i32.store offset=4 (local.get $addr) (local.get $api_id))
    (global.set $num_thunks (i32.add (global.get $num_thunks) (i32.const 1)))
    (call $update_thunk_end)
    (i32.add (i32.sub (local.get $addr) (global.get $GUEST_BASE))
             (global.get $image_base)))
`;

function u32(value) {
  return [value, value >>> 8, value >>> 16, value >>> 24].map(v => v & 0xff);
}

async function main() {
  const wasm = await compileWat(async file => {
    const source = await fs.promises.readFile(path.join(ROOT, 'src', file), 'utf8');
    if (file !== '13-exports.wat') return source;
    return source.replace(/\n\)\s*$/, `\n${extraWat}\n)\n`);
  });
  const memory = new WebAssembly.Memory({
    initial: 8192,
    maximum: 8192,
    shared: true,
  });
  const hostCtx = {
    getMemory: () => memory.buffer,
    renderer: null,
    resourceJson: {},
  };
  const imports = createHostImports(hostCtx);
  imports.host.memory = memory;
  Object.assign(imports.host, {
    create_thread: () => 0,
    exit_thread: () => 0,
    create_event: () => 0,
    set_event: () => 0,
    reset_event: () => 0,
    wait_single: () => 0,
    wait_multiple: () => 0,
    com_create_instance: () => 0x80004002,
  });

  const { instance } = await WebAssembly.instantiate(wasm, imports);
  const e = instance.exports;
  const exe = fs.readFileSync(path.join(ROOT, 'test', 'binaries', 'calc.exe'));
  new Uint8Array(memory.buffer).set(exe, e.get_staging());
  assert(e.load_pe(exe.length), 'fixture PE initializes API dispatch');

  const imageBase = e.get_image_base() >>> 0;
  const guestBase = e.get_guest_base() >>> 0;
  const wa = guest => (guest - imageBase + guestBase) >>> 0;
  const bytes = new Uint8Array(memory.buffer);
  const dv = new DataView(memory.buffer);
  const alloc = size => e.guest_alloc(size) >>> 0;
  const writeAscii = value => {
    const guest = alloc(value.length + 1);
    for (let i = 0; i < value.length; i++) bytes[wa(guest) + i] = value.charCodeAt(i);
    bytes[wa(guest) + value.length] = 0;
    return guest;
  };
  const readAscii = guest => {
    let value = '';
    for (let p = wa(guest); bytes[p]; p++) value += String.fromCharCode(bytes[p]);
    return value;
  };
  const write32 = (guest, value) => dv.setUint32(wa(guest), value >>> 0, true);
  const read32 = guest => dv.getUint32(wa(guest), true);

  const makeApiCaller = name => {
    const api = apiTable.find(entry => entry.name === name);
    assert(api, `${name} is registered`);
    assert.strictEqual(api.nargs, 8, `${name} keeps its eight-argument ABI`);
    const thunk = e.test_make_api_thunk(api.id) >>> 0;
    return args => {
    const code = [];
    for (const arg of [...args].reverse()) code.push(0x68, ...u32(arg >>> 0));
    code.push(0xb8, ...u32(thunk), 0xff, 0xd0, 0xc2, 0x10, 0x00);
    const wrapper = alloc(code.length);
    bytes.set(code, wa(wrapper));
    e.call_func(wrapper, 0, 0, 0, 0);
    for (let i = 0; i < 1000 && e.get_eip(); i++) e.run(5000);
    assert.strictEqual(e.get_eip(), 0, `${name} wrapper terminates`);
    return e.get_eax() >>> 0;
    };
  };
  const callVerFindFile = makeApiCaller('VerFindFileA');

  const filename = writeAscii('missing.dll');
  const windowsDir = writeAscii('C:\\WINDOWS');
  const appDir = writeAscii('C:\\APP');
  const current = alloc(32);
  const currentLength = alloc(4);
  const destination = alloc(32);
  const destinationLength = alloc(4);
  write32(currentLength, 32);
  write32(destinationLength, 32);

  assert.strictEqual(callVerFindFile([
    0, filename, windowsDir, appDir, current, currentLength,
    destination, destinationLength,
  ]), 0x1, 'missing private file reports VFF_CURNEDEST');
  assert.strictEqual(readAscii(current), '', 'no installed version has an empty current directory');
  assert.strictEqual(read32(currentLength), 1, 'current length includes its NUL');
  assert.strictEqual(readAscii(destination), 'C:\\APP', 'private file destination is the app directory');
  assert.strictEqual(read32(destinationLength), 7, 'destination length includes its NUL');

  bytes.fill(0xcc, wa(destination), wa(destination) + 32);
  write32(currentLength, 32);
  write32(destinationLength, 4);
  assert.strictEqual(callVerFindFile([
    0, filename, windowsDir, appDir, current, currentLength,
    destination, destinationLength,
  ]), 0x5, 'short destination adds VFF_BUFFTOOSMALL');
  assert.strictEqual(readAscii(destination), 'C:\\', 'short output remains NUL-terminated');
  assert.strictEqual(read32(destinationLength), 7, 'short output reports the required capacity');

  write32(currentLength, 32);
  write32(destinationLength, 32);
  assert.strictEqual(callVerFindFile([
    1, filename, windowsDir, appDir, current, currentLength,
    destination, destinationLength,
  ]), 0x1, 'missing shared file reports VFF_CURNEDEST');
  assert.strictEqual(readAscii(destination), 'C:\\WINDOWS\\SYSTEM',
    'shared file destination is the Win98 system directory');
  assert.strictEqual(read32(destinationLength), 18,
    'shared destination length includes its NUL');

  // InstallShield's next call installs its generated temporary file under the
  // final executable name chosen above. Exercise that paired API against the
  // same in-memory VFS the real installer uses.
  hostCtx.vfs.dirs.add('c:\\source');
  hostCtx.vfs.dirs.add('c:\\app');
  hostCtx.vfs.files.set('c:\\source\\stage.tmp', {
    data: Uint8Array.from([0x4d, 0x5a, 0x90, 0x00]), attrs: 0x20,
  });
  const sourceFile = writeAscii('stage.tmp');
  const destFile = writeAscii('game.exe');
  const sourceDir = writeAscii('C:\\SOURCE');
  const tempFile = alloc(32);
  const tempLength = alloc(4);
  write32(tempLength, 32);
  const callVerInstallFile = makeApiCaller('VerInstallFileA');
  assert.strictEqual(callVerInstallFile([
    2, sourceFile, destFile, sourceDir, appDir, 0, tempFile, tempLength,
  ]), 0, 'staged file installs without VIF failure flags');
  assert(!hostCtx.vfs.files.has('c:\\source\\stage.tmp'),
    'successful installation consumes the staged source file');
  assert.deepStrictEqual(Array.from(hostCtx.vfs.files.get('c:\\app\\game.exe').data),
    [0x4d, 0x5a, 0x90, 0x00], 'destination keeps the staged payload bytes');
  assert.strictEqual(readAscii(tempFile), '', 'direct install reports no leftover temporary file');
  assert.strictEqual(read32(tempLength), 1, 'temporary filename length includes the NUL');

  console.log('test-ver-find-file: PASS');
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
