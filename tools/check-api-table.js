#!/usr/bin/env node
// Gate: src/api_table.json ids are array positions, and the array is append-only.
//
// gen_api_table.js renumbers every entry from its index on each run, so a
// mid-array insert silently rewrites thousands of ids — and every id is baked
// into the compiled hash table, the generated dispatch br_table, and the
// hardcoded fast paths in 09b-dispatch.wat. The append-only rule was previously
// documented only in a memory note; this makes it a build failure.
//
// Usage: node tools/check-api-table.js [--base=<git-rev>]
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const REL = 'src/api_table.json';

const baseArg = process.argv.find(a => a.startsWith('--base='));
const BASE = baseArg ? baseArg.slice(7) : 'HEAD';

const table = JSON.parse(fs.readFileSync(path.join(ROOT, REL), 'utf8'));

let failed = false;

// 1. id === index, names unique.
const seen = new Map();
for (let i = 0; i < table.length; i++) {
  const e = table[i];
  if (e.id !== i) {
    console.error(`ERROR: ${REL}[${i}] has id=${e.id} (name=${e.name}); id must equal array index.`);
    failed = true;
  }
  if (seen.has(e.name)) {
    console.error(`ERROR: duplicate API name "${e.name}" at indices ${seen.get(e.name)} and ${i}.`);
    failed = true;
  }
  seen.set(e.name, i);
}

// 2. Append-only vs the base revision: every entry that existed keeps its slot.
let baseTable = null;
try {
  const raw = execFileSync('git', ['show', `${BASE}:${REL}`], {
    cwd: ROOT, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
  });
  baseTable = JSON.parse(raw.toString('utf8'));
} catch {
  console.log(`api_table: no ${BASE} copy to diff against (new file or shallow tree) — index check only.`);
}

if (baseTable) {
  if (table.length < baseTable.length) {
    console.error(`ERROR: ${REL} shrank (${baseTable.length} -> ${table.length}). Entries are append-only; ` +
      'removing one renumbers every later id and invalidates the compiled hash table.');
    failed = true;
  }
  const n = Math.min(table.length, baseTable.length);
  let moved = 0;
  for (let i = 0; i < n; i++) {
    if (table[i].name !== baseTable[i].name) {
      if (moved < 10) {
        console.error(`ERROR: index ${i} was "${baseTable[i].name}" at ${BASE}, is now "${table[i].name}". ` +
          'Add new APIs at the END of the array.');
      }
      moved++;
      failed = true;
    }
  }
  if (moved > 10) console.error(`  ...and ${moved - 10} more renumbered entries.`);
  if (!failed && table.length > baseTable.length) {
    console.log(`api_table: ${table.length - baseTable.length} new entr${table.length - baseTable.length === 1 ? 'y' : 'ies'} appended.`);
  }
}

if (failed) process.exit(1);
console.log(`api_table OK: ${table.length} entries, id === index, append-only vs ${BASE}.`);
