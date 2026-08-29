#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const ROOT = path.join(__dirname, '..');
const GAM = process.env.IWD_SAVE_GAM || path.join(ROOT,
  'build/local-candidate-smoke/icewind-dale-demo/saved-vfs/mpsave/000000001-quick-save/icewind.gam');
const URL = process.env.WINE_ASSEMBLY_URL || 'http://127.0.0.1:8080/index.html';

if (!fs.existsSync(GAM)) {
  console.log('SKIP  Icewind Dale Quick Save missing; run node test/test-icewind-dale-demo.js first');
  process.exit(0);
}

const bytes = fs.readFileSync(GAM);
assert(bytes.includes(Buffer.from('codex\0', 'ascii')),
  'the native Quick Save does not contain the created CODEX party member');

(async () => {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: ['--no-sandbox'],
  });
  try {
    const page = await browser.newPage();
    await page.goto(`${URL}?iwd-persistence=${Date.now()}`, { waitUntil: 'load', timeout: 60000 });
    const encoded = bytes.toString('base64');
    const first = await page.evaluate(async data => {
      localStorage.clear();
      const app = wineApps.APPS.icewind_dale_demo;
      const vfs = new FilesystemImports.VirtualFS();
      const persistence = VfsPersistence.attach(vfs, {
        appId: 'icewind_dale_demo',
        patterns: app.persistFiles,
      });
      const binary = atob(data);
      const payload = Uint8Array.from(binary, character => character.charCodeAt(0));
      const guestPath = 'c:\\mpsave\\000000001-quick-save\\icewind.gam';
      const handle = vfs.createFile(guestPath, 0x40000000, 2);
      const write = vfs.writeFile(handle, payload, payload.length);
      await Promise.resolve();
      persistence.flush();
      return {
        ok: !!(handle && write && write.ok),
        keys: Object.keys(localStorage).filter(key => key.startsWith(
          'wine-assembly:vfs:icewind_dale_demo:')),
      };
    }, encoded);
    assert(first.ok, 'the browser VFS did not write the native Quick Save');
    assert.strictEqual(first.keys.length, 1,
      'the Icewind Dale save was not stored under its app-scoped browser key');

    await page.reload({ waitUntil: 'load', timeout: 60000 });
    const restored = await page.evaluate(() => {
      const app = wineApps.APPS.icewind_dale_demo;
      const vfs = new FilesystemImports.VirtualFS();
      const persistence = VfsPersistence.attach(vfs, {
        appId: 'icewind_dale_demo',
        patterns: app.persistFiles,
      });
      const entry = vfs.files.get(
        'c:\\mpsave\\000000001-quick-save\\icewind.gam');
      const text = entry ? new TextDecoder('windows-1252').decode(entry.data) : '';
      return {
        restored: persistence.restored,
        size: entry ? entry.data.length : 0,
        hasCodex: text.includes('codex\0'),
      };
    });
    assert.deepStrictEqual(restored, {
      restored: 1,
      size: bytes.length,
      hasCodex: true,
    }, 'a fresh page did not restore the created CODEX party member byte-for-byte');

    console.log(`PASS  Icewind Dale web persistence restores CODEX from native Quick Save (${bytes.length} bytes)`);
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error && error.stack || error);
  process.exit(1);
});
