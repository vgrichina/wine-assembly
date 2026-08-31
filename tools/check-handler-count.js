#!/usr/bin/env node
// Ensure the three places that encode the handler count agree:
//   1. (table $handlers N funcref)        in src/02-thread-table.wat
//   2. number of $th_* entries in (elem)  in src/02-thread-table.wat
//   3. `i32.ge_u ... (i32.const N)` guard in src/04-cache.wat
// Drift causes valid handler indices to be flagged as "cache corruption",
// producing infinite cache-reset loops (see apps/rct.md for the incident).
//
// Also check that the profiling tables in src/01-header.wat can still hold
// every handler. $handler_hist_record drops any pair whose handler index is
// >= $HANDLER_HIST_COUNT, so a cap left behind by a growing handler table
// silently hides exactly the fused superinstructions the pair histogram is
// read to evaluate (see docs/interpreter-dispatch-perf.md).
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

const guardMatch = cache.match(/i32\.ge_u \(local\.get \$fn\) \(i32\.const (\d+)\)\)[\s\S]{0,240}(?:0xCAC4BAD0|return_call \$dispatch_bad)/);
if (!guardMatch) { console.error('[check-handler-count] could not find dispatch-bad guard in 04-cache.wat'); process.exit(2); }
const guardValue = +guardMatch[1];

if (!/\(func \$dispatch_bad[\s\S]{0,240}0xCAC4BAD0/.test(cache)) {
  console.error('[check-handler-count] could not find CAC4BAD0 recovery body in $dispatch_bad');
  process.exit(2);
}

const ok = tableSize === elemCount && elemCount === guardValue;
const line = `handler table=${tableSize} elem entries=${elemCount} cache guard=${guardValue}`;
if (!ok) {
  console.error(`[check-handler-count] MISMATCH: ${line}`);
  console.error('  all three must be equal. Bump them together when adding/removing $th_* handlers.');
  process.exit(1);
}

const header = fs.readFileSync(path.join(root, 'src/01-header.wat'), 'utf8');
function headerGlobal(name) {
  const m = header.match(new RegExp(`\\(global \\$${name} i32 \\(i32\\.const (0x[0-9A-Fa-f]+|\\d+)\\)\\)`));
  if (!m) { console.error(`[check-handler-count] could not find $${name} in src/01-header.wat`); process.exit(2); }
  return Number(m[1]);
}
const histCount = headerGlobal('HANDLER_HIST_COUNT');
const pairSize = headerGlobal('HANDLER_PAIR_HIST_COUNTS_SIZE');
const countsSize = headerGlobal('HANDLER_HIST_COUNTS_SIZE');

const profErrors = [];
if (tableSize > histCount) {
  profErrors.push(`$HANDLER_HIST_COUNT=${histCount} < handler table=${tableSize}: handlers ${histCount}..${tableSize - 1} are invisible in the pair histogram`);
}
if (pairSize < histCount * histCount * 4) {
  profErrors.push(`$HANDLER_PAIR_HIST_COUNTS_SIZE=${pairSize} < ${histCount}*${histCount}*4=${histCount * histCount * 4}`);
}
if (countsSize < tableSize * 4) {
  profErrors.push(`$HANDLER_HIST_COUNTS_SIZE=${countsSize} < handler table ${tableSize}*4=${tableSize * 4}`);
}
if (profErrors.length) {
  console.error('[check-handler-count] profiling tables too small:');
  for (const e of profErrors) console.error(`  ${e}`);
  console.error('  raise the globals in src/01-header.wat (and re-check placement with tools/wat-memory-map.js).');
  process.exit(1);
}

console.log(`[check-handler-count] OK ${line} hist_count=${histCount} pair_bytes=${pairSize}`);
