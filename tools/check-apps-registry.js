#!/usr/bin/env node
// Check that lib/apps.js still describes files that exist.
//
// The registry is shared now — the desktop icons and `run.js --app=<id>` read
// the same entry — so a typo'd path is no longer a browser-only annoyance that
// shows up as a 404 in the console: headless runs mount the same list. This
// walks every entry and reports what is not on disk.
//
// Exit code is 1 when an exe is missing, or when a data file is missing from
// an app that declares requiredFiles (those apps refuse to launch without a
// complete set). Missing optional data files are printed but not fatal.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { APPS } = require(path.join(ROOT, 'lib', 'apps.js'));
const { win16FileCandidates } = require(path.join(ROOT, 'lib', 'vfs-seed.js'));

const resolve = p => (path.isAbsolute(p) ? p : path.join(ROOT, p));
const urlOf = item => (typeof item === 'string' ? item : (item && item.url));

let missingExes = 0, missingRequired = 0, missingOptional = 0, apps = 0;

for (const id of Object.keys(APPS).sort()) {
  const app = APPS[id];
  apps++;
  if (!app.exe || !fs.existsSync(resolve(app.exe))) {
    console.log(`FAIL ${id}: exe not found: ${app.exe}`);
    missingExes++;
  }
  for (const spec of (app.dlls || [])) {
    // Bare names are resolved from the DLL registry at load time, not here.
    if (!spec.includes('/')) continue;
    if (!fs.existsSync(resolve(spec))) {
      console.log(`FAIL ${id}: dll not found: ${spec}`);
      missingExes++;
    }
  }
  // A `win16Modules` name is a module name, not a filename: the page fetches
  // it under each of the spellings a Win16 library ships as. A name with no
  // file behind it is a LoadLibrary that fails only in the browser — the CLI
  // reads the exe's own directory and never consults this list — which is
  // exactly the divergence this gate exists to catch.
  const exeDir = app.exe ? path.dirname(resolve(app.exe)) : null;
  for (const name of (app.win16Modules || [])) {
    if (!exeDir) continue;
    if (!win16FileCandidates(name).some(f => fs.existsSync(path.join(exeDir, f)))) {
      console.log(`FAIL ${id}: win16 module not found beside the exe: ${name}`);
      missingExes++;
    }
  }
  const missing = [];
  for (const item of (app.files || [])) {
    const url = urlOf(item);
    if (url && !fs.existsSync(resolve(url))) missing.push(url);
  }
  if (missing.length) {
    const label = app.requiredFiles ? 'FAIL' : 'warn';
    if (app.requiredFiles) missingRequired += missing.length;
    else missingOptional += missing.length;
    console.log(`${label} ${id}: ${missing.length} file(s) not found: ` +
      missing.slice(0, 6).join(', ') + (missing.length > 6 ? ` (+${missing.length - 6} more)` : ''));
  }
}

const bad = missingExes + missingRequired;
console.log(`[check-apps-registry] ${apps} apps, ${missingExes} missing exe/dll, ` +
  `${missingRequired} missing required file(s), ${missingOptional} missing optional file(s)`);
process.exit(bad ? 1 : 0);
