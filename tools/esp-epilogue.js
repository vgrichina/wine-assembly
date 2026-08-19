#!/usr/bin/env node
// Generate every handler's stdcall epilogue from api_table.json's nargs.
//
// The rule is uniform: a $handle_X pops `4 * (nargs + 1)` — the return address
// plus its arguments — and getting it wrong is the documented cause of wild
// jumps, because the caller returns to garbage thousands of instructions later.
// Those ~1200 lines were hand-typed, and one of them (GlobalSize) was wrong.
//
//   node tools/esp-epilogue.js            report handlers and their epilogues
//   node tools/esp-epilogue.js --check    fail if any epilogue disagrees with nargs
//   node tools/esp-epilogue.js --sync     rewrite disagreeing epilogues from nargs
//
// WHY THE EPILOGUE STAYS IN THE HANDLER
//
// The review this came from proposed emitting the pop in the generated dispatch
// table instead and deleting the handler-side lines. I implemented that and
// backed it out; the caller cannot pop, for at least four separate reasons,
// three of which are invisible to a reading of the handler:
//
//   1. Trampolines. EnumDisplayMonitors, CreateWindowExA, DispatchMessageA and
//      others pop their own frame and then *build a guest callback's frame* on
//      top. A caller-side pop corrupts the stack they just set up.
//   2. Direct callers. 320 handlers are called by name from elsewhere in the
//      WAT — the Win16 bridge, the test exports, other handlers. Those call
//      sites do not pop, so the handler must.
//   3. Conditional epilogues. A blocking API pops only once its wait finishes
//      and yields on every earlier pass; popping per dispatch drops ESP once
//      per poll.
//   4. Something in WordPad's MFC startup that survives all three filters:
//      with 113 of the "provably simple" handlers converted it crashes in
//      HeapAlloc, with 112 it does not, and the 113th is safe on its own. That
//      is an interaction the static shape of a handler does not predict.
//
// So the value — epilogues derived from the table rather than typed — is taken
// here, in the handler, where every call path behaves identically. --check runs
// in the build next to check-handler-esp.js.

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'src');

const EXEMPT = new Set([
  'wsprintfA', 'wsprintfW', 'sprintf', '_snprintf', 'sscanf',  // cdecl varargs
  '_EH_prolog',
]);
const COM_METHOD = /^I[A-Z][A-Za-z0-9]*_[A-Za-z0-9_]+$/;

// Handlers whose single epilogue deliberately pops something other than their
// own full frame. Each needs a reason, because "it looked wrong but it's fine"
// is how the one real bug in this set (GlobalSize claiming nargs=2) survived.
const PARTIAL = new Map([
  // Delegates to $handle_LoadLibraryA, which already consumed the return
  // address and the first argument; this pops only the two extra Ex arguments.
  ['LoadLibraryExA', 'delegates to LoadLibraryA, pops only the extra Ex args'],
  // Delegates to $handle_MapVirtualKeyA, which pops ret + 2 args; this pops the
  // third (the locale handle it ignores).
  ['MapVirtualKeyExA', 'delegates to MapVirtualKeyA, pops only the extra locale arg'],
]);
// Helpers that redirect EIP or otherwise take over the frame.
const REDIRECTS = /call \$(crash_unimplemented|host_exit|raise_exception|d3dim_|wnd_send_message|com_|handle_|sub_|com_call_method|dx_handle_method|modal_begin|enter_modal|seh_raise|cpp_operator_|dlg_|win16_|call_guest|invoke_guest|push_guest)/;

function stripNonCode(line) {
  let out = '';
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inString) {
      if (c === '\\') { i++; continue; }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === ';' && line[i + 1] === ';') break;
    out += c;
  }
  return out;
}

// Walk one file, yielding { name, file, startLine, endLine, lines } per handler.
function handlersIn(file) {
  const text = fs.readFileSync(path.join(SRC_DIR, file), 'utf8');
  const lines = text.split('\n');
  const found = [];
  let start = -1, name = null, depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const code = stripNonCode(lines[i]);
    if (start < 0) {
      const m = code.match(/\(func \$handle_([A-Za-z0-9_?@$]+)/);
      if (!m) continue;
      start = i; name = m[1]; depth = 0;
    }
    for (const c of code) { if (c === '(') depth++; else if (c === ')') depth--; }
    if (depth !== 0) continue;
    found.push({ name, file, startLine: start, endLine: i });
    start = -1; name = null;
  }
  return { text, lines, found };
}

function loadApiTable() {
  const table = JSON.parse(fs.readFileSync(path.join(SRC_DIR, 'api_table.json'), 'utf8'));
  const byName = {};
  for (const e of table) if (e && e.name) byName[e.name] = e;
  return { table, byName };
}

// Every epilogue line in every handler, with what nargs says it should be.
// A handler may pop on several paths (a trampoline pops its own frame before
// building the callback's), so each line is judged on its own: it is an
// epilogue if it is the whole line and pops a frame-shaped amount.
function scan() {
  const { byName } = loadApiTable();
  const files = fs.readdirSync(SRC_DIR).filter(f => f.endsWith('.wat')).sort();
  const rows = [];
  for (const file of files) {
    const { lines, found } = handlersIn(file);
    for (const h of found) {
      if (EXEMPT.has(h.name) || COM_METHOD.test(h.name)) continue;
      const entry = byName[h.name];
      if (!entry || typeof entry.nargs !== 'number') continue;
      if ((entry.convention || 'stdcall') !== 'stdcall') continue;
      const expected = 4 * (entry.nargs + 1);
      for (let k = h.startLine; k <= h.endLine; k++) {
        const code = stripNonCode(lines[k]).trim();
        // Trailing parens after the epilogue close the enclosing (then ...) or
        // the function itself. They are structural, not part of the epilogue —
        // requiring the line to end right after it silently skipped 350
        // handlers, which a deliberately corrupted epilogue proved.
        const m = code.match(/^\(global\.set \$esp \(i32\.add \(global\.get \$esp\) \(i32\.const (\d+)\)\)\)\)*$/);
        if (!m) continue;
        rows.push({ file, name: h.name, line: k, found: parseInt(m[1], 10), expected });
      }
    }
  }
  return rows;
}

module.exports = { scan, loadApiTable };

if (require.main === module) {
  const CHECK = process.argv.includes('--check');
  const SYNC = process.argv.includes('--sync');
  const rows = scan();

  // A handler that pops several times is a trampoline: at least one of its
  // pops is its own stdcall frame, the others belong to a callback frame it
  // built. Only judge handlers with a single epilogue.
  const perHandler = new Map();
  for (const r of rows) {
    if (!perHandler.has(r.name)) perHandler.set(r.name, []);
    perHandler.get(r.name).push(r);
  }
  const wrong = [];
  for (const [name, list] of perHandler) {
    if (list.length !== 1) continue;
    if (PARTIAL.has(name)) continue;
    if (list[0].found !== list[0].expected) wrong.push(list[0]);
  }

  if (SYNC) {
    const byFile = new Map();
    for (const r of wrong) {
      if (!byFile.has(r.file)) byFile.set(r.file, []);
      byFile.get(r.file).push(r);
    }
    for (const [file, list] of byFile) {
      const p = path.join(SRC_DIR, file);
      const lines = fs.readFileSync(p, 'utf8').split('\n');
      for (const r of list) {
        lines[r.line] = lines[r.line].replace(
          /\(i32\.const \d+\)\)\)/,
          `(i32.const ${r.expected})))`);
        console.log(`${file}:${r.line + 1}  $handle_${r.name}  ${r.found} -> ${r.expected}`);
      }
      fs.writeFileSync(p, lines.join('\n'));
    }
    console.log(`synced ${wrong.length} epilogue(s) from api_table.json nargs`);
    process.exit(0);
  }

  if (CHECK) {
    if (wrong.length) {
      console.log(`[esp-epilogue] ${wrong.length} epilogue(s) disagree with api_table.json:`);
      for (const r of wrong) {
        console.log(`  ${r.file}:${r.line + 1}\t$handle_${r.name}\tpops ${r.found}, nargs says ${r.expected}` +
          '  (fix with: node tools/esp-epilogue.js --sync)');
      }
      process.exit(1);
    }
    console.log(`[esp-epilogue] OK — ${perHandler.size} handler(s), ${rows.length} epilogue line(s) match nargs`);
    process.exit(0);
  }

  const multi = [...perHandler.values()].filter(l => l.length > 1).length;
  console.log(`${perHandler.size} handlers with an epilogue, ${rows.length} epilogue lines`);
  console.log(`  ${multi} handler(s) pop more than once (trampolines — not judged)`);
  console.log(`  ${PARTIAL.size} deliberately partial (see PARTIAL in this file)`);
  console.log(`  ${wrong.length} disagree with nargs`);
}
