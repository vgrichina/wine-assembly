#!/usr/bin/env node
// Verify each $handle_X function applies the stdcall ESP cleanup that matches
// api_table.json's nargs. Expected value:
//   esp += 4 * (nargs + 1)   ;; ret addr + nargs stdcall slots
// ESP drift is the documented cause of wild jumps: a handler that pops the
// wrong amount leaves the caller returning to garbage many instructions later,
// where the real cause is no longer visible.
//
// Function boundaries are found by paren depth, so `;;` comments and string
// literals must be stripped first — both are full of parens, and counting them
// makes the walker lose track of where a function ends. That produced a long
// tail of "NO esp cleanup" reports for handlers that clean up perfectly well.
//
// A handler passes when at least one of its ESP adjustments matches. Handlers
// that trampoline into a guest callback legitimately move ESP several times —
// popping their own frame, then building the callback's — so demanding that
// every adjustment match reports them all as broken. What is always wrong is a
// handler with no matching adjustment anywhere, which is what an orphaned
// cleanup line looks like after a stray paren closes the function early.

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const conventionArg = args.find(arg => arg.startsWith('--convention='));
const conventionFilter = conventionArg ? conventionArg.slice('--convention='.length) : null;
const verbose = args.includes('--verbose');
// --trace-func=Name dumps the per-line paren depth for one handler, which is
// how you tell a real ESP bug from the walker losing the function boundary.
const traceArg = args.find(arg => arg.startsWith('--trace-func='));
const traceFunc = traceArg ? traceArg.slice('--trace-func='.length) : null;
if (conventionFilter && !['cdecl', 'stdcall'].includes(conventionFilter)) {
  console.error('usage: check-handler-esp.js [--convention=cdecl|stdcall] [--verbose]');
  process.exit(2);
}

const apiTable = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'api_table.json'), 'utf8'));
const apiByName = {};
for (const entry of apiTable) {
  if (entry && entry.name) apiByName[entry.name] = entry;
}

// Handlers that legitimately do not follow stdcall ESP cleanup.
const EXEMPT = new Set([
  'wsprintfA', 'wsprintfW', 'sprintf', '_snprintf', 'sscanf',  // cdecl varargs
  '_EH_prolog',  // naked helper builds an SEH frame and returns manually
]);

// COM interface methods carry a placeholder nargs of 5 in api_table.json
// (gen_api_table.js sets it to match the 5-arg + name_ptr handler signature),
// so their real stdcall frame size is not recorded anywhere and cannot be
// checked here. Skip them rather than emit 130 findings nobody can act on.
const COM_METHOD = /^I[A-Z][A-Za-z0-9]*_[A-Za-z0-9_]+$/;

// Every part, not a hardcoded list. The list was a maintenance trap: moving a
// handler into a new file (09a7b-ole, 09a7c-mixer, 09a9-comctl32 …) silently
// dropped it out of this gate's coverage, and the gate still said OK.
const SRC = fs.readdirSync(path.join(__dirname, '..', 'src'))
  .filter(f => f.endsWith('.wat'))
  .sort()
  .map(f => `src/${f}`);

// Remove string literals and `;;` comments so only structural parens remain.
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

const issues = [];
let checked = 0;
let skippedCom = 0;
let skippedDelegating = 0;

for (const file of SRC) {
  const fpath = path.join(__dirname, '..', file);
  if (!fs.existsSync(fpath)) continue;
  const lines = fs.readFileSync(fpath, 'utf8').split('\n');

  let funcStart = -1, funcName = null, depth = 0;
  let adjustments = [];   // { value, line }
  let delegates = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const code = stripNonCode(raw);

    if (funcStart < 0) {
      const m = code.match(/\(func \$handle_([A-Za-z0-9_?@$]+)/);
      if (!m) continue;
      funcStart = i;
      funcName = m[1];
      depth = 0;
      adjustments = [];
      delegates = false;
    }

    // A handler that hands off to a sub-dispatcher lets that callee do the
    // cleanup, so its own frame arithmetic is not comparable.
    if (/call \$(dispatch_|crash_unimplemented|host_exit|raise_exception|d3dim_|wnd_send_message|com_|handle_|sub_|com_call_method|dx_handle_method|modal_begin|enter_modal|seh_raise|cpp_operator_)/.test(code)) {
      delegates = true;
    }
    const em = code.match(/global\.set \$esp\s*\(i32\.add\s*\(global\.get \$esp\)\s*\(i32\.const (\d+)\)/);
    if (em) adjustments.push({ value: parseInt(em[1], 10), line: i + 1 });

    for (const c of code) { if (c === '(') depth++; else if (c === ')') depth--; }

    if (traceFunc && funcName === traceFunc) {
      console.log(`  ${String(i + 1).padStart(6)} depth=${String(depth).padStart(3)} | ${code.trimEnd()}`);
    }

    if (depth !== 0) continue;

    // Function ended on this line.
    const name = funcName;
    const startLine = funcStart + 1;
    funcStart = -1;
    funcName = null;

    if (EXEMPT.has(name)) continue;
    if (COM_METHOD.test(name)) { skippedCom++; continue; }
    const entry = apiByName[name];
    if (!entry || typeof entry.nargs !== 'number') continue;
    const convention = entry.convention || 'stdcall';
    if (conventionFilter && convention !== conventionFilter) continue;
    if (delegates) { skippedDelegating++; continue; }

    const expected = convention === 'stdcall' ? 4 * (entry.nargs + 1) : 4;
    checked++;
    if (adjustments.length === 0) {
      issues.push(`${file}:${startLine}\t$handle_${name}\tNO esp cleanup (expected ${expected})`);
      continue;
    }
    if (!adjustments.some(adj => adj.value === expected)) {
      const seen = [...new Set(adjustments.map(a => a.value))].join(', ');
      issues.push(`${file}:${adjustments[0].line}\t$handle_${name}\tesp += ${seen} (expected ${expected}, nargs=${entry.nargs})`);
    }
  }
}

if (verbose) {
  console.log(`[check-handler-esp] checked ${checked} handler(s); ` +
    `skipped ${skippedCom} COM method(s) with placeholder nargs and ` +
    `${skippedDelegating} delegating handler(s)`);
}

if (issues.length === 0) {
  console.log('[check-handler-esp] OK');
  process.exit(0);
}
console.log(`[check-handler-esp] ${issues.length} issue(s):`);
for (const i of issues) console.log('  ' + i);
process.exit(1);
