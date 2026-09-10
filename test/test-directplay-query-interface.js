#!/usr/bin/env node
'use strict';

const { createHostImports } = require('../lib/host-imports');
const { compileSrcWasm } = require('./compile-src');

const extraWat = String.raw`
  (func (export "test_create_directplay3") (result i32)
    (call $dx_create_com_obj (i32.const 26) (global.get $DX_VTBL_DPLAY3)))

  (func (export "test_create_directplay_lobby2") (result i32)
    (call $dx_create_com_obj (i32.const 27) (global.get $DX_VTBL_DPLAYLOBBY2)))

  (func (export "test_dx_refcount") (param $obj i32) (result i32)
    (load.field DxObject refcount (call $dx_from_this (local.get $obj))))

  (func (export "test_call_directplay3_qi")
      (param $obj i32) (param $iid i32) (param $out i32) (result i32)
    (global.set $esp (i32.const 0x00300000))
    (call $handle_IDirectPlay3_QueryInterface
      (local.get $obj) (local.get $iid) (local.get $out)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))

  (func (export "test_call_lobby2_qi")
      (param $obj i32) (param $iid i32) (param $out i32) (result i32)
    (global.set $esp (i32.const 0x00300000))
    (call $handle_IDirectPlayLobby2_QueryInterface
      (local.get $obj) (local.get $iid) (local.get $out)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))

  (func (export "test_call_directplay3_release") (param $obj i32) (result i32)
    (global.set $esp (i32.const 0x00300000))
    (call $handle_IDirectPlay3_Release
      (local.get $obj) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))

  (func (export "test_call_lobby2_release") (param $obj i32) (result i32)
    (global.set $esp (i32.const 0x00300000))
    (call $handle_IDirectPlayLobby2_Release
      (local.get $obj) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))
`;

async function main() {
  const wasm = compileSrcWasm((file, source) =>
    file === '13-exports.wat' ? `${source}\n${extraWat}\n` : source);
  const memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
  const imports = createHostImports({ getMemory: () => memory.buffer, renderer: null, resourceJson: {} });
  imports.host.memory = memory;
  Object.assign(imports.host, {
    create_thread: () => 0, exit_thread: () => 0, terminate_thread: () => 0,
    create_event: () => 0,
    set_event: () => 0, reset_event: () => 0, wait_single: () => 0,
    wait_multiple: () => 0, com_create_instance: () => 0x80004002,
  });
  const { instance } = await WebAssembly.instantiate(wasm, imports);
  const e = instance.exports;
  e.init_dx_com_thunks();
  const dv = new DataView(memory.buffer);
  const wa = gp => gp - e.get_image_base() + e.get_guest_base();
  const alloc = n => e.guest_alloc(n) >>> 0;
  let pass = 0;
  let fail = 0;
  const check = (name, ok) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
    ok ? pass++ : fail++;
  };
  const writeGuid = words => {
    const value = alloc(16);
    words.forEach((word, i) => dv.setUint32(wa(value) + i * 4, word, true));
    return value;
  };

  const iunknown = writeGuid([0, 0, 0x000000c0, 0x46000000]);
  const dplay2a = writeGuid([0x9d460580, 0x11cfa822, 0x80000c96, 0x824e53c7]);
  const dplay3a = writeGuid([0x133efe41, 0x11d032dc, 0xa000fb9c, 0xcb430ac9]);
  const dplay3w = writeGuid([0x133efe40, 0x11d032dc, 0xa000fb9c, 0xcb430ac9]);
  const dplay4a = writeGuid([0x0ab1c531, 0x11d14745, 0x0000a1a7, 0xfcab03f8]);
  const lobbyA = writeGuid([0x26c66a70, 0x11cfb367, 0xaa0024a0, 0xac576100]);
  const lobby2a = writeGuid([0x1bb4af80, 0x11d0a303, 0xa0004f9c, 0x5e4205c9]);
  const lobby2w = writeGuid([0x0194c220, 0x11d0a303, 0xa0004f9c, 0x5e4205c9]);
  const sameData1WrongSuffix = writeGuid([0x133efe41, 0, 0, 0]);
  const out = alloc(4);

  const dplay = e.test_create_directplay3() >>> 0;
  check('creates the bounded ANSI DirectPlay3 object',
    dplay !== 0 && e.test_dx_refcount(dplay) === 1);
  check('DirectPlay3 QueryInterface returns E_POINTER without AddRef',
    (e.test_call_directplay3_qi(dplay, dplay3a, 0) >>> 0) === 0x80004003 &&
    e.test_dx_refcount(dplay) === 1 && (e.get_esp() >>> 0) === 0x00300010);
  dv.setUint32(wa(out), 0xfeedface, true);
  check('DirectPlay3 rejects a same-Data1 partial GUID and clears output',
    (e.test_call_directplay3_qi(dplay, sameData1WrongSuffix, out) >>> 0) === 0x80004002 &&
    dv.getUint32(wa(out), true) === 0 && e.test_dx_refcount(dplay) === 1);
  check('DirectPlay3 rejects the Unicode sibling interface',
    (e.test_call_directplay3_qi(dplay, dplay3w, out) >>> 0) === 0x80004002 &&
    e.test_dx_refcount(dplay) === 1);
  check('DirectPlay3 rejects DirectPlay4A because its six tail slots are absent',
    (e.test_call_directplay3_qi(dplay, dplay4a, out) >>> 0) === 0x80004002 &&
    e.test_dx_refcount(dplay) === 1);
  check('DirectPlay3 accepts inherited IDirectPlay2A and AddRefs',
    e.test_call_directplay3_qi(dplay, dplay2a, out) === 0 &&
    dv.getUint32(wa(out), true) === dplay && e.test_dx_refcount(dplay) === 2);
  check('DirectPlay2A query reference balances', e.test_call_directplay3_release(dplay) === 1);
  check('DirectPlay3 accepts its own live Bellhop IID and AddRefs',
    e.test_call_directplay3_qi(dplay, dplay3a, out) === 0 &&
    dv.getUint32(wa(out), true) === dplay && e.test_dx_refcount(dplay) === 2);
  check('DirectPlay3 own-IID query reference balances', e.test_call_directplay3_release(dplay) === 1);
  check('DirectPlay3 accepts IUnknown and AddRefs',
    e.test_call_directplay3_qi(dplay, iunknown, out) === 0 && e.test_dx_refcount(dplay) === 2);
  check('DirectPlay3 references balance to destruction',
    e.test_call_directplay3_release(dplay) === 1 && e.test_call_directplay3_release(dplay) === 0);

  const lobby = e.test_create_directplay_lobby2() >>> 0;
  check('creates the bounded ANSI DirectPlayLobby2 object',
    lobby !== 0 && e.test_dx_refcount(lobby) === 1);
  check('Lobby2 rejects the Unicode sibling and clears output',
    (e.test_call_lobby2_qi(lobby, lobby2w, out) >>> 0) === 0x80004002 &&
    dv.getUint32(wa(out), true) === 0 && e.test_dx_refcount(lobby) === 1);
  check('Lobby2 rejects an IID from the DirectPlay object family',
    (e.test_call_lobby2_qi(lobby, dplay3a, out) >>> 0) === 0x80004002 &&
    e.test_dx_refcount(lobby) === 1);
  check('Lobby2 accepts inherited IDirectPlayLobbyA and AddRefs',
    e.test_call_lobby2_qi(lobby, lobbyA, out) === 0 &&
    dv.getUint32(wa(out), true) === lobby && e.test_dx_refcount(lobby) === 2);
  check('LobbyA query reference balances', e.test_call_lobby2_release(lobby) === 1);
  check('Lobby2 accepts its own live Bellhop IID and AddRefs',
    e.test_call_lobby2_qi(lobby, lobby2a, out) === 0 &&
    dv.getUint32(wa(out), true) === lobby && e.test_dx_refcount(lobby) === 2);
  check('Lobby2 own-IID query reference balances', e.test_call_lobby2_release(lobby) === 1);
  check('Lobby2 accepts IUnknown and AddRefs',
    e.test_call_lobby2_qi(lobby, iunknown, out) === 0 && e.test_dx_refcount(lobby) === 2);
  check('Lobby2 references balance to destruction',
    e.test_call_lobby2_release(lobby) === 1 && e.test_call_lobby2_release(lobby) === 0);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
