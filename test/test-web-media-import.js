#!/usr/bin/env node
// Drop a zip on the desktop and play what is inside it.
//
// This is the end-to-end shape of docs/design-byo-media.md phase ④, and it has
// to be a browser test because every interesting part of it is browser-only:
// the <input type=file> import path, the insert dialog, IndexedDB, OPFS, and a
// launch that reaches a real guest window. The node tests underneath it
// (test-media-sniff, test-zip-mount, test-vfs-lazy-entry) cover the parsing and
// the VFS; nothing but a page can cover the seam between them.
//
// Two passes, because they fail differently:
//
//   1. session import   upload the archive through the real file input, drive
//                       the real dialog, and require a guest WINDOW at the end
//                       -- not merely a registered app. A mount that produced
//                       plausible VFS entries but bytes the PE loader cannot
//                       use would pass every check short of this one.
//
//   2. kept import      the same archive with "keep", then a full page RELOAD.
//                       This is the only assertion that distinguishes storage
//                       that works from storage that merely did not throw: the
//                       icon has to be rebuilt from IndexedDB, and its bytes
//                       have to still be in OPFS, in a page that never saw the
//                       original File object.
//
// The fixture is a real archive built by the system `zip` around a real
// program (notepad.exe), for the reason make-test-zip.js gives: an archive
// produced by our own writer proves nothing about the ones people drop.

'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const puppeteer = require('puppeteer');

const ROOT = path.join(__dirname, '..');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = path.join(ROOT, 'test', 'output', 'media-import');
const EXE = path.join(ROOT, 'binaries', 'notepad.exe');

if (!fs.existsSync(CHROME)) {
  console.log('SKIP  Chrome not found for media import test');
  process.exit(0);
}
if (!fs.existsSync(EXE)) {
  console.log('SKIP  binaries/notepad.exe missing for media import test');
  process.exit(0);
}

// A zip holding one program, the way a shareware download did.
function makeFixture() {
  let zipBin = null;
  try { zipBin = execFileSync('/usr/bin/which', ['zip'], { encoding: 'utf8' }).trim(); }
  catch (_) { return null; }
  if (!zipBin) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-media-import-'));
  const stage = path.join(dir, 'notepad');
  fs.mkdirSync(stage);
  fs.copyFileSync(EXE, path.join(stage, 'NOTEPAD.EXE'));
  fs.writeFileSync(path.join(stage, 'README.TXT'), 'from the archive\r\n');
  const zipPath = path.join(dir, 'notepad-game.zip');
  execFileSync(zipBin, ['-q', '-r', zipPath, 'notepad'], { cwd: dir });
  return { dir, zipPath };
}

function startStaticServer() {
  const root = fs.realpathSync(ROOT);
  const server = http.createServer((request, response) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname); }
    catch (_) { response.writeHead(400); response.end(); return; }
    if (pathname === '/') pathname = '/index.html';
    const file = path.normalize(path.join(root, pathname));
    if (file !== root && !file.startsWith(root + path.sep)) {
      response.writeHead(403); response.end(); return;
    }
    fs.readFile(file, (error, data) => {
      if (error) { response.writeHead(error.code === 'ENOENT' ? 404 : 500); response.end(); return; }
      const types = {
        '.css': 'text/css', '.html': 'text/html', '.js': 'text/javascript',
        '.json': 'application/json', '.wasm': 'application/wasm',
      };
      response.writeHead(200, {
        'Content-Type': types[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      response.end(data);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function openPage(browser, base, label) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 800 });
  page.on('pageerror', error => console.log(`  [pageerror ${label}]`, error.message));
  page.on('console', msg => {
    const text = msg.text();
    if (/media|Mount|ERROR/i.test(text)) console.log(`  [console ${label}]`, text.slice(0, 200));
  });
  await page.goto(`${base}/index.html`, { waitUntil: 'load', timeout: 90000 });
  await page.waitForFunction(() => !!window.wineMedia && typeof launchApp === 'function',
    { timeout: 90000 });
  return page;
}

// Feed the archive through the page's own <input type=file>. This is the
// import path a phone uses (no drag-drop on iOS, no showOpenFilePicker in
// Safari), so it is the one worth driving rather than calling importFile().
async function uploadThroughInput(page, zipPath) {
  const input = await page.evaluateHandle(() => window.wineMedia._fileInput);
  await input.asElement().uploadFile(zipPath);
  await page.evaluate(() => {
    window.wineMedia._fileInput.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

const dialogState = () => {
  const modal = document.querySelector('.wa-media-modal');
  if (!modal) return null;
  return {
    title: modal.querySelector('.wa-media-title').textContent,
    body: modal.querySelector('.wa-media-body').textContent,
    hasKeep: !!modal.querySelector('input[type=radio]:not(:checked)'),
    launchChecked: modal.querySelector('input[type=checkbox]').checked,
  };
};

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const fixture = makeFixture();
  if (!fixture) {
    console.log('SKIP  system `zip` not available to build the media fixture');
    return;
  }
  const server = await startStaticServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--disable-gpu', '--no-sandbox', '--no-first-run'],
  });

  try {
    // ---- pass 1: session import, through the dialog, to a window ----------
    const page = await openPage(browser, base, 'session');

    // Desktop furniture rule: the button shows with the desktop and hides
    // with it — a fullscreen surface must not have a DOM button floating on
    // top of the game.
    const btnDisplay = (cls) => page.evaluate((toggled) => {
      const body = document.body;
      const had = body.className;
      if (toggled) body.className = `${had} ${toggled}`.trim();
      const display = getComputedStyle(
        document.querySelector('.wa-media-import-btn')).display;
      body.className = had;
      return display;
    }, cls);
    assert.notStrictEqual(await btnDisplay(''), 'none',
      'the + Add a game button shows on the idle desktop');
    assert.strictEqual(await btnDisplay('exclusive-fullscreen'), 'none',
      'the button hides over an exclusive-fullscreen surface');
    assert.strictEqual(await btnDisplay('single-app app-running'), 'none',
      'the button hides while a single-app page runs its app');

    await uploadThroughInput(page, fixture.zipPath);

    await page.waitForFunction(() => !!document.querySelector('.wa-media-modal'), { timeout: 30000 });
    const dialog = await page.evaluate(dialogState);
    await page.screenshot({ path: path.join(OUT, 'insert-dialog.png') });
    assert.match(dialog.title, /notepad-game\.zip/, 'the dialog names the media');
    assert.match(dialog.body, /ZIP archive/, `the dialog says what it detected: ${dialog.body}`);
    assert.match(dialog.body, /NOTEPAD\.EXE/i, 'the dialog names the program it found');
    assert.match(dialog.body, /c:\\program files\\notepad-game/i,
      `the dialog says where it mounts: ${dialog.body}`);
    assert.strictEqual(dialog.launchChecked, true, '"launch after insert" is on by default');

    // Session-only is the default and stays selected; OK does the rest.
    const defaultIsSession = await page.evaluate(() => {
      const radios = [...document.querySelectorAll('.wa-media-modal input[type=radio]')];
      return radios[0].checked && !radios[1].checked;
    });
    assert.ok(defaultIsSession, 'this-session-only is the default choice');

    await page.evaluate(() => {
      [...document.querySelectorAll('.wa-media-modal button')]
        .find(b => b.textContent === 'OK').click();
    });

    // A registered app is not the assertion -- a guest window is.
    await page.waitForFunction(() => {
      const app = runningApps.find(item => item && item.wine && item.wine.running);
      if (!app) return false;
      const lo = app.wine._hwndBase || 0;
      return Object.keys(sharedRenderer.windows)
        .some(hwnd => Number(hwnd) >= lo && Number(hwnd) < lo + 0x10000);
    }, { timeout: 180000 });
    await page.screenshot({ path: path.join(OUT, 'session-running.png') });

    const session = await page.evaluate(() => {
      const wine = runningApps[0].wine;
      const vfs = wine._helpCtx.vfs;
      const icon = document.querySelector('.desktop-icon[data-media-badge="session"]');
      return {
        appId: runningApps[0].name,
        badge: icon ? icon.dataset.mediaBadge : null,
        iconLabel: icon ? icon.querySelector('.icon-label').textContent : null,
        mounted: [...vfs.files.keys()].filter(p => p.includes('notepad-game')),
        sessionCount: window.wineMedia.sessionItems.size,
      };
    });
    assert.strictEqual(session.badge, 'session',
      'a session import is badged as one, because it is gone on reload');
    assert.match(session.iconLabel, /^\(~\)/, `the (~) badge is on the icon: ${session.iconLabel}`);
    assert.ok(session.mounted.some(p => /notepad\.exe$/.test(p)),
      `the archive really mounted: ${JSON.stringify(session.mounted)}`);
    assert.ok(session.mounted.some(p => /readme\.txt$/.test(p)),
      'the archive mounted whole, not just the exe');
    console.log('  ok    dropped zip mounted, launched, and reached a window');

    // ---- pass 2: keep it, reload, and find it again -----------------------
    await page.evaluate(() => stopAllApps());
    await uploadThroughInput(page, fixture.zipPath);
    await page.waitForFunction(() => !!document.querySelector('.wa-media-modal'), { timeout: 30000 });

    const keepable = await page.evaluate(() => {
      const radios = [...document.querySelectorAll('.wa-media-modal input[type=radio]')];
      return !radios[1].disabled;
    });
    if (!keepable) {
      // A browser with no OPFS degrades to session-only by design; say so
      // rather than failing, but never silently skip it in Chrome.
      throw new Error('the keep option was disabled in Chrome, which does have OPFS');
    }
    await page.evaluate(() => {
      const radios = [...document.querySelectorAll('.wa-media-modal input[type=radio]')];
      radios[1].click();
      // Nothing should launch this time: the reload is the assertion.
      document.querySelector('.wa-media-modal input[type=checkbox]').click();
      [...document.querySelectorAll('.wa-media-modal button')]
        .find(b => b.textContent === 'OK').click();
    });
    await page.waitForFunction(
      () => !!document.querySelector('.desktop-icon[data-media-badge="kept"]'), { timeout: 120000 });
    await page.screenshot({ path: path.join(OUT, 'kept.png') });

    // The catalog is what a reload reads, so check what actually landed in it.
    const stored = await page.evaluate(async () => {
      const lib = await window.mediaLibrary.MediaLibrary.open();
      const rows = await lib.list();
      const estimate = await window.mediaLibrary.MediaLibrary.estimate();
      const persisted = await navigator.storage.persisted();
      const file = rows.length ? await lib.fileFor(rows[0].id) : null;
      lib.close();
      return {
        rows: rows.map(r => ({
          name: r.name, kind: r.kind, size: r.size, state: r.state,
          exePath: r.exePath, schema: r.schema, hasHash: !!r.sha256,
        })),
        opfsSize: file ? file.size : -1,
        estimate,
        persisted,
      };
    });
    assert.strictEqual(stored.rows.length, 1, `exactly one library row: ${JSON.stringify(stored.rows)}`);
    const row = stored.rows[0];
    assert.strictEqual(row.state, 'complete', 'only a completed copy is listed');
    assert.strictEqual(row.kind, 'zip', 'the catalog remembers what it is');
    assert.strictEqual(row.schema, 1, 'rows carry their schema version');
    assert.ok(row.hasHash, 'the row carries a content digest');
    assert.match(row.exePath, /notepad\.exe$/i, 'the catalog remembers which program to launch');
    assert.strictEqual(stored.opfsSize, row.size,
      'the OPFS copy is the whole archive, not a truncated one');
    assert.ok(stored.estimate && stored.estimate.quota > 0, 'site storage reports a quota');
    console.log(`  ok    kept in OPFS + IndexedDB (${row.size} bytes, ` +
      `persist granted=${stored.persisted})`);

    // The real test of "kept": a page that never saw the File.
    await page.close();
    const fresh = await openPage(browser, base, 'reload');
    await fresh.waitForFunction(
      () => !!document.querySelector('.desktop-icon[data-media-badge="kept"]'), { timeout: 60000 });
    const restored = await fresh.evaluate(() => {
      const icon = document.querySelector('.desktop-icon[data-media-badge="kept"]');
      return {
        label: icon.querySelector('.icon-label').textContent,
        appId: icon.dataset.app,
        registered: !!window.wineMedia.keptItems.size,
        sessionCount: window.wineMedia.sessionItems.size,
      };
    });
    assert.match(restored.label, /^\(o\)/, `kept media wears the (o) badge: ${restored.label}`);
    assert.strictEqual(restored.sessionCount, 0,
      'a reload really did drop the session import -- the badge was honest');

    // And it still runs, from bytes that only exist in OPFS now.
    await fresh.evaluate((appId) => window.wineMedia.launch(appId), restored.appId);
    await fresh.waitForFunction(() => {
      const app = runningApps.find(item => item && item.wine && item.wine.running);
      if (!app) return false;
      const lo = app.wine._hwndBase || 0;
      return Object.keys(sharedRenderer.windows)
        .some(hwnd => Number(hwnd) >= lo && Number(hwnd) < lo + 0x10000);
    }, { timeout: 180000 });
    await fresh.screenshot({ path: path.join(OUT, 'kept-relaunched.png') });
    console.log('  ok    kept media survived a reload and launched from OPFS');

    // My Media lists it, and says the honest thing about durability.
    const shelf = await fresh.evaluate(async () => {
      await window.wineMedia.showLibrary();
      await new Promise(r => setTimeout(r, 400));
      const modal = [...document.querySelectorAll('.wa-media-modal')].pop();
      return {
        rows: modal.querySelectorAll('.wa-media-row').length,
        badges: [...modal.querySelectorAll('.wa-media-badge')].map(b => b.textContent),
        foot: modal.querySelector('.wa-media-foot').textContent,
      };
    });
    assert.strictEqual(shelf.rows, 1, 'My Media lists the kept import');
    assert.deepStrictEqual(shelf.badges, ['(o)'], 'and badges it as kept');
    assert.match(shelf.foot, /site storage available/,
      `the footer labels the estimate as origin headroom: ${shelf.foot}`);
    assert.match(shelf.foot, /Eviction protection: (granted|not granted)/,
      `the footer states the persist() answer either way: ${shelf.foot}`);
    console.log('  ok    My Media reports storage and eviction protection honestly');

    // ---- pass 3: a bare exe, and the icon walked out of its resources ------
    //
    // The design's promise is that an import is indistinguishable from a
    // built-in app, and the icon is most of that. A dropped program has no URL
    // for the icon walker, so this is the one path that proves the bytes entry
    // point in lib/resources-icon.js is actually reached.
    await fresh.evaluate(() => {
      stopAllApps();
      [...document.querySelectorAll('.wa-media-modal')].forEach(m => m.remove());
    });
    await uploadThroughInput(fresh, EXE);
    await fresh.waitForFunction(() => !!document.querySelector('.wa-media-modal'), { timeout: 30000 });
    const exeDialog = await fresh.evaluate(dialogState);
    assert.match(exeDialog.body, /Windows program/, `an MZ is detected as a program: ${exeDialog.body}`);
    await fresh.evaluate(() => {
      document.querySelector('.wa-media-modal input[type=checkbox]').click();  // don't launch
      [...document.querySelectorAll('.wa-media-modal button')]
        .find(b => b.textContent === 'OK').click();
    });
    await fresh.waitForFunction(
      () => [...document.querySelectorAll('.desktop-icon[data-media-badge="session"]')].length > 0,
      { timeout: 60000 });
    const bareExe = await fresh.evaluate(() => {
      const icon = document.querySelector('.desktop-icon[data-media-badge="session"]');
      const img = icon.querySelector('.icon-img img');
      return {
        label: icon.querySelector('.icon-label').textContent,
        iconIsImage: !!img,
        iconSrc: img ? img.src.slice(0, 22) : null,
      };
    });
    assert.ok(bareExe.iconIsImage,
      'a dropped exe wears its own icon, extracted from its resources');
    assert.strictEqual(bareExe.iconSrc, 'data:image/png;base64,',
      `the icon is a real extracted PNG: ${bareExe.iconSrc}`);
    console.log('  ok    a bare exe imports with the icon from its own resources');

    console.log('PASS  media import: drop, mount, launch, keep, reload, relaunch');
  } finally {
    await browser.close();
    server.close();
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
