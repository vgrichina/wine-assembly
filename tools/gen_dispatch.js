#!/usr/bin/env node
// gen_dispatch.js — Regenerate br_table boilerplate in 09-dispatch.wat
//
// Reads the current dispatch file, extracts handler bodies between
// ") ;; N: ApiName" markers, then regenerates the block declarations
// and br_table from api_table.json. Existing handlers are preserved;
// new APIs get a default stub.

const fs = require('fs');
const path = require('path');

const apiTable = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'api_table.json'), 'utf8'));
const dispatchPath = path.join(__dirname, '..', 'src', 'parts', '09-dispatch.wat');
const src = fs.readFileSync(dispatchPath, 'utf8');

// ── Extract handler bodies from current file ────────────────────────
// Format: ") ;; N: ApiName ...\n  <body>\n    (return)\n"
// We key by API id (the number after ";; ").
const handlers = new Map(); // id -> { comment, body }

// Match lines like "    ) ;; 42: GetLastError — some note"
const markerRe = /^\s*\)\s*;;\s*(\d+):\s*(.+)$/;

const lines = src.split('\n');

// Find the range of the dispatch table (from first ") ;; 0:" to ") ;; fallback")
let firstHandler = -1, fallbackLine = -1;
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(markerRe);
  if (m && firstHandler < 0) firstHandler = i;
  if (/^\s*\)\s*;;\s*fallback/.test(lines[i])) { fallbackLine = i; break; }
}

if (firstHandler >= 0 && fallbackLine >= 0) {
  let currentId = null, currentComment = null, bodyLines = [];

  for (let i = firstHandler; i < fallbackLine; i++) {
    const m = lines[i].match(markerRe);
    if (m) {
      // Save previous handler
      if (currentId !== null) {
        handlers.set(currentId, { comment: currentComment, body: bodyLines.join('\n') });
      }
      currentId = parseInt(m[1]);
      currentComment = m[2].trim();
      bodyLines = [];
    } else {
      bodyLines.push(lines[i]);
    }
  }
  // Save last handler
  if (currentId !== null) {
    handlers.set(currentId, { comment: currentComment, body: bodyLines.join('\n') });
  }
}

console.error(`Extracted ${handlers.size} handlers from current file`);

// ── Extract preamble (everything before br_table blocks) ────────────
// Find the ";; === O(1) br_table dispatch ===" marker
let preambleEnd = -1;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('O(1) br_table dispatch')) { preambleEnd = i + 1; break; }
}
if (preambleEnd < 0) {
  console.error('ERROR: could not find br_table dispatch marker');
  process.exit(1);
}
const preamble = lines.slice(0, preambleEnd).join('\n');

// ── Extract postamble (everything after the dispatch function) ──────
// Find ") ;; fallback" and grab from there to end, including the fallback body
// and all sub-dispatcher functions
let postStart = -1;
for (let i = fallbackLine; i < lines.length; i++) {
  // The dispatch function ends with "  )" on its own line after fallback
  if (/^\s*\)\s*$/.test(lines[i]) && i > fallbackLine) {
    postStart = i + 1;
    break;
  }
}
const fallbackBody = lines.slice(fallbackLine, postStart).join('\n');
const postamble = lines.slice(postStart).join('\n');

// ── Generate new dispatch ───────────────────────────────────────────
const N = apiTable.length;
const out = [];

out.push(preamble);

// Block declarations: fallback outermost, then N-1 down to 0 innermost
out.push('    (block $fallback');
for (let id = N - 1; id >= 0; id--) {
  out.push(`    (block $api_${id}`);
}

// br_table line
let br = '      (br_table';
for (let id = 0; id < N; id++) br += ` $api_${id}`;
br += ' $fallback (local.get $api_id))';
out.push(br);

// Handler bodies
for (let id = 0; id < N; id++) {
  const api = apiTable[id];
  const h = handlers.get(id);

  if (h) {
    // Preserve existing handler with its original comment
    out.push(`    ) ;; ${id}: ${h.comment}`);
    out.push(h.body);
  } else {
    // Generate default stub for new API
    out.push(`    ) ;; ${id}: ${api.name}`);
    out.push(`      ;; stub`);
    out.push(`      (global.set $eax (i32.const 0))`);
    out.push(`      (global.set $esp (i32.add (global.get $esp) (i32.const ${(api.nargs + 1) * 4})))`);
    out.push('    (return)');
  }
}

// Fallback + sub-dispatchers
out.push(fallbackBody);
out.push(postamble);

// ── Validate paren balance ──────────────────────────────────────────
const result = out.join('\n');
let depth = 0;
for (let ci = 0; ci < result.length; ci++) {
  if (result[ci] === '"') { while (ci + 1 < result.length && result[++ci] !== '"') { if (result[ci] === '\\') ci++; } continue; }
  if (result[ci] === ';' && result[ci + 1] === ';') { while (ci < result.length && result[ci] !== '\n') ci++; continue; }
  if (result[ci] === '(') depth++;
  if (result[ci] === ')') depth--;
}
if (depth !== 0) {
  console.error(`WARNING: paren imbalance, final depth = ${depth}`);
}

fs.writeFileSync(dispatchPath, result);
console.error(`Written ${dispatchPath} (${N} APIs, ${handlers.size} preserved, ${N - handlers.size} new stubs)`);
