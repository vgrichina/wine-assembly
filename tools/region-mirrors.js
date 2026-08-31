#!/usr/bin/env node
// region-mirrors.js — the `(global $R i32 (i32.const 0x…))` copies of the map.
//
// WHAT THIS IS FOR
// docs/watx-region-safety-design.md §6. Every declared region has a global
// behind it, and that global — not the declaration — is what the emulator reads:
// ~1100 `global.get` sites across src/. While its initializer is a LITERAL the
// map cannot move at all, because an allocated region relocates and every one of
// those sites keeps reading the address it used to be at, with nothing to say so.
//
// So the mirrors have to be symbolic:
//
//   (global $WND_RECORDS      i32 (i32.const 0x00007000))   ->  (region.addr $WND_RECORDS 0)
//   (global $WND_RECORDS_SIZE i32 (i32.const 0x00001800))   ->  (region.size $WND_RECORDS)
//
// That is a mechanical edit across ~350 lines in 20 files, which is exactly the
// kind of edit a person gets 349 of right. It is also CHECKABLE: while the
// regions are still `region.declare-fixed`, the symbolic form emits the literal's
// bytes, so a correct conversion changes no bytes and an incorrect one does.
//
// WHAT IT REFUSES TO DO
// Only NAME-MATCHED mirrors are rewritten: `$R` against region `$R`, and
// `$R_SIZE` against region `$R`'s extent. A literal that merely happens to land
// inside a region is NOT converted, because a number is not an address just
// because it falls in a range — `$CLASS_ATOM_BASE = 0xC000` is an ATOM, and it
// lands inside $WND_DLG_RECORDS by arithmetic accident. Those are reported by
// `--interior` as leads for a human, which is §7's "a literal is evidence, never
// proof" applied to the one place where acting on the evidence would be silent.
//
// Usage:
//   node tools/region-mirrors.js                 census: matched / interior / stale
//   node tools/region-mirrors.js --interior      only the unmatched interior hits
//   node tools/region-mirrors.js --rewrite       convert the name-matched mirrors
//   node tools/region-mirrors.js --check         exit 1 if any mirror is still a literal
//   node tools/region-mirrors.js --revert        symbolic mirrors back to literals
//
// Both directions take `--file=NAME` (repeat, or comma-separated) to work on a
// subset of src/. That is not a convenience: this is a shared worktree, and a
// mechanical edit across 12 files will land on top of somebody's uncommitted
// work. `--revert --file=X` backs this tool's own edit out of the one file
// another agent holds, without touching the eleven it does not.
'use strict';

const fs = require('fs');
const path = require('path');
const { WAT_FILES } = require('../lib/compile-wat');
const { collectDeclarations } = require('./check-region-decls.js');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const DECLS = '00-regions.wat';

const hex = (n) => `0x${(n >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
const has = (flag) => process.argv.includes(`--${flag}`);

// --file=A,B --file=C  ->  a set, or null meaning "every file in WAT_FILES".
const ONLY = (() => {
  const picked = process.argv
    .filter(a => a.startsWith('--file='))
    .flatMap(a => a.slice('--file='.length).split(',').map(s => s.trim()).filter(Boolean));
  return picked.length ? new Set(picked) : null;
})();
const selected = (file) => !ONLY || ONLY.has(file) || ONLY.has(`src/${file}`);

// The same global shape tools/check-region-decls.js recognizes, plus the two
// symbolic forms, so a half-converted tree is reported rather than misread.
const LITERAL = /^(\s*\(global\s+(\$[A-Za-z0-9_]+)\s+(?:i32|\(mut\s+i32\))\s+)\(i32\.const\s+([^)\s]+)\)(\)\s*(?:;;.*)?)$/;
const SYMBOLIC = /^(\s*\(global\s+(\$[A-Za-z0-9_]+)\s+(?:i32|\(mut\s+i32\))\s+)\(region\.(addr|size|end)\s+(\$[A-Za-z0-9_]+)(?:\s+([^)\s]+))?\)(\)\s*(?:;;.*)?)$/;

// ALIASES — the globals that hold an address INSIDE a region under another
// name. `--interior` finds candidates, but it cannot decide: most of its 213
// hits are counts and message ids that land in a region by arithmetic accident
// ($CLASS_ATOM_BASE = 0xC000 is an ATOM; $XTYP_POKE = 0x4090 is a DDE
// transaction type). These are the ones that are genuinely a pointer into the
// named region, checked one by one, and each is rewritten only after its
// current literal is confirmed to equal base+offset — so a stale entry here is
// an error, never a silent relocation.
const ALIASES = [
  ['THREAD_BASE', 'THREAD_CACHE_BASE', 0],
  // Not the region's end: $THREAD_CACHE_BASE also holds the per-thread
  // partitions above 0x400000, and $THREAD_END is where the MAIN thread's
  // 4MB cache stops.
  ['THREAD_END', 'THREAD_CACHE_BASE', 0x400000],
  ['thread_alloc', 'THREAD_CACHE_BASE', 0],
  ['PAGE_DIR', 'PAGE_DIR_BASE', 0],
  ['PAGE_INDEX', 'PAGE_INDEX_ARENA', 0],
  ['GDI_BLIT_DST_DESC', 'GDI_BLIT_DESC', 0x00],
  ['GDI_BLIT_SRC_DESC', 'GDI_BLIT_DESC', 0x50],
  ['GDI_RGB555_MASKS', 'DIB_DEFAULT_RGB555_MASKS', 0],
  ['LOCK_VIRTUAL_MAP', 'LOCK_TABLE', 0x000],
  ['LOCK_DX', 'LOCK_TABLE', 0x040],
  ['LOCK_SOCKET', 'LOCK_TABLE', 0x080],
  ['COM_AUX_NEXT_SHARED', 'LOCK_TABLE', 0x0C0],
  ['VSOCK_NEXT_PORT_SHARED', 'LOCK_TABLE', 0x100],
  ['THUNK_NEXT_SHARED', 'LOCK_TABLE', 0x140],
  ['LOCK_WND', 'LOCK_TABLE', 0x180],
  ['HEAP_DEFAULT_BASE', 'GUEST_HEAP_BASE', 0],
  ['win_ini_name_ptr', 'STRING_CONSTANTS', 0x00],
  ['exe_name_wa', 'STRING_CONSTANTS', 0x20],
  ['WIN16_DLL_STAGING', 'PE_STAGING', 0x400000],
  ['CONSOLE_TITLE', 'RESERVED_PAGE_STRINGS', 0x024],
  ['STATIC_SYS_DLL_NAMES', 'RESERVED_PAGE_STRINGS', 0x050],
  ['STATIC_SYS_DIR', 'RESERVED_PAGE_STRINGS', 0x074],
  ['STATIC_SYS_DLL_EXT', 'RESERVED_PAGE_STRINGS', 0x088],
  ['WIN16_NAME_KERNEL', 'RESERVED_PAGE_STRINGS', 0x0F0],
  ['WIN16_NAME_USER', 'RESERVED_PAGE_STRINGS', 0x0F7],
  ['WIN16_NAME_GDI', 'RESERVED_PAGE_STRINGS', 0x0FC],
  ['WIN16_NAME_KEYBOARD', 'RESERVED_PAGE_STRINGS', 0x100],
  ['WIN16_NAME_SOUND', 'RESERVED_PAGE_STRINGS', 0x109],
  ['WIN16_NAME_SHELL', 'RESERVED_PAGE_STRINGS', 0x10F],
  ['WIN16_NAME_MMSYSTEM', 'RESERVED_PAGE_STRINGS', 0x115],
  ['WIN16_NAME_COMMDLG', 'RESERVED_PAGE_STRINGS', 0x11E],
  ['WIN16_NAME_CARDS', 'RESERVED_PAGE_STRINGS', 0x126],
  ['WIN16_NAME_DDEML', 'RESERVED_PAGE_STRINGS', 0x12C],
  ['WIN16_NAME_SHELLABOUT', 'RESERVED_PAGE_STRINGS', 0x132],
  ['WIN16_NAME_NDDEAPI', 'RESERVED_PAGE_STRINGS', 0x13D],
  ['WIN16_NAME_NDDEGETWINDOW', 'RESERVED_PAGE_STRINGS', 0x145],
  ['WIN16_NAME_WIN87EM', 'RESERVED_PAGE_STRINGS', 0x153],
  ['WIN16_DDE_SHARES', 'RESERVED_PAGE_STRINGS', 0x160],
  ['console_text_base', 'CONSOLE_TEXT', 0],
  ['console_attr_base', 'CONSOLE_ATTR', 0],
  ['CONSOLE_BUFFER_ACTIVE', 'CONSOLE_INPUT', 0x014],
  ['CONSOLE_BUFFER_TABLE', 'CONSOLE_INPUT', 0x840],
  ['CONSOLE_TITLE_STORAGE', 'CONSOLE_INPUT', 0xA00],
  ['CONSOLE_HANDLE_TABLE', 'CONSOLE_INPUT', 0xB00],
  ['D3DIM_UNIMPL_EXEC_OP', 'D3DIM_AUX', 0x000],
  ['D3DIM_UNIMPL_DRAW', 'D3DIM_AUX', 0x020],
  ['D3DIM_EB_CACHE_PTRS', 'D3DIM_AUX', 0x040],
  ['D3DIM_STATEBLOCKS', 'D3DIM_AUX', 0x840],
  ['D3DIM_MATRIX_USED', 'D3DIM_AUX', 0xF00],
  ['GDI_BITMAP_FONT_SYSTEM_PATH', 'GDI_BITMAP_FONT_STATIC', 0x000],
  ['GDI_BITMAP_FONT_SYSTEM_STATE', 'GDI_BITMAP_FONT_STATIC', 0x01C],
  ['GDI_BITMAP_FONT_MS_SANS_PATH', 'GDI_BITMAP_FONT_STATIC', 0x020],
  ['GDI_BITMAP_FONT_MS_SANS_STATE', 'GDI_BITMAP_FONT_STATIC', 0x044],
  ['GDI_BITMAP_FONT_FIXED_PATH', 'GDI_BITMAP_FONT_STATIC', 0x048],
  ['GDI_BITMAP_FONT_FIXED_STATE', 'GDI_BITMAP_FONT_STATIC', 0x068],
  ['GDI_BITMAP_FONT_COURIER_PATH', 'GDI_BITMAP_FONT_STATIC', 0x06C],
  ['GDI_BITMAP_FONT_COURIER_STATE', 'GDI_BITMAP_FONT_STATIC', 0x08C],
  ['GDI_BITMAP_FONT_TERMINAL_PATH', 'GDI_BITMAP_FONT_STATIC', 0x120],
  ['GDI_BITMAP_FONT_TERMINAL_STATE', 'GDI_BITMAP_FONT_STATIC', 0x140],
  ['GDI_BITMAP_FONT_WESTERN', 'GDI_BITMAP_FONT_STATIC', 0x144],
  ['GDI_FONT_MAPPER_FONT', 'GDI_BITMAP_FONT_STATIC', 0x150],
  ['GDI_FONT_MAPPER_COMIC_SANS', 'GDI_BITMAP_FONT_STATIC', 0x158],
  ['TT_SUBST_DEFAULT', 'TT_FONT_STRING_STORAGE', 0x00],
  ['TT_SUBST_TMS_RMN', 'TT_FONT_STRING_STORAGE', 0x08],
  ['TT_SUBST_TIMES_NEW_ROMAN', 'TT_FONT_STRING_STORAGE', 0x10],
  ['TT_FONT_DIR_PATTERN', 'TT_FONT_STRING_STORAGE', 0x20],
  ['TT_FONT_DIR_PREFIX', 'TT_FONT_STRING_STORAGE', 0x40],
];

function parseInt32(text) {
  const t = String(text).trim().replace(/_/g, '');
  if (!/^(0x[0-9a-fA-F]+|\d+)$/.test(t)) return null;
  return Number.parseInt(t, /^0x/i.test(t) ? 16 : 10) >>> 0;
}

function main() {
  const decls = collectDeclarations();
  const byName = new Map(decls.map(d => [d.name, d]));
  // Sorted by base so the innermost containing region is reported, not the
  // 60 MB address space that also contains it.
  const sorted = [...decls].sort((a, b) => (b.base - a.base) || (a.size - b.size));

  const aliases = [];      // in the curated ALIASES table: an interior pointer
  const aliasErrors = [];  // ALIASES entry that no longer describes the tree
  const matched = [];    // name-matched: safe to rewrite
  const interior = [];   // lands inside a region, name says nothing: a lead only
  const stale = [];      // name-matched but the literal disagrees with the map
  const already = [];    // already symbolic

  const edits = new Map();   // file -> [{ index, text }]  literal  -> symbolic
  const reverts = new Map(); // file -> [{ index, text }]  symbolic -> literal

  for (const file of WAT_FILES) {
    if (file === DECLS || !file.endsWith('.wat') || !selected(file)) continue;
    const full = path.join(SRC, file);
    const lines = fs.readFileSync(full, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      const sym = SYMBOLIC.exec(line);
      if (sym) {
        const [, head, name, kind, rname, off, tail] = sym;
        already.push({ file, line: i + 1, name });
        // The inverse edit, so `--revert --file=X` can back this tool's own
        // conversion out of one file without disturbing the rest.
        const region = byName.get(rname.slice(1));
        if (region) {
          const value = kind === 'size' ? region.size
            : kind === 'end' ? region.base + region.size
            : region.base + (off ? (parseInt32(off) || 0) : 0);
          reverts.set(file, (reverts.get(file) || []).concat(
            { index: i, text: `${head}(i32.const ${hex(value)})${tail}` }));
        }
        return;
      }
      const m = LITERAL.exec(line);
      if (!m) return;
      const [, head, name, rawValue, tail] = m;
      const value = parseInt32(rawValue);
      if (value === null) return;
      const bare = name.slice(1);
      const where = { file, line: i + 1, name, value };

      const asBase = byName.get(bare);
      if (asBase) {
        if (value === asBase.base) {
          matched.push({ ...where, kind: 'base', region: bare });
          edits.set(file, (edits.get(file) || []).concat(
            { index: i, text: `${head}(region.addr $${bare} 0)${tail}` }));
        } else {
          stale.push({ ...where, kind: 'base', region: bare, expected: asBase.base });
        }
        return;
      }
      if (bare.endsWith('_SIZE')) {
        const asSize = byName.get(bare.slice(0, -'_SIZE'.length));
        if (asSize) {
          if (value === asSize.size) {
            matched.push({ ...where, kind: 'size', region: bare.slice(0, -'_SIZE'.length) });
            edits.set(file, (edits.get(file) || []).concat(
              { index: i, text: `${head}(region.size $${bare.slice(0, -'_SIZE'.length)})${tail}` }));
          } else {
            stale.push({ ...where, kind: 'size', region: bare.slice(0, -'_SIZE'.length),
              expected: asSize.size });
          }
          return;
        }
      }
      const alias = ALIASES.find(a => a[0] === bare);
      if (alias) {
        const [, rname, off] = alias;
        const region = byName.get(rname);
        if (!region) {
          aliasErrors.push(`${file}:${i + 1} ${name} names $${rname}, which is not declared`);
          return;
        }
        const want = off === 'end' ? region.base + region.size : region.base + off;
        if (value !== want) {
          aliasErrors.push(`${file}:${i + 1} ${name} = ${hex(value)}, but ` +
            `$${rname} + ${off === 'end' ? 'end' : hex(off)} is ${hex(want)}`);
          return;
        }
        aliases.push({ ...where, region: rname, offset: off });
        edits.set(file, (edits.get(file) || []).concat({
          index: i,
          text: `${head}(region.${off === 'end' ? `end $${rname}` : `addr $${rname} ${hex(off)}`})${tail}`,
        }));
        return;
      }
      const inside = sorted.find(d => value >= d.base && value < d.base + d.size);
      if (inside) {
        interior.push({ ...where, region: inside.name, offset: value - inside.base });
      }
    });
  }

  if (has('interior')) {
    for (const h of interior) {
      console.log(`${h.file}:${h.line}  ${h.name} = ${hex(h.value)}  ` +
        `= $${h.region} + ${hex(h.offset)}`);
    }
    console.log(`region-mirrors: ${interior.length} literal(s) inside a region under ` +
      `another name — leads, not conversions`);
    return 0;
  }

  for (const s of stale) {
    console.error(`region-mirrors: STALE ${s.file}:${s.line} ${s.name} = ${hex(s.value)}, ` +
      `but $${s.region}'s ${s.kind} is ${hex(s.expected)}`);
  }
  for (const e of aliasErrors) console.error(`region-mirrors: ALIAS ${e}`);

  if (has('check')) {
    if (stale.length || aliasErrors.length) return 1;
    if (aliases.length) {
      for (const a of aliases) {
        console.error(`region-mirrors: ${a.file}:${a.line} ${a.name} is still a literal ` +
          `pointer into $${a.region}`);
      }
      return 1;
    }
    if (matched.length) {
      for (const m of matched.slice(0, 20)) {
        console.error(`region-mirrors: ${m.file}:${m.line} ${m.name} is still a literal ` +
          `copy of $${m.region}'s ${m.kind}`);
      }
      console.error(`region-mirrors: ${matched.length} mirror(s) still literal; ` +
        `run node tools/region-mirrors.js --rewrite`);
      return 1;
    }
    console.log(`region-mirrors OK: ${already.length} mirror(s) symbolic, none literal`);
    return 0;
  }

  if (has('revert')) {
    let files = 0, n = 0;
    for (const [file, list] of reverts) {
      const full = path.join(SRC, file);
      const lines = fs.readFileSync(full, 'utf8').split(/\r?\n/);
      for (const e of list) { lines[e.index] = e.text; n++; }
      fs.writeFileSync(full, lines.join('\n'));
      files++;
    }
    console.log(`region-mirrors: reverted ${n} mirror(s) to literals in ${files} file(s)`);
    return 0;
  }

  if (has('rewrite')) {
    if (stale.length || aliasErrors.length) {
      console.error('region-mirrors: refusing to rewrite while a mirror disagrees with the map');
      return 1;
    }
    let files = 0;
    for (const [file, list] of edits) {
      const full = path.join(SRC, file);
      const lines = fs.readFileSync(full, 'utf8').split(/\r?\n/);
      for (const e of list) lines[e.index] = e.text;
      fs.writeFileSync(full, lines.join('\n'));
      files++;
    }
    console.log(`region-mirrors: rewrote ${matched.length} mirror(s) and ` +
      `${aliases.length} interior alias(es) in ${files} file(s)`);
    return 0;
  }

  const bases = matched.filter(m => m.kind === 'base').length;
  console.log(`region-mirrors: ${matched.length} literal mirror(s) (${bases} base, ` +
    `${matched.length - bases} size), ${already.length} already symbolic, ` +
    `${stale.length} stale, ${aliases.length} literal interior alias(es), ` +
    `${interior.length} interior lead(s).`);
  const perFile = new Map();
  for (const m of matched) perFile.set(m.file, (perFile.get(m.file) || 0) + 1);
  for (const [f, n] of [...perFile].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  src/${f}`);
  }
  return stale.length ? 1 : 0;
}

if (require.main === module) process.exit(main());
