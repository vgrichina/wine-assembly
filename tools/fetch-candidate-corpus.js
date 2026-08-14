#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const MANIFEST_PATH = path.join(ROOT, 'test', 'candidate-corpus', 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
const ASSET_ROOT = path.resolve(ROOT, manifest.assetRoot);
const argv = process.argv.slice(2);
const force = argv.includes('--force');
const idArg = argv.find(arg => arg.startsWith('--id='));
const selectedIds = idArg
  ? new Set(idArg.slice('--id='.length).split(',').map(value => value.trim()).filter(Boolean))
  : null;

function usage(message) {
  if (message) console.error(message);
  console.error('usage: node tools/fetch-candidate-corpus.js [--id=a,b] [--force]');
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
    fs.writeFileSync(provenanceFile, `${JSON.stringify({
      id: candidate.id,
      name: candidate.name,
      version: candidate.version,
      sourcePage: candidate.sourcePage,
      packages: provenance,
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
