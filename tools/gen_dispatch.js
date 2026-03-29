#!/usr/bin/env node
// gen_dispatch.js — Rewrite 09-dispatch.wat with br_table dispatch
// Uses a proper S-expression tokenizer to extract handler bodies.

const fs = require('fs');
const path = require('path');

const apiTable = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'api_table.json'), 'utf8'));
// Read original dispatch — use git show to get committed version (avoids reading our own output)
const { execSync } = require('child_process');
let dispatchSrc;
try {
  dispatchSrc = execSync('git show HEAD:src/parts/09-dispatch.wat', { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
} catch (e) {
  dispatchSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'parts', '09-dispatch.wat'), 'utf8');
}
const lines = dispatchSrc.split('\n');

// ── S-expression tokenizer ──────────────────────────────────────────
// Tokenizes WAT into: '(', ')', strings, comments, and atoms.
// Returns an array of {type, value, line} tokens.
function tokenize(src) {
  const tokens = [];
  let i = 0, line = 1;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\n') { line++; i++; continue; }
    if (ch === ' ' || ch === '\t' || ch === '\r') { i++; continue; }
    if (ch === '(') { tokens.push({ type: 'open', value: '(', line }); i++; continue; }
    if (ch === ')') { tokens.push({ type: 'close', value: ')', line }); i++; continue; }
    // ;; line comment — capture as token
    if (ch === ';' && src[i + 1] === ';') {
      let end = src.indexOf('\n', i);
      if (end === -1) end = src.length;
      tokens.push({ type: 'comment', value: src.slice(i, end), line });
      i = end;
      continue;
    }
    // (; block comment ;)
    if (ch === '(' && src[i + 1] === ';') {
      let end = src.indexOf(';)', i + 2);
      if (end === -1) end = src.length; else end += 2;
      tokens.push({ type: 'comment', value: src.slice(i, end), line });
      i = end;
      continue;
    }
    // String literal
    if (ch === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\') j++; // skip escaped char
        j++;
      }
      tokens.push({ type: 'string', value: src.slice(i, j + 1), line });
      i = j + 1;
      continue;
    }
    // Atom (keyword, number, $identifier, etc.)
    let j = i;
    while (j < src.length && !/[\s()";\n]/.test(src[j])) j++;
    tokens.push({ type: 'atom', value: src.slice(i, j), line });
    i = j;
  }
  return tokens;
}

// ── Parse S-expressions into a tree ─────────────────────────────────
// Each node is either:
//   { type: 'list', children: [...], line }
//   { type: 'atom'|'string'|'comment', value, line }
function parse(tokens) {
  let pos = 0;
  function parseExpr() {
    if (pos >= tokens.length) return null;
    const tok = tokens[pos];
    if (tok.type === 'open') {
      pos++; // consume '('
      const node = { type: 'list', children: [], line: tok.line };
      while (pos < tokens.length && tokens[pos].type !== 'close') {
        const child = parseExpr();
        if (child) node.children.push(child);
      }
      if (pos < tokens.length) pos++; // consume ')'
      return node;
    }
    if (tok.type === 'close') return null; // shouldn't happen
    pos++;
    return tok;
  }
  const nodes = [];
  while (pos < tokens.length) {
    const n = parseExpr();
    if (n) nodes.push(n);
  }
  return nodes;
}

// ── Serialize S-expression tree back to WAT ─────────────────────────
function serialize(node, indent = 0) {
  if (node.type === 'comment') return ' '.repeat(indent) + node.value;
  if (node.type === 'atom' || node.type === 'string') return node.value;
  if (node.type !== 'list') return '';

  const children = node.children;
  if (children.length === 0) return ' '.repeat(indent) + '()';

  // Check if this is a short expression (fits on one line)
  const flat = '(' + children.map(c => serialize(c, 0)).join(' ') + ')';
  if (flat.length < 120 && !flat.includes('\n') && !children.some(c => c.type === 'comment')) {
    return ' '.repeat(indent) + flat;
  }

  // Multi-line: first child on same line as '(', rest indented
  const lines = ['(' + serialize(children[0], 0)];
  for (let i = 1; i < children.length; i++) {
    lines.push(serialize(children[i], indent + 2));
  }
  return ' '.repeat(indent) + lines.join('\n') + ')';
}

// ── Reconstruct original source for a token range ───────────────────
// Instead of re-serializing (which loses formatting), extract original source.
// We need token positions in the source. Let's re-tokenize with positions.
function tokenizeWithPos(src) {
  const tokens = [];
  let i = 0, line = 1;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\n') { line++; i++; continue; }
    if (ch === ' ' || ch === '\t' || ch === '\r') { i++; continue; }
    if (ch === '(') { tokens.push({ type: 'open', start: i, end: i + 1, line }); i++; continue; }
    if (ch === ')') { tokens.push({ type: 'close', start: i, end: i + 1, line }); i++; continue; }
    if (ch === ';' && src[i + 1] === ';') {
      let end = src.indexOf('\n', i);
      if (end === -1) end = src.length;
      tokens.push({ type: 'comment', start: i, end, line, value: src.slice(i, end) });
      i = end;
      continue;
    }
    if (ch === '(' && src[i + 1] === ';') {
      let end = src.indexOf(';)', i + 2);
      if (end === -1) end = src.length; else end += 2;
      tokens.push({ type: 'comment', start: i, end, line });
      i = end;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') { if (src[j] === '\\') j++; j++; }
      tokens.push({ type: 'string', start: i, end: j + 1, line });
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < src.length && !/[\s()";\n]/.test(src[j])) j++;
    tokens.push({ type: 'atom', start: i, end: j, line, value: src.slice(i, j) });
    i = j;
  }
  return tokens;
}

// ── Find matching close paren for an open paren at token index ──────
function findMatchingClose(tokens, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < tokens.length; i++) {
    if (tokens[i].type === 'open') depth++;
    if (tokens[i].type === 'close') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

// ── Main logic: extract handlers from dispatch ──────────────────────
const tokens = tokenizeWithPos(dispatchSrc);
const commentRe = /^;;\s+(\w+)\((\d+)\)/;

// Map API name → id
const nameToId = new Map();
for (const api of apiTable) nameToId.set(api.name, api.id);

// Find the win32_dispatch function boundaries in tokens.
// Only extract handlers from within this function, not sub-dispatchers.
let dispFuncOpen = -1, dispFuncClose = -1;
for (let ti = 0; ti < tokens.length; ti++) {
  if (tokens[ti].type === 'atom' && tokens[ti].value === '$win32_dispatch') {
    // Walk back to find enclosing (func
    for (let k = ti - 1; k >= 0; k--) {
      if (tokens[k].type === 'atom' && tokens[k].value === 'func') {
        dispFuncOpen = k - 1; // the '(' before 'func'
        break;
      }
    }
    if (dispFuncOpen >= 0) {
      dispFuncClose = findMatchingClose(tokens, dispFuncOpen);
    }
    break;
  }
}
if (dispFuncOpen < 0 || dispFuncClose < 0) {
  console.error('ERROR: could not find $win32_dispatch function');
  process.exit(1);
}

// Find each ";; ApiName(N)" comment followed by an (if ...) block.
// Only within win32_dispatch function.
const handlers = new Map(); // name -> original source string of body

for (let ti = dispFuncOpen; ti <= dispFuncClose; ti++) {
  const tok = tokens[ti];
  if (tok.type !== 'comment') continue;
  const m = tok.value.match(commentRe);
  if (!m) continue;
  const apiName = m[1];

  // Find next (if ...) — the open paren
  let ifOpen = -1;
  for (let j = ti + 1; j < tokens.length; j++) {
    if (tokens[j].type === 'comment') continue;
    if (tokens[j].type === 'open') {
      // Check if next atom is 'if'
      if (j + 1 < tokens.length && tokens[j + 1].type === 'atom' && tokens[j + 1].value === 'if') {
        ifOpen = j;
      }
    }
    break;
  }
  if (ifOpen < 0) continue;

  const ifClose = findMatchingClose(tokens, ifOpen);
  if (ifClose < 0) continue;

  // Within the (if ...) block, find (then ...) — a direct child
  // (if COND (then BODY)) — 'then' is at depth 1 relative to (if
  let thenOpen = -1;
  for (let j = ifOpen + 1; j <= ifClose; j++) {
    if (tokens[j].type === 'open' && j + 1 <= ifClose && tokens[j + 1].type === 'atom' && tokens[j + 1].value === 'then') {
      thenOpen = j;
      break;
    }
  }
  if (thenOpen < 0) continue;

  const thenClose = findMatchingClose(tokens, thenOpen);
  if (thenClose < 0) continue;

  // The body is everything between the 'then' atom and the closing paren of (then ...)
  // Find the 'then' atom token
  const thenAtom = thenOpen + 1; // tokens[thenAtom].value === 'then'

  // Body tokens: from thenAtom+1 to thenClose-1
  // Extract original source for these tokens
  if (thenAtom + 1 > thenClose - 1) {
    // Empty then — check if content is on same line as 'then'
    // Extract source between 'then' end and thenClose start
    const bodyStart = tokens[thenAtom].end;
    const bodyEnd = tokens[thenClose].start;
    const bodySrc = dispatchSrc.slice(bodyStart, bodyEnd).trim();
    if (bodySrc) handlers.set(apiName, bodySrc);
    continue;
  }

  const firstBodyTok = tokens[thenAtom + 1];
  const lastBodyTok = tokens[thenClose - 1];

  // Extract original source from first body token start to last body token end
  // But we want to include full lines for readability
  const bodyStart = firstBodyTok.start;
  const bodyEnd = lastBodyTok.end;
  let bodySrc = dispatchSrc.slice(bodyStart, bodyEnd);

  // Also grab any content between 'then' and first body token (e.g., on same line)
  const thenEnd = tokens[thenAtom].end;
  const preBody = dispatchSrc.slice(thenEnd, bodyStart).trim();
  if (preBody) bodySrc = preBody + ' ' + bodySrc;

  handlers.set(apiName, bodySrc);
}

console.error(`Extracted ${handlers.size} handlers via tokenizer`);

// Check coverage
let missing = [];
for (const api of apiTable) {
  if (!handlers.has(api.name)) missing.push(api.name);
}
if (missing.length) console.error(`Missing (${missing.length}): ${missing.join(', ')}`);

// ── Find sub-dispatcher functions ───────────────────────────────────
let subDispatchStart = -1;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].match(/^\s*\(func \$dispatch_/)) {
    subDispatchStart = i;
    break;
  }
}
const subDispatchers = subDispatchStart >= 0 ? lines.slice(subDispatchStart).join('\n') : '';

// ── Generate new dispatch ───────────────────────────────────────────
const N = apiTable.length;
const out = [];

out.push('  ;; ============================================================');
out.push('  ;; WIN32 API DISPATCH (table-driven)');
out.push('  ;; ============================================================');
out.push('  (func $win32_dispatch (param $thunk_idx i32)');
out.push('    (local $api_id i32) (local $name_rva i32) (local $name_ptr i32)');
out.push('    (local $arg0 i32) (local $arg1 i32) (local $arg2 i32) (local $arg3 i32)');
out.push('    (local $arg4 i32)');
out.push('    (local $w0 i32) (local $w1 i32) (local $w2 i32)');
out.push('    (local $msg_ptr i32) (local $tmp i32) (local $packed i32)');
out.push('    (local $i i32) (local $j i32) (local $v i32)');
out.push('');
out.push('    ;; Read thunk data');
out.push('    (local.set $name_rva (i32.load (i32.add (global.get $THUNK_BASE) (i32.mul (local.get $thunk_idx) (i32.const 8)))))');
out.push('    (local.set $api_id (i32.load (i32.add (i32.add (global.get $THUNK_BASE) (i32.mul (local.get $thunk_idx) (i32.const 8))) (i32.const 4))))');
out.push('');
out.push('    ;; Catch-return thunk');
out.push('    (if (i32.eq (local.get $name_rva) (i32.const 0xCACA0000))');
out.push('      (then (global.set $eip (global.get $eax)) (return)))');
out.push('');
out.push('    (local.set $name_ptr (i32.add (global.get $GUEST_BASE) (i32.add (local.get $name_rva) (i32.const 2))))');
out.push('');
out.push('    ;; Load args from guest stack');
out.push('    (local.set $arg0 (call $gl32 (i32.add (global.get $esp) (i32.const 4))))');
out.push('    (local.set $arg1 (call $gl32 (i32.add (global.get $esp) (i32.const 8))))');
out.push('    (local.set $arg2 (call $gl32 (i32.add (global.get $esp) (i32.const 12))))');
out.push('    (local.set $arg3 (call $gl32 (i32.add (global.get $esp) (i32.const 16))))');
out.push('    (local.set $arg4 (call $gl32 (i32.add (global.get $esp) (i32.const 20))))');
out.push('');
out.push('    ;; Load name words for sub-dispatchers');
out.push('    (local.set $w0 (i32.load (local.get $name_ptr)))');
out.push('    (local.set $w1 (i32.load (i32.add (local.get $name_ptr) (i32.const 4))))');
out.push('    (local.set $w2 (i32.load (i32.add (local.get $name_ptr) (i32.const 8))))');
out.push('');
out.push('    ;; Log API name');
out.push('    (call $host_log (local.get $name_ptr) (i32.const 32))');
out.push('');
out.push('    ;; === O(1) br_table dispatch ===');

// Open blocks: fallback outermost, then N-1 down to 0 innermost
out.push('    (block $fallback');
for (let id = N - 1; id >= 0; id--) {
  out.push(`    (block $api_${id}`);
}

// br_table — one long line
let br = '      (br_table';
for (let id = 0; id < N; id++) br += ` $api_${id}`;
br += ' $fallback (local.get $api_id))';
out.push(br);

// Close each block with its handler
for (let id = 0; id < N; id++) {
  const api = apiTable[id];
  out.push(`    ) ;; ${id}: ${api.name}`);

  const body = handlers.get(api.name);
  if (body) {
    // Indent body and emit
    const bodyLines = body.split('\n');
    for (const bl of bodyLines) {
      out.push('      ' + bl.trim());
    }
  } else {
    // Route to sub-dispatchers for grouped APIs
    const lstrApis = ['lstrlenA', 'lstrcpyA', 'lstrcatA', 'lstrcpynA', 'lstrcmpA'];
    const localApis = ['LocalAlloc', 'LocalFree', 'LocalReAlloc', 'LocalLock', 'LocalUnlock', 'LocalHandle', 'LocalSize'];
    const globalApis = ['GlobalAlloc', 'GlobalFree', 'GlobalReAlloc', 'GlobalLock', 'GlobalUnlock', 'GlobalHandle', 'GlobalSize'];
    const regApis = ['RegOpenKeyA', 'RegCloseKey', 'RegCreateKeyA', 'RegQueryValueExA', 'RegSetValueExA'];
    if (lstrApis.includes(api.name)) {
      out.push(`      (call $dispatch_lstr (local.get $name_ptr) (local.get $arg0) (local.get $arg1) (local.get $arg2))`);
    } else if (localApis.includes(api.name)) {
      out.push(`      (call $dispatch_local (local.get $name_ptr) (local.get $arg0) (local.get $arg1) (local.get $arg2))`);
    } else if (globalApis.includes(api.name)) {
      out.push(`      (call $dispatch_global (local.get $name_ptr) (local.get $arg0) (local.get $arg1) (local.get $arg2))`);
    } else if (regApis.includes(api.name)) {
      out.push(`      (call $dispatch_reg (local.get $name_ptr))`);
    } else if (api.name === 'MessageBeep') {
      out.push(`      ;; MessageBeep — no-op`);
      out.push(`      (global.set $eax (i32.const 1))`);
      out.push(`      (global.set $esp (i32.add (global.get $esp) (i32.const 8)))`);
    } else {
      out.push(`      ;; stub`);
      out.push(`      (global.set $eax (i32.const 0))`);
      out.push(`      (global.set $esp (i32.add (global.get $esp) (i32.const ${(api.nargs + 1) * 4})))`);
    }
  }
  out.push('    (return)');
}

// Fallback
out.push('    ) ;; fallback');
out.push('    (call $host_log (local.get $name_ptr) (i32.const 48))');
out.push('    (global.set $eax (i32.const 0))');
out.push('    (global.set $esp (i32.add (global.get $esp) (i32.const 4)))');
out.push('  )');
out.push('');

// Append sub-dispatchers
if (subDispatchers) {
  out.push(subDispatchers);
}

// ── Validate paren balance ──────────────────────────────────────────
const result = out.join('\n');
let depth = 0;
for (let ci = 0; ci < result.length; ci++) {
  if (result[ci] === '"') { while (ci + 1 < result.length && result[++ci] !== '"') { if (result[ci] === '\\') ci++; } continue; }
  if (result[ci] === ';' && result[ci + 1] === ';') { while (ci < result.length && result[ci] !== '\n') ci++; continue; }
  if (result[ci] === '(') depth++;
  if (result[ci] === ')') depth--;
  if (depth < 0) {
    const lineNum = result.slice(0, ci).split('\n').length;
    console.error(`ERROR: paren underflow at output line ${lineNum}`);
    process.exit(1);
  }
}
if (depth !== 0) {
  console.error(`ERROR: paren imbalance, final depth = ${depth}`);
  process.exit(1);
}

const outPath = path.join(__dirname, '..', 'src', 'parts', '09-dispatch.wat');
fs.writeFileSync(outPath, result + '\n');
console.error(`Written ${outPath} (${out.length} lines, parens balanced)`);
