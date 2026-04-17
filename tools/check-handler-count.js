#!/usr/bin/env node
// Ensure the three places that encode the handler count agree:
//   1. (table $handlers N funcref)        in src/02-thread-table.wat
//   2. number of $th_* entries in (elem)  in src/02-thread-table.wat
//   3. `i32.ge_u ... (i32.const N)` guard in src/04-cache.wat
// Drift causes valid handler indices to be flagged as "cache corruption",
// producing infinite cache-reset loops (see apps/rct.md for the incident).
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const tbl = fs.readFileSync(path.join(root, 'src/02-thread-table.wat'), 'utf8');
const cache = fs.readFileSync(path.join(root, 'src/04-cache.wat'), 'utf8');

const tableMatch = tbl.match(/\(table \$handlers\s+(\d+)\s+funcref\)/);
if (!tableMatch) { console.error('[check-handler-count] could not find table declaration'); process.exit(2); }
const tableSize = +tableMatch[1];

const elemStart = tbl.indexOf('(elem');
const elemBlock = tbl.slice(elemStart);
const elemCount = (elemBlock.match(/^\s*\$th_[A-Za-z0-9_]+/gm) || []).length;

const guardMatch = cache.match(/i32\.ge_u \(local\.get \$fn\) \(i32\.const (\d+)\)\)[\s\S]{0,200}0xCAC4BAD0/);
if (!guardMatch) { console.error('[check-handler-count] could not find CAC4BAD0 guard in 04-cache.wat'); process.exit(2); }
const guardValue = +guardMatch[1];

const ok = tableSize === elemCount && elemCount === guardValue;
const line = `handler table=${tableSize} elem entries=${elemCount} cache guard=${guardValue}`;
if (!ok) {
  console.error(`[check-handler-count] MISMATCH: ${line}`);
  console.error('  all three must be equal. Bump them together when adding/removing $th_* handlers.');
  process.exit(1);
}
console.log(`[check-handler-count] OK ${line}`);
