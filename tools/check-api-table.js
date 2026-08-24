#!/usr/bin/env node
// Gate: src/api_table.json ids are array positions, and the array is append-only.
//
// gen_api_table.js renumbers every entry from its index on each run, so a
// mid-array insert silently rewrites thousands of ids — and every id is baked
// into the compiled hash table, the generated dispatch br_table, and the
// hardcoded fast paths in 09b-dispatch.wat. The append-only rule was previously
// documented only in a memory note; this makes it a build failure.
//
// During a merge the rule can only hold against ONE parent: if both branches
// appended, the resolution has to renumber somebody's tail. So when MERGE_HEAD
// exists the gate passes if the table is append-only vs *either* parent, and
// says which one. Keep the trunk's ids stable and renumber the feature branch's
// own additions -- the trunk's are the ones every later merge diffs against.
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
function loadBase(rev) {
  try {
    const raw = execFileSync('git', ['show', `${rev}:${REL}`], {
      cwd: ROOT, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    });
    return JSON.parse(raw.toString('utf8'));
  } catch {
    return null;
  }
}

// Compare against one base; returns the list of complaints (empty == clean).
function appendOnlyErrors(baseTable, label) {
  const errors = [];
  if (table.length < baseTable.length) {
    errors.push(`ERROR: ${REL} shrank (${baseTable.length} -> ${table.length}) vs ${label}. Entries are ` +
      'append-only; removing one renumbers every later id and invalidates the compiled hash table.');
  }
  const n = Math.min(table.length, baseTable.length);
  let moved = 0;
  for (let i = 0; i < n; i++) {
    if (table[i].name !== baseTable[i].name) {
      if (moved < 10) {
        errors.push(`ERROR: index ${i} was "${baseTable[i].name}" at ${label}, is now "${table[i].name}". ` +
          'Add new APIs at the END of the array.');
      }
      moved++;
    }
  }
  if (moved > 10) errors.push(`  ...and ${moved - 10} more renumbered entries.`);
  return errors;
}

// A merge resolution can only preserve one parent's ids; accept either.
// `.git` is a file in a worktree, so ask git for the real gitdir.
const bases = [{ rev: BASE, table: loadBase(BASE) }];
try {
  const gitDir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  const mergeHead = path.join(gitDir, 'MERGE_HEAD');
  if (fs.existsSync(mergeHead)) {
    const other = fs.readFileSync(mergeHead, 'utf8').trim().split('\n')[0];
    bases.push({ rev: other, table: loadBase(other) });
  }
} catch { /* not a git tree — the HEAD lookup below already handles that */ }

let cleanRev = BASE;
const usable = bases.filter(b => b.table);
if (!usable.length) {
  console.log(`api_table: no ${BASE} copy to diff against (new file or shallow tree) — index check only.`);
} else {
  const results = usable.map(b => ({ ...b, errors: appendOnlyErrors(b.table, b.rev) }));
  const clean = results.find(r => !r.errors.length);
  if (clean) {
    cleanRev = clean.rev;
    const added = table.length - clean.table.length;
    if (added > 0) console.log(`api_table: ${added} new entr${added === 1 ? 'y' : 'ies'} appended vs ${clean.rev}.`);
  } else {
    // Report the closest miss so the fix is obvious.
    const best = results.reduce((a, b) => (a.errors.length <= b.errors.length ? a : b));
    for (const e of best.errors) console.error(e);
    failed = true;
  }
}

if (failed) process.exit(1);
console.log(`api_table OK: ${table.length} entries, id === index, append-only vs ${cleanRev}.`);
