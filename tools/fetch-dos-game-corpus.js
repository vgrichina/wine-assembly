#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const manifest = require('../test/dos-game-corpus/manifest.json');
const assetRoot = path.resolve(ROOT, manifest.assetRoot);
const force = process.argv.includes('--force');
const idArg = process.argv.find(argument => argument.startsWith('--id='));
const selected = idArg ? new Set(idArg.slice(5).split(',').filter(Boolean)) : null;

function digest(file, algorithm) {
  return crypto.createHash(algorithm).update(fs.readFileSync(file)).digest('hex');
}

function download(url, destination, redirects = 8) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === 'http:' ? http : https;
    const request = client.get(parsed, {
      headers: { 'User-Agent': 'WineAssemblyDosGameCorpus/1.0' },
    }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        if (!redirects) return reject(new Error(`too many redirects for ${url}`));
        return download(new URL(response.headers.location, parsed).href, destination, redirects - 1)
          .then(resolve, reject);
      }
      if (response.statusCode !== 200) {
        response.resume();
        return reject(new Error(`HTTP ${response.statusCode} for ${url}`));
      }
      const output = fs.createWriteStream(destination, { flags: 'wx' });
      response.pipe(output);
      output.on('finish', () => output.close(resolve));
      output.on('error', reject);
    });
    request.on('error', reject);
  });
}

async function main() {
  const known = new Set(manifest.games.map(game => game.id));
  if (selected) {
    const unknown = [...selected].filter(id => !known.has(id));
    if (unknown.length) throw new Error(`unknown DOS game IDs: ${unknown.join(', ')}`);
  }
  fs.mkdirSync(assetRoot, { recursive: true });
  for (const game of manifest.games.filter(item => !selected || selected.has(item.id))) {
    const directory = path.join(assetRoot, game.id);
    const archive = path.join(directory, game.package.file);
    fs.mkdirSync(directory, { recursive: true });
    if (force && fs.existsSync(archive)) fs.rmSync(archive);
    if (!fs.existsSync(archive)) {
      const temporary = `${archive}.download`;
      fs.rmSync(temporary, { force: true });
      console.log(`GET   ${game.id} ${game.package.url}`);
      await download(game.package.url, temporary);
      fs.renameSync(temporary, archive);
    }
    if (fs.statSync(archive).size !== game.package.size ||
        digest(archive, 'sha1') !== game.package.sha1 ||
        digest(archive, 'sha256') !== game.package.sha256) {
      throw new Error(`${game.id}: downloaded archive does not match the pinned package`);
    }
    const executable = path.join(directory, game.executable);
    if (force || !fs.existsSync(executable)) {
      const extracted = spawnSync('unzip', ['-oq', archive, '-d', directory], {
        encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
      });
      if (extracted.status !== 0) {
        throw new Error(`${game.id}: unzip failed\n${extracted.stdout}${extracted.stderr}`);
      }
    }
    if (!fs.existsSync(executable)) throw new Error(`${game.id}: missing ${game.executable}`);
    console.log(`READY ${game.id} ${path.relative(ROOT, executable)}`);
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
