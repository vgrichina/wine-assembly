#!/usr/bin/env node
// Fixed WAT memory regions must be declared as:
//   (global $NAME i32 (i32.const START))
//   (global $NAME_SIZE i32 (i32.const SIZE))
// The executable map is extracted from those globals instead of comments.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { WAT_FILES } = require('../lib/compile-wat');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const WASM_MEMORY_SIZE = 0x20000000;

function parseConstI32(value) {
  const text = String(value).trim();
  if (/^-?0x/i.test(text)) return Number.parseInt(text, 16) >>> 0;
  return Number.parseInt(text, 10) >>> 0;
}

function collectConstGlobals() {
  const globals = new Map();
  const re = /^\s*\(global\s+(\$[A-Za-z0-9_]+)\s+(?:i32|\(mut\s+i32\))\s+\(i32\.const\s+([^)]+)\)\)\s*(?:;;.*)?$/;
  for (const file of WAT_FILES) {
    const source = fs.readFileSync(path.join(SRC, file), 'utf8');
    for (const [lineNo, line] of source.split(/\r?\n/).entries()) {
      const match = line.match(re);
      if (!match) continue;
      const name = match[1].slice(1);
      assert(!globals.has(name), `duplicate global $${name} at ${file}:${lineNo + 1}`);
      globals.set(name, {
        name,
        value: parseConstI32(match[2]),
        file,
        line: lineNo + 1,
      });
    }
  }
  return globals;
}

function collectRegions(globals) {
  const regions = [];
  for (const [name, sizeGlobal] of globals) {
    if (!name.endsWith('_SIZE')) continue;
    const baseName = name.slice(0, -'_SIZE'.length);
    const baseGlobal = globals.get(baseName);
    if (!baseGlobal) continue;
    const size = sizeGlobal.value >>> 0;
    assert(size > 0, `$${name} must be non-zero`);
    regions.push({
      name: baseName,
      start: baseGlobal.value >>> 0,
      size,
      end: (baseGlobal.value + size) >>> 0,
      baseGlobal,
      sizeGlobal,
    });
  }
  return regions.sort((a, b) => (a.start - b.start) || (a.end - b.end));
}

function hex(value) {
  return `0x${(value >>> 0).toString(16).padStart(8, '0')}`;
}

const globals = collectConstGlobals();
const regions = collectRegions(globals);

const requiredRegions = [
  'UPDATE_RECT',
  'UPDATE_FLAGS',
  'WND_BG_BRUSH_TABLE',
  'WND_RECORDS',
  'CONTROL_TABLE',
  'CONTROL_GEOM',
  'CLASS_RECORDS',
  'TIMER_TABLE',
  'MENU_DATA_TABLE',
  'WND_DLG_RECORDS',
  'PAINT_FLAGS',
  'PROP_TABLE',
  'TV_TABLE',
  'SYNC_TABLE',
  'EDIT_LAYOUT_SCRATCH',
  'D3DIM_MATRICES',
  'DX_OBJECTS',
  'COM_WRAPPERS',
  'COM_WRAPPERS_AUX',
];

const regionNames = new Set(regions.map(region => region.name));
for (const name of requiredRegions) {
  assert(regionNames.has(name), `missing fixed memory region $${name}/$${name}_SIZE`);
}

for (const region of regions) {
  const end = region.start + region.size;
  assert(end <= WASM_MEMORY_SIZE,
    `${region.name} exceeds WASM memory: ${hex(region.start)}..${hex(end)} ` +
    `(${region.baseGlobal.file}:${region.baseGlobal.line})`);
  region.end = end;
}

for (let i = 1; i < regions.length; i++) {
  const prev = regions[i - 1];
  const cur = regions[i];
  assert(prev.end <= cur.start,
    `fixed WAT memory regions overlap:\n` +
    `  ${prev.name}: ${hex(prev.start)}..${hex(prev.end)} ` +
    `(${prev.baseGlobal.file}:${prev.baseGlobal.line}, size ${prev.sizeGlobal.file}:${prev.sizeGlobal.line})\n` +
    `  ${cur.name}: ${hex(cur.start)}..${hex(cur.end)} ` +
    `(${cur.baseGlobal.file}:${cur.baseGlobal.line}, size ${cur.sizeGlobal.file}:${cur.sizeGlobal.line})`);
}

const treeviewSource = fs.readFileSync(path.join(SRC, '09c2-treeview.wat'), 'utf8');
assert(!/\(i32\.const\s+0x0*9000\)/i.test(treeviewSource),
  'treeview table must use $TV_TABLE, not a hard-coded 0x9000 base');

console.log(`test-wat-memory-map: ok (${regions.length} fixed regions)`);
