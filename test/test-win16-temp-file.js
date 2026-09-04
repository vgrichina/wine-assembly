#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { bootRenderHarness } = require('./render-helper');

const extraWat = String.raw`
  (func (export "test_win16_temp_file") (param $drive i32) (param $unique i32) (result i32)
    (call $win16_seg_set (i32.const 1) (i32.const 0x00100000)
      (i32.const 0x10000) (i32.const 0) (i32.const 1))
    (call $win16_seg_set (i32.const 2) (i32.const 0x00110000)
      (i32.const 0x10000) (i32.const 1) (i32.const 2))
    (global.set $code16 (i32.const 1))
    (global.set $sreg_cs (call $win16_index_to_sel (i32.const 1)))
    (global.set $seg_base_cs (i32.const 0x00100000))
    (global.set $sreg_ss (call $win16_index_to_sel (i32.const 2)))
    (global.set $seg_base_ss (i32.const 0x00110000))
    (global.set $sreg_ds (call $win16_index_to_sel (i32.const 2)))
    (global.set $seg_base_ds (i32.const 0x00110000))
    (call $gs8 (i32.const 0x00110200) (i32.const 0x53)) ;; S
    (call $gs8 (i32.const 0x00110201) (i32.const 0x44)) ;; D
    (call $gs8 (i32.const 0x00110202) (i32.const 0))
    (global.set $esp (i32.const 0x00110100))
    ;; Far return, then Pascal's rightmost argument first.
    (call $gs16 (i32.const 0x00110100) (i32.const 0x0010))
    (call $gs16 (i32.const 0x00110102) (call $win16_index_to_sel (i32.const 1)))
    (call $gs16 (i32.const 0x00110104) (i32.const 0x0300))
    (call $gs16 (i32.const 0x00110106) (call $win16_index_to_sel (i32.const 2)))
    (call $gs16 (i32.const 0x00110108) (local.get $unique))
    (call $gs16 (i32.const 0x0011010A) (i32.const 0x0200))
    (call $gs16 (i32.const 0x0011010C) (call $win16_index_to_sel (i32.const 2)))
    (call $gs16 (i32.const 0x0011010E) (local.get $drive))
    (drop (call $win16_kernel (i32.const 97)))
    (i32.or (i32.and (global.get $eax) (i32.const 0xFFFF))
      (i32.shl (global.get $esp) (i32.const 16))))

  (func (export "test_win16_temp_byte") (param $index i32) (result i32)
    (call $gl8 (i32.add (i32.const 0x00110300) (local.get $index))))

  (func (export "test_win16_mkdir") (result i32)
    (call $win16_seg_set (i32.const 2) (i32.const 0x00110000)
      (i32.const 0x10000) (i32.const 1) (i32.const 2))
    (global.set $sreg_ds (call $win16_index_to_sel (i32.const 2)))
    (global.set $seg_base_ds (i32.const 0x00110000))
    ;; C:\WINDOWS\TEMP\WISE
    (i64.store (call $g2w (i32.const 0x00110400))
      (i64.const 0x4F444E49575C3A43))
    (i64.store offset=8 (call $g2w (i32.const 0x00110400))
      (i64.const 0x5C504D45545C5357))
    (i64.store offset=16 (call $g2w (i32.const 0x00110400))
      (i64.const 0x00000045534957))
    (global.set $edx (i32.const 0x0400))
    (global.set $eax (i32.const 0x3900))
    (call $win16_dos_int21)
    (global.get $eax))

  (func (export "test_win16_disk_free") (param $which i32) (result i32)
    (global.set $eax (i32.const 0x3600))
    (call $win16_dos_int21)
    (if (result i32) (i32.eqz (local.get $which))
      (then (global.get $eax))
      (else (if (result i32) (i32.eq (local.get $which) (i32.const 1))
        (then (global.get $ebx))
        (else (if (result i32) (i32.eq (local.get $which) (i32.const 2))
          (then (global.get $ecx))
          (else (global.get $edx))))))))

  (func (export "test_win16_rename") (result i32)
    (call $win16_seg_set (i32.const 2) (i32.const 0x00110000)
      (i32.const 0x10000) (i32.const 1) (i32.const 2))
    (global.set $sreg_ds (call $win16_index_to_sel (i32.const 2)))
    (global.set $seg_base_ds (i32.const 0x00110000))
    (call $win16_set_sreg (i32.const 0) (call $win16_index_to_sel (i32.const 2)))
    (i64.store (call $g2w (i32.const 0x00110500))
      (i64.const 0x2E444C4F5C3A43)) ;; C:\OLD.
    (i32.store offset=7 (call $g2w (i32.const 0x00110500))
      (i32.const 0x00504D54))       ;; TMP\0
    (i64.store (call $g2w (i32.const 0x00110540))
      (i64.const 0x2E57454E5C3A43)) ;; C:\NEW.
    (i32.store offset=7 (call $g2w (i32.const 0x00110540))
      (i32.const 0x00504D54))       ;; TMP\0
    (global.set $edx (i32.const 0x0500))
    (global.set $edi (i32.const 0x0540))
    (global.set $eax (i32.const 0x5600))
    (call $win16_dos_int21)
    (global.get $eax))

  (func (export "test_win16_ctl3d_module") (param $v2 i32) (result i32)
    (local $name i32) (local $module i32)
    (call $win16_dynamic_modules_reset)
    (local.set $name (call $g2w (i32.const 0x00110600)))
    (i32.store8 (local.get $name) (select (i32.const 7) (i32.const 5) (local.get $v2)))
    (i32.store offset=1 (local.get $name) (i32.const 0x334C5443)) ;; CTL3
    (i32.store16 offset=5 (local.get $name) (i32.const 0x5644))  ;; DV
    (i32.store8 offset=7 (local.get $name) (i32.const 0x32))     ;; 2
    (local.set $module (call $win16_dynamic_module_id (local.get $name)))
    (i32.or (local.get $module)
      (i32.shl (call $win16_module_emulated (local.get $module)) (i32.const 16))))

  (func (export "test_win16_ctl3d_ordinal") (param $which i32) (result i32)
    (local $name i32)
    (local.set $name (call $g2w (i32.const 0x00110640)))
    (if (i32.eq (local.get $which) (i32.const 1))
      (then
        (i32.store8 (local.get $name) (i32.const 13))
        (i64.store offset=1 (local.get $name) (i64.const 0x47455244334C5443))
        (i32.store offset=9 (local.get $name) (i32.const 0x45545349))
        (i32.store8 offset=13 (local.get $name) (i32.const 0x52))))
    (if (i32.eq (local.get $which) (i32.const 2))
      (then
        (i32.store8 (local.get $name) (i32.const 15))
        (i64.store offset=1 (local.get $name) (i64.const 0x524E5544334C5443))
        (i32.store offset=9 (local.get $name) (i32.const 0x53494745))
        (i32.store16 offset=13 (local.get $name) (i32.const 0x4554))
        (i32.store8 offset=15 (local.get $name) (i32.const 0x52))))
    (if (i32.eq (local.get $which) (i32.const 3))
      (then
        (i32.store8 (local.get $name) (i32.const 17))
        (i64.store offset=1 (local.get $name) (i64.const 0x54554144334C5443))
        (i64.store offset=9 (local.get $name) (i64.const 0x53414C434255534F))
        (i32.store8 offset=17 (local.get $name) (i32.const 0x53))))
    (if (i32.eq (local.get $which) (i32.const 4))
      (then
        (i32.store8 (local.get $name) (i32.const 18))
        (i64.store offset=1 (local.get $name) (i64.const 0x474C4444334C5443))
        (i64.store offset=9 (local.get $name) (i64.const 0x494150454D415246))
        (i32.store16 offset=17 (local.get $name) (i32.const 0x544E))))
    (call $win16_ctl3d_ordinal (local.get $name)))

  (func (export "test_win16_ctl3d_call") (param $ordinal i32) (result i32)
    (call $win16_seg_set (i32.const 1) (i32.const 0x00100000)
      (i32.const 0x10000) (i32.const 0) (i32.const 1))
    (call $win16_seg_set (i32.const 2) (i32.const 0x00110000)
      (i32.const 0x10000) (i32.const 1) (i32.const 2))
    (global.set $code16 (i32.const 1))
    (global.set $sreg_cs (call $win16_index_to_sel (i32.const 1)))
    (global.set $seg_base_cs (i32.const 0x00100000))
    (global.set $sreg_ss (call $win16_index_to_sel (i32.const 2)))
    (global.set $seg_base_ss (i32.const 0x00110000))
    (global.set $esp (i32.const 0x00110100))
    (call $gs16 (i32.const 0x00110100) (i32.const 0x0010))
    (call $gs16 (i32.const 0x00110102) (call $win16_index_to_sel (i32.const 1)))
    (drop (call $win16_ctl3d (local.get $ordinal)))
    (i32.or (i32.and (global.get $eax) (i32.const 0xFFFF))
      (i32.shl (i32.sub (global.get $esp) (i32.const 0x00110000)) (i32.const 16))))
`;

(async () => {
  const apiSource = fs.readFileSync(path.join(__dirname, '..', 'src', '09e-win16-api.wat'), 'utf8');
  const dialogSource = fs.readFileSync(path.join(__dirname, '..', 'src', '09e2-win16-dialog.wat'), 'utf8');
  const loaderSource = fs.readFileSync(path.join(__dirname, '..', 'src', '08c-ne-loader.wat'), 'utf8');
  const hostImportsSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'host-imports.js'), 'utf8');
  const browserHostSource = fs.readFileSync(path.join(__dirname, '..', 'host.js'), 'utf8');
  assert.match(apiSource,
    /i32\.eq \(local\.get \$ordinal\) \(i32\.const 7\)[\s\S]{0,120}win16_SetStretchBltMode/,
    'Win16 GDI.7 should dispatch through the shared stretch-mode state');
  assert.match(apiSource,
    /i32\.eq \(local\.get \$ordinal\) \(i32\.const 20\)[\s\S]{0,100}win16_ShellExecute/,
    'Win16 SHELL.20 should reach the shared VFS-aware ShellExecute host path');
  assert.match(dialogSource,
    /func \$win16_DialogBoxIndirect[\s\S]*?win16_gseg_field[\s\S]*?win16_dlg_to32[\s\S]*?win16_dlg_run/,
    'DialogBoxIndirect should validate, convert, and run its HGLOBAL template');
  assert.match(dialogSource,
    /func \$win16_DialogBox \(param \$with_param[\s\S]*?win16_res_module[\s\S]*?win16_res_module_id[\s\S]*?win16_find_resource/,
    'DialogBox should resolve its template in the caller-supplied hInstance');
  assert.match(dialogSource,
    /func \$win16_DialogBoxIndirect \(param \$modeless i32\)[\s\S]*?win16_dlg_modeless_pending[\s\S]*?win16_dlg_run/,
    'CreateDialogIndirect should share template conversion but return through the modeless continuation');
  assert.match(dialogSource,
    /local\.set \$offset \(select[\s\S]*?local\.set \$handle[\s\S]*?local\.set \$frame \(select \(i32\.const 12\)[\s\S]*?win16_far_to_guest[\s\S]*?local\.get \$offset/,
    'CreateDialogIndirect should consume its 12-byte frame and convert the supplied far template pointer');
  assert.match(apiSource,
    /ordinal\) \(i32\.const 219\)[\s\S]{0,120}win16_DialogBoxIndirect \(i32\.const 1\)/,
    'USER.219 CreateDialogIndirect should select the modeless indirect-dialog path');
  assert.match(apiSource,
    /func \$win16_DispatchMessage[\s\S]*?WNDPROC_DIALOG[\s\S]*?dialog_proc_get[\s\S]*?win16_enter_wndproc/,
    'DispatchMessage should enter the retained DLGPROC for a modeless Win16 dialog');
  assert.match(apiSource,
    /ordinal\) \(i32\.const 89\)[\s\S]{0,120}win16_DialogBox \(i32\.const 0\) \(i32\.const 1\)/,
    'USER.89 CreateDialog should select the modeless resource-dialog path');
  assert.match(apiSource,
    /ordinal\) \(i32\.const 126\)[\s\S]{0,120}win16_InvalidateRgn/,
    'USER.126 InvalidateRgn should reach the shared invalidation handler');
  assert.match(loaderSource,
    /func \$load_ne_dll_sized[\s\S]*?local\.get \$staged_size[\s\S]*?local\.get \$meta_pages[\s\S]*?local\.get \$meta_size/,
    'dynamic Win16 DLLs should retain their complete staged image, not only the first 64KB');
  assert.match(loaderSource,
    /func \$win16_dll_image_size_ptr[\s\S]{0,400}i32\.const 0x8800/,
    'dynamic image lengths should stay in the gap before the resource descriptor table');
  assert.match(apiSource,
    /func \$win16_LoadLibrary[\s\S]*?host_win16_stage_module[\s\S]*?load_ne_dll_sized/,
    'Win16 LoadLibrary should pass the exact staged byte length to the NE loader');
  assert.match(hostImportsSource,
    /return Number\(ctx\.win16StageModule\(name, id\)\) \|\| 0/,
    'the shared host import should preserve the staged byte length');
  assert.match(browserHostSource,
    /_stageWin16Module\(name, id\)[\s\S]*?memory\.set\(bytes, base\);\s*return bytes\.length;/,
    'the browser staging callback should return the exact helper image length');
  const { exports: e, hostCtx } = await bootRenderHarness({ extraWat, fonts: 'none' });
  const result = e.test_win16_temp_file(0x63, 0x1234) >>> 0;
  assert.strictEqual(result & 0xFFFF, 0x1234,
    'KERNEL.97 should preserve a caller-supplied unique number');
  assert.strictEqual(result >>> 16, 0x0110,
    'GetTempFileName16 should pop its 12-byte Pascal argument frame');
  const text = Array.from({ length: 64 }, (_, i) => e.test_win16_temp_byte(i))
    .slice(0, Array.from({ length: 64 }, (_, i) => e.test_win16_temp_byte(i)).indexOf(0))
    .map(ch => String.fromCharCode(ch)).join('');
  assert.strictEqual(text, 'C:\\WINDOWS\\TEMP\\SD1234.tmp');
  assert.strictEqual(e.test_win16_mkdir() & 0xFFFF, 0,
    'DOS3Call AH=39 should report successful directory creation in AX');
  assert.ok(hostCtx.vfs.dirs.has('c:\\windows\\temp\\wise'),
    'DOS3Call AH=39 should create the requested VFS directory');
  assert.deepStrictEqual([0, 1, 2, 3].map(n => e.test_win16_disk_free(n) & 0xFFFF),
    [8, 32768, 512, 65535],
    'DOS3Call AH=36 should advertise enough writable space for period installers');
  hostCtx.vfs.files.set('c:\\old.tmp', { data: Uint8Array.of(1, 2, 3), attrs: 0x20 });
  assert.strictEqual(e.test_win16_rename() & 0xFFFF, 0,
    'DOS3Call AH=56 should report successful file rename in AX');
  assert.ok(!hostCtx.vfs.files.has('c:\\old.tmp') && hostCtx.vfs.files.has('c:\\new.tmp'),
    'DOS3Call AH=56 should move the file to the ES:DI path');
  assert.strictEqual(e.test_win16_ctl3d_module(0), 0x0001000D,
    'CTL3D should receive a dynamic pseudo-module handle and be emulated');
  assert.strictEqual(e.test_win16_ctl3d_module(1), 0x0001000D,
    'CTL3DV2 should use the same narrowly matched emulation path');
  assert.deepStrictEqual([1, 2, 3, 4].map(n => e.test_win16_ctl3d_ordinal(n)), [1, 2, 3, 4],
    'all CTL3D exports requested by WISE should resolve by name');
  assert.strictEqual(e.test_win16_ctl3d_call(1) >>> 0, 0x01060001,
    'Ctl3dRegister should return TRUE and pop its HINSTANCE argument');
  assert.strictEqual(e.test_win16_ctl3d_call(4) >>> 0, 0x010E0000,
    'Ctl3dDlgFramePaint should return FALSE and pop its 10-byte frame');
  console.log('test-win16-temp-file: PASS');
})().catch(error => { console.error(error); process.exit(1); });
