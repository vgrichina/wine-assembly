// d3dim-methods.js — shared spec of Direct3D Immediate Mode interface methods
// Consumed by gen_api_table.js (to append API entries) and gen_d3dim_stubs.js
// (to generate stub handler WAT).
//
// nargs is the stdcall argument count (including `this`). Used both for
// ESP-cleanup in stub bodies (4 + nargs*4) and for handler-frame param count.
// All COM stubs here use the standard handler signature (5 args + name_ptr).

'use strict';

// Each entry: { prefix, methods: [ { name, nargs, ret? } ] }
// ret defaults to 'D3D_OK' (0). 'NOOP_VOID' returns nothing-meaningful (eax=0).
// 'TRUE' returns 1, 'NOTIMPL' returns 0x80004001.
//
// Interface lists below are canonical DX5/6/7 orderings (Wine + DXSDK consensus).
// IDs allocated via gen_api_table.js (existing.length-based, contiguous per interface).

const interfaces = [
  // ── IDirect3D2 ──────────────────────────────────────────────────────
  { prefix: 'IDirect3D2', methods: [
    { name: 'QueryInterface', nargs: 3 },
    { name: 'AddRef',         nargs: 1, ret: 'ADDREF' },
    { name: 'Release',        nargs: 1, ret: 'RELEASE' },
    { name: 'EnumDevices',    nargs: 3 },
    { name: 'CreateLight',    nargs: 3, body: 'CREATE_LIGHT' },
    { name: 'CreateMaterial', nargs: 3, body: 'CREATE_MATERIAL' },
    { name: 'CreateViewport', nargs: 3, body: 'CREATE_VIEWPORT' },
    { name: 'FindDevice',     nargs: 3 },
    { name: 'CreateDevice',   nargs: 4, body: 'CREATE_DEVICE2' },
  ]},

  // ── IDirect3D7 ──────────────────────────────────────────────────────
  { prefix: 'IDirect3D7', methods: [
    { name: 'QueryInterface',           nargs: 3 },
    { name: 'AddRef',                   nargs: 1, ret: 'ADDREF' },
    { name: 'Release',                  nargs: 1, ret: 'RELEASE' },
    { name: 'EnumDevices',              nargs: 3 },
    { name: 'CreateDevice',             nargs: 4, body: 'CREATE_DEVICE7' },
    { name: 'CreateVertexBuffer',       nargs: 4, body: 'CREATE_VB7' },
    { name: 'EnumZBufferFormats',       nargs: 4 },
    { name: 'EvictManagedTextures',     nargs: 1 },
  ]},

  // ── IDirect3DDevice (v1) ────────────────────────────────────────────
  { prefix: 'IDirect3DDevice', methods: [
    { name: 'QueryInterface',     nargs: 3 },
    { name: 'AddRef',             nargs: 1, ret: 'ADDREF' },
    { name: 'Release',            nargs: 1, ret: 'RELEASE' },
    { name: 'Initialize',         nargs: 4 },
    { name: 'GetCaps',            nargs: 3 },
    { name: 'SwapTextureHandles', nargs: 3 },
    { name: 'CreateExecuteBuffer', nargs: 4, body: 'CREATE_EXEC' },
    { name: 'GetStats',           nargs: 2 },
    { name: 'Execute',            nargs: 4 },
    { name: 'AddViewport',        nargs: 2 },
    { name: 'DeleteViewport',     nargs: 2 },
    { name: 'NextViewport',       nargs: 4 },
    { name: 'Pick',               nargs: 5 },
    { name: 'GetPickRecords',     nargs: 3 },
    { name: 'EnumTextureFormats', nargs: 3 },
    { name: 'CreateMatrix',       nargs: 2 },
    { name: 'SetMatrix',          nargs: 3 },
    { name: 'GetMatrix',          nargs: 3 },
    { name: 'DeleteMatrix',       nargs: 2 },
    { name: 'BeginScene',         nargs: 1, body: 'BEGIN_SCENE' },
    { name: 'EndScene',           nargs: 1, body: 'END_SCENE' },
    { name: 'GetDirect3D',        nargs: 2 },
  ]},

  // ── IDirect3DDevice2 ────────────────────────────────────────────────
  { prefix: 'IDirect3DDevice2', methods: [
    { name: 'QueryInterface',          nargs: 3 },
    { name: 'AddRef',                  nargs: 1, ret: 'ADDREF' },
    { name: 'Release',                 nargs: 1, ret: 'RELEASE' },
    { name: 'GetCaps',                 nargs: 3 },
    { name: 'SwapTextureHandles',      nargs: 3 },
    { name: 'GetStats',                nargs: 2 },
    { name: 'AddViewport',             nargs: 2 },
    { name: 'DeleteViewport',          nargs: 2 },
    { name: 'NextViewport',            nargs: 4 },
    { name: 'EnumTextureFormats',      nargs: 3 },
    { name: 'BeginScene',              nargs: 1, body: 'BEGIN_SCENE' },
    { name: 'EndScene',                nargs: 1, body: 'END_SCENE' },
    { name: 'GetDirect3D',             nargs: 2 },
    { name: 'SetCurrentViewport',      nargs: 2, body: 'SET_VP_DEV' },
    { name: 'GetCurrentViewport',      nargs: 2, body: 'GET_VP_DEV' },
    { name: 'SetRenderTarget',         nargs: 3 },
    { name: 'GetRenderTarget',         nargs: 2 },
    { name: 'Begin',                   nargs: 4 },
    { name: 'BeginIndexed',            nargs: 6 },
    { name: 'Vertex',                  nargs: 2 },
    { name: 'Index',                   nargs: 2 },
    { name: 'End',                     nargs: 2 },
    { name: 'GetRenderState',          nargs: 3 },
    { name: 'SetRenderState',          nargs: 3, body: 'SET_RS' },
    { name: 'GetLightState',           nargs: 3 },
    { name: 'SetLightState',           nargs: 3, body: 'SET_LS' },
    { name: 'SetTransform',            nargs: 3, body: 'SET_XFORM' },
    { name: 'GetTransform',            nargs: 3 },
    { name: 'MultiplyTransform',       nargs: 3 },
    { name: 'DrawPrimitive',           nargs: 6 },
    { name: 'DrawIndexedPrimitive',    nargs: 8 },
    { name: 'SetClipStatus',           nargs: 2 },
    { name: 'GetClipStatus',           nargs: 2 },
  ]},

  // ── IDirect3DDevice7 ────────────────────────────────────────────────
  { prefix: 'IDirect3DDevice7', methods: [
    { name: 'QueryInterface',                nargs: 3 },
    { name: 'AddRef',                        nargs: 1, ret: 'ADDREF' },
    { name: 'Release',                       nargs: 1, ret: 'RELEASE' },
    { name: 'GetCaps',                       nargs: 2 },
    { name: 'EnumTextureFormats',            nargs: 3 },
    { name: 'BeginScene',                    nargs: 1, body: 'BEGIN_SCENE' },
    { name: 'EndScene',                      nargs: 1, body: 'END_SCENE' },
    { name: 'GetDirect3D',                   nargs: 2 },
    { name: 'SetRenderTarget',               nargs: 3 },
    { name: 'GetRenderTarget',               nargs: 2 },
    { name: 'Clear',                         nargs: 6 },
    { name: 'SetTransform',                  nargs: 3, body: 'SET_XFORM' },
    { name: 'GetTransform',                  nargs: 3 },
    { name: 'SetViewport',                   nargs: 2 },
    { name: 'MultiplyTransform',             nargs: 3 },
    { name: 'GetViewport',                   nargs: 2 },
    { name: 'SetMaterial',                   nargs: 2 },
    { name: 'GetMaterial',                   nargs: 2 },
    { name: 'SetLight',                      nargs: 3 },
    { name: 'GetLight',                      nargs: 3 },
    { name: 'BeginStateBlock',               nargs: 1 },
    { name: 'EndStateBlock',                 nargs: 2 },
    { name: 'PreLoad',                       nargs: 2 },
    { name: 'DrawPrimitive',                 nargs: 5 },
    { name: 'DrawIndexedPrimitive',          nargs: 7 },
    { name: 'SetClipStatus',                 nargs: 2 },
    { name: 'GetClipStatus',                 nargs: 2 },
    { name: 'DrawPrimitiveStrided',          nargs: 6 },
    { name: 'DrawIndexedPrimitiveStrided',   nargs: 8 },
    { name: 'DrawPrimitiveVB',               nargs: 6 },
    { name: 'DrawIndexedPrimitiveVB',        nargs: 7 },
    { name: 'ComputeSphereVisibility',       nargs: 5 },
    { name: 'GetTexture',                    nargs: 3 },
    { name: 'SetTexture',                    nargs: 3, body: 'SET_TEX' },
    { name: 'GetTextureStageState',          nargs: 4 },
    { name: 'SetTextureStageState',          nargs: 4, body: 'SET_TSS' },
    { name: 'ValidateDevice',                nargs: 2 },
    { name: 'ApplyStateBlock',               nargs: 2 },
    { name: 'CaptureStateBlock',             nargs: 2 },
    { name: 'DeleteStateBlock',              nargs: 2 },
    { name: 'CreateStateBlock',              nargs: 3 },
    { name: 'Load',                          nargs: 7 },
    { name: 'LightEnable',                   nargs: 3 },
    { name: 'GetLightEnable',                nargs: 3 },
    { name: 'SetClipPlane',                  nargs: 3 },
    { name: 'GetClipPlane',                  nargs: 3 },
    { name: 'GetInfo',                       nargs: 4 },
    { name: 'SetRenderState',                nargs: 3, body: 'SET_RS' },
    { name: 'GetRenderState',                nargs: 3 },
  ]},

  // ── IDirect3DViewport (v1) ──────────────────────────────────────────
  { prefix: 'IDirect3DViewport', methods: [
    { name: 'QueryInterface',       nargs: 3 },
    { name: 'AddRef',               nargs: 1, ret: 'ADDREF' },
    { name: 'Release',              nargs: 1, ret: 'RELEASE' },
    { name: 'Initialize',           nargs: 2 },
    { name: 'GetViewport',          nargs: 2, body: 'VP_GET' },
    { name: 'SetViewport',          nargs: 2, body: 'VP_SET' },
    { name: 'TransformVertices',    nargs: 6 },
    { name: 'LightElements',        nargs: 3 },
    { name: 'SetBackground',        nargs: 2 },
    { name: 'GetBackground',        nargs: 3 },
    { name: 'SetBackgroundDepth',   nargs: 2 },
    { name: 'GetBackgroundDepth',   nargs: 3 },
    { name: 'Clear',                nargs: 4, body: 'VP_CLEAR' },
    { name: 'AddLight',             nargs: 2 },
    { name: 'DeleteLight',          nargs: 2 },
    { name: 'NextLight',            nargs: 4 },
  ]},

  // ── IDirect3DViewport2 ──────────────────────────────────────────────
  { prefix: 'IDirect3DViewport2', methods: [
    { name: 'QueryInterface',       nargs: 3 },
    { name: 'AddRef',               nargs: 1, ret: 'ADDREF' },
    { name: 'Release',              nargs: 1, ret: 'RELEASE' },
    { name: 'Initialize',           nargs: 2 },
    { name: 'GetViewport',          nargs: 2, body: 'VP_GET' },
    { name: 'SetViewport',          nargs: 2, body: 'VP_SET' },
    { name: 'TransformVertices',    nargs: 6 },
    { name: 'LightElements',        nargs: 3 },
    { name: 'SetBackground',        nargs: 2 },
    { name: 'GetBackground',        nargs: 3 },
    { name: 'SetBackgroundDepth',   nargs: 2 },
    { name: 'GetBackgroundDepth',   nargs: 3 },
    { name: 'Clear',                nargs: 4, body: 'VP_CLEAR' },
    { name: 'AddLight',             nargs: 2 },
    { name: 'DeleteLight',          nargs: 2 },
    { name: 'NextLight',            nargs: 4 },
    { name: 'GetViewport2',         nargs: 2, body: 'VP_GET' },
    { name: 'SetViewport2',         nargs: 2, body: 'VP_SET' },
  ]},

  // ── IDirect3DMaterial (v1) ──────────────────────────────────────────
  { prefix: 'IDirect3DMaterial', methods: [
    { name: 'QueryInterface', nargs: 3 },
    { name: 'AddRef',         nargs: 1, ret: 'ADDREF' },
    { name: 'Release',        nargs: 1, ret: 'RELEASE' },
    { name: 'Initialize',     nargs: 2 },
    { name: 'SetMaterial',    nargs: 2 },
    { name: 'GetMaterial',    nargs: 2 },
    { name: 'GetHandle',      nargs: 3, body: 'MAT_HANDLE' },
    { name: 'Reserve',        nargs: 1 },
    { name: 'Unreserve',      nargs: 1 },
  ]},

  // ── IDirect3DMaterial2 ──────────────────────────────────────────────
  { prefix: 'IDirect3DMaterial2', methods: [
    { name: 'QueryInterface', nargs: 3 },
    { name: 'AddRef',         nargs: 1, ret: 'ADDREF' },
    { name: 'Release',        nargs: 1, ret: 'RELEASE' },
    { name: 'SetMaterial',    nargs: 2 },
    { name: 'GetMaterial',    nargs: 2 },
    { name: 'GetHandle',      nargs: 3, body: 'MAT_HANDLE' },
  ]},

  // ── IDirect3DExecuteBuffer ──────────────────────────────────────────
  { prefix: 'IDirect3DExecuteBuffer', methods: [
    { name: 'QueryInterface',  nargs: 3 },
    { name: 'AddRef',          nargs: 1, ret: 'ADDREF' },
    { name: 'Release',         nargs: 1, ret: 'RELEASE' },
    { name: 'Initialize',      nargs: 3 },
    { name: 'Lock',            nargs: 2, body: 'EXEC_LOCK' },
    { name: 'Unlock',          nargs: 1 },
    { name: 'SetExecuteData',  nargs: 2, body: 'EXEC_SETDATA' },
    { name: 'GetExecuteData',  nargs: 2 },
    { name: 'Validate',        nargs: 5 },
    { name: 'Optimize',        nargs: 2 },
  ]},

  // ── IDirect3DVertexBuffer ───────────────────────────────────────────
  { prefix: 'IDirect3DVertexBuffer', methods: [
    { name: 'QueryInterface',      nargs: 3 },
    { name: 'AddRef',              nargs: 1, ret: 'ADDREF' },
    { name: 'Release',             nargs: 1, ret: 'RELEASE' },
    { name: 'Lock',                nargs: 4, body: 'VB_LOCK' },
    { name: 'Unlock',              nargs: 1 },
    { name: 'ProcessVertices',     nargs: 8 },
    { name: 'GetVertexBufferDesc', nargs: 2 },
    { name: 'Optimize',            nargs: 3 },
  ]},

  // ── IDirect3DVertexBuffer7 ──────────────────────────────────────────
  { prefix: 'IDirect3DVertexBuffer7', methods: [
    { name: 'QueryInterface',         nargs: 3 },
    { name: 'AddRef',                 nargs: 1, ret: 'ADDREF' },
    { name: 'Release',                nargs: 1, ret: 'RELEASE' },
    { name: 'Lock',                   nargs: 4, body: 'VB_LOCK' },
    { name: 'Unlock',                 nargs: 1 },
    { name: 'ProcessVertices',        nargs: 8 },
    { name: 'GetVertexBufferDesc',    nargs: 2 },
    { name: 'Optimize',               nargs: 3 },
    { name: 'ProcessVerticesStrided', nargs: 9 },
  ]},

  // ── IDirect3DTexture (v1) ───────────────────────────────────────────
  { prefix: 'IDirect3DTexture', methods: [
    { name: 'QueryInterface',  nargs: 3 },
    { name: 'AddRef',          nargs: 1, ret: 'ADDREF' },
    { name: 'Release',         nargs: 1, ret: 'RELEASE' },
    { name: 'Initialize',      nargs: 3 },
    { name: 'GetHandle',       nargs: 3, body: 'TEX_HANDLE' },
    { name: 'PaletteChanged',  nargs: 3 },
    { name: 'Load',            nargs: 2, body: 'TEX_LOAD' },
    { name: 'Unload',          nargs: 1 },
  ]},

  // ── IDirect3DTexture2 ───────────────────────────────────────────────
  { prefix: 'IDirect3DTexture2', methods: [
    { name: 'QueryInterface',  nargs: 3 },
    { name: 'AddRef',          nargs: 1, ret: 'ADDREF' },
    { name: 'Release',         nargs: 1, ret: 'RELEASE' },
    { name: 'GetHandle',       nargs: 3, body: 'TEX_HANDLE' },
    { name: 'PaletteChanged',  nargs: 3 },
    { name: 'Load',            nargs: 2, body: 'TEX_LOAD' },
  ]},
];

// Vtable globals registered with gen_dispatch.js. Order matches declaration in
// 01-header / 09a8 globals block (prefix → global name, no `extends` needed
// since IM interfaces don't inherit via prefix-match in our scheme).
const vtableGlobals = [
  { prefix: 'IDirect3D2',              global: 'DX_VTBL_D3D2' },
  { prefix: 'IDirect3D7',              global: 'DX_VTBL_D3D7' },
  { prefix: 'IDirect3DDevice',         global: 'DX_VTBL_D3DDEV1' },
  { prefix: 'IDirect3DDevice2',        global: 'DX_VTBL_D3DDEV2' },
  { prefix: 'IDirect3DDevice7',        global: 'DX_VTBL_D3DDEV7' },
  { prefix: 'IDirect3DViewport',       global: 'DX_VTBL_D3DVP1' },
  { prefix: 'IDirect3DViewport2',      global: 'DX_VTBL_D3DVP2' },
  { prefix: 'IDirect3DMaterial',       global: 'DX_VTBL_D3DMAT1' },
  { prefix: 'IDirect3DMaterial2',      global: 'DX_VTBL_D3DMAT2' },
  { prefix: 'IDirect3DExecuteBuffer',  global: 'DX_VTBL_D3DEXEC' },
  { prefix: 'IDirect3DVertexBuffer',   global: 'DX_VTBL_D3DVB' },
  { prefix: 'IDirect3DVertexBuffer7',  global: 'DX_VTBL_D3DVB7' },
  { prefix: 'IDirect3DTexture',        global: 'DX_VTBL_D3DTEX' },
  { prefix: 'IDirect3DTexture2',       global: 'DX_VTBL_D3DTEX2' },
];

module.exports = { interfaces, vtableGlobals };
