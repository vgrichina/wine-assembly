#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { compileWat } = require('../lib/compile-wat');

const ROOT = path.join(__dirname, '..');
const header = fs.readFileSync(path.join(ROOT, 'src', '01-header.wat'), 'utf8');
const hostImports = fs.readFileSync(path.join(ROOT, 'lib', 'host-imports.js'), 'utf8');
const status = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'docs', 'gdi-migration-status.json'), 'utf8'));
const watSource = fs.readdirSync(path.join(ROOT, 'src'))
  .filter(name => name.endsWith('.wat'))
  .map(name => fs.readFileSync(path.join(ROOT, 'src', name), 'utf8'))
  .join('\n');

// This allowlist is deliberately code-owned rather than derived from the JSON
// inventory. Expanding the document alone must never expand JavaScript's GDI
// authority.
const PERMANENT_NON_TEXT_BRIDGE = [
  'gdi_set_region_bands',
  'gdi_set_window_rgn',
  'gdi_surface_attach',
  'gdi_surface_create',
  'gdi_surface_delete',
  'gdi_surface_upload',
];
const CANVAS_TEXT_POLICY = [
  'gdi_text_bind', 'gdi_text_mask',
].sort();
const MAX_TEMPORARY_NON_TEXT_EXCEPTIONS = 0;
const sorted = values => [...values].sort();

const imported = sorted([...header.matchAll(/\(import\s+"host"\s+"(gdi_[^"]+)"/g)]
  .map(match => match[1]));
const jsMethods = sorted([...hostImports.matchAll(/^\s+(gdi_[a-z0-9_]+):/gm)]
  .map(match => match[1]));
const internalStubs = sorted([...header.matchAll(
  /^\s+\(func \$host_(gdi_[a-z0-9_]+).*\(i32\.const 0\)\)$/gm)]
  .map(match => match[1]));
const expectedImports = sorted([...PERMANENT_NON_TEXT_BRIDGE, ...CANVAS_TEXT_POLICY]);

assert.strictEqual(status.schemaVersion, 2);
assert.deepStrictEqual(sorted(status.policy.permanentNonTextBridge.map(item => item.name)),
  PERMANENT_NON_TEXT_BRIDGE,
  'documented permanent bridge must match the code-owned allowlist');
assert.deepStrictEqual(sorted(status.policy.canvasTextPolicy), CANVAS_TEXT_POLICY,
  'documented text policy must match the code-owned allowlist');
assert.deepStrictEqual(status.policy.resourceByteBoundaries, [],
  'no current gdi_* import is a pure resource-byte boundary');
assert(status.policy.temporaryNonTextExceptions.length <= MAX_TEMPORARY_NON_TEXT_EXCEPTIONS,
  'temporary non-text exception budget may only shrink');
assert.strictEqual(status.policy.maximumTemporaryNonTextExceptions,
  MAX_TEMPORARY_NON_TEXT_EXCEPTIONS);

assert.deepStrictEqual(imported, expectedImports,
  'only presentation bridges and Canvas text policy may be imported from JS');
assert.deepStrictEqual(jsMethods, expectedImports,
  'lib/host-imports.js must not retain non-text semantic GDI methods');
for (const obsolete of [
  'dx_surface_sync', '_legacyGetDrawTarget', '_resolveDcRecord',
  '_getSurfaceCanvas', '_surfaceCanvasToDib', '_dibToSurfaceCanvas',
  '_screenCanvasState', '_getScreenDcTarget', '_dcState',
]) {
  assert(!header.includes(obsolete) && !hostImports.includes(obsolete),
    `${obsolete} must not restore a Canvas-owned or split-brain GDI path`);
}
assert(!/\bconst _getDC\b/.test(hostImports),
  '_getDC must not restore a JavaScript semantic DC record');
assert(!hostImports.includes('_gdiObjects'),
  'mixed JavaScript GDI object storage must stay removed');
for (const removed of [
  '_gdiTextOut', '_drawBinaryCanvasText', '_drawWithClip',
  '_getDrawTarget', '_markDrawTargetDirty', '_seedDrawTargetRect',
]) {
  assert(!hostImports.includes(removed),
    `${removed} must not restore Canvas destination text drawing or readback`);
}
assert.deepStrictEqual(sorted(status.eliminatedNonTextSemantics), internalStubs,
  'every eliminated semantic import must remain an explicit WAT unsupported stub');
assert.deepStrictEqual(sorted(status.watUnsupportedStubs), internalStubs,
  'stub inventory must exactly match the WAT source');
assert.strictEqual(internalStubs.length, 0,
  'all purged non-text semantic calls must have WAT implementations');

// WebAssembly has no short-circuit logical AND. A pointer used directly as an
// i32.and operand is a bit mask, so aligned addresses can turn a true predicate
// into false. Require explicit nonzero normalization for pointer-shaped names.
const rawPointerAnd = /\(i32\.and\s+\(local\.get \$(?:p|ptr|record|entry|data|bmi|points|pixels|buffer|formats|requested)\)\s+\((?:i32\.(?:eq|ne|lt|le|gt|ge)|call)/g;
assert.deepStrictEqual([...watSource.matchAll(rawPointerAnd)].map(match => match[0]), [],
  'pointer values in logical i32.and expressions must be normalized with i32.ne');

(async () => {
  const wasm = await compileWat(file => fs.promises.readFile(path.join(ROOT, 'src', file), 'utf8'));
  assert(wasm.length > 0, 'WAT must remain linkable after removing JS imports');
  await WebAssembly.compile(wasm);
  console.log(`PASS  JS GDI bridge is restricted to ${PERMANENT_NON_TEXT_BRIDGE.length} presentation imports and ${CANVAS_TEXT_POLICY.length} text imports`);
  console.log('PASS  no eliminated non-text semantic call remains a WAT stub');
  console.log('PASS  temporary non-text exception budget is zero and cannot expand');
  console.log('PASS  pointer operands are normalized before logical i32.and expressions');
  console.log(`PASS  WAT validates after the bridge purge (${wasm.length} bytes)`);
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
