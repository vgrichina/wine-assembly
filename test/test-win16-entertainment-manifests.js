#!/usr/bin/env node
'use strict';

// The browser cannot mount an executable's whole directory the way the CLI
// harness can.  Files that a Win16 game opens before LoadLibrary (VB custom
// controls and Stones level DLLs in particular) therefore have to appear in
// the shared app manifest as well as in win16Modules.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { APPS } = require('../lib/apps');

const ROOT = path.join(__dirname, '..');
const entries = Object.entries(APPS).filter(([id]) => id.startsWith('wep16_'));
assert.strictEqual(entries.length, 29, 'all 29 distinct Entertainment Pack games are registered');

const required = {
  wep16_rattler:  { files: ['FIELD100.DLL'], modules: ['FIELD100', 'WEPUTIL'] },
  wep16_rodent:   { files: ['FIELD100.DLL'], modules: ['FIELD100', 'WEPUTIL'] },
  wep16_stones:   {
    files: ['STONE.SAV', 'STONE00.DLL', 'STONE01.DLL', 'STONE02.DLL',
      'STONE03.DLL', 'STONE04.DLL', 'STONEE00.DLL', 'STONEE01.DLL',
      'STONEE02.DLL', 'STONEE03.DLL'],
    modules: ['WEPUTIL', 'STONE00', 'STONE01', 'STONE02', 'STONE03',
      'STONE04', 'STONEE00', 'STONEE01', 'STONEE02', 'STONEE03'],
  },
  wep16_fujigolf: { files: ['FUJIGOLF.DAT'], modules: [] },
  wep16_gofigure: {
    files: ['GAUGE.VBX', 'THREED.VBX', 'CMDIALOG.VBX'],
    modules: ['GAUGE', 'THREED', 'CMDIALOG', 'WEP4UTIL'],
  },
  wep16_tictacdp: {
    files: ['TicTacDp.brd', 'CMDIALOG.VBX', 'THREED.VBX'],
    modules: ['CMDIALOG', 'THREED'],
  },
};

for (const [id, want] of Object.entries(required)) {
  const app = APPS[id];
  assert(app, `${id} is registered`);
  const files = new Set((app.files || []).map(file => path.basename(file)));
  for (const name of want.files) assert(files.has(name), `${id} mounts ${name}`);
  assert.deepStrictEqual(app.win16Modules || [], want.modules, `${id} runtime modules`);
}

// The proprietary corpus is intentionally Git-ignored.  When it is installed,
// validate the complete local inventory and Archive.org-recovered bytes too;
// clean source checkouts still retain the manifest assertions above.
const corpus = path.join(ROOT, 'test', 'binaries', 'wep16');
if (fs.existsSync(corpus)) {
  const exes = [];
  for (const vol of fs.readdirSync(corpus)) {
    const dir = path.join(corpus, vol);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const name of fs.readdirSync(dir)) {
      if (/\.exe$/i.test(name)) exes.push(path.join(dir, name));
    }
  }
  assert.strictEqual(exes.length, 31, 'installed WEP1-WEP4 corpus contains 31 executables');

  for (const [id, app] of entries) {
    for (const rel of [app.exe, ...(app.files || [])]) {
      assert(fs.existsSync(path.join(ROOT, rel)), `${id} asset exists: ${rel}`);
    }
  }

  const recoveredHashes = {
    'WEP2/RODENT.EXE': '57b693794b83738353a3e561fb54cfb621b443a2f6375bd6814e5db06dbc6fae',
    'WEP3/FUJIGOLF.DAT': '4c8d598c737dbc995af8dc7cbb0bcd64126f488b8d55befa6f1a8d0d54861701',
    'WEP4/TICTACDP.EXE': '1cc429e6e8f9928c799b7cdf187ad41e5100a3f70e30194729ad685ea6619b2d',
    'WEP4/TicTacDp.brd': '072e63a61a16825b6483d0717d3bc9b9a2147b77107464f0551305f55411543c',
  };
  for (const [rel, want] of Object.entries(recoveredHashes)) {
    const bytes = fs.readFileSync(path.join(corpus, rel));
    const got = crypto.createHash('sha256').update(bytes).digest('hex');
    assert.strictEqual(got, want, `${rel} matches documented Internet Archive bytes`);
  }

  const sweep = execFileSync(process.execPath, [
    path.join(ROOT, 'tools', 'wep32-compare.js'),
    '--dir=test/binaries/wep16', '--batches=150', '--batch-size=20000',
  ], { cwd: ROOT, encoding: 'utf8', timeout: 300000, maxBuffer: 64 * 1024 * 1024 });
  assert.match(sweep, /31\/31 draw a screen/, 'all 31 installed executables render a screen');
  assert.doesNotMatch(sweep, /\b(?:CRASH|ERRORBOX|BLANK|NOWINDOW|NORUNTIME)\b/,
    'the complete sweep has no failed verdict');
}

console.log('PASS Win16 Entertainment Pack manifests and recovered-source hashes');
