#!/usr/bin/env node

'use strict';

const crypto = require('crypto');
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const PRINT_PIN = process.argv.includes('--print-pin');
const LIST = process.argv.includes('--list');

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

// A handler with no call, control-flow branch, fail-loud trap, or memory write
// cannot delegate work or publish an output buffer. It may still read state and
// mutate a global: that broader shape deliberately catches stateful-looking
// no-ops such as SetFileApisToOEM/ANSI, which escaped the old exact matcher.
const effectOrControl = /\((?:call(?:_indirect)?|return|unreachable|if|block|loop|br(?:_if|_table|_on_[A-Za-z0-9_]+)?|memory\.(?:fill|copy|init|grow)|table\.(?:set|fill|copy|init)|data\.drop|elem\.drop|(?:i32|i64|f32|f64|v128)\.(?:store\d*|atomic\.(?:store|rmw|cmpxchg|wait|notify)))\b/;
const isQuietHandler = flat =>
  !effectOrControl.test(flat) && !/\bunreachable\b/.test(flat);

function quietEntries(file, source) {
  const entries = [];
  for (const body of functions(source, 'handle_')) {
    const flat = body.replace(/\s+/g, ' ');
    const match = flat.match(/^\(func \$(handle_\S+)/);
    if (match && isQuietHandler(flat)) {
      entries.push({ name: `${file}:${match[1]}`, body: flat });
    }
  }
  return entries;
}

for (const [label, flat, expected] of [
  ['constant return', '(func $handle_X (global.set $eax (i32.const 1)))', true],
  ['stateful no-op', '(func $handle_X (global.set $mode (i32.const 1)) (global.set $eax (i32.const 1)))', true],
  ['delegating handler', '(func $handle_X (call $do_work))', false],
  ['output store', '(func $handle_X (i32.store (local.get $p) (i32.const 1)))', false],
  ['conditional behavior', '(func $handle_X (if (local.get $p) (then (nop))))', false],
  ['fail loud', '(func $handle_X unreachable)', false],
]) {
  if (isQuietHandler(flat) !== expected) {
    throw new Error(`quiet-handler classifier self-check failed: ${label}`);
  }
}

const quiet = [];
for (const file of fs.readdirSync(SRC).filter(name => name.endsWith('.wat')).sort()) {
  const source = fs.readFileSync(path.join(SRC, file), 'utf8');
  quiet.push(...quietEntries(file, source));
}

quiet.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
const digest = crypto.createHash('sha256')
  .update(quiet.map(entry => `${entry.name}:${entry.body}`).join('\n'))
  .digest('hex');
// This is a ratchet, not approval of the old entries. Any addition or mutation
// changes the digest and stops the build; deleting/fixing an entry deliberately
// lowers the count and updates the digest after review.
const EXPECTED_COUNT = 514;
const EXPECTED_SHA256 = 'd0d614c572452aa4db6bcd62a651a8ee864710e8add41fd3b1d20201d1f33c96';

const pinLines = () => [
  `const EXPECTED_COUNT = ${quiet.length};`,
  `const EXPECTED_SHA256 = '${digest}';`,
];

if (PRINT_PIN || LIST) {
  if (LIST) for (const entry of quiet) console.log(`${entry.name}\n  ${entry.body}`);
  for (const line of pinLines()) console.log(line);
  process.exit(0);
}

if (quiet.length !== EXPECTED_COUNT || digest !== EXPECTED_SHA256) {
  console.error(`Silent-handler inventory changed: count=${quiet.length}, sha256=${digest}`);
  console.error('A new straight-line handler must implement behavior, delegate it, or fail loudly.');
  console.error('If existing quiet handlers were fixed, review with --list and paste this pin:');
  for (const line of pinLines()) console.error(line);
  process.exit(1);
}

// On a clean Git checkout, reject the historical failure mode where one
// commit changes handlers and a later commit merely catches the pin up. A
// classifier change may legitimately establish a new baseline without a WAT
// edit. Dirty development trees and source archives are handled by the normal
// inventory comparison above; this commit-boundary audit is extra CI evidence.
function git(args) {
  return childProcess.spawnSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function enforceSameCommitPin() {
  const inside = git(['rev-parse', '--is-inside-work-tree']);
  if (inside.status !== 0 || inside.stdout.trim() !== 'true') return;
  const parent = git(['rev-parse', '--verify', 'HEAD^']);
  if (parent.status !== 0) return;
  // Do not compare HEAD while testing uncommitted handler/tool edits.
  if (git(['diff', '--quiet', '--', 'src', 'tools/check-silent-stubs.js']).status !== 0) return;
  if (git(['diff', '--cached', '--quiet', '--',
    'src', 'tools/check-silent-stubs.js']).status !== 0) return;

  const oldToolResult = git(['show', 'HEAD^:tools/check-silent-stubs.js']);
  if (oldToolResult.status !== 0) return;
  const oldTool = oldToolResult.stdout;
  const newTool = fs.readFileSync(__filename, 'utf8');
  const pinOnly = text => text.replace(
    /^const EXPECTED_(?:COUNT|SHA256) = .*;$/gm, '');
  const pinText = text => (text.match(
    /^const EXPECTED_(?:COUNT|SHA256) = .*;$/gm) || []).join('\n');
  if (pinText(oldTool) === pinText(newTool)) return;
  if (pinOnly(oldTool) !== pinOnly(newTool)) return; // classifier/tool change

  const changed = git(['diff', '--name-only', 'HEAD^', 'HEAD', '--', 'src']);
  if (changed.status !== 0) return;
  let inventoryChanged = false;
  for (const relative of changed.stdout.trim().split('\n').filter(
    name => name.endsWith('.wat'))) {
    const file = path.basename(relative);
    const oldResult = git(['show', `HEAD^:${relative}`]);
    const oldEntries = oldResult.status === 0
      ? quietEntries(file, oldResult.stdout) : [];
    const currentPath = path.join(ROOT, relative);
    const newEntries = fs.existsSync(currentPath)
      ? quietEntries(file, fs.readFileSync(currentPath, 'utf8')) : [];
    const serial = entries => entries
      .map(entry => `${entry.name}:${entry.body}`).sort().join('\n');
    if (serial(oldEntries) !== serial(newEntries)) {
      inventoryChanged = true;
      break;
    }
  }
  if (!inventoryChanged) {
    console.error('Silent-handler pin changed without an inventory or classifier change in this commit.');
    console.error('Re-pin in the same commit that changes the handler inventory.');
    process.exit(1);
  }
}

enforceSameCommitPin();

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

console.log(`PASS  straight-line silent-handler inventory is pinned (${quiet.length})`);
console.log('PASS  D3D9 resource/output stubs fail loudly');
