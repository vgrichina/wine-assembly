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

  if (has('check')) {
    if (stale.length) return 1;
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
    if (stale.length) {
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
    console.log(`region-mirrors: rewrote ${matched.length} mirror(s) in ${files} file(s)`);
    return 0;
  }

  const bases = matched.filter(m => m.kind === 'base').length;
  console.log(`region-mirrors: ${matched.length} literal mirror(s) (${bases} base, ` +
    `${matched.length - bases} size), ${already.length} already symbolic, ` +
    `${stale.length} stale, ${interior.length} interior lead(s).`);
  const perFile = new Map();
  for (const m of matched) perFile.set(m.file, (perFile.get(m.file) || 0) + 1);
  for (const [f, n] of [...perFile].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  src/${f}`);
  }
  return stale.length ? 1 : 0;
}

if (require.main === module) process.exit(main());
