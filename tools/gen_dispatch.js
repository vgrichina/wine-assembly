#!/usr/bin/env node
// gen_dispatch.js — Generate 09b2-dispatch-table.generated.wat
//
// Reads api_table.json and generates the $dispatch_api_table function
// containing just the br_table that calls $handle_{Name} functions.
// The hand-written $win32_dispatch wrapper lives in 09b-dispatch.wat.

const fs = require('fs');
const path = require('path');

const apiTable = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'api_table.json'), 'utf8'));
const outPath = path.join(__dirname, '..', 'src', '09b2-dispatch-table.generated.wat');

// --check: generate in memory and compare with the file on disk. Used as a build
// gate so a stale generated table fails the build instead of dispatching to the
// wrong handler at runtime.
const CHECK_ONLY = process.argv.includes('--check');

// A COM vtable whose api_ids are not contiguous produces a table that dispatches
// method N to some unrelated API. This used to print WARNING and generate the
// broken table anyway; it is now fatal.
const errors = [];
function fatal(msg) { errors.push(msg); console.error(`ERROR: ${msg}`); }

// Clean up old generated file if it exists
const oldPath = path.join(__dirname, '..', 'src', '09b-dispatch.generated.wat');
if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);

const N = apiTable.length;
const out = [];
const PAGE_SIZE = 256;

// Hand-written fast paths and the COM-vtable bootstrap still need a few IDs,
// but their source must never bake in api_table.json's current array indexes.
// Emit the names beside the generated dispatcher so an append/reorder repair
// updates every consumer through the existing `gen_dispatch.js --check` gate.
const namedApiIds = [
  ['MsgWaitForMultipleObjects', 'API_ID_MsgWaitForMultipleObjects'],
  ['PeekMessageA', 'API_ID_PeekMessageA'],
  ['PeekMessageW', 'API_ID_PeekMessageW'],
  ['IDirectDraw_QueryInterface', 'API_ID_IDirectDraw_BASE'],
  ['IAMMultiMediaStream_QueryInterface', 'API_ID_IAMMultiMediaStream_BASE'],
  ['IShellLinkA_QueryInterface', 'API_ID_IShellLinkA_BASE'],
  ['IPersistFile_QueryInterface', 'API_ID_IPersistFile_BASE'],
];

out.push('  ;; Named API ids consumed by hand-written dispatch fast paths.');
out.push('  ;; Generated from api_table.json; never replace these with array indexes.');
for (const [name, symbol] of namedApiIds) {
  const matches = apiTable.filter(api => api.name === name);
  if (matches.length !== 1) {
    fatal(`named API id ${name} must match exactly one api_table.json entry (found ${matches.length})`);
    continue;
  }
  out.push(`  (global $${symbol} i32 (i32.const ${matches[0].id}))`);
}
out.push('');

// OpenGL/WGL exports share one ABI bridge. `words` counts physical 32-bit
// stack words (GLdouble consumes two), while api_table nargs remains the
// source-level argument count used by tracing.
const gpuApis = new Map([
  ['glAlphaFunc', 2], ['glBlendFunc', 2], ['glClear', 1], ['glClearColor', 4],
  ['glCullFace', 1], ['glDepthFunc', 1], ['glDepthMask', 1], ['glDepthRange', 4],
  ['glDisable', 1], ['glDrawBuffer', 1], ['glEnable', 1], ['glFinish', 0],
  ['glGetError', 0], ['glGetFloatv', 2], ['glGetString', 1], ['glPointSize', 1],
  ['glPolygonMode', 2], ['glReadPixels', 7], ['glScissor', 4], ['glShadeModel', 1],
  ['glViewport', 4], ['glBegin', 1], ['glEnd', 0], ['glColor3f', 3],
  ['glColor3fv', 1], ['glColor4f', 4], ['glColor4fv', 1], ['glColor4ubv', 1],
  ['glTexCoord2f', 2], ['glVertex2f', 2], ['glVertex3f', 3], ['glVertex3fv', 1],
  ['glFrustum', 12], ['glLoadIdentity', 0], ['glLoadMatrixf', 1],
  ['glMatrixMode', 1], ['glOrtho', 12], ['glPopMatrix', 0], ['glPushMatrix', 0],
  ['glRotatef', 4], ['glScalef', 3], ['glTranslatef', 3], ['glBindTexture', 2],
  ['glDeleteTextures', 2], ['glTexEnvf', 3], ['glTexImage2D', 9],
  ['glTexParameterf', 3], ['glTexSubImage2D', 9], ['wglCreateContext', 1],
  ['wglDeleteContext', 1], ['wglGetProcAddress', 1], ['wglMakeCurrent', 2],
  ['wglChoosePixelFormat', 2], ['wglDescribePixelFormat', 4],
  ['wglSetPixelFormat', 3],
  // Legacy ref_gl.dll dynamically asks for this spelling. Opcode 55 is the
  // same backend-neutral present operation used by GDI32!SwapBuffers.
  ['wglSwapBuffers', 1],
  // Appended after the stable GL/WGL opcode range. GoldSrc uses the scalar
  // unsigned-byte colour entry point for world geometry and polygon offset
  // for coplanar decals.
  ['glColor4ub', 4],
  ['glPolygonOffset', 2],
  ['glColor3ubv', 1],
  // GLU matrix helpers are appended after the stable GL/WGL/GPU range.
  // Their GLdouble arguments consume two physical stack dwords each.
  ['gluPerspective', 8],
  ['gluLookAt', 18],
  ['gluBuild2DMipmaps', 7],
  ['gluOrtho2D', 8],
  // Win98-era intros use immediate-mode normals even when lighting is toggled
  // only for a subset of their geometry. Keep these appended so every older
  // command-stream opcode stays stable.
  ['glNormal3f', 3],
  ['glNormal3fv', 1],
  ['glIsEnabled', 1],
  ['glColorMaterial', 2],
  ['glLightfv', 3],
  ['glMaterialfv', 3],
  ['glLightModelfv', 2],
  ['glLightModeli', 2],
  ['glMaterialf', 3],
  ['glLightf', 3],
  ['glPixelStorei', 2],
  ['glGenTextures', 2],
  ['glHint', 2],
  ['glPushAttrib', 1],
  ['glPopAttrib', 0],
  ['glFogfv', 2],
  ['glFogf', 2],
  ['glFogi', 2],
  ['glFrontFace', 1],
  ['glTexEnvi', 3],
  ['glTexGeni', 3],
  ['glTexGenf', 3],
  ['glTexGenfv', 3],
]);
const gpuApiOrder = [...gpuApis.keys()];

function handlerCall(api) {
  const gpuOpcode = gpuApiOrder.indexOf(api.name);
  if (gpuOpcode >= 0) {
    return `      (call $handle_gpu_api (i32.const ${gpuOpcode}) (i32.const ${gpuApis.get(api.name)}) (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3) (local.get $arg4) (local.get $name_ptr))`;
  }
  const vbDdSlot = api.name.match(/^IVBDirectDraw7_DirectSlot(\d+)$/);
  if (vbDdSlot) {
    const slot = parseInt(vbDdSlot[1], 10);
    return `      (call $handle_IVBDirectDraw7_DirectSlot (i32.const ${slot}) (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3) (local.get $arg4) (local.get $name_ptr))`;
  }
  const vbClipSlot = api.name.match(/^IVBDirectDrawClipper_DirectSlot(\d+)$/);
  if (vbClipSlot) {
    const slot = parseInt(vbClipSlot[1], 10);
    return `      (call $handle_IVBDirectDrawClipper_DirectSlot (i32.const ${slot}) (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3) (local.get $arg4) (local.get $name_ptr))`;
  }
  const vbSoundSlot = api.name.match(/^IVBDirectSound_DirectSlot(\d+)$/);
  if (vbSoundSlot) {
    const slot = parseInt(vbSoundSlot[1], 10);
    return `      (call $handle_IVBDirectSound_DirectSlot (i32.const ${slot}) (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3) (local.get $arg4) (local.get $name_ptr))`;
  }
  const vbSurfaceSlot = api.name.match(/^IVBDirectDrawSurface7_DirectSlot(\d+)$/);
  if (vbSurfaceSlot) {
    const slot = parseInt(vbSurfaceSlot[1], 10);
    return `      (call $handle_IVBDirectDrawSurface7_DirectSlot (i32.const ${slot}) (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3) (local.get $arg4) (local.get $name_ptr))`;
  }
  const daSlot = api.name.match(/^IDirectAnimationDA(View|Statics|Behavior)_DirectSlot(\d+)$/);
  if (daSlot) {
    const iface = daSlot[1];
    const slot = parseInt(daSlot[2], 10);
    return `      (call $handle_IDirectAnimationDA${iface}_DirectSlot (i32.const ${slot}) (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3) (local.get $arg4) (local.get $name_ptr))`;
  }
  const handler = api.handler || api.name;
  if (!/^[A-Za-z0-9_?@$]+$/.test(handler)) {
    fatal(`API ${api.name} has invalid handler alias ${JSON.stringify(handler)}`);
  }
  return `      (call $handle_${handler} (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3) (local.get $arg4) (local.get $name_ptr))`;
}

out.push('  ;; ============================================================');
out.push('  ;; API BR_TABLE DISPATCH — GENERATED, do not edit');
out.push('  ;; Generated by tools/gen_dispatch.js from api_table.json');
out.push('  ;; Hand-written dispatch wrapper is in 09b-dispatch.wat');
out.push('  ;; ============================================================');
out.push('  (func $dispatch_api_table (param $api_id i32) (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)');
out.push('');
out.push('    ;; === Paged br_table dispatch ===');
for (let base = 0, page = 0; base < N; base += PAGE_SIZE, page++) {
  const end = Math.min(base + PAGE_SIZE, N);
  out.push(`    (if (i32.lt_u (local.get $api_id) (i32.const ${end}))`);
  out.push('      (then');
  out.push(`        (call $dispatch_api_table_page_${page} (i32.sub (local.get $api_id) (i32.const ${base})) (local.get $arg0) (local.get $arg1) (local.get $arg2) (local.get $arg3) (local.get $arg4) (local.get $name_ptr))`);
  out.push('        (return)))');
}
out.push('    (call $handle_fallback (local.get $name_ptr) (local.get $api_id))');
out.push('  )');

for (let base = 0, page = 0; base < N; base += PAGE_SIZE, page++) {
  const end = Math.min(base + PAGE_SIZE, N);
  const count = end - base;
  out.push('');
  out.push(`  (func $dispatch_api_table_page_${page} (param $api_id i32) (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)`);
  out.push(`    ;; api ids ${base}..${end - 1}`);
  out.push('    (block $fallback');
  for (let slot = count - 1; slot >= 0; slot--) {
    out.push(`    (block $api_${slot}`);
  }
  let br = '      (br_table';
  for (let slot = 0; slot < count; slot++) br += ` $api_${slot}`;
  br += ' $fallback (local.get $api_id))';
  out.push(br);
  for (let slot = 0; slot < count; slot++) {
    const id = base + slot;
    const api = apiTable[id];
    out.push(`    ) ;; ${id}: ${api.name}`);
    out.push(handlerCall(api));
    out.push('      (return)');
  }
  out.push('    ) ;; fallback');
  out.push(`    (call $handle_fallback (local.get $name_ptr) (i32.add (local.get $api_id) (i32.const ${base})))`);
  out.push('  )');
}

// ── Generate $init_dx_com_thunks from api_table.json ────────────────
// COM interfaces: prefix → WAT global name.  Order matters (parent before child).
const comInterfaces = [
  { prefix: 'IDirectDraw',          global: 'DX_VTBL_DDRAW' },
  { prefix: 'IDirectDraw2',         global: 'DX_VTBL_DDRAW2',   extends: 'IDirectDraw' },
  { prefix: 'IDirectDrawSurface',   global: 'DX_VTBL_DDSURF' },
  { prefix: 'IDirectDrawSurface2',  global: 'DX_VTBL_DDSURF2', extends: 'IDirectDrawSurface' },
  { prefix: 'IDirectDrawPalette',   global: 'DX_VTBL_DDPAL' },
  { prefix: 'IDirectDrawClipper',  global: 'DX_VTBL_DDCLIP' },
  { prefix: 'IDirectSound',         global: 'DX_VTBL_DSOUND' },
  { prefix: 'IDirectSoundBuffer',   global: 'DX_VTBL_DSBUF' },
  { prefix: 'IDirectInput',         global: 'DX_VTBL_DINPUT' },
  { prefix: 'IDirectInputDevice',   global: 'DX_VTBL_DIDEV' },
  { prefix: 'IDirectPlay3',         global: 'DX_VTBL_DPLAY3' },
  { prefix: 'IDirectPlayLobby2',    global: 'DX_VTBL_DPLAYLOBBY2' },
  { prefix: 'IDirect3D',            global: 'DX_VTBL_D3D' },
  { prefix: 'IDirect3D3',           global: 'DX_VTBL_D3D3' },
  { prefix: 'IDirectDrawFactory',   global: 'DX_VTBL_DDFACTORY' },
  { prefix: 'IDirectAnimationDAView', global: 'DX_VTBL_DA_VIEW' },
  { prefix: 'IDirectAnimationDAStatics', global: 'DX_VTBL_DA_STATICS' },
  { prefix: 'IDirectAnimationDABehavior', global: 'DX_VTBL_DA_BEHAVIOR' },
  { prefix: 'IMalloc',              global: 'DX_VTBL_IMALLOC' },
  { prefix: 'IRunningObjectTable',   global: 'DX_VTBL_OLE_ROT' },
  { prefix: 'IEnumMoniker',         global: 'DX_VTBL_OLE_ENUMMONIKER' },
  { prefix: 'IMoniker',             global: 'DX_VTBL_OLE_MONIKER' },
  { prefix: 'IBindCtx',             global: 'DX_VTBL_OLE_BINDCTX' },
  { prefix: 'IEnumString',          global: 'DX_VTBL_OLE_ENUMSTRING' },
  { prefix: 'ILockBytes',           global: 'DX_VTBL_OLE_LOCKBYTES' },
  { prefix: 'IStream',              global: 'DX_VTBL_OLE_STREAM' },
  { prefix: 'IStorage',             global: 'DX_VTBL_OLE_STORAGE' },
  { prefix: 'IDataObject',          global: 'DX_VTBL_OLE_DATAOBJECT' },
  { prefix: 'IEnumFORMATETC',       global: 'DX_VTBL_OLE_ENUMFORMATETC' },
  { prefix: 'IEnumSTATSTG',         global: 'DX_VTBL_OLE_ENUMSTATSTG' },
  { prefix: 'IOleObject',           global: 'DX_VTBL_OLE_OBJECT' },
  { prefix: 'IPersistStorage',      global: 'DX_VTBL_OLE_PERSISTSTORAGE' },
  { prefix: 'IOleCache',            global: 'DX_VTBL_OLE_CACHE' },
  { prefix: 'IViewObject',          global: 'DX_VTBL_OLE_VIEWOBJECT' },
  { prefix: 'IViewObject2',         global: 'DX_VTBL_OLE_VIEWOBJECT2', extends: 'IViewObject' },
  { prefix: 'IDirect3DDevice3',     global: 'DX_VTBL_D3DDEV3' },
  { prefix: 'IDirect3DViewport3',   global: 'DX_VTBL_D3DVP3' },
  { prefix: 'IDirect3DLight',       global: 'DX_VTBL_D3DLIGHT' },
  { prefix: 'IDirect3DMaterial3',   global: 'DX_VTBL_D3DMAT3' },
];

// Append Direct3D Immediate Mode interfaces from shared spec.
const { vtableGlobals: d3dimVtables } = require('./d3dim-methods');
for (const v of d3dimVtables) comInterfaces.push(v);

// OLE Automation font object (OleCreateFontIndirect). Kept last so its
// registry slot is appended rather than shifting every existing one.
comInterfaces.push({ prefix: 'IFont', global: 'DX_VTBL_OLE_FONT' });

// DirectSound3D is an auxiliary view of an existing sound buffer. Keep it at
// the registry tail so adding it cannot renumber any established interface.
comInterfaces.push({ prefix: 'IDirectSound3DBuffer', global: 'DX_VTBL_DS3DBUF' });

// Direct3D 9. Also at the tail: $dx_sync_thread_vtables restores globals by
// registry offset, so anything inserted above renumbers every later slot.
const { vtableGlobals: d3d9Vtables } = require('./d3d9-methods');
for (const v of d3d9Vtables) comInterfaces.push(v);

// IDirectInput7: the v1 vtable plus FindDevice/CreateDeviceEx. Tail again,
// for the same registry-offset reason as the entries above.
comInterfaces.push({ prefix: 'IDirectInput7', global: 'DX_VTBL_DINPUT7', extends: 'IDirectInput' });

// IDirectInputDevice2: the v1 device vtable plus the force-feedback/Poll
// methods. Tail again, same registry-offset reason.
comInterfaces.push({ prefix: 'IDirectInputDevice2', global: 'DX_VTBL_DIDEV2', extends: 'IDirectInputDevice' });

// Surface3 adds SetSurfaceDesc to Surface2. Keep it at the absolute tail so
// every established cross-thread vtable registry offset remains stable.
comInterfaces.push({ prefix: 'IDirectDrawSurface3', global: 'DX_VTBL_DDSURF3', extends: 'IDirectDrawSurface2' });

// D3D9 swap chains were added after every established interface. Keep this at
// the absolute tail so worker-thread registry offsets remain append-only.
comInterfaces.push({ prefix: 'IDirect3DSwapChain9', global: 'DX_VTBL_D3DSWAP9' });

// Listener is an auxiliary view of a primary DirectSound buffer. Append it
// after every established interface so registry offsets remain stable.
comInterfaces.push({ prefix: 'IDirectSound3DListener', global: 'DX_VTBL_DS3DLISTENER' });

// Build a map of prefix → { startId, count } from the api_table
const byName = new Map(apiTable.map(a => [a.name, a]));
const ifaceInfo = new Map();
for (const iface of comInterfaces) {
  // Find all APIs matching this interface (prefix + "_")
  const methods = apiTable.filter(a => a.name.startsWith(iface.prefix + '_'));
  if (methods.length === 0) {
    fatal(`no methods found for COM interface ${iface.prefix}`);
    continue;
  }
  methods.sort((a, b) => a.id - b.id);
  const startId = methods[0].id;
  // Verify contiguous
  for (let i = 1; i < methods.length; i++) {
    if (methods[i].id !== startId + i) {
      fatal(`${iface.prefix} api_ids not contiguous: expected ${startId + i}, got ${methods[i].id} (${methods[i].name}). ` +
        'COM vtable slots are computed as startId + slot, so this table would call the wrong method.');
    }
  }
  let slotApiIds = null;
  if (iface.methods) {
    slotApiIds = iface.methods.map(method => {
      const api = byName.get(`${iface.prefix}_${method}`);
      if (!api) {
        fatal(`${iface.prefix} vtable method ${method} has no api_table.json entry`);
        return startId;
      }
      return api.id;
    });
    if (slotApiIds.length !== methods.length) {
      fatal(`${iface.prefix} vtable order has ${slotApiIds.length} slots but ${methods.length} APIs`);
    }
  }
  ifaceInfo.set(iface.prefix, { startId, count: methods.length, slotApiIds });
}

out.push('');
out.push('  ;; ============================================================');
out.push('  ;; COM VTABLE INIT — GENERATED, do not edit');
out.push('  ;; Generated by tools/gen_dispatch.js from api_table.json');
out.push('  ;; ============================================================');
out.push('  (func $init_dx_com_thunks (export "init_dx_com_thunks")');

const builtVtableCounts = new Map();
for (const iface of comInterfaces) {
  const info = ifaceInfo.get(iface.prefix);
  if (!info) continue;
  if (iface.extends) {
    // Extended interface: copy parent vtable + append extra methods
    const parentInfo = ifaceInfo.get(iface.extends);
    if (!parentInfo) { fatal(`COM interface ${iface.prefix} extends ${iface.extends}, which has no methods in api_table.json`); continue; }
    // The parent may itself extend another interface. Copy its full generated
    // vtable, not only the methods declared directly on that parent.
    const parentCount = builtVtableCounts.get(iface.extends) || parentInfo.count;
    const totalCount = parentCount + info.count;
    out.push(`    ;; ${iface.prefix}: extends ${iface.extends} (${parentCount}) + ${info.count} extra = ${totalCount} total, extra at api_id ${info.startId}`);
    out.push(`    (global.set $${iface.global} (call $extend_com_vtable`);
    out.push(`      (global.get $${ifaceInfo.get(iface.extends) ? comInterfaces.find(c => c.prefix === iface.extends).global : '??'}) (i32.const ${parentCount}) (i32.const ${info.startId}) (i32.const ${totalCount})))`);
    builtVtableCounts.set(iface.prefix, totalCount);
  } else {
    out.push(`    ;; ${iface.prefix}: ${info.count} methods starting at api_id ${info.startId}`);
    out.push(`    (global.set $${iface.global} (call $init_com_vtable (i32.const ${info.startId}) (i32.const ${info.count})))`);
    if (info.slotApiIds) {
      for (let slot = 0; slot < info.slotApiIds.length; slot++) {
        const apiId = info.slotApiIds[slot];
        if (apiId === info.startId + slot) continue;
        out.push(`    (call $set_com_vtable_slot_api_id (global.get $${iface.global}) (i32.const ${slot}) (i32.const ${apiId}))`);
      }
    }
    builtVtableCounts.set(iface.prefix, info.count);
  }
}

out.push('  )');

// ── Validate paren balance ──────────────────────────────────────────
const result = out.join('\n') + '\n';
let depth = 0;
for (let ci = 0; ci < result.length; ci++) {
  if (result[ci] === '"') { while (ci + 1 < result.length && result[++ci] !== '"') { if (result[ci] === '\\') ci++; } continue; }
  if (result[ci] === ';' && result[ci + 1] === ';') { while (ci < result.length && result[ci] !== '\n') ci++; continue; }
  if (result[ci] === '(') depth++;
  if (result[ci] === ')') depth--;
}
if (depth !== 0) {
  fatal(`paren imbalance in generated output, final depth = ${depth}`);
}

if (errors.length) {
  console.error(`${errors.length} fatal problem(s); ${CHECK_ONLY ? 'not checking' : 'not writing'} ${path.relative(process.cwd(), outPath)}.`);
  process.exit(1);
}

if (CHECK_ONLY) {
  const onDisk = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : null;
  if (onDisk !== result) {
    console.error(`ERROR: ${path.relative(process.cwd(), outPath)} is stale — it does not match what api_table.json generates.`);
    console.error('       Run: node tools/gen_dispatch.js');
    process.exit(1);
  }
  console.log(`dispatch table OK: 09b2-dispatch-table.generated.wat matches api_table.json (${N} APIs).`);
} else {
  fs.writeFileSync(outPath, result);
  console.error(`Written ${outPath} (${N} APIs)`);
}
