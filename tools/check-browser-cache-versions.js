#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RUNTIME_FILES = [
  'index.html',
  'host.js',
  'lib/guest-worker.js',
  'lib/d3d-command-stream.js',
];

function lineAt(text, index) {
  return text.slice(0, index).split('\n').length;
}

function normalizeAsset(sourceFile, rawUrl) {
  const value = String(rawUrl).replace(/\\/g, '/');
  if (/^(?:[a-z]+:)?\/\//i.test(value) || /^(?:data|blob):/i.test(value)) return null;
  const pathname = value.split(/[?#]/, 1)[0];
  if (!pathname) return null;
  if (pathname.startsWith('/')) return path.posix.normalize(pathname.slice(1));
  return path.posix.normalize(path.posix.join(path.posix.dirname(sourceFile), pathname));
}

function readRuntimeFiles(root = ROOT) {
  const files = new Map();
  for (const name of RUNTIME_FILES) {
    files.set(name, fs.readFileSync(path.join(root, name), 'utf8'));
  }
  return files;
}

function readTestFiles(root = ROOT) {
  const files = new Map();
  for (const entry of fs.readdirSync(path.join(root, 'test'), { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
    const name = `test/${entry.name}`;
    files.set(name, fs.readFileSync(path.join(root, name), 'utf8'));
  }
  return files;
}

function collectVersionRefs(files) {
  const refs = [];
  const quotedVersion = /(['"`])([^'"`\s]+\.js)\?v=(\d+)\1/g;
  for (const [sourceFile, text] of files) {
    let match;
    while ((match = quotedVersion.exec(text)) !== null) {
      const asset = normalizeAsset(sourceFile, match[2]);
      if (!asset) continue;
      refs.push({
        asset,
        version: match[3],
        sourceFile,
        line: lineAt(text, match.index),
      });
    }
  }
  return refs;
}

function collectScriptList(text, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(
    `\\b${escaped}\\s*=\\s*Object\\.freeze\\(\\s*\\[([\\s\\S]*?)\\]\\s*\\)`,
  ).exec(text || '');
  if (!match) return [];
  return [...match[1].matchAll(/(['"])([^'"]+\.js)\1/g)].map(item => item[2]);
}

function validateCacheVersions(files, testFiles = new Map()) {
  const errors = [];
  const refs = collectVersionRefs(files);
  for (const ref of refs) {
    errors.push(`${ref.sourceFile}:${ref.line} hand-writes ${ref.asset}?v=${ref.version}; ` +
      'browser code must inherit the one WINE_SOURCE_VERSION');
  }
  for (const [sourceFile, text] of testFiles) {
    // Match both a literal foo.js?v=9 and a regex spelling such as
    // foo\.js\?v=(\d+). Non-JS asset fixtures and inherited non-numeric
    // worker keys remain legitimate.
    const numericJsVersion = /\.js(?:\\)?\?v=(?:\(?\\d|\d)/g;
    for (let numeric; (numeric = numericJsVersion.exec(text));) {
      errors.push(`${sourceFile}:${lineAt(text, numeric.index)} re-states a numeric JavaScript ` +
        'cache key; assert membership in the shared source-version graph instead');
    }
  }

  const indexText = files.get('index.html') || '';
  const scriptTag = /<script\b[^>]*\bsrc\s*=\s*(['"])([^'"]+)\1/gi;
  let match;
  const staticScripts = [];
  while ((match = scriptTag.exec(indexText)) !== null) {
    const rawUrl = match[2];
    const asset = normalizeAsset('index.html', rawUrl);
    if (!asset || !asset.endsWith('.js')) continue;
    staticScripts.push({ asset, line: lineAt(indexText, match.index) });
  }
  if (staticScripts.length !== 1 || staticScripts[0].asset !== 'build-info.js') {
    errors.push('index.html must load exactly one static bootstrap script (build-info.js); ' +
      `found ${staticScripts.map(item => item.asset).join(', ') || 'none'}`);
  }

  const indexScripts = collectScriptList(indexText, 'WINE_RUNTIME_SCRIPTS');
  if (!indexScripts.length) errors.push('index.html has no WINE_RUNTIME_SCRIPTS source list');
  if (new Set(indexScripts).size !== indexScripts.length) {
    errors.push('WINE_RUNTIME_SCRIPTS contains a duplicate source');
  }
  if (indexScripts[0] !== 'lib/region-map.generated.js') {
    errors.push('WINE_RUNTIME_SCRIPTS must load lib/region-map.generated.js first');
  }
  if (indexScripts.filter(source => source === 'host.js').length !== 1) {
    errors.push('WINE_RUNTIME_SCRIPTS must contain host.js exactly once');
  }
  if (!indexText.includes("window.WINE_SOURCE_VERSION = String(window.WINE_BUILD || 'dev')")) {
    errors.push('index.html must derive WINE_SOURCE_VERSION from build-info.js WINE_BUILD');
  }
  if (!/wineVersionedUrl[\s\S]*encodeURIComponent\(window\.WINE_SOURCE_VERSION\)/.test(indexText) ||
      !indexText.includes('window.wineLoadVersionedScripts(WINE_RUNTIME_SCRIPTS)')) {
    errors.push('index.html runtime list is not loaded through the shared encoded source version');
  }

  let sourceAssignments = 0;
  for (const text of files.values()) {
    sourceAssignments += (text.match(/(?:window\.)?WINE_SOURCE_VERSION\s*=/g) || []).length;
  }
  if (sourceAssignments !== 1) {
    errors.push(`runtime graph must assign WINE_SOURCE_VERSION exactly once (found ${sourceAssignments})`);
  }

  const hostText = files.get('host.js') || '';
  if (!hostText.includes("static SOURCE_VERSION = String(globalThis.WINE_SOURCE_VERSION || 'dev')")) {
    errors.push('host.js SOURCE_VERSION must consume the page-owned WINE_SOURCE_VERSION');
  }
  for (const asset of [
    'src/api_table.json', 'build/wine-assembly.wasm',
    'lib/host-import-sigs.generated.json', 'lib/guest-worker.js',
    'lib/watx-compile-worker.js',
    'fonts/substitutions.json',
  ]) {
    if (!hostText.includes(`WineAssembly.versionedUrl('${asset}')`) &&
        !(asset === 'build/wine-assembly.wasm' &&
          hostText.includes('WineAssembly.versionedUrl(artifact)'))) {
      errors.push(`host.js does not route ${asset} through WineAssembly.versionedUrl`);
    }
  }

  const workerText = files.get('lib/guest-worker.js') || '';
  const workerScripts = collectScriptList(workerText, 'WORKER_SCRIPTS');
  if (!workerScripts.length || workerScripts[0] !== 'region-map.generated.js') {
    errors.push('guest-worker WORKER_SCRIPTS must exist and load region-map.generated.js first');
  }
  if (!workerText.includes("new URL(self.location.href).searchParams.get('v')") ||
      !workerText.includes('importScripts(...WORKER_SCRIPTS.map(versionedWorkerUrl))')) {
    errors.push('guest-worker dependencies must inherit the cache key from its own URL');
  }
  if (!workerText.includes("workerUrl: versionedWorkerUrl('d3d-render-worker.js')")) {
    errors.push('guest-worker must pass its inherited key to d3d-render-worker.js');
  }

  const d3dText = files.get('lib/d3d-command-stream.js') || '';
  if (!/new Worker\(options\.workerUrl \|\| versionedWorkerUrl\([\s\S]*?'d3d-render-worker\.js'/.test(d3dText)) {
    errors.push('d3d-command-stream default worker URL must consume the shared source version');
  }

  return {
    errors,
    refs,
    indexScripts,
    workerScripts,
    assets: new Set([...indexScripts, ...workerScripts]).size,
    sourceVersion: 'build-info/WINE_BUILD',
  };
}

function selfTest() {
  const good = new Map([
    ['index.html', [
      '<script src="build-info.js"></script>',
      "window.WINE_SOURCE_VERSION = String(window.WINE_BUILD || 'dev');",
      'function wineVersionedUrl() { encodeURIComponent(window.WINE_SOURCE_VERSION); }',
      'const WINE_RUNTIME_SCRIPTS = Object.freeze(["lib/region-map.generated.js", "host.js"]);',
      'window.wineLoadVersionedScripts(WINE_RUNTIME_SCRIPTS);',
    ].join('\n')],
    ['host.js', [
      "static SOURCE_VERSION = String(globalThis.WINE_SOURCE_VERSION || 'dev');",
      "WineAssembly.versionedUrl('src/api_table.json');",
      "WineAssembly.versionedUrl('build/wine-assembly.wasm');",
      "WineAssembly.versionedUrl('lib/host-import-sigs.generated.json');",
      "WineAssembly.versionedUrl('lib/guest-worker.js');",
      "WineAssembly.versionedUrl('lib/watx-compile-worker.js');",
      "WineAssembly.versionedUrl('fonts/substitutions.json');",
    ].join('\n')],
    ['lib/guest-worker.js', [
      "new URL(self.location.href).searchParams.get('v');",
      'const WORKER_SCRIPTS = Object.freeze(["region-map.generated.js"]);',
      'importScripts(...WORKER_SCRIPTS.map(versionedWorkerUrl));',
      "workerUrl: versionedWorkerUrl('d3d-render-worker.js')",
    ].join('\n')],
    ['lib/d3d-command-stream.js',
      "new Worker(options.workerUrl || versionedWorkerUrl('d3d-render-worker.js', root.WINE_SOURCE_VERSION));"],
  ]);
  assert.deepStrictEqual(validateCacheVersions(good).errors, []);

  const changed = (name, from, to) => {
    const files = new Map(good);
    files.set(name, files.get(name).replace(from, to));
    return validateCacheVersions(files).errors.join('\n');
  };
  assert.match(changed('index.html', '<script src="build-info.js"></script>',
    '<script src="host.js?v=9"></script>'), /hand-writes[\s\S]*exactly one static bootstrap/);
  assert.match(changed('index.html', "window.WINE_BUILD || 'dev'", "'9'"),
    /derive WINE_SOURCE_VERSION/);
  assert.match(changed('index.html', ', "host.js"', ''), /host\.js exactly once/);
  assert.match(changed('lib/guest-worker.js', 'WORKER_SCRIPTS.map(versionedWorkerUrl)',
    'WORKER_SCRIPTS'), /dependencies must inherit/);
  const badAssertion = new Map([
    ['test/test-old-cache-key.js', String.raw`assert(/host\.js\?v=(\d+)/);`],
  ]);
  assert.match(validateCacheVersions(good, badAssertion).errors.join('\n'),
    /test-old-cache-key[\s\S]*re-states a numeric JavaScript cache key/);
}

function main() {
  if (process.argv.includes('--self-test')) selfTest();
  const result = validateCacheVersions(readRuntimeFiles(), readTestFiles());
  if (result.errors.length) {
    for (const error of result.errors) console.error(`browser cache version: ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Browser cache versions: one ${result.sourceVersion} authority, ` +
    `${result.indexScripts.length} page scripts, ${result.workerScripts.length} worker scripts`);
}

if (require.main === module) main();

module.exports = {
  collectScriptList, collectVersionRefs, normalizeAsset, readTestFiles,
  validateCacheVersions,
};
