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

function watStringLength(literal) {
  let length = 0;
  for (let i = 0; i < literal.length; i++, length++) {
    if (literal[i] !== '\\') continue;
    if (/[0-9a-f]/i.test(literal[i + 1] || '') &&
        /[0-9a-f]/i.test(literal[i + 2] || '')) i += 2;
    else i += 1;
  }
  return length;
}

function collectDataRegions() {
  const regions = [];
  const dataRe = /\(data\s+\(i32\.const\s+([^)]+)\)\s*((?:"(?:[^"\\]|\\.)*"\s*)+)\)/gs;
  const stringRe = /"((?:[^"\\]|\\.)*)"/g;
  for (const file of WAT_FILES) {
    const source = fs.readFileSync(path.join(SRC, file), 'utf8');
    for (const match of source.matchAll(dataRe)) {
      let size = 0;
      for (const part of match[2].matchAll(stringRe)) size += watStringLength(part[1]);
      const offset = match.index;
      regions.push({
        name: '(data)',
        start: parseConstI32(match[1]),
        size,
        end: parseConstI32(match[1]) + size,
        file,
        line: source.slice(0, offset).split(/\r?\n/).length,
      });
    }
  }
  return regions;
}

function hex(value) {
  return `0x${(value >>> 0).toString(16).padStart(8, '0')}`;
}

const globals = collectConstGlobals();
const regions = collectRegions(globals);
const dataRegions = collectDataRegions();

const requiredRegions = [
  'UPDATE_RECT',
  'UPDATE_FLAGS',
  'API_HASH_TABLE',
  'DLL_TABLE',
  'DLL_RSRC_TABLE',
  'DLL_PATH_TABLE',
  'WIN16_FILE_TABLE',
  'WIN16_SEG_TABLE',
  'WIN16_THUNK_TABLE',
  'WIN16_APP_DLL_STAGING',
  'WIN16_BUILTIN_NAMES',
  'WND_BG_BRUSH_TABLE',
  'WND_RECORDS',
  'WINDOW_EXTRA_TABLE',
  'CONTROL_TABLE',
  'CONTROL_GEOM',
  'CLASS_RECORDS',
  'TIMER_TABLE',
  'TIMER_SHARED',
  'TLS_NEXT_INDEX_SHARED',
  'MENU_DATA_TABLE',
  'WND_DLG_RECORDS',
  'PAINT_FLAGS',
  'PROP_TABLE',
  'TV_TABLE',
  'SCROLL_AUX_TABLE',
  'SYNC_TABLE',
  'EDIT_LAYOUT_SCRATCH',
  'SHARED_DLG_ENDED',
  'SHARED_DLG_RESULT',
  'SHARED_MODAL_DLG_HWND',
  'SHARED_MODAL_RESULT',
  'SHARED_MODAL_DONE',
  'GDI_REGION_TABLE',
  'GDI_DC_PATH_TABLE',
  'GDI_REGION_BANDS',
  'GDI_REGION_WORK',
  'GDI_DC_CLIP_TABLE',
  'GDI_DC_SYSTEM_CLIP_TABLE',
  'GDI_DC_SAVE_TABLE',
  'GDI_LINE_DESC',
  'GDI_BLIT_DESC',
  'GDI_PALETTE_RESOLVE',
  'GDI_DC_STATE_TABLE',
  'GDI_OBJECT_TABLE',
  'GDI_WINDOW_SURFACE_TABLE',
  'GDI_WINDOW_SURFACE_HWM',
  'GDI_DC_AUX_TABLE',
  'GDI_OBJECT_GEN',
  'GDI_NEAREST_CACHE',
  'GDI_BITMAP_FONT_IO',
  'GDI_BITMAP_FONT_DESC',
  'GDI_BITMAP_FONT_STATIC',
  'EXTRA_CMDLINE_BUFFER',
  'GDI_BITMAP_FONT_TABLE',
  'GDI_BITMAP_TEXT_LAYOUT',
  'GDI_BITMAP_TEXT_PREFIX',
  'TT_FONT_STRING_STORAGE',
  'CONSOLE_TEXT',
  'CONSOLE_ATTR',
  'CONSOLE_INPUT',
  'CODE_PAGE_BITMAP',
  'CS_TABLE',
  'CP1252_TO_CP437',
  'CP437_TO_CP1252',
  'D3DIM_MATRICES',
  'D3DIM_AUX',
  'DX_VTBL_REGISTRY',
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

// A high fixed address must either publish its own extent or explicitly name
// the sized region that owns it. Merely falling numerically inside some table
// is not enough: that would let a newly added, accidentally colliding global
// pass without anyone deciding which layout it belongs to. The explicit alias
// list is for named subfields, initial mutable pointers, and one end marker.
const highFixedAliases = new Map(Object.entries({
  THUNK_END: { owner: 'THUNK_BASE', atEnd: true },
  WIN16_DLL_STAGING: { owner: 'PE_STAGING' },
  GDI_BLIT_DST_DESC: { owner: 'GDI_BLIT_DESC' },
  GDI_BLIT_SRC_DESC: { owner: 'GDI_BLIT_DESC' },
  LOCK_VIRTUAL_MAP: { owner: 'LOCK_TABLE' },
  LOCK_DX: { owner: 'LOCK_TABLE' },
  LOCK_SOCKET: { owner: 'LOCK_TABLE' },
  LOCK_WND: { owner: 'LOCK_TABLE' },
  COM_AUX_NEXT_SHARED: { owner: 'LOCK_TABLE' },
  VSOCK_NEXT_PORT_SHARED: { owner: 'LOCK_TABLE' },
  THUNK_NEXT_SHARED: { owner: 'LOCK_TABLE' },
  console_text_base: { owner: 'CONSOLE_TEXT' },
  console_attr_base: { owner: 'CONSOLE_ATTR' },
  CONSOLE_BUFFER_TABLE: { owner: 'CONSOLE_INPUT' },
  CONSOLE_BUFFER_ACTIVE: { owner: 'CONSOLE_INPUT' },
  CONSOLE_TITLE_STORAGE: { owner: 'CONSOLE_INPUT' },
  D3DIM_MATRIX_USED: { owner: 'D3DIM_AUX' },
  D3DIM_UNIMPL_EXEC_OP: { owner: 'D3DIM_AUX' },
  D3DIM_UNIMPL_DRAW: { owner: 'D3DIM_AUX' },
  D3DIM_EB_CACHE_PTRS: { owner: 'D3DIM_AUX' },
  D3DIM_STATEBLOCKS: { owner: 'D3DIM_AUX' },
  GDI_BITMAP_FONT_SYSTEM_PATH: { owner: 'GDI_BITMAP_FONT_STATIC' },
  GDI_BITMAP_FONT_SYSTEM_STATE: { owner: 'GDI_BITMAP_FONT_STATIC' },
  GDI_BITMAP_FONT_MS_SANS_PATH: { owner: 'GDI_BITMAP_FONT_STATIC' },
  GDI_BITMAP_FONT_MS_SANS_STATE: { owner: 'GDI_BITMAP_FONT_STATIC' },
  GDI_BITMAP_FONT_FIXED_PATH: { owner: 'GDI_BITMAP_FONT_STATIC' },
  GDI_BITMAP_FONT_FIXED_STATE: { owner: 'GDI_BITMAP_FONT_STATIC' },
  GDI_BITMAP_FONT_COURIER_PATH: { owner: 'GDI_BITMAP_FONT_STATIC' },
  GDI_BITMAP_FONT_COURIER_STATE: { owner: 'GDI_BITMAP_FONT_STATIC' },
  GDI_BITMAP_FONT_TERMINAL_PATH: { owner: 'GDI_BITMAP_FONT_STATIC' },
  GDI_BITMAP_FONT_TERMINAL_STATE: { owner: 'GDI_BITMAP_FONT_STATIC' },
  GDI_BITMAP_FONT_WESTERN: { owner: 'GDI_BITMAP_FONT_STATIC' },
  GDI_FONT_MAPPER_FONT: { owner: 'GDI_BITMAP_FONT_STATIC' },
  GDI_FONT_MAPPER_COMIC_SANS: { owner: 'GDI_BITMAP_FONT_STATIC' },
  TT_SUBST_DEFAULT: { owner: 'TT_FONT_STRING_STORAGE' },
  TT_SUBST_TMS_RMN: { owner: 'TT_FONT_STRING_STORAGE' },
  TT_SUBST_TIMES_NEW_ROMAN: { owner: 'TT_FONT_STRING_STORAGE' },
  TT_FONT_DIR_PATTERN: { owner: 'TT_FONT_STRING_STORAGE' },
  TT_FONT_DIR_PREFIX: { owner: 'TT_FONT_STRING_STORAGE' },
}));

const regionByName = new Map(regions.map(region => [region.name, region]));
for (const [name, spec] of highFixedAliases) {
  const global = globals.get(name);
  assert(global, `stale high fixed-address alias $${name}`);
  assert(!globals.has(`${name}_SIZE`),
    `$${name} now has its own extent; remove its stale alias entry`);
  const owner = regionByName.get(spec.owner);
  assert(owner, `high fixed-address alias $${name} has missing owner $${spec.owner}`);
  const located = spec.atEnd
    ? global.value === owner.end
    : global.value >= owner.start && global.value < owner.end;
  assert(located,
    `high fixed-address alias $${name}=${hex(global.value)} is outside ` +
    `$${owner.name}=${hex(owner.start)}..${hex(owner.end)} ` +
    `(${global.file}:${global.line})`);
}

for (const global of globals.values()) {
  if (global.value < 0x07000000 || global.value >= 0x08000000 ||
      global.name.endsWith('_SIZE')) continue;
  assert(globals.has(`${global.name}_SIZE`) || highFixedAliases.has(global.name),
    `high fixed-address global $${global.name}=${hex(global.value)} must declare ` +
    `$${global.name}_SIZE or an explicit owning-region alias ` +
    `(${global.file}:${global.line})`);
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

const globalValue = name => {
  const global = globals.get(name);
  assert(global, `missing global $${name} required by fixed-memory capacity audit`);
  return global.value;
};

// Tie declared extents to the counts/strides that index them. Otherwise a
// too-small _SIZE would make the overlap test green while the implementation
// still writes beyond it.
assert.strictEqual(globalValue('DLL_TABLE_SIZE'), globalValue('DLL_TABLE_CAPACITY') * 32,
  'DLL_TABLE_SIZE must cover every 32-byte DLL record');
assert.strictEqual(globalValue('DLL_RSRC_TABLE_SIZE'), globalValue('DLL_TABLE_CAPACITY') * 8,
  'DLL_RSRC_TABLE_SIZE must cover every 8-byte resource record');
assert.strictEqual(globalValue('DLL_PATH_TABLE_SIZE'), globalValue('DLL_TABLE_CAPACITY') * 4,
  'DLL_PATH_TABLE_SIZE must cover every path pointer');
assert.strictEqual(globalValue('WIN16_FILE_TABLE_SIZE'), globalValue('WIN16_FILE_MAX') * 4,
  'WIN16_FILE_TABLE_SIZE must cover every handle slot');
assert(globalValue('WIN16_SEG_TABLE_SIZE') >= (globalValue('WIN16_SEG_MAX') + 1) * 16,
  'WIN16_SEG_TABLE_SIZE must cover every segment record plus scratch');
assert.strictEqual(globalValue('WIN16_THUNK_TABLE_SIZE'), globalValue('WIN16_THUNK_MAX') * 4,
  'WIN16_THUNK_TABLE_SIZE must cover every import thunk');
assert.strictEqual(globalValue('CODE_PAGE_BITMAP_SIZE'),
  Math.ceil(globalValue('CODE_PAGE_BITMAP_PAGES') / 8),
  'CODE_PAGE_BITMAP_SIZE must cover every tracked page bit');
assert.strictEqual(globalValue('CONSOLE_TEXT_SIZE'), globalValue('CONSOLE_MAX_CELLS') * 2,
  'CONSOLE_TEXT_SIZE must cover every screen-buffer cell');
assert.strictEqual(globalValue('CONSOLE_ATTR_SIZE'), globalValue('CONSOLE_MAX_CELLS') * 2,
  'CONSOLE_ATTR_SIZE must cover every screen-buffer attribute');
assert.strictEqual(globalValue('GDI_NEAREST_CACHE_SIZE'),
  globalValue('GDI_NEAREST_CACHE_SLOTS') * 8,
  'GDI_NEAREST_CACHE_SIZE must cover every colour-cache record');
assert(globalValue('COM_WRAPPERS_AUX_SIZE') >= globalValue('COM_WRAPPERS_AUX_MAX') * 8 &&
       globalValue('COM_WRAPPERS_AUX_SIZE') < (globalValue('COM_WRAPPERS_AUX_MAX') + 1) * 8,
  'COM_WRAPPERS_AUX_SIZE must cover its records and less than one padded record');
assert.strictEqual(globalValue('DX_VTBL_REGISTRY_SIZE'),
  (globalValue('DX_VTBL_REGISTRY_COUNT') + 1) * 4,
  'DX_VTBL_REGISTRY_SIZE must cover its count and every vtable pointer');
assert(globalValue('WIN16_DYNAMIC_MODULES') * globalValue('WIN16_APP_DLL_STRIDE') <=
       globalValue('WIN16_APP_DLL_STAGING_SIZE'),
  'WIN16 app-local DLL slots exceed WIN16_APP_DLL_STAGING_SIZE');
assert(globalValue('WIN16_DLL_STAGING') +
       globalValue('WIN16_DYNAMIC_BASE') * globalValue('WIN16_DLL_STAGING_STRIDE') <=
       regionByName.get('PE_STAGING').end,
  'Win16 system DLL staging slots exceed PE_STAGING');

// Data segments intentionally initialize some declared regions. They may be
// contained by those regions, but must not straddle an unrelated table. A
// worker WebAssembly instance reapplies every data segment to shared memory,
// so even a seemingly harmless overlap corrupts live process state.
for (const data of dataRegions) {
  assert(data.end <= WASM_MEMORY_SIZE,
    `WAT data exceeds memory: ${hex(data.start)}..${hex(data.end)} (${data.file}:${data.line})`);
  for (const region of regions) {
    if (data.start >= region.end || data.end <= region.start) continue;
    const contained = data.start >= region.start && data.end <= region.end;
    assert(contained,
      `WAT data overlaps fixed memory region:\n` +
      `  data: ${hex(data.start)}..${hex(data.end)} (${data.file}:${data.line})\n` +
      `  ${region.name}: ${hex(region.start)}..${hex(region.end)} ` +
      `(${region.baseGlobal.file}:${region.baseGlobal.line})`);
  }
}

const treeviewSource = fs.readFileSync(path.join(SRC, '09c2-treeview.wat'), 'utf8');
assert(!/\(i32\.const\s+0x0*9000\)/i.test(treeviewSource),
  'treeview table must use $TV_TABLE, not a hard-coded 0x9000 base');

const handlersSource = fs.readFileSync(path.join(SRC, '09a-handlers.wat'), 'utf8');
const hostImportsSource = fs.readFileSync(path.join(ROOT, 'lib', 'host-imports.js'), 'utf8');
assert(!/GDI_PALETTE_(?:TABLE|SELECTED|ENTRIES)/.test(hostImportsSource),
  'JavaScript must not retain semantic GDI palette storage');
assert(!/_parseFntStrike|_parseFonStrikes|_drawBitmapGlyph|bitmapFont/.test(hostImportsSource),
  'JavaScript must not retain FNT parsing, selection, or bitmap glyph rasterization');

const apiTable = JSON.parse(fs.readFileSync(path.join(SRC, 'api_table.json'), 'utf8'));
assert(apiTable.some(api => api.name === 'GetProfileStringW' && api.nargs === 5),
  'api_table.json must retain GetProfileStringW for Media Player device discovery');
assert(apiTable.length * 8 <= globals.get('API_HASH_TABLE_SIZE').value,
  'api_table.json exceeds the declared API hash table memory region');

console.log(`test-wat-memory-map: ok (${regions.length} fixed regions, ${dataRegions.length} data segments)`);
