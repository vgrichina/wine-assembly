#!/usr/bin/env node
/**
 * WAT parenthesis & label scope checker.
 *
 * Usage:
 *   node tools/check-parens.js [file]                   # balance + label check + auto-diff vs HEAD
 *   node tools/check-parens.js [file] --range 800-850   # annotated depth + labels
 *   node tools/check-parens.js [file] --funcs           # function boundaries
 *   node tools/check-parens.js [file] --depth N         # lines that cross depth N
 *   node tools/check-parens.js [file] --diff            # force diff vs git HEAD (all divergences)
 *   node tools/check-parens.js [file] --no-diff         # skip auto-diff
 */
'use strict';
const fs = require('fs');
const { execSync } = require('child_process');

let file = 'build/combined.wat';
let showRange = null;
let showFuncs = false;
let showDepth = null;
let diffMode = false;
let noDiff = false;

const argv = process.argv.slice(2);
while (argv.length) {
  const a = argv.shift();
  if (a === '--range' && argv.length) {
    const [lo, hi] = argv.shift().split('-').map(Number);
    showRange = { lo, hi };
  } else if (a === '--funcs') {
    showFuncs = true;
  } else if (a === '--depth' && argv.length) {
    showDepth = Number(argv.shift());
  } else if (a === '--diff') {
    diffMode = true;
  } else if (a === '--no-diff') {
    noDiff = true;
  } else if (!a.startsWith('-')) {
    file = a;
  }
}

/** Strip ;; comments from a line */
function stripComment(line) {
  let inStr = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') inStr = !inStr;
    if (!inStr && line[i] === ';' && line[i + 1] === ';') return line.slice(0, i);
  }
  return line;
}

/**
 * Analyze WAT source: depth profile, label scopes, br validation.
 * When snapshotLabels is true, records the active label stack per line (slower).
 */
function analyze(lines, { snapshotLabels = false } = {}) {
  let depth = 0;
  const profile = [];        // { before, after, labels? } per line
  const labelStack = [];     // { name, kind, depth, line }
  const scopeStack = [];     // tracks all scope openers to know when to pop labels
  const errors = [];
  const funcBounds = [];
  let currentFunc = null;

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const raw = lines[i];
    const stripped = stripComment(raw);
    const before = depth;

    let pos = 0;
    while (pos < stripped.length) {
      if (stripped[pos] === '(') {
        depth++;
        const rest = stripped.slice(pos + 1).trimStart();

        const blockMatch = rest.match(/^(block|loop)\s+\$(\S+)/);
        const ifMatch = rest.match(/^if\b/);
        const funcMatch = rest.match(/^func\s+\$(\S+)/);

        if (blockMatch) {
          const label = '$' + blockMatch[2];
          labelStack.push({ name: label, kind: blockMatch[1], depth, line: lineNum });
          scopeStack.push({ hasLabel: true, depth });
        } else if (ifMatch) {
          const ifLabelMatch = rest.match(/^if\s+\$(\S+)/);
          if (ifLabelMatch) {
            labelStack.push({ name: '$' + ifLabelMatch[1], kind: 'if', depth, line: lineNum });
            scopeStack.push({ hasLabel: true, depth });
          } else {
            scopeStack.push({ hasLabel: false, depth });
          }
        } else if (funcMatch) {
          currentFunc = { name: '$' + funcMatch[1], startLine: lineNum, startDepth: depth };
        }

        // Check br/br_if targets
        const brMatch = rest.match(/^br(?:_if)?\s+\$(\S+)/);
        if (brMatch) {
          const target = '$' + brMatch[1].replace(/\)+$/, '');
          const found = labelStack.find(l => l.name === target);
          if (!found) {
            errors.push({ line: lineNum, msg: `br target ${target} not in scope`, text: raw.trimEnd().slice(0, 120) });
          }
        }

        pos++;
      } else if (stripped[pos] === ')') {
        depth--;

        while (scopeStack.length && scopeStack[scopeStack.length - 1].depth > depth) {
          const s = scopeStack.pop();
          if (s.hasLabel && labelStack.length) labelStack.pop();
        }

        if (currentFunc && depth < currentFunc.startDepth) {
          funcBounds.push({ ...currentFunc, endLine: lineNum });
          currentFunc = null;
        }

        pos++;
      } else {
        pos++;
      }
    }

    const entry = { before, after: depth };
    if (snapshotLabels) {
      entry.labels = labelStack.map(l => l.name);
      entry.func = currentFunc ? currentFunc.name : (funcBounds.length ? funcBounds[funcBounds.length - 1].name : null);
    }
    profile.push(entry);

    if (depth < 0) {
      errors.push({ line: lineNum, msg: `unbalanced ) — depth went to ${depth}`, text: raw.trimEnd() });
    }
  }

  if (depth !== 0) {
    errors.push({ line: lines.length, msg: `final depth ${depth} (expected 0)` });
  }

  return { profile, errors, funcBounds };
}

// --- Main ---

const text = fs.readFileSync(file, 'utf-8');
const lines = text.split('\n');

let hasOutput = false;

// --range: annotated depth + active labels
if (showRange) {
  const { profile, errors } = analyze(lines, { snapshotLabels: true });
  for (let i = showRange.lo - 1; i < Math.min(showRange.hi, lines.length); i++) {
    const p = profile[i];
    const ln = String(i + 1).padStart(5);
    const d = p.before === p.after
      ? String(p.after).padStart(2)
      : `${p.before}->${p.after}`;
    const scopeStr = p.labels.length ? ` {${p.labels.join(' ')}}` : '';
    const code = lines[i].trimEnd().slice(0, 90);
    console.log(`${ln} [${d.padEnd(5)}]${scopeStr}  ${code}`);
  }
  // Show any errors in the range
  for (const e of errors) {
    if (e.line >= showRange.lo && e.line <= showRange.hi) {
      console.error(`  ^^^ ERROR line ${e.line}: ${e.msg}`);
    }
  }
  hasOutput = true;
}

// For non-range modes, analyze without label snapshots (faster)
const { profile, errors, funcBounds } = hasOutput ? { profile: [], errors: [], funcBounds: [] } : analyze(lines);

// --funcs: show function boundaries
if (showFuncs) {
  for (const f of funcBounds) {
    console.log(`${String(f.startLine).padStart(5)} depth=${String(f.startDepth).padStart(2)}  ${f.name}  (ends ${f.endLine})`);
  }
  hasOutput = true;
}

// --depth: show lines that transition to/from a specific depth
if (showDepth !== null) {
  for (let i = 0; i < profile.length; i++) {
    const p = profile[i];
    if (p.after === showDepth && p.before !== p.after) {
      const ln = String(i + 1).padStart(4);
      console.log(`${ln} [${String(p.before).padStart(2)}->${String(p.after).padStart(2)}] ${lines[i].trimEnd().slice(0, 100)}`);
    }
  }
  hasOutput = true;
}

/**
 * Run a diff against git HEAD. Returns { ok, regions, funcDrift, lineCountChanged }.
 * When `quiet` is true and there's nothing to report, prints nothing.
 */
function runDiff({ quiet = false } = {}) {
  let oldText;
  try {
    oldText = execSync(`git show HEAD:${file}`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
  } catch {
    if (!quiet) console.error(`Cannot diff: ${file} not in git HEAD`);
    return { ok: false };
  }
  const oldLines = oldText.split('\n');
  const oldResult = analyze(oldLines);
  const oldProfile = oldResult.profile;
  const oldFuncs = oldResult.funcBounds;

  // Collect contiguous regions where depth differs, using a small gap tolerance
  // so nearby divergences merge into one region.
  const GAP = 3;
  const regions = [];
  const maxLen = Math.min(profile.length, oldProfile.length);
  let cur = null;
  for (let i = 0; i < maxLen; i++) {
    if (profile[i].after !== oldProfile[i].after) {
      if (cur && i - cur.end <= GAP) cur.end = i;
      else { cur = { start: i, end: i }; regions.push(cur); }
    }
  }

  // Per-function drift: map function name -> old/new end line.
  // A func whose span length shifted significantly is a strong signal the
  // structure re-nested (e.g. got prematurely closed).
  const newFuncMap = new Map(funcBounds.map(f => [f.name, f]));
  const funcDrift = [];
  for (const of_ of oldFuncs) {
    const nf = newFuncMap.get(of_.name);
    if (!nf) continue;
    const oldSpan = of_.endLine - of_.startLine;
    const newSpan = nf.endLine - nf.startLine;
    // Tolerate small edits; flag when span changes by > 50% AND > 20 lines
    if (Math.abs(newSpan - oldSpan) > 20 && Math.abs(newSpan - oldSpan) > oldSpan * 0.5) {
      funcDrift.push({ name: of_.name, oldSpan, newSpan, oldStart: of_.startLine, newStart: nf.startLine });
    }
  }

  if (!quiet || regions.length || funcDrift.length) {
    if (regions.length === 0 && funcDrift.length === 0) {
      if (profile.length !== oldProfile.length) {
        console.log(`Line count changed: ${oldProfile.length} -> ${profile.length} (depths match on overlap)`);
      } else {
        console.log('Depth profiles match HEAD — no divergence');
      }
    } else {
      if (funcDrift.length) {
        console.log(`Function span drift vs HEAD (suspect misnesting):`);
        for (const d of funcDrift) {
          console.log(`  ${d.name}: span ${d.oldSpan} -> ${d.newSpan} lines (old L${d.oldStart}, new L${d.newStart})`);
        }
      }
      if (regions.length) {
        // Once code is added/removed, line-index comparison cascades — so just
        // show the first region in detail. That's where the real bug usually is.
        const r = regions[0];
        console.log(`First depth divergence from HEAD at line ${r.start + 1} (${regions.length} region(s) total):`);
        const ctxStart = Math.max(0, r.start - 2);
        const ctxEnd = Math.min(r.end + 2, r.start + 10);
        for (let j = ctxStart; j <= Math.min(ctxEnd, maxLen - 1); j++) {
          const diverges = profile[j].after !== oldProfile[j].after;
          const marker = diverges ? '>>' : '  ';
          const op = oldProfile[j].after;
          const np = profile[j].after;
          const depthStr = op === np ? `  [${np}]` : `  [${op}->${np}]`;
          console.log(`${marker} ${String(j + 1).padStart(5)}${depthStr} ${lines[j].trimEnd().slice(0, 90)}`);
        }
        if (regions.length > 1) console.log(`  … ${regions.length - 1} more region(s); pass --diff for full view (first region is usually the culprit)`);
      }
    }
  }

  return { ok: true, regions, funcDrift };
}

// --diff: compare depth profile against git HEAD version (explicit mode)
if (diffMode) {
  runDiff({ quiet: false });
  hasOutput = true;
}

// Default: report errors and balance
if (!hasOutput && errors.length) {
  for (const e of errors) {
    const ln = e.line ? `line ${e.line}: ` : '';
    console.error(`ERROR: ${ln}${e.msg}`);
    if (e.text) console.error(`  ${e.text}`);
  }
  process.exit(1);
}

if (!hasOutput) {
  for (let i = 0; i < profile.length; i++) {
    const p = profile[i];
    if (Math.abs(p.after - p.before) > 6) {
      console.log(`WARN: large depth change at line ${i + 1}: ${p.before}->${p.after}`);
    }
  }
  console.log(`OK: ${lines.length} lines, balanced, labels in scope`);
  // Auto-diff vs HEAD — cheap, and catches misnesting that balances overall.
  if (!noDiff) runDiff({ quiet: true });
}
