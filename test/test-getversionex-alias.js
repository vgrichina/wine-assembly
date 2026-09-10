#!/usr/bin/env node

'use strict';

const assert = require('assert');
const apiTable = require('../src/api_table.json');
const RegionMap = require('../lib/region-map.generated.js');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_get_proc_version_ex") (param $stack i32) (result i32)
    (local $name i32)
    (local.set $name (call $heap_alloc (i32.const 13)))
    (i32.store (call $g2w (local.get $name)) (i32.const 0x56746547)) ;; "GetV"
    (i32.store offset=4 (call $g2w (local.get $name)) (i32.const 0x69737265)) ;; "ersi"
    (i32.store offset=8 (call $g2w (local.get $name)) (i32.const 0x78456e6f)) ;; "onEx"
    (i32.store8 offset=12 (call $g2w (local.get $name)) (i32.const 0))
    (global.set $esp (local.get $stack))
    (call $handle_GetProcAddress
      (global.get $image_base) (local.get $name) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))

  (func (export "test_call_version_ex") (param $stack i32) (param $info i32) (result i32)
    (global.set $esp (local.get $stack))
    (call $handle_GetVersionEx
      (local.get $info) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $esp))

  (func (export "test_get_proc_system_windows_directory") (param $stack i32) (result i32)
    (local $name i32)
    (local.set $name (call $heap_alloc (i32.const 27)))
    (i32.store (call $g2w (local.get $name)) (i32.const 0x53746547)) ;; "GetS"
    (i32.store offset=4 (call $g2w (local.get $name)) (i32.const 0x65747379)) ;; "yste"
    (i32.store offset=8 (call $g2w (local.get $name)) (i32.const 0x6e69576d)) ;; "mWin"
    (i32.store offset=12 (call $g2w (local.get $name)) (i32.const 0x73776f64)) ;; "dows"
    (i32.store offset=16 (call $g2w (local.get $name)) (i32.const 0x65726944)) ;; "Dire"
    (i32.store offset=20 (call $g2w (local.get $name)) (i32.const 0x726f7463)) ;; "ctor"
    (i32.store offset=24 (call $g2w (local.get $name)) (i32.const 0x00004179)) ;; "yA"
    (global.set $esp (local.get $stack))
    (call $handle_GetProcAddress
      (global.get $image_base) (local.get $name) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))

  (func (export "test_call_system_windows_directory")
        (param $stack i32) (param $buf i32) (result i32)
    (global.set $esp (local.get $stack))
    (call $handle_GetSystemWindowsDirectoryA
      (local.get $buf) (i32.const 260) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $esp))

  (func (export "test_get_proc_system_default_ui_language") (param $stack i32) (result i32)
    (local $name i32)
    (local.set $name (call $heap_alloc (i32.const 27)))
    (i32.store (call $g2w (local.get $name)) (i32.const 0x53746547)) ;; "GetS"
    (i32.store offset=4 (call $g2w (local.get $name)) (i32.const 0x65747379)) ;; "yste"
    (i32.store offset=8 (call $g2w (local.get $name)) (i32.const 0x6665446d)) ;; "mDef"
    (i32.store offset=12 (call $g2w (local.get $name)) (i32.const 0x746c7561)) ;; "ault"
    (i32.store offset=16 (call $g2w (local.get $name)) (i32.const 0x614c4955)) ;; "UILa"
    (i32.store offset=20 (call $g2w (local.get $name)) (i32.const 0x6175676e)) ;; "ngua"
    (i32.store offset=24 (call $g2w (local.get $name)) (i32.const 0x00006567)) ;; "ge"
    (global.set $esp (local.get $stack))
    (call $handle_GetProcAddress
      (global.get $image_base) (local.get $name) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))

  (func (export "test_call_system_default_ui_language") (param $stack i32) (result i32)
    (global.set $esp (local.get $stack))
    (call $handle_GetSystemDefaultUILanguage
      (i32.const 0) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $esp))

  (func (export "test_get_proc_lstrlen") (param $stack i32) (result i32)
    (local $name i32)
    (local.set $name (call $heap_alloc (i32.const 8)))
    (i32.store (call $g2w (local.get $name)) (i32.const 0x7274736c)) ;; "lstr"
    (i32.store offset=4 (call $g2w (local.get $name)) (i32.const 0x006e656c)) ;; "len"
    (global.set $esp (local.get $stack))
    (call $handle_GetProcAddress
      (global.get $image_base) (local.get $name) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $eax))

  (func (export "test_call_lstrlen")
        (param $stack i32) (param $text i32) (result i32)
    (global.set $esp (local.get $stack))
    (call $handle_lstrlen
      (local.get $text) (i32.const 0) (i32.const 0)
      (i32.const 0) (i32.const 0) (i32.const 0))
    (global.get $esp))
`;

(async () => {
  const api = apiTable.find(entry => entry.name === 'GetVersionEx');
  assert(api, 'the historical unsuffixed GetVersionEx export exists');
  assert.strictEqual(api.nargs, 1, 'GetVersionEx has one stdcall argument');

  const { exports: wat, memory } = await bootRenderHarness({ extraWat, fonts: 'none' });
  const stack = 0x074ff000;
  const info = wat.guest_alloc(148) >>> 0;
  const infoWasm = RegionMap.g2w(info, wat.get_image_base());
  const view = new DataView(memory.buffer);
  view.setUint32(infoWasm, 148, true);

  assert.notStrictEqual(wat.test_get_proc_version_ex(stack) >>> 0, 0,
    'GetProcAddress(GetVersionEx) returns a callable thunk');
  assert.strictEqual(wat.test_call_version_ex(stack, info) >>> 0, stack + 8,
    'GetVersionEx pops its argument and return address');
  assert.strictEqual(wat.get_eax(), 1, 'GetVersionEx succeeds');
  assert.strictEqual(view.getUint32(infoWasm + 4, true), 4, 'reports Windows 98 major version');
  assert.strictEqual(view.getUint32(infoWasm + 8, true), 10, 'reports Windows 98 minor version');
  assert.strictEqual(view.getUint32(infoWasm + 16, true), 1,
    'reports VER_PLATFORM_WIN32_WINDOWS');

  const systemWindowsApi = apiTable.find(entry => entry.name === 'GetSystemWindowsDirectoryA');
  assert(systemWindowsApi, 'GetSystemWindowsDirectoryA is exposed to dynamic callers');
  assert.strictEqual(systemWindowsApi.nargs, 2, 'GetSystemWindowsDirectoryA has two arguments');
  assert.notStrictEqual(wat.test_get_proc_system_windows_directory(stack) >>> 0, 0,
    'GetProcAddress(GetSystemWindowsDirectoryA) returns a callable thunk');
  const path = wat.guest_alloc(260) >>> 0;
  assert.strictEqual(wat.test_call_system_windows_directory(stack, path) >>> 0, stack + 12,
    'GetSystemWindowsDirectoryA pops its arguments and return address');
  assert.strictEqual(wat.get_eax(), 10, 'GetSystemWindowsDirectoryA returns the path length');
  const pathWasm = RegionMap.g2w(path, wat.get_image_base());
  assert.strictEqual(Buffer.from(new Uint8Array(memory.buffer, pathWasm, 10)).toString('latin1'),
    'C:\\WINDOWS', 'GetSystemWindowsDirectoryA returns the Win98 Windows directory');

  const systemUiLanguageApi = apiTable.find(entry => entry.name === 'GetSystemDefaultUILanguage');
  assert(systemUiLanguageApi, 'GetSystemDefaultUILanguage is exposed to dynamic callers');
  assert.strictEqual(systemUiLanguageApi.nargs, 0,
    'GetSystemDefaultUILanguage has no arguments');
  assert.notStrictEqual(wat.test_get_proc_system_default_ui_language(stack) >>> 0, 0,
    'GetProcAddress(GetSystemDefaultUILanguage) returns a callable thunk');
  assert.strictEqual(wat.test_call_system_default_ui_language(stack) >>> 0, stack + 4,
    'GetSystemDefaultUILanguage pops only its return address');
  assert.strictEqual(wat.get_eax(), 0x0409,
    'GetSystemDefaultUILanguage reports English (United States)');

  const lstrlenApi = apiTable.find(entry => entry.name === 'lstrlen');
  assert(lstrlenApi, 'the unsuffixed lstrlen compatibility export exists');
  assert.strictEqual(lstrlenApi.nargs, 1, 'lstrlen has one argument');
  assert.notStrictEqual(wat.test_get_proc_lstrlen(stack) >>> 0, 0,
    'GetProcAddress(lstrlen) returns a callable thunk');
  const text = wat.guest_alloc(14) >>> 0;
  const textWasm = RegionMap.g2w(text, wat.get_image_base());
  new Uint8Array(memory.buffer, textWasm, 14).set(
    Buffer.from('Black & White\0', 'latin1'));
  assert.strictEqual(wat.test_call_lstrlen(stack, text) >>> 0, stack + 8,
    'lstrlen pops its argument and return address');
  assert.strictEqual(wat.get_eax(), 13, 'lstrlen uses ANSI byte-string semantics');

  console.log('PASS  InstallShield dynamic KERNEL32 compatibility exports resolve');
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
