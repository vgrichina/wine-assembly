#!/usr/bin/env node

// Materialize the desktop's executable resources as small PNGs, plus a
// manifest saying which apps have one.
//
// Usage:
//   node tools/extract-app-icons.js            write icons/apps/*.png + manifest
//   node tools/extract-app-icons.js --check    fail if anything is stale/missing
//
// Why the manifest and not just the files. A missing PNG is indistinguishable
// from a not-yet-generated one from inside the browser, so the fallback path
// has to assume the worst and download the whole executable to look for an
// icon. That is the right guess for an app the build has never seen (a dropped
// zip, a debug-only entry) and the wrong one for an app whose executable the
// build has already opened and found nothing in: quake2_demo_installer has no
// RT_GROUP_ICON at all, and the page was fetching its 39MB installer on every
// cold load to re-learn that. The manifest is the build telling the page what
// it already knows, so each app id lands in exactly one of three buckets:
//
//   icons    a PNG exists — load it, never touch the executable
//   noIcon   the executable was parsed and has no icon — use the glyph
//   runtime  preExtractIcon:false, the icon may not be redistributed — the
//            page extracts it live, so skip the PNG 404 and go straight there
//
// An id in none of the three (an imported program, a debug-only entry) keeps
// the original behaviour: try the PNG, fall back to parsing the executable.
//
// Scope is the apps the desktop *grid* can show: DESKTOP_APPS plus, on a LAN
// host, LOCAL_CANDIDATE_APPS. DEBUG_ONLY_APPS are deliberately absent — they
// appear only in the ?debug <select>, which has no images in it and so never
// asks for an icon.

'use strict';

const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const { APPS, DESKTOP_APPS, LOCAL_CANDIDATE_APPS } = require('../lib/apps');
const { extractIconRgba } = require('../lib/resources-icon');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'icons', 'apps');
const MANIFEST = path.join(ROOT, 'lib', 'app-icon-manifest.json');
const CHECK = process.argv.includes('--check');
const listed = [...DESKTOP_APPS, ...LOCAL_CANDIDATE_APPS];
const expectedNames = new Set();
const manifest = { icons: [], noIcon: [], runtime: [] };
let failures = 0;

function encodePng(icon) {
  const png = new PNG({ width: icon.w, height: icon.h });
  png.data.set(icon.pixels);
  return PNG.sync.write(png);
}

for (const [id] of listed) {
  const exe = APPS[id] && APPS[id].exe;
  if (APPS[id] && APPS[id].preExtractIcon === false) {
    console.log(`RUNTIME ICON ${id}: package license keeps extracted icon out of tracked assets`);
    manifest.runtime.push(id);
    continue;
  }
  const exePath = exe && path.join(ROOT, exe);
  if (!exePath || !fs.existsSync(exePath)) {
    console.error(`MISSING EXE  ${id}: ${exe || '(no registry entry)'}`);
    failures++;
    continue;
  }
  const icon = extractIconRgba(fs.readFileSync(exePath));
  if (!icon) {
    console.log(`NO ICON      ${id}: desktop keeps its fallback glyph`);
    manifest.noIcon.push(id);
    continue;
  }

  const name = `${encodeURIComponent(id)}.png`;
  const outputPath = path.join(OUT, name);
  const bytes = encodePng(icon);
  expectedNames.add(name);
  manifest.icons.push(id);
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

// Sorted so the file is a function of the registry and not of iteration order:
// a reordered lib/apps.js must not show up as a diff here.
for (const key of Object.keys(manifest)) manifest[key].sort();
const manifestText = JSON.stringify(manifest, null, 2) + '\n';
if (CHECK) {
  const current = fs.existsSync(MANIFEST) ? fs.readFileSync(MANIFEST, 'utf-8') : null;
  if (current !== manifestText) {
    console.error('STALE        lib/app-icon-manifest.json');
    failures++;
  }
} else {
  fs.writeFileSync(MANIFEST, manifestText);
  console.log(`WROTE        lib/app-icon-manifest.json ` +
    `(${manifest.icons.length} icons, ${manifest.noIcon.length} without one, ` +
    `${manifest.runtime.length} extracted at runtime)`);
}

if (failures) process.exit(1);
if (CHECK) {
  console.log(`PASS  ${expectedNames.size} pre-extracted desktop icons are current, ` +
    `manifest covers ${manifest.icons.length + manifest.noIcon.length + manifest.runtime.length} apps`);
}
