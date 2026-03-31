#!/usr/bin/env node
// migrate_dispatch.js — One-time migration: split 09-dispatch.wat into
//   09a-handlers.wat (hand-written handler functions + sub-dispatchers)
// Then gen_dispatch.js generates 09b-dispatch.generated.wat

const fs = require('fs');
const path = require('path');

const apiTable = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'api_table.json'), 'utf8'));
const dispatchPath = path.join(__dirname, '..', 'src', 'parts', '09-dispatch.wat');
const handlersPath = path.join(__dirname, '..', 'src', 'parts', '09a-handlers.wat');
const src = fs.readFileSync(dispatchPath, 'utf8');
const lines = src.split('\n');

// ── Extract handler bodies ────────────────────────────────────────
const markerRe = /^\s*\)\s*;;\s*(\d+):\s*(.+)$/;
const handlers = new Map(); // id -> { comment, bodyLines }

let firstHandler = -1, fallbackLine = -1;
for (let i = 0; i < lines.length; i++) {
  if (markerRe.test(lines[i]) && firstHandler < 0) firstHandler = i;
  if (/^\s*\)\s*;;\s*fallback/.test(lines[i])) { fallbackLine = i; break; }
}

if (firstHandler < 0 || fallbackLine < 0) {
  console.error('ERROR: could not find handler markers');
  process.exit(1);
}

let currentId = null, currentComment = null, bodyLines = [];
for (let i = firstHandler; i < fallbackLine; i++) {
  const m = lines[i].match(markerRe);
  if (m) {
    if (currentId !== null) {
      handlers.set(currentId, { comment: currentComment, bodyLines: [...bodyLines] });
    }
    currentId = parseInt(m[1]);
    currentComment = m[2].trim();
    bodyLines = [];
  } else {
    bodyLines.push(lines[i]);
  }
}
if (currentId !== null) {
  handlers.set(currentId, { comment: currentComment, bodyLines: [...bodyLines] });
}

console.error(`Extracted ${handlers.size} handlers`);

// ── Extract sub-dispatchers (everything after the dispatch function closes) ──
let dispatchEnd = -1;
for (let i = fallbackLine; i < lines.length; i++) {
  if (/^\s*\)\s*$/.test(lines[i]) && i > fallbackLine) {
    dispatchEnd = i;
    break;
  }
}
const subDispatchers = lines.slice(dispatchEnd + 1).join('\n').trim();

// ── Detect which extra locals each handler body needs ─────────────
const extraLocals = ['tmp', 'v', 'i', 'j', 'msg_ptr', 'packed', 'w0', 'w1', 'w2', 'name_rva'];

function detectLocals(bodyText) {
  const needed = [];
  for (const loc of extraLocals) {
    const re = new RegExp('\\$' + loc + '(?=[\\s)])', 'g');
    if (re.test(bodyText)) {
      needed.push(loc);
    }
  }
  return needed;
}

// ── Generate 09a-handlers.wat ─────────────────────────────────────
const out = [];
out.push('  ;; ============================================================');
out.push('  ;; WIN32 API HANDLER FUNCTIONS');
out.push('  ;; Hand-written implementations called from the generated dispatch.');
out.push('  ;; Each handler receives (arg0..arg4, name_ptr) and must set $eax');
out.push('  ;; and adjust $esp for stdcall cleanup before returning.');
out.push('  ;; ============================================================');
out.push('');

for (let id = 0; id < apiTable.length; id++) {
  const api = apiTable[id];
  const h = handlers.get(id);
  if (!h) { console.error(`WARNING: no handler for id ${id} (${api.name})`); continue; }

  // Clean up body: remove trailing bare (return) fall-through guard
  let body = [...h.bodyLines];
  while (body.length && body[0].trim() === '') body.shift();
  while (body.length && body[body.length - 1].trim() === '') body.pop();
  if (body.length && body[body.length - 1].trim() === '(return)') body.pop();
  while (body.length && body[body.length - 1].trim() === '') body.pop();

  const bodyText = body.join('\n');
  const locals = detectLocals(bodyText);

  let funcLines = [];
  funcLines.push(`  ;; ${id}: ${h.comment}`);
  funcLines.push(`  (func $handle_${api.name} (param $arg0 i32) (param $arg1 i32) (param $arg2 i32) (param $arg3 i32) (param $arg4 i32) (param $name_ptr i32)`);
  if (locals.length) {
    funcLines.push('    ' + locals.map(l => `(local $${l} i32)`).join(' '));
  }
  for (const line of body) {
    funcLines.push(line.replace(/^      /, '    '));
  }
  funcLines.push('  )');
  out.push(funcLines.join('\n'));
  out.push('');
}

// Fallback handler
out.push('  ;; fallback: unknown API');
out.push('  (func $handle_fallback (param $name_ptr i32)');
out.push('    (call $host_log (local.get $name_ptr) (i32.const 48))');
out.push('    (global.set $eax (i32.const 0))');
out.push('    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))');
out.push('  )');
out.push('');

// Add sub-dispatchers
if (subDispatchers) {
  out.push('  ;; ============================================================');
  out.push('  ;; SUB-DISPATCHERS (Local*, Global*, lstr*, Reg*)');
  out.push('  ;; ============================================================');
  out.push(subDispatchers);
}

fs.writeFileSync(handlersPath, out.join('\n') + '\n');
console.error(`Wrote ${handlersPath}: ${apiTable.length} handler functions`);
console.error('\nMigration complete. Now run: node tools/gen_dispatch.js');
