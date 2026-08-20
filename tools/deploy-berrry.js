#!/usr/bin/env node
// Deploy Wine-Assembly to berrry.app
// Usage:
//   node tools/deploy-berrry.js                  create app (first deploy only)
//   node tools/deploy-berrry.js --update         update; only push files whose
//                                                sha256 differs from server
//   node tools/deploy-berrry.js --update --full  force-reupload everything
//   node tools/deploy-berrry.js --update --files=a,b,c   push explicit list
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
const TEXT_EXTS = new Set(['.html', '.js', '.json', '.wat', '.css', '.md', '.webmanifest', '.ini']);

// Skip these root text files
const SKIP_FILES = new Set(['package.json', 'package-lock.json']);

// Directories to skip entirely
const SKIP_DIRS = new Set(['node_modules', '.git', '.claude', 'scratch', 'tools', 'test', 'build', 'binaries']);

// Directories that contain binary assets (base64-encoded)
const BINARY_DIRS = ['binaries', 'icons', 'build'];

// Skip individual large files (>500KB) that aren't essential
const MAX_BINARY_SIZE = 500 * 1024;
// But always include these even if large
const LARGE_OK = new Set(['cards.dll', 'comctl32.dll']);
const LARGE_OK_PATHS = new Set([
  'build/wine-assembly.wasm',
  'build/wine-assembly.compat.wasm',
  'binaries/pinball/PINBALL.DAT',
  'binaries/pinball-plus95/PINBALL.DAT',
  'binaries/winamp.exe',
  'binaries/wep32-community/Funpack/FunPack.dll',
  'binaries/wep32-community/QBlackjack/QuickBlackjack.exe',
  'binaries/plus98/DIALOG.BMP',
]);


// Binary extensions to include
const BINARY_EXTS = new Set(['.exe', '.dll', '.manifest', '.hlp', '.chm', '.bmp', '.ico', '.cur', '.wav', '.mp3', '.mid', '.m3u', '.dat', '.inf', '.ini', '.txt', '.png', '.wasm']);

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

// What under binaries/ the live site needs, asked of the same registries the
// page itself reads rather than of a hand-kept list here.
//
// The hand-kept list is how mspaint.cnt and binaries/dlls/mfc42.dll came to
// 404 on a deploy that reported success: Paint is a desktop icon and its help
// file and MFC runtime are in lib/apps.js and lib/dll-registry.js, but nobody
// remembered to add them here, and there is nothing about "the deploy shipped
// every file it decided to ship" that can notice a file it never considered.
// Derived, the two cannot drift: adding an app or a DLL to the registry ships
// its assets.
function desktopAssetPaths() {
  const { APPS, DESKTOP_APPS, LOCAL_CANDIDATE_APPS, DEBUG_ONLY_APPS, appFileUrl } =
    require(path.join(ROOT, 'lib', 'apps.js'));
  const { DLL_PATHS } = require(path.join(ROOT, 'lib', 'dll-registry.js'));
  const out = new Set();
  const add = p => { if (p && p.startsWith('binaries/')) out.add(p); };

  // index.html offers exactly these three lists and nothing else, so an APPS
  // entry no icon and no selector row can reach is not a live-site asset.
  const listed = [...DESKTOP_APPS, ...LOCAL_CANDIDATE_APPS, ...DEBUG_ONLY_APPS];
  for (const [id] of listed) {
    const app = APPS[id];
    if (!app) continue;
    add(app.exe);
    // A bare DLL name is resolved through the registry below, not here.
    for (const d of app.dlls || []) if (d.includes('/')) add(d);
    // `win16Modules` names NE modules the page fetches from the exe's own
    // directory by candidate filename, not paths — those still do not ship.
    for (const f of app.files || []) add(appFileUrl(f));
  }
  // Any app can LoadLibrary any of these at runtime, so they all ship.
  for (const p of Object.values(DLL_PATHS)) add(p);
  return out;
}

function collectBinaries() {
  const files = [];
  const wanted = desktopAssetPaths();
  const seen = new Set();

  // binaries/ ships exactly what the registries name — not what a directory
  // walk with an extension filter happens to match.
  for (const rel of [...wanted].sort()) {
    const full = path.join(ROOT, rel);
    if (!fs.existsSync(full)) { console.log('  MISSING: ' + rel); continue; }
    const stat = fs.statSync(full);
    if (stat.size > MAX_BINARY_SIZE &&
        !LARGE_OK.has(path.basename(full).toLowerCase()) &&
        !LARGE_OK_PATHS.has(rel)) {
      // A registry-declared asset is by definition needed, so this is a
      // warning about weight, not a decision to leave the app broken.
      console.log('  LARGE: ' + rel + ' (' + (stat.size / 1024).toFixed(0) + 'KB)');
    }
    seen.add(rel);
    files.push({ name: rel, content: fs.readFileSync(full).toString('base64'), encoding: 'base64' });
  }

  // icons/ and build/ have no registry; they are whole directories the page
  // fetches by name, so they still walk.
  for (const subdir of BINARY_DIRS.filter(d => d !== 'binaries')) {
    const dir = path.join(ROOT, subdir);
    if (!fs.existsSync(dir)) continue;
    const found = walk(fs.realpathSync(dir), subdir,
      (name) => BINARY_EXTS.has(path.extname(name).toLowerCase()));
    for (const f of found) {
      if (seen.has(f.rel)) continue;
      const stat = fs.statSync(f.full);
      if (stat.size > MAX_BINARY_SIZE &&
          !LARGE_OK.has(path.basename(f.full).toLowerCase()) &&
          !LARGE_OK_PATHS.has(f.rel)) {
        console.log('  SKIP (too large): ' + f.rel + ' (' + (stat.size / 1024).toFixed(0) + 'KB)');
        continue;
      }
      files.push({ name: f.rel, content: fs.readFileSync(f.full).toString('base64'), encoding: 'base64' });
    }
  }
  return files;
}

// fonts/ ships neither as a text dir nor as a binary dir, so before this it was
// not deployed at all: the bundled .FON strikes, the scalable substitutes, and
// even the @font-face files the page's own CSS asks for were all missing from
// the live site, which silently fell back to whatever the visitor's machine
// had. That is the exact non-determinism the font work exists to remove.
//
// Only what the running app opens goes up. fonts/liberation and fonts/wine are
// the vendored *sources*: 6.5 MB that tools/gen-font-subsets.sh reduces to the
// ~300 KB in fonts/subset, and nothing fetches them at runtime.
function collectFonts() {
  const files = [];
  const dir = path.join(ROOT, 'fonts');
  if (!fs.existsSync(dir)) return files;

  const push = (rel, full) => {
    files.push({
      name: rel,
      content: fs.readFileSync(full).toString('base64'),
      encoding: 'base64',
    });
  };

  // Bitmap strikes, the CSS webfonts, and the manifest host.js reads to know
  // which substitute answers which Win98 filename.
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (!fs.statSync(full).isFile()) continue;
    const ext = path.extname(entry).toLowerCase();
    if (!['.fon', '.ttf', '.otf', '.woff2', '.json'].includes(ext)) continue;
    push('fonts/' + entry, full);
  }

  const subsetDir = path.join(dir, 'subset');
  if (fs.existsSync(subsetDir)) {
    for (const entry of fs.readdirSync(subsetDir)) {
      if (path.extname(entry).toLowerCase() !== '.ttf') continue;
      push('fonts/subset/' + entry, path.join(subsetDir, entry));
    }
  }
  return files;
}

// A deploy is a sequence of batches, and the live site is whatever prefix of
// them landed. So a dropped socket in the middle is not "the deploy failed" —
// it is a site serving the new index.html against the old assets, which is how
// a run that stopped at batch 6 of 17 left every .fon 404ing while the page
// still asked for them. Retry the transport before giving up, and when it does
// give up, say that the site is now mixed.
async function fetchRetry(url, opts, label) {
  const attempts = 4;
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(url, opts);
      if (r.status >= 500 && i < attempts) {
        console.log(`  ${label}: HTTP ${r.status}, retrying (${i}/${attempts - 1})...`);
        await new Promise(res => setTimeout(res, 1000 * i));
        continue;
      }
      return r;
    } catch (e) {
      if (i >= attempts) throw e;
      const why = (e && e.cause && e.cause.code) || (e && e.message) || 'error';
      console.log(`  ${label}: ${why}, retrying (${i}/${attempts - 1})...`);
      await new Promise(res => setTimeout(res, 1000 * i));
    }
  }
}

async function apiJson(method, endpoint, body) {
  const r = await fetchRetry(API_BASE + endpoint, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, `${method} ${endpoint}`);
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!r.ok) console.error(`API ${method} ${endpoint} -> ${r.status}:`, json);
  return { status: r.status, data: json };
}

async function apiMultipart(method, endpoint, body) {
  const files = body.files || [];
  const metadata = { ...body };
  delete metadata.files;

  const form = new FormData();
  form.append('metadata', JSON.stringify(metadata));
  for (const f of files) {
    const raw = f.encoding === 'base64'
      ? Buffer.from(f.content, 'base64')
      : Buffer.from(f.content, 'utf-8');
    form.append('file', new Blob([raw]), f.name);
  }

  // The FormData holds Blobs, not a consumed stream, so it can be posted again.
  const r = await fetchRetry(API_BASE + endpoint, { method, body: form },
    `${method} ${endpoint}`);
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!r.ok) console.error(`API ${method} ${endpoint} -> ${r.status}:`, json);
  return { status: r.status, data: json };
}

async function api(method, endpoint, body) {
  const hasBinary = (body.files || []).some(f => f.encoding === 'base64');
  return hasBinary
    ? apiMultipart(method, endpoint, body)
    : apiJson(method, endpoint, body);
}

function loadExplicitFiles(relList) {
  // Load specific files by repo-relative path. Encodes as text or base64 by extension.
  const files = [];
  for (const originalRel of relList) {
    const rel = originalRel.replace(/\\/g, '/').replace(/^\.\//, '');
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

function fileByteSize(file) {
  return file.encoding === 'base64'
    ? Buffer.byteLength(file.content, 'base64')
    : Buffer.byteLength(file.content, 'utf-8');
}

// Shared by deploy and rollback so both stay under the same request ceiling.
const BATCH_LIMIT = 950 * 1024; // stay under berrry.app body limit

function splitIntoBatches(files) {
  const batches = [];
  let batch = [], batchSize = 0;
  for (const f of files) {
    const fSize = fileByteSize(f) + f.name.length + 500; // multipart overhead estimate
    if (batchSize + fSize > BATCH_LIMIT && batch.length) {
      batches.push(batch);
      batch = []; batchSize = 0;
    }
    batch.push(f); batchSize += fSize;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

async function fetchServerManifest() {
  const r = await fetch(API_BASE + '/apps/' + SUBDOMAIN + '/files');
  if (!r.ok) { console.error('Failed to fetch manifest:', r.status); return null; }
  const j = await r.json();
  const map = new Map();
  for (const f of j.files || []) map.set(f.name, f.hash);
  return map;
}

// Every upload batch becomes a version, so an interrupted deploy leaves the
// live app serving a half-updated mixture with no way to tell from the outside.
// The API has no rollback verb - what it has is the ability to read any past
// version's files back - so a rollback is "fetch what that version served and
// push it again", which lands as a new version rather than erasing history.
async function listVersions(limit) {
  const r = await fetch(API_BASE + '/apps/' + SUBDOMAIN + '/versions');
  if (!r.ok) { console.error('Failed to list versions:', r.status); return null; }
  const j = await r.json();
  const versions = j.versions || [];
  console.log('current version: ' + j.current_version);
  for (const v of versions.slice(0, limit)) {
    console.log('  ' + String(v.version).padStart(5) + '  ' + v.created_at +
      (v.is_current ? '  <- current' : '  ') + '  ' + (v.message || ''));
  }
  return j;
}

async function rollback(version, dryRun, full) {
  console.log('Reading version ' + version + '...');
  const listUrl = API_BASE + '/apps/' + SUBDOMAIN + '/files?version=' + version;
  const r = await fetch(listUrl);
  if (!r.ok) { console.error('Cannot read version ' + version + ':', r.status); return 1; }
  const listing = await r.json();
  const target = listing.files || [];
  if (!target.length) { console.error('Version ' + version + ' lists no files'); return 1; }
  console.log('  ' + target.length + ' files in version ' + version);

  // Restore only what actually differs, the same way --update only uploads
  // what differs. A version can hold hundreds of files that no deploy has
  // touched in months; re-pushing those is tens of MB of traffic to write
  // back bytes that are already correct.
  let names = target.map(f => f.name);
  if (!full) {
    const live = await fetchServerManifest();
    if (live) {
      names = target
        .filter(f => live.get(f.name) !== f.hash)
        .map(f => f.name);
      console.log('  ' + names.length + ' differ from what is live now');
    }
  }
  if (!names.length) {
    console.log('Nothing to restore: the live app already matches version ' + version);
    return 0;
  }

  const files = [];
  for (const name of names) {
    const url = API_BASE + '/apps/' + SUBDOMAIN + '/files/' +
      name.split('/').map(encodeURIComponent).join('/') + '?version=' + version;
    const fr = await fetch(url);
    if (!fr.ok) { console.error('  FAILED to read ' + name + ': ' + fr.status); return 1; }
    const buf = Buffer.from(await fr.arrayBuffer());
    // Same split the upload uses, so a file goes back exactly as it came.
    if (TEXT_EXTS.has(path.extname(name).toLowerCase())) {
      files.push({ name, content: buf.toString('utf-8') });
    } else {
      files.push({ name, content: buf.toString('base64'), encoding: 'base64' });
    }
  }

  const batches = splitIntoBatches(files);
  const bytes = files.reduce((n, f) => n + fileByteSize(f), 0);
  console.log('  ' + files.length + ' files, ' + (bytes / 1024).toFixed(0) +
    ' KB, ' + batches.length + ' batches');

  // A rollback is a write to a live site, so it can be inspected first.
  if (dryRun) {
    const shown = files.slice(0, 12).map(f => f.name);
    console.log('  would restore: ' + shown.join(', ') +
      (files.length > shown.length ? ', +' + (files.length - shown.length) + ' more' : ''));
    const current = await fetch(API_BASE + '/apps/' + SUBDOMAIN + '/files');
    if (current.ok) {
      const now = new Set(((await current.json()).files || []).map(f => f.name));
      // Orphans are measured against everything the target version had, not
      // against the subset being restored - the untouched files are already
      // correct and are not orphans just because they need no write.
      const everHad = new Set(target.map(f => f.name));
      const orphans = [...now].filter(n => !everHad.has(n));
      console.log('  live now: ' + now.size + ' files');
      // The API merges rather than replaces and has no delete, so anything
      // added after the target version stays on the server. Unreferenced by
      // the restored index.html, but still fetchable.
      console.log('  added since v' + version + ', would remain but be ' +
        'unreferenced: ' + orphans.length +
        (orphans.length ? ' (' + orphans.slice(0, 6).join(', ') +
          (orphans.length > 6 ? ', ...' : '') + ')' : ''));
    }
    console.log('DRY RUN - nothing was written');
    return 0;
  }

  console.log('Restoring as a new version in ' + batches.length + ' batches...');
  for (let i = 0; i < batches.length; i += 1) {
    // Every batch activates. It is tempting to activate only the last one so
    // an interrupted rollback cannot leave a half-restore live - but each PUT
    // branches from the *current* version, so a batch that does not activate
    // is discarded by the next one, and only the final batch's files survive.
    // That was tried here and restored 2 files out of 50.
    const body = {
      files: batches[i],
      message: 'Roll back to version ' + version,
      activate: true,
    };
    console.log('  batch ' + (i + 1) + '/' + batches.length + ' (' +
      batches[i].length + ' files)...');
    const res = await api('PUT', '/apps/' + SUBDOMAIN, body);
    if (res.status !== 200) {
      console.error('  batch failed: ' + res.status);
      return 1;
    }
  }
  console.log('Rolled back to version ' + version);
  return 0;
}

async function deploy() {
  const versionsArg = process.argv.includes('--versions');
  const rollbackArg = process.argv.find(a => a.startsWith('--rollback='));
  if (versionsArg) { await listVersions(30); return; }
  // Standalone repair pass: --verify on its own checks and heals the live site
  // without re-deploying anything.
  if (process.argv.includes('--verify') && !process.argv.includes('--update')
      && !process.argv.some(a => a.startsWith('--files='))) {
    await verifyServed();
    return;
  }
  if (rollbackArg) {
    const target = Number(rollbackArg.slice('--rollback='.length));
    if (!Number.isInteger(target) || target <= 0) {
      console.error('--rollback=N needs a version number; see --versions');
      process.exit(2);
    }
    process.exit(await rollback(target, process.argv.includes('--dry-run'),
      process.argv.includes('--full')));
  }

  const isUpdate = process.argv.includes('--update');
  const isFull = process.argv.includes('--full');
  const filesArg = process.argv.find(a => a.startsWith('--files='));
  // Default: --update implies sha256-diff against the server. Pass --full
  // to force a complete reupload (rare; useful if the manifest is stale).
  // --files= is always literal and skips diffing.
  const useDiff = isUpdate && !isFull && !filesArg;

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
    binFiles = collectBinaries().concat(collectFonts());
    let binBytes = 0;
    for (const f of binFiles) { const sz = f.content.length * 3 / 4; binBytes += sz; console.log('  ' + f.name + ' (' + (sz / 1024).toFixed(1) + 'KB)'); }
    console.log('Total binaries: ' + (binBytes / 1024).toFixed(0) + 'KB, ' + binFiles.length + ' files\n');
  }

  let allFiles = [...textFiles, ...binFiles];

  // What would go up, without going up: the asset set is derived now, so
  // "which files does this deploy think the site is made of" is a question
  // worth being able to ask before answering it live.
  if (process.argv.includes('--dry-run')) {
    console.log('Dry run: ' + allFiles.length + ' files would be considered.');
    return;
  }

  if (useDiff) {
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

  const appMeta = {
    subdomain: SUBDOMAIN,
    title: 'Wine-Assembly \u2014 Windows 98 Emulator',
    description: 'x86 Windows 98 PE interpreter in WebAssembly. Runs real Win32 executables in the browser.',
  };

  const batches = splitIntoBatches(allFiles);

  console.log('Split into ' + batches.length + ' batches\n');

  // First batch: create or update with metadata
  for (let i = 0; i < batches.length; i++) {
    const isFirst = i === 0;
    const body = isFirst
      ? { ...appMeta, files: batches[i] }
      : { subdomain: SUBDOMAIN, files: batches[i] };
    const transport = batches[i].some(f => f.encoding === 'base64') ? 'multipart' : 'json';

    if (isFirst && !isUpdate) {
      console.log('Creating app (batch 1/' + batches.length + ', ' + batches[i].length + ' files, ' + transport + ')...');
      const r = await api('POST', '/apps', body);
      console.log('Result:', r.status, r.data);
      if (r.status >= 400) return;
    } else {
      console.log('Updating (batch ' + (i + 1) + '/' + batches.length + ', ' + batches[i].length + ' files, ' + transport + ')...');
      const r = await api('PUT', '/apps/' + SUBDOMAIN, body);
      console.log('Result:', r.status);
      if (r.status >= 400 && r.status !== 404) {
        throw new Error(`batch ${i + 1}/${batches.length} failed with HTTP ${r.status}`
          + ` — the site now has batches 1..${i} of this deploy and the previous`
          + ` version of everything after; re-run to finish it`);
      }
    }
  }

  console.log('\nDone! Visit: https://' + SUBDOMAIN + '.berrry.app');

  if (process.argv.includes('--verify')) await verifyServed();
}

// Being in the server's file manifest is not the same as being served. An
// interrupted deploy can leave a file stored under a version that never went
// live, and because the next run diffs by sha256 it then sees the bytes
// already there and skips it forever — which is how the site kept 404ing
// fonts/w95fa.woff2 and every fonts/subset/*.ttf across two successful-looking
// deploys. So ask the live site, not the manifest, and re-upload whatever it
// will not hand back.
async function verifyServed() {
  console.log('\nVerifying what the live site actually serves...');
  const manifest = await fetchServerManifest();
  if (!manifest) return;
  const names = [...manifest.keys()];
  const base = 'https://' + SUBDOMAIN + '.berrry.app/';
  const missing = [];
  let done = 0, next = 0;
  const worker = async () => {
    for (let i = next++; i < names.length; i = next++) {
      const name = names[i];
      try {
        const r = await fetch(base + name.split('/').map(encodeURIComponent).join('/'),
          { method: 'HEAD' });
        if (r.status === 404) missing.push(name);
      } catch { /* a transport blip is not evidence the file is missing */ }
      if (++done % 100 === 0) console.log(`  ${done}/${names.length} checked`);
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));

  if (!missing.length) {
    console.log(`All ${names.length} files serve.`);
    return;
  }
  // Only re-upload what still exists locally; a file the repo dropped is
  // supposed to be gone, and its 404 is the correct answer.
  const local = missing.filter(n => fs.existsSync(path.join(ROOT, n)));
  console.log(`${missing.length} stored-but-not-served file(s); ${local.length} still in the repo:`);
  for (const n of missing) console.log(`  ${n}${local.includes(n) ? '' : '  (gone locally, leaving it)'}`);
  if (!local.length) return;

  for (const batch of splitIntoBatches(loadExplicitFiles(local))) {
    console.log(`Re-uploading ${batch.length} file(s)...`);
    const r = await api('PUT', '/apps/' + SUBDOMAIN, { subdomain: SUBDOMAIN, files: batch });
    console.log('Result:', r.status);
    if (r.status >= 400 && r.status !== 404) throw new Error(`re-upload failed: HTTP ${r.status}`);
  }
  console.log('Re-uploaded. Run --verify again to confirm.');
}

deploy().catch(e => { console.error(e); process.exit(1); });
