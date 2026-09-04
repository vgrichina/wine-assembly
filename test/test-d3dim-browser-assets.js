#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { APPS, appFileUrl } = require('../lib/apps');
const { isLoadableDll, dllPath } = require('../lib/dll-registry');

const root = path.join(__dirname, '..');
const generatedDispatch = fs.readFileSync(
  path.join(root, 'src', '09b2-dispatch-table.generated.wat'), 'utf8');
const directxHandlers = fs.readFileSync(
  path.join(root, 'src', '09a8-handlers-directx.wat'), 'utf8');

assert(directxHandlers.includes('(func $set_com_vtable_slot_api_id'),
  'DirectX must provide a helper for stable API ids whose COM slot is non-sequential');
assert(generatedDispatch.includes(
  '(call $set_com_vtable_slot_api_id (global.get $DX_VTBL_D3DDEV7) (i32.const 20) (i32.const 1394))'),
  'IDirect3DDevice7 slot 20 must dispatch SetRenderState');
assert(generatedDispatch.includes(
  '(call $set_com_vtable_slot_api_id (global.get $DX_VTBL_D3DDEV7) (i32.const 37) (i32.const 1382))'),
  'IDirect3DDevice7 slot 37 must dispatch SetTextureStageState');

assert.strictEqual(isLoadableDll('D3DXOF.DLL'), true,
  'browser DLL policy must recognize the retained-mode .x loader');
assert.strictEqual(dllPath('d3dxof.dll'), 'binaries/dlls/d3dxof.dll');
assert(fs.existsSync(path.join(root, dllPath('d3dxof.dll'))),
  'the registered d3dxof DLL must be present');

const viewerFiles = APPS.dx_viewer.files;
const expectedAliases = new Map([
  ['c:\\camera.x', 'test/fixtures/d3drm/tetra.x'],
  ['c:\\mslogo.x', 'test/fixtures/d3drm/cube.x'],
  ['c:\\sphere2.x', 'test/fixtures/d3drm/cube.x'],
]);
for (const [vfsPath, url] of expectedAliases) {
  assert(viewerFiles.some(file => file && typeof file === 'object' &&
    file.vfsPath === vfsPath && file.url === url),
  `Viewer must mount a plain Mesh fixture at ${vfsPath}`);
  assert(fs.existsSync(path.join(root, url)), `${url} must exist`);
}

for (const invalid of ['camera.x', 'mslogo.x', 'sphere2.x']) {
  assert(!viewerFiles.some(file => appFileUrl(file).toLowerCase() ===
    `binaries/dx-sdk/bin/${invalid}`),
  `Viewer must not mount the fabricated ProgressiveMesh ${invalid}`);
}

console.log('PASS D3DIM browser manifests load retained-mode DLL and valid Viewer meshes');
