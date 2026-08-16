#!/usr/bin/env node
// gen_win16_ordinals.js — build src/win16-ordinals.generated.json, the
// ordinal-to-name map for the Win16 modules our NE apps import from.
//
//   node tools/gen_win16_ordinals.js [--check]
//
// Every Win16 import is by ordinal, so a trace or a trap that says "module 1
// ordinal 91" names nothing useful. This turns the real modules' own export
// tables into the map that makes it say KERNEL.91 INITTASK instead.
//
// The names live in JSON rather than in WAT on purpose. They are for humans:
// dispatch keys off (module, ordinal) numerically and never needs a string, so
// putting ~1,500 names in the module would cost bytes in every build to no
// runtime end. This mirrors src/api_table.json, which is likewise JSON read by
// the JS tracing layer.
//
// The source modules are gitignored local fixtures — stock Windows install
// files, see test/binaries/dlls/SOURCES.md for provenance and the extraction
// recipe. The generated JSON holds only names and ordinals and is committed,
// so nothing downstream needs the binaries.
//
// --check regenerates in memory and fails if the committed file differs, so CI
// can prove the map still matches the modules it claims to come from.

const fs = require('fs');
const path = require('path');
const { readExports } = require('./ne-exports.js');

const ROOT = path.join(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'scratch', 'win16-system');
const OUT = path.join(ROOT, 'src', 'win16-ordinals.generated.json');

// The file each module ships as. A Win16 module name is not its filename —
// SOUND ships as mmsound.drv — so the module name is read out of each file
// rather than assumed from it, and mismatches are an error.
const MODULES = [
  { module: 'KERNEL',   file: 'krnl386.exe' },
  { module: 'USER',     file: 'user.exe' },
  { module: 'GDI',      file: 'gdi.exe' },
  { module: 'KEYBOARD', file: 'keyboard.drv' },
  { module: 'SOUND',    file: 'mmsound.drv' },
  { module: 'SHELL',    file: 'shell.dll' },
  { module: 'MMSYSTEM', file: 'mmsystem.dll' },
  { module: 'COMMDLG',  file: 'commdlg.dll' },
  { module: 'DDEML',    file: 'ddeml.dll' },
  // CARDS is not a system module: it ships with the card games and is a
  // tracked test binary, so this one entry needs no local fixture at all.
  { module: 'CARDS',    file: 'CARDS.DLL', dir: path.join(ROOT, 'test', 'binaries', 'win98-16bit') },
];

function build() {
  const out = { modules: {} };
  const missing = [];
  for (const { module: name, file, dir } of MODULES) {
    const full = path.join(dir || SRC_DIR, file);
    if (!fs.existsSync(full)) { missing.push(file); continue; }
    const info = readExports(full);
    if (info.module !== name) {
      throw new Error(`${file}: module name is ${info.module}, expected ${name} — ` +
        `either the wrong file or the alias changed`);
    }
    const ordinals = {};
    for (const [ordinal, rec] of [...info.named.entries()].sort((a, b) => a[0] - b[0])) {
      ordinals[ordinal] = rec.name;
    }
    out.modules[name] = { file, description: info.description, ordinals };
  }
  if (missing.length) {
    throw new Error(`missing local fixtures in scratch/win16-system: ${missing.join(', ')}\n` +
      `See test/binaries/dlls/SOURCES.md for the ISO and the extraction recipe.`);
  }
  return out;
}

function main() {
  const check = process.argv.includes('--check');
  let built;
  try {
    built = build();
  } catch (e) {
    if (check && /missing local fixtures/.test(e.message)) {
      // A checkout without the fixtures cannot verify the map, and that is not
      // a failure — the committed JSON is the artifact everything else uses.
      console.log('[gen_win16_ordinals] source modules absent, skipping check');
      return;
    }
    console.error(`[gen_win16_ordinals] ${e.message}`);
    process.exit(1);
  }

  const text = JSON.stringify(built, null, 1) + '\n';
  const total = Object.values(built.modules).reduce((n, m) => n + Object.keys(m.ordinals).length, 0);

  if (check) {
    const have = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (have !== text) {
      console.error('[gen_win16_ordinals] src/win16-ordinals.generated.json is stale — rerun without --check');
      process.exit(1);
    }
    console.log(`[gen_win16_ordinals] OK ${total} names across ${Object.keys(built.modules).length} modules`);
    return;
  }

  fs.writeFileSync(OUT, text);
  console.log(`[gen_win16_ordinals] wrote ${path.relative(ROOT, OUT)} — ` +
    `${total} names across ${Object.keys(built.modules).length} modules`);
}

main();
