#!/usr/bin/env node

'use strict';

// Convert the COM1 output from probes/gdi-font-outline.c into a compact,
// reviewable Win98 contract fixture. The large bitmap/outline payloads are
// represented by hashes plus byte ranges; API-shape tests do not need to
// duplicate every captured byte in source control.
//
//   node tools/v86-reference/gdi-font-outline-to-json.js \
//     /tmp/gdi-font-outline.serial /tmp/gdi-font-outline.json

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SOURCE = path.join(__dirname, 'probes', 'gdi-font-outline.c');
const EXE = path.join(ROOT, '.cache', 'v86-reference', 'gdi-font-outline.exe');
const OUT = path.join(ROOT, 'test', 'fixtures', 'gdi-font-outline-win98.json');

const serialPath = process.argv[2];
const metadataPath = process.argv[3];
const outputPath = process.argv[4] || OUT;
if (!serialPath) {
  console.error('usage: node tools/v86-reference/gdi-font-outline-to-json.js '
    + '<serial.txt> [capture-metadata.json] [out.json]');
  process.exit(2);
}

const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
const parseFields = line => Object.fromEntries(line.split(' ').slice(1).map(field => {
  const at = field.indexOf('=');
  return [field.slice(0, at), field.slice(at + 1)];
}));
const parseMetrics = value => value.split(',').map(Number);

const serial = fs.readFileSync(serialPath);
const lines = serial.toString('latin1').split(/\r?\n/);
const cases = [];
const pairs = [];
const placements = [];
let face = null;
let kerning = null;
let current = null;
let sawHeader = false;
let sawDone = false;

for (const line of lines) {
  if (!line) continue;
  if (line === 'GDI_FONT_OUTLINE_V1') { sawHeader = true; continue; }
  if (line === 'GDI_FONT_OUTLINE_DONE') { sawDone = true; continue; }
  if (line.startsWith('FACE ')) {
    const fields = parseFields(line);
    face = { requested: fields.requested, selected: fields.selected, height: Number(fields.height) };
  } else if (line.startsWith('CASE ')) {
    const fields = parseFields(line);
    current = {
      character: Number(fields.char),
      format: Number(fields.format),
      matrix: fields.matrix,
      needed: Number(fields.needed),
      metrics: parseMetrics(fields.metrics),
    };
  } else if (line.startsWith('RESULT ')) {
    if (!current) throw new Error('RESULT without CASE');
    const fields = parseFields(line);
    const bytes = Buffer.from(fields.data, 'hex');
    current.result = Number(fields.bytes);
    current.resultMetrics = parseMetrics(fields.metrics);
    current.dataSha256 = sha256(bytes);
    current.dataMax = bytes.length ? Math.max(...bytes) : 0;
  } else if (line === 'ENDCASE') {
    if (!current) throw new Error('ENDCASE without CASE');
    cases.push(current);
    current = null;
  } else if (line.startsWith('KERN ')) {
    const fields = parseFields(line);
    kerning = { total: Number(fields.total), copied: Number(fields.copied), pairs };
  } else if (line.startsWith('PAIR ')) {
    const fields = parseFields(line);
    pairs.push({
      first: Number(fields.first),
      second: Number(fields.second),
      found: fields.found === '1',
      amount: Number(fields.amount),
    });
  } else if (line.startsWith('GCP ')) {
    const fields = parseFields(line);
    placements.push({
      text: fields.text,
      flags: Number(fields.flags),
      packed: Number(fields.packed),
      glyphs: Number(fields.glyphs),
      dx: fields.dx ? fields.dx.split(',').map(Number) : [],
      caret: fields.caret ? fields.caret.split(',').map(Number) : [],
    });
  }
}

if (!sawHeader || !sawDone || current || !face || !kerning || !cases.length) {
  throw new Error('incomplete Win98 glyph-outline capture; refusing to pin it');
}

let metadata = null;
if (metadataPath) metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
const fixture = {
  provenance: {
    kind: 'native-windows-98-reference',
    source: 'tools/v86-reference/probes/gdi-font-outline.c',
    capturedAt: metadata ? metadata.capturedAt : null,
    probeSourceSha256: sha256(fs.readFileSync(SOURCE)),
    probeExeSha256: fs.existsSync(EXE) ? sha256(fs.readFileSync(EXE)) : null,
    serialOutputSha256: sha256(serial),
    screenshotSha256: metadata ? metadata.screenshotSha256 : null,
    v86: metadata ? metadata.v86 : null,
    note: 'Captured from real Windows 98 GDI with Arial selected into a memory DC. '
      + 'GGO gray bytes use inclusive maxima; GGO_BEZIER is rejected by Win98.',
  },
  face,
  cases,
  kerning,
  placements,
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`Wrote ${outputPath}: ${cases.length} outline cases, ${pairs.length} kern pairs, `
  + `${placements.length} placement cases`);
