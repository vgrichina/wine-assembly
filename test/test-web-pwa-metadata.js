#!/usr/bin/env node
// Static PWA/iOS install coverage: iOS should be able to launch from the Home
// Screen without Safari tabs/address bar, and deploy must include the assets.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.webmanifest'), 'utf8'));
const deploy = fs.readFileSync(path.join(root, 'tools/deploy-berrry.js'), 'utf8');

assert(html.includes('<link rel="manifest" href="manifest.webmanifest">'), 'index.html should link the web app manifest');
assert(html.includes('apple-mobile-web-app-capable" content="yes"'), 'iOS Home Screen launch should use standalone mode');
assert(html.includes('apple-mobile-web-app-title" content="Wine-Assembly"'), 'iOS Home Screen app should have an explicit title');
assert(html.includes('apple-mobile-web-app-status-bar-style" content="black-translucent"'), 'iOS standalone status bar should be app-colored');
assert(html.includes('rel="apple-touch-icon" href="icons/apple-touch-icon.png"'), 'iOS Home Screen should have a touch icon');

assert.strictEqual(manifest.display, 'standalone', 'manifest should request standalone display');
assert.deepStrictEqual(manifest.display_override, ['fullscreen', 'standalone'], 'manifest should request fullscreen with standalone fallback');
assert.strictEqual(manifest.background_color, '#008080', 'manifest background should match desktop teal');
assert.strictEqual(manifest.theme_color, '#008080', 'manifest theme should match desktop teal');
assert(manifest.icons.some(i => i.src === 'icons/icon-192.png' && i.sizes === '192x192'), 'manifest should include a 192px icon');
assert(manifest.icons.some(i => i.src === 'icons/icon-512.png' && i.sizes === '512x512'), 'manifest should include a 512px icon');

for (const rel of ['icons/apple-touch-icon.png', 'icons/icon-192.png', 'icons/icon-512.png']) {
  const full = path.join(root, rel);
  assert(fs.existsSync(full), `${rel} should exist`);
  assert(fs.statSync(full).size > 500, `${rel} should be a non-empty PNG`);
}

assert(deploy.includes("'.webmanifest'"), 'deploy should treat webmanifest as text');
assert(deploy.includes("'icons'"), 'deploy should include the icons directory');
assert(deploy.includes("'.png'"), 'deploy should include PNG binary assets');

console.log('PASS  web PWA metadata supports iOS Home Screen launch');
