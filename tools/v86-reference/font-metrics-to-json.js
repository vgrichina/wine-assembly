#!/usr/bin/env node

'use strict';

// Turn the COM1 output of probes/font-metrics.c into the pinned reference
// test/fixtures/font-metrics.json.
//
//   node tools/v86-reference/capture.js --manifest tools/v86-reference/font-apps.json \
//     --app font-metrics --online --output /tmp/fontmet.png --serial-output /tmp/fontmet.txt
//   node tools/v86-reference/font-metrics-to-json.js /tmp/fontmet.txt
//
// The provenance block carries the hashes of the probe source, the built
// probe, and the serial capture, so a reference that drifted from the probe
// that produced it is detectable rather than merely suspicious.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const SOURCE = path.join(ROOT, 'tools', 'v86-reference', 'probes', 'font-metrics.c');
const EXE = path.join(ROOT, '.cache', 'v86-reference', 'font-metrics.exe');
const OUT = path.join(ROOT, 'test', 'fixtures', 'font-metrics.json');

const input = process.argv[2];
if (!input) {
  console.error('usage: node tools/v86-reference/font-metrics-to-json.js <serial.txt> [out.json]');
  process.exit(2);
}
const output = process.argv[3] || OUT;

const sha256 = file => (fs.existsSync(file)
  ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  : null);

const text = fs.readFileSync(input, 'latin1');
const lines = text.split(/\r?\n/);

const strings = [];
const faces = [];
let face = null;
let sawEnd = false;

for (const line of lines) {
  if (!line) continue;
  const parts = line.split(' ');
  const kind = parts[0];
  if (kind === 'STRINGS') continue;
  if (kind === 'END') { sawEnd = true; continue; }
  if (kind === 'FACE') {
    face = { name: parts.slice(1).join(' '), sizes: {} };
    faces.push(face);
    continue;
  }
  if (/^\d+$/.test(kind) && face === null) {
    strings[Number(kind)] = parts.slice(1).join(' ');
    continue;
  }
  if (!face) continue;
  const request = Number(parts[1]);
  const size = face.sizes[request] || (face.sizes[request] = {});
  if (kind === 'ACTUAL') {
    size.actualFace = parts.slice(2).join(' ');
  } else if (kind === 'TM') {
    const n = parts.slice(2).map(Number);
    [
      size.tmHeight, size.tmAscent, size.tmDescent, size.tmInternalLeading,
      size.tmExternalLeading, size.tmAveCharWidth, size.tmMaxCharWidth,
      size.tmWeight, size.tmOverhang, size.tmItalic, size.tmUnderlined,
      size.tmStruckOut, size.tmFirstChar, size.tmLastChar, size.tmDefaultChar,
      size.tmBreakChar, size.tmPitchAndFamily, size.tmCharSet,
    ] = n;
  } else if (kind === 'CW') {
    size.charWidths = parts.slice(2).map(Number);
  } else if (kind === 'EX') {
    const [cx, cy, index] = parts.slice(2).map(Number);
    (size.extents || (size.extents = []))[index] = [cx, cy];
  }
}

if (!sawEnd) {
  console.error('capture did not reach END — the probe was cut short, refusing to pin it');
  process.exit(1);
}
if (!faces.length) {
  console.error('capture contains no faces');
  process.exit(1);
}

const reference = {
  provenance: {
    kind: 'native-windows-98-reference',
    source: 'tools/v86-reference/probes/font-metrics.c',
    capturedAt: new Date().toISOString(),
    probeSourceSha256: sha256(SOURCE),
    probeExeSha256: sha256(EXE),
    serialOutputSha256: crypto.createHash('sha256').update(text, 'latin1').digest('hex'),
    note: 'GetTextMetricsA, GetCharWidthA(0x20..0x7E) and GetTextExtentPoint32A '
      + 'read from real Windows 98 GDI through CreateFontA on a screen DC. '
      + 'Negative requested heights are character height, positive ones are '
      + 'total cell height; both are captured because GDI resolves them to '
      + 'different ppem even when they land on the same cell.',
  },
  strings,
  faces: faces.map(entry => ({
    name: entry.name,
    sizes: Object.fromEntries(Object.entries(entry.sizes)
      .sort(([a], [b]) => Number(b) - Number(a))),
  })),
};

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(reference, null, 2)}\n`);
const sizes = faces.reduce((total, entry) => total + Object.keys(entry.sizes).length, 0);
console.log(`Wrote ${output}: ${faces.length} faces, ${sizes} size records`);
