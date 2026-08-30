#!/usr/bin/env node

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

function functions(source, prefix) {
  const clean = source.replace(/;;.*$/gm, '');
  const result = [];
  for (let start = 0; (start = clean.indexOf(`(func $${prefix}`, start)) >= 0;) {
    let depth = 0;
    let end = start;
    for (; end < clean.length; end++) {
      if (clean[end] === '(') depth++;
      if (clean[end] === ')' && --depth === 0) { end++; break; }
    }
    result.push(clean.slice(start, end));
    start = end;
  }
  return result;
}

const simple = [];
for (const file of fs.readdirSync(SRC).filter(name => name.endsWith('.wat')).sort()) {
  const source = fs.readFileSync(path.join(SRC, file), 'utf8');
  for (const body of functions(source, 'handle_')) {
    const flat = body.replace(/\s+/g, ' ');
    const match = flat.match(/^\(func \$(handle_\S+) (?:\(param [^)]+\) )*\(global\.set \$eax \(i32\.const ([^)]+)\)\) \(global\.set \$esp \(i32\.add \(global\.get \$esp\) \(i32\.const ([^)]+)\)\)\)\)$/);
    if (match) simple.push(`${file}:${match[1]}:${match[2]}:${match[3]}`);
  }
}

simple.sort();
const digest = crypto.createHash('sha256').update(simple.join('\n')).digest('hex');
// This is a ratchet, not approval of the old entries. Any addition or mutation
// changes the digest and stops the build; deleting/fixing an entry deliberately
// lowers the count and updates the digest after review.
const EXPECTED_COUNT = 330;
const EXPECTED_SHA256 = '9e04237b9f52ea62812f93230949e6a83984d3cf1cf9081ed879733023b58e98';

if (simple.length !== EXPECTED_COUNT || digest !== EXPECTED_SHA256) {
  console.error(`Silent-stub inventory changed: count=${simple.length}, sha256=${digest}`);
  console.error('A new constant-return handler must implement behavior or call $crash_unimplemented.');
  console.error('If existing stubs were removed, review the list and ratchet this baseline down.');
  for (const entry of simple) console.error(`  ${entry}`);
  process.exit(1);
}

// D3D9 HRESULT success with an untouched output pointer is especially toxic:
// it hands the guest NULL/stale resources and the eventual failure names an
// unrelated call. Scalar-return getters are deliberately not in this set.
const d3d9 = fs.readFileSync(path.join(SRC, '09ad-handlers-d3d9.wat'), 'utf8');
const dangerous = [];
for (const body of functions(d3d9, 'handle_IDirect3D')) {
  const flat = body.replace(/\s+/g, ' ');
  const match = flat.match(/^\(func \$(handle_\S+) (?:\(param [^)]+\) )*\(global\.set \$eax \(i32\.const 0\)\) \(global\.set \$esp \(i32\.add \(global\.get \$esp\) \(i32\.const ([^)]+)\)\)\)\)$/);
  if (!match) continue;
  const name = match[1];
  if (/(?:_QueryInterface|_Create|_Lock)/.test(name) ||
      /_Get(?:AdapterIdentifier|DeviceCaps|DisplayMode|GammaRamp|RenderTarget|DepthStencilSurface|Transform|Viewport|Material|Light|LightEnable|ClipPlane|RenderState|ClipStatus|Texture|TextureStageState|SamplerState|PaletteEntries|CurrentTexturePalette|ScissorRect|FVF|LevelDesc|SurfaceLevel|Desc)$/.test(name)) {
    dangerous.push(name);
  }
}
if (dangerous.length) {
  console.error('D3D9 output/resource methods may not silently return D3D_OK:');
  for (const name of dangerous) console.error(`  ${name}`);
  process.exit(1);
}

console.log(`PASS  silent constant-return handler inventory is pinned (${simple.length})`);
console.log('PASS  D3D9 resource/output stubs fail loudly');
