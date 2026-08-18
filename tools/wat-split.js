#!/usr/bin/env node
// Move a contiguous run of top-level forms out of one WAT part into another.
//
// The build is a concatenation, so splitting a file is semantically free — but
// only if the cut lands on real form boundaries. This counts parens the way the
// compiler does (string literals and `;;` comments do not nest), takes each
// form's leading comment block with it, and refuses anything it cannot verify.
//
// Usage:
//   node tools/wat-split.js --from=src/10-helpers.wat --to=src/10d-gdi-region.wat \
//        --first=gdi_rgn_record --last=gdi_rgn_free [--header="TEXT"] [--dry-run]
//
// After moving, add the new file to WAT_FILES in lib/compile-wat.js —
// tools/check-wat-manifest.js fails the build until you do.
'use strict';

const fs = require('fs');

const args = process.argv.slice(2);
const arg = (name, def) => {
  const hit = args.find(a => a.startsWith(`--${name}=`));
  return hit === undefined ? def : hit.slice(name.length + 3);
};
const FROM = arg('from');
const TO = arg('to');
const FIRST = arg('first');
const LAST = arg('last');
// --names=a,b,c moves a *set* of functions rather than a contiguous range.
// Scattered families (09a's menu handlers sit in a dozen places) cannot be
// expressed as first/last, and moving them one call at a time would rewrite the
// file a dozen times.
const NAMES = (arg('names', '') || '').split(',').map(x => x.trim()).filter(Boolean);
const HEADER = arg('header', '');
const DRY = args.includes('--dry-run');

if (!FROM || !TO || (!NAMES.length && (!FIRST || !LAST))) {
  console.error('usage: wat-split.js --from=A.wat --to=B.wat ' +
    '(--first=funcName --last=funcName | --names=a,b,c) [--header="TEXT"] [--dry-run]');
  process.exit(2);
}

const src = fs.readFileSync(FROM, 'utf8');
const lines = src.split('\n');

// Index every top-level form: its start offset, end offset, and name.
//
// Depth-from-zero does not work here: a part may close forms opened by an
// earlier part, so the running depth goes negative partway through several
// files. What is reliable is the layout every part follows — a top-level form
// starts at column 2 — so anchor on that and paren-match from there.
function topLevelForms(text) {
  const forms = [];
  const re = /^  \((func|global|data|elem|table|memory|type|import|export|start)\b/gm;
  let m;
  while ((m = re.exec(text))) {
    const start = m.index + 2;
    let depth = 0, end = -1;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (c === '"') { while (++i < text.length && text[i] !== '"') if (text[i] === '\\') i++; continue; }
      if (c === ';' && text[i + 1] === ';') { while (i < text.length && text[i] !== '\n') i++; continue; }
      if (c === '(') depth++;
      else if (c === ')') { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    if (end < 0) continue;
    const head = text.slice(start, Math.min(start + 200, end));
    const nm = /^\(\s*(\w[\w.]*)\s+(\$[A-Za-z0-9_$]+)?/.exec(head);
    forms.push({ start, end, kind: m[1], name: nm && nm[2] ? nm[2].slice(1) : null });
  }
  return forms;
}

const forms = topLevelForms(src);

// A form plus the comment block directly above it, as a [start, end) slice.
function sliceOf(form) {
  const linesAll = src.split('\n');
  const lineOfOff = off => src.slice(0, off).split('\n').length;
  let startLine = lineOfOff(form.start);
  while (startLine > 1 && /^\s*;;/.test(linesAll[startLine - 2])) startLine--;
  const start = linesAll.slice(0, startLine - 1).join('\n').length + (startLine > 1 ? 1 : 0);
  let end = form.end;
  while (end < src.length && (src[end] === '\n' || src[end] === ' ')) end++;
  return { start, end, startLine, endLine: lineOfOff(form.end) };
}

if (NAMES.length) {
  const picked = [];
  for (const n of NAMES) {
    const f = forms.find(x => x.name === n);
    if (!f) { console.error(`no top-level form named $${n} in ${FROM}`); process.exit(1); }
    picked.push({ name: n, ...sliceOf(f) });
  }
  picked.sort((a, b) => a.start - b.start);
  const movedText = picked.map(p => src.slice(p.start, p.end).replace(/\s+$/, '')).join('\n\n');
  console.log(`${FROM} -> ${TO}`);
  console.log(`  ${picked.length} named forms, ${movedText.split('\n').length} lines`);
  for (const p of picked) console.log(`    $${p.name}  (lines ${p.startLine}-${p.endLine})`);
  if (DRY) process.exit(0);

  // Cut from the end so earlier offsets stay valid.
  let out = src;
  for (const p of [...picked].reverse()) out = out.slice(0, p.start) + out.slice(p.end);
  const hdr = HEADER ? `  ;; ============================================================\n` +
    HEADER.split('\n').map(l => `  ;; ${l}`).join('\n') +
    `\n  ;; ============================================================\n\n` : '';
  const existing = fs.existsSync(TO) ? fs.readFileSync(TO, 'utf8').replace(/\s+$/, '') + '\n\n' : '';
  fs.writeFileSync(TO, existing + hdr + movedText + '\n');
  fs.writeFileSync(FROM, out);
  console.log(`  appended to ${TO}, ${FROM} is now ${out.split('\n').length} lines`);
  console.log('  remember: add the new file to WAT_FILES in lib/compile-wat.js');
  process.exit(0);
}

const firstIdx = forms.findIndex(f => f.name === FIRST);
const lastIdx = forms.findIndex(f => f.name === LAST);
if (firstIdx < 0) { console.error(`no top-level form named $${FIRST} in ${FROM}`); process.exit(1); }
if (lastIdx < 0) { console.error(`no top-level form named $${LAST} in ${FROM}`); process.exit(1); }
if (lastIdx < firstIdx) { console.error('--last comes before --first'); process.exit(1); }

// Take the comment block immediately above the first form with it.
const lineOf = off => src.slice(0, off).split('\n').length;
let startLine = lineOf(forms[firstIdx].start);
while (startLine > 1 && /^\s*;;/.test(lines[startLine - 2])) startLine--;
const cutStart = lines.slice(0, startLine - 1).join('\n').length + (startLine > 1 ? 1 : 0);
let cutEnd = forms[lastIdx].end;
while (cutEnd < src.length && (src[cutEnd] === '\n' || src[cutEnd] === ' ')) cutEnd++;

const moved = src.slice(cutStart, cutEnd);
const movedNames = forms.slice(firstIdx, lastIdx + 1).map(f => f.name).filter(Boolean);

console.log(`${FROM} -> ${TO}`);
console.log(`  ${movedNames.length} forms, lines ${startLine}-${lineOf(forms[lastIdx].end)} ` +
  `(${moved.split('\n').length} lines)`);
console.log(`  first: $${movedNames[0]}   last: $${movedNames[movedNames.length - 1]}`);
if (DRY) process.exit(0);

const header = HEADER ? `  ;; ============================================================\n` +
  HEADER.split('\n').map(l => `  ;; ${l}`).join('\n') +
  `\n  ;; ============================================================\n\n` : '';

fs.writeFileSync(TO, header + moved.replace(/\s+$/, '') + '\n');
fs.writeFileSync(FROM, src.slice(0, cutStart) + src.slice(cutEnd));
console.log(`  wrote ${TO}, ${FROM} is now ${fs.readFileSync(FROM, 'utf8').split('\n').length} lines`);
console.log('  remember: add the new file to WAT_FILES in lib/compile-wat.js');
