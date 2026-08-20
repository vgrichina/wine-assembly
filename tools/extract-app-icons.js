#!/usr/bin/env node

// Materialize the desktop's executable resources as small PNGs. The browser
// loads these first and falls back to downloading/parsing an EXE only when the
// matching PNG does not exist.

'use strict';

const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const { APPS, DESKTOP_APPS, LOCAL_CANDIDATE_APPS } = require('../lib/apps');
const { extractIconRgba } = require('../lib/resources-icon');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'icons', 'apps');
const CHECK = process.argv.includes('--check');
const listed = [...DESKTOP_APPS, ...LOCAL_CANDIDATE_APPS];
const expectedNames = new Set();
let failures = 0;

function encodePng(icon) {
  const png = new PNG({ width: icon.w, height: icon.h });
  png.data.set(icon.pixels);
  return PNG.sync.write(png);
}

for (const [id] of listed) {
  const exe = APPS[id] && APPS[id].exe;
  const exePath = exe && path.join(ROOT, exe);
  if (!exePath || !fs.existsSync(exePath)) {
    console.error(`MISSING EXE  ${id}: ${exe || '(no registry entry)'}`);
    failures++;
    continue;
  }
  const icon = extractIconRgba(fs.readFileSync(exePath));
  if (!icon) {
    console.log(`NO ICON      ${id}: browser will use its EXE fallback`);
    continue;
  }

  const name = `${encodeURIComponent(id)}.png`;
  const outputPath = path.join(OUT, name);
  const bytes = encodePng(icon);
  expectedNames.add(name);
  if (CHECK) {
    const current = fs.existsSync(outputPath) ? fs.readFileSync(outputPath) : null;
    if (!current || !current.equals(bytes)) {
      console.error(`STALE        icons/apps/${name}`);
      failures++;
    }
  } else {
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(outputPath, bytes);
    console.log(`WROTE        icons/apps/${name} (${icon.w}x${icon.h}, ${bytes.length} bytes)`);
  }
}

if (fs.existsSync(OUT)) {
  for (const name of fs.readdirSync(OUT).filter(name => name.endsWith('.png'))) {
    if (!expectedNames.has(name)) {
      console.error(`STALE        icons/apps/${name} (not a desktop app with an extractable icon)`);
      failures++;
    }
  }
}

if (failures) process.exit(1);
if (CHECK) console.log(`PASS  ${expectedNames.size} pre-extracted desktop icons are current`);
