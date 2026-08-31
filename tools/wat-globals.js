#!/usr/bin/env node
// wat-globals.js — every constant i32 global in src/, with its VALUE.
//
// WHY THIS EXISTS
// Four tools and one test read the emulator's constant globals by regex, each
// with its own copy of the same pattern, and each of them assumed the
// initializer was a literal:
//
//   (global $WND_RECORDS i32 (i32.const 0x00007000))
//
// Wave 3 makes the mirrors symbolic, because a literal mirror pins the region it
// mirrors (docs/watx-region-safety-design.md §6):
//
//   (global $WND_RECORDS      i32 (region.addr $WND_RECORDS 0))
//   (global $WND_RECORDS_SIZE i32 (region.size $WND_RECORDS))
//
// A regex looking for `i32.const` does not fail on that — it finds NOTHING and
// reports an empty map, which reads as green in three of the five callers. So
// the reading moves here, once, and resolves both spellings against the placed
// layout (tools/region-layout.js, which asks the compiler rather than parsing).
//
//   const { collect } = require('./wat-globals');
//   const g = collect();                 // Map name -> { name, value, file, line, form }
//   g.get('WND_RECORDS').value           // the address, literal or symbolic
//   g.get('WND_RECORDS').form            // 'literal' | 'region'
//
// `form` is kept because the difference matters to a gate: a mirror that is
// still a literal is a region that cannot move.
'use strict';

const fs = require('fs');
const path = require('path');
const { WAT_FILES } = require('../lib/compile-wat');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

// The historical shape all five callers matched, plus the three region forms.
// Deliberately anchored to a whole line: a global initializer that needs more
// than one line is not a constant this file should be guessing about.
const LITERAL = /^\s*\(global\s+(\$[A-Za-z0-9_]+)\s+(?:i32|\(mut\s+i32\))\s+\(i32\.const\s+([^)]+)\)\)\s*(?:;;.*)?$/;
const REGION = /^\s*\(global\s+(\$[A-Za-z0-9_]+)\s+(?:i32|\(mut\s+i32\))\s+\(region\.(addr|size|end)\s+(\$[A-Za-z0-9_]+)(?:\s+([^)\s]+))?\)\)\s*(?:;;.*)?$/;

function parseConstI32(value) {
  const text = String(value).trim().replace(/_/g, '');
  if (!/^(0x[0-9a-fA-F]+|\d+)$/.test(text)) return null;
  return Number.parseInt(text, /^0x/i.test(text) ? 16 : 10) >>> 0;
}

function collect(options = {}) {
  const { layout } = require('./region-layout.js');
  const placed = layout(options.shake ? { shake: options.shake } : {});
  const globals = new Map();
  const duplicates = [];
  for (const file of WAT_FILES) {
    if (!file.endsWith('.wat')) continue;
    const source = fs.readFileSync(path.join(SRC, file), 'utf8');
    source.split(/\r?\n/).forEach((line, i) => {
      let name, value, form;
      const lit = LITERAL.exec(line);
      if (lit) {
        name = lit[1].slice(1);
        value = parseConstI32(lit[2]);
        form = 'literal';
        if (value === null) return;
      } else {
        const reg = REGION.exec(line);
        if (!reg) return;
        name = reg[1].slice(1);
        form = 'region';
        const region = placed.byName.get(reg[3].slice(1));
        if (!region) {
          throw new Error(`wat-globals: ${file}:${i + 1} $${name} names region ` +
            `${reg[3]}, which is not in the placed layout`);
        }
        const off = reg[4] === undefined ? 0 : parseConstI32(reg[4]);
        if (off === null) {
          throw new Error(`wat-globals: ${file}:${i + 1} $${name}: ` +
            `(region.addr ${reg[3]} ${reg[4]}) offset is not an integer literal`);
        }
        value = reg[2] === 'size' ? region.size
          : reg[2] === 'end' ? (region.base + region.size) >>> 0
          : (region.base + off) >>> 0;
      }
      if (globals.has(name)) {
        duplicates.push(`$${name} at ${file}:${i + 1} and ` +
          `${globals.get(name).file}:${globals.get(name).line}`);
        return;
      }
      globals.set(name, { name, value, file, line: i + 1, form });
    });
  }
  if (duplicates.length && !options.allowDuplicates) {
    throw new Error(`wat-globals: duplicate global(s): ${duplicates.join('; ')}`);
  }
  globals.duplicates = duplicates;
  return globals;
}

if (require.main === module) {
  const g = collect({ allowDuplicates: true });
  const only = (process.argv.find(a => a.startsWith('--name=')) || '').slice('--name='.length);
  for (const v of g.values()) {
    if (only && v.name !== only) continue;
    console.log(`0x${(v.value >>> 0).toString(16).toUpperCase().padStart(8, '0')}  ` +
      `${v.form.padEnd(7)} $${v.name}  (${v.file}:${v.line})`);
  }
  const symbolic = [...g.values()].filter(v => v.form === 'region').length;
  console.log(`wat-globals: ${g.size} constant i32 global(s), ${symbolic} region-backed` +
    (g.duplicates.length ? `, ${g.duplicates.length} duplicate name(s)` : ''));
}

module.exports = { collect, parseConstI32 };
