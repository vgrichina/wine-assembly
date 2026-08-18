#!/usr/bin/env node
// Locate, print, or delete a whole `(func $name ...)` in a WAT part, counting
// parens the way the compiler does (string literals and `;;` comments do not
// nest). Hand-deleting a 60-line function by line number is how a stray paren
// gets left behind, and the compiler happily accepts a surplus ')' that closes
// the *next* function early.
//
// Usage:
//   node tools/wat-func.js <file.wat> <name>            # print it with line numbers
//   node tools/wat-func.js <file.wat> <name> --refs     # count references project-wide
//   node tools/wat-func.js <file.wat> <name> --delete   # remove it (refuses if referenced)
'use strict';

const fs = require('fs');
const path = require('path');

const [, , file, rawName, ...flags] = process.argv;
if (!file || !rawName) {
  console.error('usage: node tools/wat-func.js <file.wat> <name> [--refs|--delete] [--force]');
  process.exit(2);
}
const name = rawName.startsWith('$') ? rawName.slice(1) : rawName;
const DELETE = flags.includes('--delete');
const FORCE = flags.includes('--force');

const src = fs.readFileSync(file, 'utf8');

// The definition's opening paren.
const defRe = new RegExp(`\\(func\\s+\\$${name}(?![A-Za-z0-9_$])`);
const m = defRe.exec(src);
if (!m) {
  console.error(`no (func $${name} ...) in ${file}`);
  process.exit(1);
}
const start = m.index;

let depth = 0, end = -1;
for (let i = start; i < src.length; i++) {
  const c = src[i];
  if (c === '"') { while (++i < src.length && src[i] !== '"') if (src[i] === '\\') i++; continue; }
  if (c === ';' && src[i + 1] === ';') { while (i < src.length && src[i] !== '\n') i++; continue; }
  if (c === '(') depth++;
  else if (c === ')') { depth--; if (depth === 0) { end = i + 1; break; } }
}
if (end < 0) { console.error(`unbalanced parens after (func $${name}`); process.exit(1); }

const startLine = src.slice(0, start).split('\n').length;
const endLine = src.slice(0, end).split('\n').length;

// Preceding comment block belongs to the function.
const lines = src.split('\n');
let docStart = startLine;
while (docStart > 1 && /^\s*;;/.test(lines[docStart - 2])) docStart--;

// References anywhere in src/ (the definition itself is one of them). A name
// mentioned in a `;;` comment is prose, not a call — counting it would block
// deleting exactly the functions whose replacement explains what they were.
function stripComments(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { const s = i; while (++i < text.length && text[i] !== '"') if (text[i] === '\\') i++; out += text.slice(s, i + 1); continue; }
    if (c === ';' && text[i + 1] === ';') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue; }
    out += c;
  }
  return out;
}
const SRC = path.join(__dirname, '..', 'src');
let refs = 0;
for (const f of fs.readdirSync(SRC).filter(f => f.endsWith('.wat'))) {
  const text = stripComments(fs.readFileSync(path.join(SRC, f), 'utf8'));
  const re = new RegExp(`\\$${name}(?![A-Za-z0-9_$])`, 'g');
  while (re.exec(text)) refs++;
}
const exported = new RegExp(`\\(export\\s+"[^"]*"\\)`).test(src.slice(start, Math.min(end, start + 400)))
  && /\(export/.test(src.slice(start, start + 400));

if (!DELETE) {
  console.log(`${path.basename(file)}:${docStart}-${endLine}  $${name}  (${endLine - docStart + 1} lines, ${refs - 1} reference${refs - 1 === 1 ? '' : 's'}${exported ? ', EXPORTED' : ''})`);
  if (!flags.includes('--refs')) {
    for (let i = docStart; i <= endLine; i++) console.log(`${i}\t${lines[i - 1]}`);
  }
  process.exit(0);
}

if (refs > 1 && !FORCE) {
  console.error(`$${name} still has ${refs - 1} reference(s); refusing to delete (use --force).`);
  process.exit(1);
}
if (exported && !FORCE) {
  console.error(`$${name} is exported; refusing to delete (use --force).`);
  process.exit(1);
}

const cutFrom = lines.slice(0, docStart - 1).join('\n').length + (docStart > 1 ? 1 : 0);
let cutTo = end;
while (cutTo < src.length && src[cutTo] === '\n') cutTo++;  // trailing blank line
fs.writeFileSync(file, src.slice(0, cutFrom) + src.slice(cutTo));
console.log(`deleted $${name} from ${path.basename(file)} (lines ${docStart}-${endLine})`);
