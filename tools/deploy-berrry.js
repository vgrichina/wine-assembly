#!/usr/bin/env node
// Deploy Wine-Assembly to berrry.app
// Usage: node tools/deploy-berrry.js [--update]
// Autodiscovers all deployable files — no hardcoded lists.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BERRRY_KEY = process.env.BERRRY_KEY;
if (!BERRRY_KEY) { console.error('Missing BERRRY_KEY env var (try: set -a; . .env.berrry; set +a)'); process.exit(1); }
const API_BASE = 'https://berrry.app/api/nomcp/' + BERRRY_KEY;
const SUBDOMAIN = 'wine-assembly';
const ROOT = path.resolve(__dirname, '..');

// Text file extensions (served as-is)
const TEXT_EXTS = new Set(['.html', '.js', '.json', '.wat', '.css']);

// Skip these root text files
const SKIP_FILES = new Set(['package.json', 'package-lock.json']);

// Directories to skip entirely
const SKIP_DIRS = new Set(['node_modules', '.git', '.claude', 'scratch', 'tools', 'test', 'build', 'binaries']);

// Directories that contain binary assets (base64-encoded)
const BINARY_DIRS = ['binaries'];

// Skip these binary subdirs (too large, not used by app, or 16-bit)
const SKIP_BIN_DIRS = new Set(['installers', 'win98-16bit', 'demos', 'plus']);

// Skip individual large files (>500KB) that aren't essential
const MAX_BINARY_SIZE = 500 * 1024;
// But always include these even if large
const LARGE_OK = new Set(['cards.dll', 'comctl32.dll']);

// Binary extensions to include
const BINARY_EXTS = new Set(['.exe', '.dll', '.hlp', '.bmp', '.ico', '.cur', '.wav', '.mid', '.dat']);

function walk(dir, base, filter) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? base + '/' + entry.name : entry.name;
    if (entry.isSymbolicLink()) {
      const realPath = fs.realpathSync(path.join(dir, entry.name));
      const stat = fs.statSync(realPath);
      if (stat.isDirectory()) {
        results.push(...walk(realPath, rel, filter));
      } else if (filter(entry.name, rel)) {
        results.push({ rel, full: realPath });
      }
    } else if (entry.isDirectory()) {
      results.push(...walk(path.join(dir, entry.name), rel, filter));
    } else if (filter(entry.name, rel)) {
      results.push({ rel, full: path.join(dir, entry.name) });
    }
  }
  return results;
}

function collectTextFiles() {
  const files = [];
  // Root-level text files
  for (const entry of fs.readdirSync(ROOT)) {
    const ext = path.extname(entry);
    if (TEXT_EXTS.has(ext) && !SKIP_DIRS.has(entry) && !SKIP_FILES.has(entry)) {
      const full = path.join(ROOT, entry);
      if (fs.statSync(full).isFile())
        files.push({ name: entry, content: fs.readFileSync(full, 'utf-8') });
    }
  }
  // Subdirectories with text content (lib/, src/)
  for (const subdir of ['lib', 'src']) {
    const dir = path.join(ROOT, subdir);
    if (!fs.existsSync(dir)) continue;
    const found = walk(dir, subdir, (name) => TEXT_EXTS.has(path.extname(name)));
    for (const f of found)
      files.push({ name: f.rel, content: fs.readFileSync(f.full, 'utf-8') });
  }
  return files;
}

function collectBinaries() {
  const files = [];
  for (const subdir of BINARY_DIRS) {
    const dir = path.join(ROOT, subdir);
    if (!fs.existsSync(dir)) continue;
    const realDir = fs.realpathSync(dir);
    const found = walk(realDir, subdir, (name, rel) => {
      if (!BINARY_EXTS.has(path.extname(name).toLowerCase())) return false;
      const parts = rel.split('/');
      if (parts.some(p => SKIP_BIN_DIRS.has(p))) return false;
      return true;
    });
    for (const f of found) {
      const stat = fs.statSync(f.full);
      if (stat.size > MAX_BINARY_SIZE && !LARGE_OK.has(path.basename(f.full).toLowerCase())) {
        console.log('  SKIP (too large): ' + f.rel + ' (' + (stat.size / 1024).toFixed(0) + 'KB)');
        continue;
      }
      files.push({ name: f.rel, content: fs.readFileSync(f.full).toString('base64'), encoding: 'base64' });
    }
  }
  return files;
}

async function api(method, endpoint, body) {
  const r = await fetch(API_BASE + endpoint, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!r.ok) console.error(`API ${method} ${endpoint} -> ${r.status}:`, json);
  return { status: r.status, data: json };
}

function loadExplicitFiles(relList) {
  // Load specific files by repo-relative path. Encodes as text or base64 by extension.
  const files = [];
  for (const rel of relList) {
    const full = path.resolve(ROOT, rel);
    if (!fs.existsSync(full)) { console.error('SKIP missing: ' + rel); continue; }
    const ext = path.extname(rel).toLowerCase();
    if (TEXT_EXTS.has(ext)) {
      files.push({ name: rel, content: fs.readFileSync(full, 'utf-8') });
    } else {
      files.push({ name: rel, content: fs.readFileSync(full).toString('base64'), encoding: 'base64' });
    }
  }
  return files;
}

function fileSha256(file) {
  // Hash the raw bytes that berrry stores. For text files we kept the
  // utf-8 string in `content`; for binaries it's already base64 of the
  // raw bytes. Berrry hashes raw bytes, so reverse base64 first.
  const raw = file.encoding === 'base64'
    ? Buffer.from(file.content, 'base64')
    : Buffer.from(file.content, 'utf-8');
  return crypto.createHash('sha256').update(raw).digest('hex');
}

async function fetchServerManifest() {
  const r = await fetch(API_BASE + '/apps/' + SUBDOMAIN + '/files');
  if (!r.ok) { console.error('Failed to fetch manifest:', r.status); return null; }
  const j = await r.json();
  const map = new Map();
  for (const f of j.files || []) map.set(f.name, f.hash);
  return map;
}

async function deploy() {
  const isUpdate = process.argv.includes('--update');
  const isDiff = process.argv.includes('--diff');
  const filesArg = process.argv.find(a => a.startsWith('--files='));

  let textFiles, binFiles;
  if (filesArg) {
    const list = filesArg.slice('--files='.length).split(',').filter(Boolean);
    console.log('Uploading explicit file list (' + list.length + '):');
    const explicit = loadExplicitFiles(list);
    for (const f of explicit) {
      const sz = f.encoding === 'base64' ? f.content.length * 3 / 4 : f.content.length;
      console.log('  ' + f.name + ' (' + (sz / 1024).toFixed(1) + 'KB)');
    }
    textFiles = explicit;
    binFiles = [];
  } else {
    console.log('Collecting text files...');
    textFiles = collectTextFiles();
    let textBytes = 0;
    for (const f of textFiles) { textBytes += f.content.length; console.log('  ' + f.name + ' (' + (f.content.length / 1024).toFixed(1) + 'KB)'); }
    console.log('Total text: ' + (textBytes / 1024).toFixed(0) + 'KB, ' + textFiles.length + ' files\n');

    console.log('Collecting binaries...');
    binFiles = collectBinaries();
    let binBytes = 0;
    for (const f of binFiles) { const sz = f.content.length * 3 / 4; binBytes += sz; console.log('  ' + f.name + ' (' + (sz / 1024).toFixed(1) + 'KB)'); }
    console.log('Total binaries: ' + (binBytes / 1024).toFixed(0) + 'KB, ' + binFiles.length + ' files\n');
  }

  let allFiles = [...textFiles, ...binFiles];

  if (isDiff) {
    console.log('\nFetching server manifest...');
    const server = await fetchServerManifest();
    if (!server) { console.error('Cannot diff without server manifest'); return; }
    console.log('Server has ' + server.size + ' files');
    const before = allFiles.length;
    const skipped = [];
    allFiles = allFiles.filter(f => {
      const want = fileSha256(f);
      const have = server.get(f.name);
      if (have === want) { skipped.push(f.name); return false; }
      return true;
    });
    console.log('Skipping ' + skipped.length + ' unchanged files');
    console.log('Uploading ' + allFiles.length + ' of ' + before + ' files:');
    for (const f of allFiles) {
      const sz = f.encoding === 'base64' ? f.content.length * 3 / 4 : f.content.length;
      console.log('  ' + f.name + ' (' + (sz / 1024).toFixed(1) + 'KB)');
    }
    if (allFiles.length === 0) { console.log('\nNothing to upload.'); return; }
  }

  console.log('Total files: ' + allFiles.length);

  const BATCH_LIMIT = 900 * 1024; // stay under berrry.app body limit
  const appMeta = {
    subdomain: SUBDOMAIN,
    title: 'Wine-Assembly \u2014 Windows 98 Emulator',
    description: 'x86 Windows 98 PE interpreter in WebAssembly. Runs real Win32 executables in the browser.',
  };

  // Split all files into batches
  const batches = [];
  let batch = [], batchSize = 0;
  for (const f of allFiles) {
    const fSize = f.content.length + f.name.length + 50;
    if (batchSize + fSize > BATCH_LIMIT && batch.length) {
      batches.push(batch);
      batch = []; batchSize = 0;
    }
    batch.push(f); batchSize += fSize;
  }
  if (batch.length) batches.push(batch);

  console.log('Split into ' + batches.length + ' batches\n');

  // First batch: create or update with metadata
  for (let i = 0; i < batches.length; i++) {
    const isFirst = i === 0;
    const body = isFirst
      ? { ...appMeta, files: batches[i] }
      : { subdomain: SUBDOMAIN, files: batches[i] };

    if (isFirst && !isUpdate) {
      console.log('Creating app (batch 1/' + batches.length + ', ' + batches[i].length + ' files)...');
      const r = await api('POST', '/apps', body);
      console.log('Result:', r.status, r.data);
      if (r.status >= 400) return;
    } else {
      console.log('Updating (batch ' + (i + 1) + '/' + batches.length + ', ' + batches[i].length + ' files)...');
      const r = await api('PUT', '/apps/' + SUBDOMAIN, body);
      console.log('Result:', r.status);
      if (r.status >= 400 && r.status !== 404) return;
    }
  }

  console.log('\nDone! Visit: https://' + SUBDOMAIN + '.berrry.app');
}

deploy().catch(e => { console.error(e); process.exit(1); });
