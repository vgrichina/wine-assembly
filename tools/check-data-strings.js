#!/usr/bin/env node
// Gate: every hardcoded data-segment address that a lookup table uses still
// points at the string its comment claims.
//
// The ordinal-import tables (src/08b-dll-loader.wat) address 01-header.wat's
// string constants by absolute offset — `(call $lookup_api_id (i32.const
// 0x1130C)) ;; WSAStartup`. Inserting or lengthening any earlier string shifts
// every later offset, and the only symptom is an ordinal resolving to the wrong
// API at runtime, in one app, much later. The trailing comments already state
// the intent; this checks the code against them.
//
// Usage: node tools/check-data-strings.js [--list]
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

// Milestone 6 moved these segments and their use sites to the region-relative
// spelling — `(data (region.addr $ORDINAL_NAMES_WSOCK32 0x0C) "…")` and
// `(call $lookup_api_id (region.addr $ORDINAL_NAMES_WSOCK32 0x0C)) ;; WSAStartup`.
// Both forms have to resolve here or this gate quietly stops seeing the very
// tables it exists for: at the conversion commit the raw-literal reader alone
// went from 46 checked sites to 8. The bases come from the generated mirror of
// src/00-regions.wat, so this tool holds no copy of the map.
const { REGIONS } = require('../lib/region-map.generated');

// `(region.addr $NAME 0x40)` -> absolute address, or null for an unknown region.
function regionAddr(name, off) {
  const r = REGIONS[name];
  if (!r) return null;
  return r.base + off;
}

// ── Build addr -> string map from every (data (i32.const N) "...") segment ──
function parseDataSegments(text) {
  const strings = new Map(); // addr -> string starting there
  const re = /\(data\s+\((?:i32\.const\s+(0x[0-9a-fA-F]+|\d+)|region\.addr\s+\$([A-Za-z0-9_]+)\s+(0x[0-9a-fA-F]+|\d+))\)/g;
  let m;
  while ((m = re.exec(text))) {
    let base;
    if (m[1] !== undefined) {
      base = m[1].startsWith('0x') ? parseInt(m[1], 16) : Number(m[1]);
    } else {
      const off = m[3].startsWith('0x') ? parseInt(m[3], 16) : Number(m[3]);
      base = regionAddr(m[2], off);
      // An undeclared region is the compiler's error to report, not this
      // gate's — skip the segment rather than indexing it at NaN.
      if (base === null) continue;
    }
    // Concatenate every quoted chunk until the segment's closing paren.
    const bytes = [];
    let i = re.lastIndex;
    let depth = 1;
    while (i < text.length && depth > 0) {
      const ch = text[i];
      if (ch === '"') {
        let j = i + 1;
        while (j < text.length && text[j] !== '"') {
          if (text[j] === '\\' && /[0-9a-fA-F]{2}/.test(text.slice(j + 1, j + 3))) {
            bytes.push(parseInt(text.slice(j + 1, j + 3), 16));
            j += 3;
          } else if (text[j] === '\\') {
            const esc = { n: 10, t: 9, r: 13, '"': 34, "'": 39, '\\': 92 }[text[j + 1]];
            bytes.push(esc === undefined ? text.charCodeAt(j + 1) : esc);
            j += 2;
          } else {
            bytes.push(text.charCodeAt(j));
            j += 1;
          }
        }
        i = j + 1;
        continue;
      }
      if (ch === ';' && text[i + 1] === ';') { while (i < text.length && text[i] !== '\n') i++; continue; }
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      i++;
    }
    let start = 0;
    for (let k = 0; k < bytes.length; k++) {
      if (bytes[k] !== 0) continue;
      strings.set(base + start, String.fromCharCode(...bytes.slice(start, k)));
      start = k + 1;
    }
    if (start < bytes.length) strings.set(base + start, String.fromCharCode(...bytes.slice(start)));
  }
  return strings;
}

let strings = new Map();
for (const f of fs.readdirSync(SRC).filter(f => f.endsWith('.wat'))) {
  const found = parseDataSegments(fs.readFileSync(path.join(SRC, f), 'utf8'));
  for (const [addr, s] of found) if (!strings.has(addr)) strings.set(addr, s);
}

// ── Check every annotated string-address use ────────────────────────────────
// Matches: (call $lookup_api_id (i32.const 0x1130C)) ... ;; WSAStartup
const SITE = /\$(lookup_api_id|str_eq|dll_name_match|str_eq_ci)\b[^;\n]*\((?:i32\.const\s+(0x[0-9a-fA-F]+)|region\.addr\s+\$([A-Za-z0-9_]+)\s+(0x[0-9a-fA-F]+|\d+))\)/;
const COMMENT = /;;\s*([A-Za-z_][A-Za-z0-9_@.]*)\s*$/;

const LIST = process.argv.includes('--list');
let checked = 0, bad = 0;

for (const file of fs.readdirSync(SRC).filter(f => f.endsWith('.wat')).sort()) {
  const lines = fs.readFileSync(path.join(SRC, file), 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const site = SITE.exec(line);
    if (!site) continue;
    const comment = COMMENT.exec(line);
    if (!comment) continue;
    let addr;
    if (site[2] !== undefined) {
      addr = parseInt(site[2], 16);
    } else {
      const off = site[4].startsWith('0x') ? parseInt(site[4], 16) : Number(site[4]);
      addr = regionAddr(site[3], off);
      if (addr === null) continue;
    }
    const want = comment[1];
    const got = strings.get(addr);
    checked++;
    if (got === undefined) {
      // Only flag addresses that fall inside a segment we actually parsed —
      // a const in an unparsed range is not evidence of anything.
      const inRange = [...strings.keys()].some(a => a <= addr && addr < a + 256);
      if (!inRange) continue;
      console.error(`ERROR: ${file}:${i + 1}  0x${addr.toString(16).toUpperCase()} is not a string start ` +
        `(comment says "${want}")`);
      bad++;
    } else if (got !== want) {
      console.error(`ERROR: ${file}:${i + 1}  0x${addr.toString(16).toUpperCase()} holds "${got}" ` +
        `but the comment says "${want}" — a data-segment string was inserted or resized above it.`);
      bad++;
    } else if (LIST) {
      console.log(`ok  ${file}:${i + 1}  0x${addr.toString(16).toUpperCase()} "${got}"`);
    }
  }
}

if (bad) {
  console.error(`${bad} of ${checked} annotated string addresses are wrong.`);
  process.exit(1);
}
console.log(`data strings OK: ${checked} annotated addresses match their comments (${strings.size} strings indexed).`);
