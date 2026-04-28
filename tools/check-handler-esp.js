#!/usr/bin/env node
// Verify each $handle_X function in src/09a*.wat / src/09c*.wat applies the
// stdcall ESP cleanup that matches api_table.json's nargs. Expected value:
//   esp += 4 * (nargs + 1)   ;; ret addr + nargs stdcall slots
// COM/cdecl/varargs handlers are listed in EXEMPT.

const fs = require('fs');
const path = require('path');

const apiTable = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'api_table.json'), 'utf8'));
const apiByName = {};
for (const entry of apiTable) {
  if (entry && entry.name) apiByName[entry.name] = entry;
}

// Names that legitimately don't follow stdcall esp cleanup or do their own.
const EXEMPT = new Set([
  'wsprintfA', 'wsprintfW', 'sprintf', '_snprintf',  // cdecl varargs
]);

const SRC = ['src/09a-handlers.wat', 'src/09a2-handlers-console.wat',
  'src/09a3-handlers-audio.wat', 'src/09a4-handlers-gdi.wat',
  'src/09a5-handlers-window.wat', 'src/09a6-handlers-crt.wat',
  'src/09a7-handlers-dispatch.wat', 'src/09a8-handlers-directx.wat',
  'src/09aa-handlers-d3dim.wat', 'src/09ab-handlers-d3dim-core.wat'];

const issues = [];
for (const file of SRC) {
  const fpath = path.join(__dirname, '..', file);
  if (!fs.existsSync(fpath)) continue;
  const lines = fs.readFileSync(fpath, 'utf8').split('\n');
  let funcStart = -1, funcName = null, depth = 0, espAdjust = null, espLine = -1, delegates = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/\(func \$handle_([A-Za-z0-9_]+)/);
    if (m && depth === 0) {
      funcStart = i; funcName = m[1]; espAdjust = null; espLine = -1; delegates = false;
    }
    if (funcStart >= 0) {
      for (const c of line) { if (c === '(') depth++; if (c === ')') depth--; }
      // Detect delegating handlers — they call into a sub-dispatcher that handles its own cleanup
      if (/call \$(dispatch_|crash_unimplemented|host_exit|raise_exception|d3dim_|wnd_send_message|com_|handle_|sub_|com_call_method|dx_handle_method|modal_begin|enter_modal|seh_raise)/.test(line)) {
        delegates = true;
      }
      const em = line.match(/global\.set \$esp\s*\(i32\.add\s*\(global\.get \$esp\)\s*\(i32\.const (\d+)\)/);
      if (em) {
        if (espAdjust !== null) {
          // Multiple adjustments — note but skip strict check
          espAdjust = 'multi';
        } else {
          espAdjust = parseInt(em[1], 10);
          espLine = i + 1;
        }
      }
      if (depth === 0 && i > funcStart) {
        // Function ended
        if (!EXEMPT.has(funcName)) {
          // Strip COM-method prefix; api_table has e.g. IDirectDraw_Release
          let lookupName = funcName;
          // Some handlers don't have api_table entries (helpers); skip silently if unknown
          const entry = apiByName[lookupName];
          if (entry && typeof entry.nargs === 'number' && espAdjust !== 'multi' && !delegates) {
            // cdecl: caller pops stdcall args, handler only pops return address (4)
            const isStdcall = (entry.convention || 'stdcall') === 'stdcall';
            const expected = isStdcall ? 4 * (entry.nargs + 1) : 4;
            if (espAdjust === null) {
              issues.push(`${file}:${funcStart+1}\t$handle_${funcName}\tNO esp cleanup (expected ${expected})`);
            } else if (espAdjust !== expected) {
              issues.push(`${file}:${espLine}\t$handle_${funcName}\tesp += ${espAdjust} (expected ${expected}, nargs=${entry.nargs})`);
            }
          }
        }
        funcStart = -1; funcName = null;
      }
    }
  }
}

if (issues.length === 0) {
  console.log('[check-handler-esp] OK');
  process.exit(0);
}
console.log(`[check-handler-esp] ${issues.length} issue(s):`);
for (const i of issues) console.log('  ' + i);
process.exit(1);
