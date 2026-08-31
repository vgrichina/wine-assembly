#!/usr/bin/env node
// Look inside a save bundle without running the emulator.
//
//   node tools/save-bundle.js <bundle.zip>            summary + file list
//   node tools/save-bundle.js <bundle.zip> --verify   exit 1 if anything fails
//   node tools/save-bundle.js <bundle.zip> --json     machine-readable summary
//   node tools/save-bundle.js <bundle.zip> --state    dump the registry/INI keys
//   node tools/save-bundle.js <bundle.zip> --extract=DIR
//
// Reading a bundle *is* verifying it: lib/save-bundle.js checks every member's
// SHA-256 against the manifest, refuses an unlisted member, and sanitizes every
// path, before returning anything. So `--verify` is the plain read with an exit
// code attached, and every other mode has already done the same checking.

'use strict';

const fs = require('fs');
const path = require('path');
const saveBundle = require('../lib/save-bundle');

function getArg(name, fallback) {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}
const hasFlag = name => process.argv.includes(`--${name}`);

function usage(code) {
  console.error(
    'usage: node tools/save-bundle.js <bundle.zip> [--verify] [--json] [--state] ' +
    '[--extract=DIR]');
  process.exit(code);
}

function human(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function main() {
  const file = process.argv.slice(2).find(a => !a.startsWith('--'));
  if (!file) usage(2);
  if (!fs.existsSync(file)) {
    console.error(`no such bundle: ${file}`);
    process.exit(2);
  }

  let bundle;
  try {
    bundle = saveBundle.readBundle(new Uint8Array(fs.readFileSync(file)));
  } catch (e) {
    console.error(`INVALID  ${file}: ${e.message}`);
    process.exit(1);
  }

  if (hasFlag('json')) {
    console.log(JSON.stringify(
      saveBundle.inspectBundle(new Uint8Array(fs.readFileSync(file))), null, 2));
    return;
  }

  const m = bundle.manifest;
  const totalFiles = bundle.files.reduce((n, f) => n + f.data.length, 0);
  console.log(`bundle    ${path.resolve(file)}`);
  console.log(`version   ${m.version}`);
  console.log(`app       ${m.appId}`);
  console.log(`created   ${m.createdAt}`);
  console.log(`commit    ${(m.emulator || {}).commit || '(unknown)'}`);
  console.log(`globs     ${(m.patterns || []).join('  ') || '(none recorded)'}`);
  console.log(`state     ${Object.keys(bundle.registry).length} registry keys, ` +
    `${Object.keys(bundle.ini).length} INI files`);
  console.log(`files     ${bundle.files.length} (${human(totalFiles)} of save data, ` +
    `${human(bundle.bytes.length)} on disk)`);
  for (const f of bundle.files) {
    console.log(`  ${f.path.padEnd(44)} ${String(f.data.length).padStart(9)} B  ` +
      `attrs=0x${(f.attrs >>> 0).toString(16)}`);
  }

  if (hasFlag('state')) {
    console.log('\nregistry keys:');
    for (const key of Object.keys(bundle.registry).sort()) console.log(`  ${key}`);
    console.log('INI files:');
    for (const key of Object.keys(bundle.ini).sort()) console.log(`  ${key}`);
  }

  const extract = getArg('extract', null);
  if (extract) {
    for (const f of bundle.files) {
      // f.member already passed the sanitizer in readBundle: it is relative,
      // has no `..` and no drive marker, so joining it under DIR is safe.
      const out = path.join(extract, ...f.member.split('/'));
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, Buffer.from(f.data));
    }
    const manifestOut = path.join(extract, 'manifest.json');
    fs.writeFileSync(manifestOut, JSON.stringify(m, null, 2) + '\n');
    fs.writeFileSync(path.join(extract, 'registry.json'),
      JSON.stringify(bundle.registry, null, 2) + '\n');
    fs.writeFileSync(path.join(extract, 'ini.json'),
      JSON.stringify(bundle.ini, null, 2) + '\n');
    console.log(`\nextracted ${bundle.files.length} files to ${path.resolve(extract)}`);
  }

  if (hasFlag('verify')) console.log('\nOK: every member matched its manifest hash');
}

main();
