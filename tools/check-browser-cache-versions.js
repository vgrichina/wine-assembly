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

function validateCacheVersions(files) {
  const errors = [];
  const refs = collectVersionRefs(files);
  const byAsset = new Map();
  for (const ref of refs) {
    if (!byAsset.has(ref.asset)) byAsset.set(ref.asset, []);
    byAsset.get(ref.asset).push(ref);
  }

  for (const [asset, assetRefs] of byAsset) {
    const versions = [...new Set(assetRefs.map(ref => ref.version))];
    if (versions.length <= 1) continue;
    const locations = assetRefs
      .map(ref => `${ref.sourceFile}:${ref.line}=v${ref.version}`)
      .join(', ');
    errors.push(`${asset} has disagreeing cache versions: ${locations}`);
  }

  const indexText = files.get('index.html') || '';
  const scriptTag = /<script\b[^>]*\bsrc\s*=\s*(['"])([^'"]+)\1/gi;
  let match;
  while ((match = scriptTag.exec(indexText)) !== null) {
    const rawUrl = match[2];
    const asset = normalizeAsset('index.html', rawUrl);
    if (!asset || !asset.endsWith('.js') || asset === 'build-info.js') continue;
    if (!/[?&]v=\d+(?:&|$)/.test(rawUrl)) {
      errors.push(`index.html:${lineAt(indexText, match.index)} loads ${asset} without a numeric ?v=`);
    }
  }

  for (const sourceFile of ['lib/guest-worker.js']) {
    const text = files.get(sourceFile) || '';
    const importCall = /\bimportScripts\s*\(([^)]*)\)/g;
    while ((match = importCall.exec(text)) !== null) {
      const args = match[1];
      const scriptArg = /(['"])([^'"]+\.js(?:\?[^'"]*)?)\1/g;
      let argMatch;
      while ((argMatch = scriptArg.exec(args)) !== null) {
        const asset = normalizeAsset(sourceFile, argMatch[2]);
        if (!asset || /[?&]v=\d+(?:&|$)/.test(argMatch[2])) continue;
        errors.push(`${sourceFile}:${lineAt(text, match.index)} imports ${asset} without a numeric ?v=`);
      }
    }
  }

  const hostText = files.get('host.js') || '';
  const sourceMatch = hostText.match(/static\s+SOURCE_VERSION\s*=\s*['"](\d+)['"]/);
  const hostRefs = byAsset.get('host.js') || [];
  if (!sourceMatch) {
    errors.push('host.js does not declare a numeric static SOURCE_VERSION');
  } else if (hostRefs.length !== 1) {
    errors.push(`index/runtime loader graph must contain exactly one versioned host.js reference (found ${hostRefs.length})`);
  } else if (hostRefs[0].version !== sourceMatch[1]) {
    errors.push(`host.js SOURCE_VERSION=v${sourceMatch[1]} disagrees with ${hostRefs[0].sourceFile}:${hostRefs[0].line}=v${hostRefs[0].version}`);
  }

  return {
    errors,
    refs,
    assets: byAsset.size,
    sourceVersion: sourceMatch ? sourceMatch[1] : null,
  };
}

function selfTest() {
  const good = new Map([
    ['index.html', [
      '<script src="build-info.js"></script>',
      '<script src="lib/shared.js?v=7"></script>',
      '<script src="lib/dll-loader.js?v=4"></script>',
      '<script src="host.js?v=9"></script>',
    ].join('\n')],
    ['host.js', "class Host { static SOURCE_VERSION = '9'; }\nconst worker = 'lib/guest-worker.js?v=3';"],
    ['lib/guest-worker.js', "importScripts('shared.js?v=7', 'dll-loader.js?v=4');\nconst workerUrl = 'render.js?v=2';"],
    ['lib/d3d-command-stream.js', "new Worker(options.workerUrl || 'render.js?v=2');"],
  ]);
  assert.deepStrictEqual(validateCacheVersions(good).errors, []);

  const changed = (name, from, to) => {
    const files = new Map(good);
    files.set(name, files.get(name).replace(from, to));
    return validateCacheVersions(files).errors.join('\n');
  };
  assert.match(changed('lib/guest-worker.js', 'shared.js?v=7', 'shared.js?v=8'), /disagreeing cache versions/);
  assert.match(changed('host.js', "SOURCE_VERSION = '9'", "SOURCE_VERSION = '8'"), /SOURCE_VERSION=v8.*=v9/);
  assert.match(changed('lib/guest-worker.js', 'dll-loader.js?v=4', 'dll-loader.js'), /imports lib\/dll-loader\.js without/);
  assert.match(changed('index.html', 'lib/shared.js?v=7', 'lib/shared.js'), /loads lib\/shared\.js without/);
  assert.match(changed('lib/d3d-command-stream.js', 'render.js?v=2', 'render.js?v=3'), /disagreeing cache versions/);
}

function main() {
  if (process.argv.includes('--self-test')) selfTest();
  const result = validateCacheVersions(readRuntimeFiles());
  if (result.errors.length) {
    for (const error of result.errors) console.error(`browser cache version: ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Browser cache versions: ${result.refs.length} references, ${result.assets} assets, host/source v${result.sourceVersion}`);
}

if (require.main === module) main();

module.exports = { collectVersionRefs, normalizeAsset, validateCacheVersions };
