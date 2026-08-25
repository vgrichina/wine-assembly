#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const {
  diffRegistrySnapshots,
  startupRegistryFromDiff,
} = require('../lib/registry-snapshot');

const args = process.argv.slice(2);
const manifest = args.includes('--manifest');
const files = args.filter(arg => !arg.startsWith('--'));
if (files.length !== 2) {
  console.error(`Usage: node ${path.relative(process.cwd(), __filename)} BEFORE.json|defaults AFTER.json [--manifest]`);
  process.exit(2);
}

function readSnapshot(file) {
  if (file === 'defaults') return require('../lib/storage').exportStore();
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const diff = diffRegistrySnapshots(readSnapshot(files[0]), readSnapshot(files[1]));
const result = manifest ? startupRegistryFromDiff(diff) : diff;
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
