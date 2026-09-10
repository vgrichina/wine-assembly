#!/usr/bin/env node
'use strict';
const assert = require('assert');
const { interfaces } = require('../tools/d3d9-methods');
const apis = require('../src/api_table.json');
// Including this. The resource creators include their final pSharedHandle;
// ProcessVertices also includes pVertexDecl before Flags.
// Primary declaration: Wine include/d3d9.h IDirect3DDevice9 (Windows SDK ABI).
const expected = { CreateTexture:9, CreateVolumeTexture:10, CreateCubeTexture:8,
  CreateVertexBuffer:7, CreateIndexBuffer:7, CreateRenderTarget:9,
  CreateDepthStencilSurface:9, ProcessVertices:7 };
const device = interfaces.find(i=>i.prefix==='IDirect3DDevice9');
for (const [name,count] of Object.entries(expected)) {
  assert.strictEqual(device.methods.find(m=>m.name===name).nargs,count,`spec ${name}`);
  assert.strictEqual(apis.find(a=>a.name===`IDirect3DDevice9_${name}`).nargs,count,`API ${name}`);
}
console.log('PASS D3D9 resource creation/ProcessVertices stdcall signatures');
