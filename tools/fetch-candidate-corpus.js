#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const MANIFEST_PATH = path.join(ROOT, 'test', 'candidate-corpus', 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
const ASSET_ROOT = path.resolve(ROOT, manifest.assetRoot);
const argv = process.argv.slice(2);
const force = argv.includes('--force');
const prepare = argv.includes('--prepare');
const idArg = argv.find(arg => arg.startsWith('--id='));
const selectedIds = idArg
  ? new Set(idArg.slice('--id='.length).split(',').map(value => value.trim()).filter(Boolean))
  : null;

function usage(message) {
  if (message) console.error(message);
  console.error('usage: node tools/fetch-candidate-corpus.js [--id=a,b] [--force|--prepare]');
  process.exit(2);
}

function fixtureId(candidate) {
  return candidate.fixture || candidate.id;
}

function assertSafeRelative(value, label) {
  if (!value || path.isAbsolute(value) || value.split(/[\\/]+/).includes('..')) {
    throw new Error(`${label} must be a safe relative path: ${value}`);
  }
}

function sha1(filename) {
  const hash = crypto.createHash('sha1');
  hash.update(fs.readFileSync(filename));
  return hash.digest('hex');
}

function requestToFile(url, destination, redirectsLeft = 10) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === 'http:' ? http : https;
    const request = client.get(parsed, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; WineAssemblyCandidateCorpus/1.0)',
        Accept: '*/*',
      },
    }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        if (!redirectsLeft) return reject(new Error(`too many redirects for ${url}`));
        return requestToFile(new URL(response.headers.location, parsed).href, destination, redirectsLeft - 1)
          .then(resolve, reject);
      }
      if (response.statusCode !== 200) {
        response.resume();
        const error = new Error(`HTTP ${response.statusCode} for ${url}`);
        error.statusCode = response.statusCode;
        return reject(error);
      }
      const output = fs.createWriteStream(destination, { flags: 'wx' });
      response.pipe(output);
      output.on('finish', () => output.close(resolve));
      output.on('error', reject);
    });
    request.on('error', reject);
  });
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function downloadWithRetries(url, destination) {
  const retryableStatuses = new Set([429, 500, 502, 503, 504]);
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt++) {
    fs.rmSync(destination, { force: true });
    try {
      await requestToFile(url, destination);
      return;
    } catch (error) {
      lastError = error;
      const retryable = !error.statusCode || retryableStatuses.has(error.statusCode);
      if (!retryable || attempt === 4) break;
      console.log(`RETRY  ${attempt}/3: ${url}`);
      await delay(attempt * 750);
    }
  }
  throw lastError;
}

function extractArchive(archive, destination) {
  fs.mkdirSync(destination, { recursive: true });
  const result = spawnSync('7z', ['x', '-y', `-o${destination}`, archive], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status === 0) return;

  const fallback = spawnSync('unar', ['-f', '-o', destination, archive], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (fallback.status === 0) return;

  const primary = result.error && result.error.code === 'ENOENT'
    ? '7z unavailable'
    : `7z exit ${result.status}`;
  const secondary = fallback.error && fallback.error.code === 'ENOENT'
    ? 'unar unavailable'
    : `unar exit ${fallback.status}`;
  const detail = `${fallback.stdout || ''}\n${fallback.stderr || ''}`.trim().split('\n').slice(-8).join('\n');
  throw new Error(`archive extraction failed (${primary}; ${secondary})${detail ? `:\n${detail}` : ''}`);
}

function runPostExtract(candidate, destination) {
  for (const [index, step] of (candidate.postExtract || []).entries()) {
    if (step.type === 'unshield') {
      assertSafeRelative(step.cab, `${candidate.id}.postExtract[${index}].cab`);
      assertSafeRelative(step.into, `${candidate.id}.postExtract[${index}].into`);
      if (!step.group || typeof step.group !== 'string') {
        throw new Error(`${candidate.id}.postExtract[${index}].group is required`);
      }
      const cab = path.join(destination, step.cab);
      const into = path.join(destination, step.into);
      fs.mkdirSync(into, { recursive: true });
      const result = spawnSync('unshield', ['-d', into, '-g', step.group, 'x', cab], {
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
      });
      if (result.status !== 0) {
        const unavailable = result.error && result.error.code === 'ENOENT';
        const detail = `${result.stdout || ''}\n${result.stderr || ''}`.trim().split('\n').slice(-8).join('\n');
        throw new Error(`InstallShield extraction failed (${unavailable ? 'unshield unavailable' : `exit ${result.status}`})${detail ? `:\n${detail}` : ''}`);
      }
    } else if (step.type === 'copyTree') {
      assertSafeRelative(step.from, `${candidate.id}.postExtract[${index}].from`);
      assertSafeRelative(step.into, `${candidate.id}.postExtract[${index}].into`);
      const from = path.join(destination, step.from);
      const into = path.join(destination, step.into);
      fs.mkdirSync(into, { recursive: true });
      for (const entry of fs.readdirSync(from)) {
        fs.cpSync(path.join(from, entry), path.join(into, entry), {
          recursive: true,
          force: true,
        });
      }
    } else if (step.type === 'replaceText') {
      assertSafeRelative(step.file, `${candidate.id}.postExtract[${index}].file`);
      if (!Array.isArray(step.replacements) || !step.replacements.length) {
        throw new Error(`${candidate.id}.postExtract[${index}].replacements is required`);
      }
      const file = path.join(destination, step.file);
      let text = fs.readFileSync(file, 'utf8');
      for (const [replacementIndex, replacement] of step.replacements.entries()) {
        const label = `${candidate.id}.postExtract[${index}].replacements[${replacementIndex}]`;
        if (!replacement || typeof replacement.from !== 'string' ||
            typeof replacement.to !== 'string' || !replacement.from) {
          throw new Error(`${label} needs non-empty from and string to values`);
        }
        if (!text.includes(replacement.from)) {
          // Let a previously prepared local tree remain idempotent while still
          // rejecting silently changed upstream installer contents.
          if (text.includes(replacement.to)) continue;
          throw new Error(`${label} did not match ${step.file}`);
        }
        text = text.split(replacement.from).join(replacement.to);
      }
      fs.writeFileSync(file, text);
    } else if (step.type === 'prepareInfinityFullInstall') {
      for (const field of ['key', 'data', 'into', 'outputKey']) {
        assertSafeRelative(step[field], `${candidate.id}.postExtract[${index}].${field}`);
      }
      const dataDir = path.join(destination, step.data);
      const intoDir = path.join(destination, step.into);
      fs.mkdirSync(intoDir, { recursive: true });
      const installedBifs = new Set();
      const dataEntries = fs.readdirSync(dataDir);
      const dataNames = new Set(dataEntries.map(name => name.toLowerCase()));
      for (const entry of dataEntries) {
        if (!/\.cbf$/i.test(entry)) continue;
        const source = fs.readFileSync(path.join(dataDir, entry));
        if (source.subarray(0, 8).toString('ascii') !== 'BIF V1.0' || source.length < 24) {
          throw new Error(`${step.data}/${entry} is not an Infinity compressed BIF`);
        }
        const nameLength = source.readUInt32LE(8);
        const sizeOffset = 12 + nameLength;
        if (nameLength < 2 || sizeOffset + 8 > source.length) {
          throw new Error(`${step.data}/${entry} has an invalid compressed BIF header`);
        }
        const embeddedName = source.subarray(12, sizeOffset - 1).toString('ascii');
        if (path.basename(embeddedName) !== embeddedName || !/\.bif$/i.test(embeddedName)) {
          throw new Error(`${step.data}/${entry} has an unsafe embedded BIF name`);
        }
        const expectedSize = source.readUInt32LE(sizeOffset);
        const compressedSize = source.readUInt32LE(sizeOffset + 4);
        const compressedOffset = sizeOffset + 8;
        if (compressedOffset + compressedSize !== source.length) {
          throw new Error(`${step.data}/${entry} has an invalid compressed payload size`);
        }
        const output = zlib.inflateSync(source.subarray(compressedOffset));
        if (output.length !== expectedSize || output.subarray(0, 8).toString('ascii') !== 'BIFFV1  ') {
          throw new Error(`${step.data}/${entry} did not inflate to the expected BIFF payload`);
        }
        fs.writeFileSync(path.join(intoDir, embeddedName), output);
        installedBifs.add(embeddedName.toLowerCase());
      }

      const key = fs.readFileSync(path.join(destination, step.key));
      if (key.subarray(0, 8).toString('ascii') !== 'KEY V1  ' || key.length < 24) {
        throw new Error(`${step.key} is not an Infinity KEY V1 file`);
      }
      const bifCount = key.readUInt32LE(8);
      const resourceCount = key.readUInt32LE(12);
      const bifOffset = key.readUInt32LE(16);
      const resourceOffset = key.readUInt32LE(20);
      const availableBifs = new Set(dataEntries
        .filter(name => /\.bif$/i.test(name))
        .map(name => name.toLowerCase()));
      for (const name of installedBifs) availableBifs.add(name);
      const bifAvailable = new Array(bifCount).fill(false);
      let patched = 0;
      for (let bif = 0; bif < bifCount; bif++) {
        const entryOffset = bifOffset + bif * 12;
        if (entryOffset + 12 > key.length) throw new Error(`${step.key} has a truncated BIF table`);
        const nameOffset = key.readUInt32LE(entryOffset + 4);
        const nameLength = key.readUInt16LE(entryOffset + 8);
        if (nameOffset + nameLength > key.length) throw new Error(`${step.key} has a truncated BIF name`);
        const name = key.subarray(nameOffset, nameOffset + nameLength)
          .toString('ascii').replace(/\0+$/, '').replace(/\\/g, '/');
        const base = path.basename(name).toLowerCase();
        const location = key.readUInt16LE(entryOffset + 10);
        if (location === 9 && dataNames.has(base)) installedBifs.add(base);
        if (location === 9 && installedBifs.has(base)) {
          key.writeUInt16LE(1, entryOffset + 10);
          patched++;
        }
        bifAvailable[bif] = availableBifs.has(base);
      }
      if (patched !== installedBifs.size) {
        throw new Error(`${step.key} patched ${patched}/${installedBifs.size} CD2 BIF locations`);
      }
      if (resourceOffset + resourceCount * 14 > key.length) {
        throw new Error(`${step.key} has a truncated resource table`);
      }
      const resources = [];
      for (let resource = 0; resource < resourceCount; resource++) {
        const entryOffset = resourceOffset + resource * 14;
        const locator = key.readUInt32LE(entryOffset + 10);
        const bif = locator >>> 20;
        if (bif < bifAvailable.length && bifAvailable[bif]) {
          resources.push(key.subarray(entryOffset, entryOffset + 14));
        }
      }
      const output = Buffer.concat([
        key.subarray(0, resourceOffset),
        ...resources,
      ]);
      output.writeUInt32LE(resources.length, 12);
      fs.writeFileSync(path.join(destination, step.outputKey), output);
    } else {
      throw new Error(`unsupported postExtract type: ${step.type}`);
    }
  }
}

async function fetchCandidate(candidate) {
  const fixture = fixtureId(candidate);
  assertSafeRelative(fixture, `${candidate.id}.fixture`);
  const destination = path.join(ASSET_ROOT, fixture);
  if (candidate.fixture && candidate.fixture !== candidate.id) {
    console.log(`SHARED ${candidate.id}: uses fixture ${candidate.fixture}`);
    return { shared: 1 };
  }
  if (!candidate.packages.length) {
    console.log(`MANUAL ${candidate.id}: ${candidate.manual || 'no automated package is pinned'}`);
    return { manual: 1 };
  }
  const provenanceFile = path.join(destination, '.candidate-source.json');
  if (prepare) {
    if (!fs.existsSync(destination)) {
      throw new Error(`cannot prepare missing candidate fixture: ${path.relative(ROOT, destination)}`);
    }
    runPostExtract(candidate, destination);
    console.log(`PREP   ${candidate.id}: ${path.relative(ROOT, destination)}`);
    return { kept: 1 };
  }
  if (fs.existsSync(provenanceFile) && !force) {
    console.log(`KEEP   ${candidate.id}: ${path.relative(ROOT, destination)}`);
    return { kept: 1 };
  }
  if (force && fs.existsSync(destination)) fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(destination, { recursive: true });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), `wa-candidate-${candidate.id}-`));
  const provenance = [];
  try {
    for (let index = 0; index < candidate.packages.length; index++) {
      const pkg = candidate.packages[index];
      if (!pkg.url || !/^[0-9a-f]{40}$/.test(pkg.sha1 || '')) {
        throw new Error(`package ${index + 1} needs a URL and pinned SHA-1`);
      }
      const download = path.join(temp, `package-${index + 1}`);
      console.log(`FETCH  ${candidate.id}: ${pkg.url}`);
      await downloadWithRetries(pkg.url, download);
      const actual = sha1(download);
      if (actual !== pkg.sha1.toLowerCase()) {
        throw new Error(`SHA-1 mismatch for ${pkg.url}: expected ${pkg.sha1}, got ${actual}`);
      }
      const into = pkg.into || '.';
      assertSafeRelative(into === '.' ? 'root' : into, `${candidate.id}.packages[${index}].into`);
      if (pkg.type === 'archive') {
        extractArchive(download, path.join(destination, into));
      } else if (pkg.type === 'file') {
        assertSafeRelative(pkg.destination, `${candidate.id}.packages[${index}].destination`);
        const target = path.join(destination, pkg.destination);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(download, target);
      } else {
        throw new Error(`unsupported package type: ${pkg.type}`);
      }
      provenance.push({ url: pkg.url, sha1: actual, type: pkg.type, into, destination: pkg.destination || null });
    }
    runPostExtract(candidate, destination);
    fs.writeFileSync(provenanceFile, `${JSON.stringify({
      id: candidate.id,
      name: candidate.name,
      version: candidate.version,
      sourcePage: candidate.sourcePage,
      packages: provenance,
      postExtract: candidate.postExtract || [],
    }, null, 2)}\n`);
    console.log(`READY  ${candidate.id}: ${path.relative(ROOT, destination)}`);
    return { fetched: 1 };
  } catch (error) {
    console.error(`ERROR  ${candidate.id}: ${error.message}`);
    return { failed: 1 };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

(async () => {
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.candidates)) usage('unsupported candidate manifest');
  const known = new Set(manifest.candidates.map(candidate => candidate.id));
  if (known.size !== manifest.candidates.length) usage('candidate IDs must be unique');
  if (selectedIds) {
    const unknown = [...selectedIds].filter(id => !known.has(id));
    if (unknown.length) usage(`unknown candidate IDs: ${unknown.join(', ')}`);
  }
  fs.mkdirSync(ASSET_ROOT, { recursive: true });
  const wantedIds = selectedIds ? new Set(selectedIds) : null;
  if (wantedIds) {
    for (const candidate of manifest.candidates) {
      if (wantedIds.has(candidate.id) && candidate.fixture) wantedIds.add(candidate.fixture);
    }
  }
  const candidates = manifest.candidates.filter(candidate => !wantedIds || wantedIds.has(candidate.id));
  const totals = { fetched: 0, kept: 0, shared: 0, manual: 0, failed: 0 };
  for (const candidate of candidates) {
    const result = await fetchCandidate(candidate);
    for (const [key, value] of Object.entries(result)) totals[key] += value;
  }
  console.log(`candidate fetch: ${totals.fetched} fetched, ${totals.kept} kept, ${totals.shared} shared, ${totals.manual} manual, ${totals.failed} failed`);
  process.exit(totals.failed ? 1 : 0);
})().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
