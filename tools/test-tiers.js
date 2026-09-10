#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TEST_NAME = /^(?:test-[A-Za-z0-9._-]+|[A-Za-z0-9._-]+\.test)\.js$/;

// Most tests are fast, in-process UNIT tests. Browser/application tests use
// stable filename conventions so adding one does not require a second commit
// to a central manifest. These patterns are deliberately conservative: an
// unmatched test stays in the pre-commit tier instead of silently disappearing
// from it.
const E2E_PATTERNS = Object.freeze([
  /(?:-web|-gameplay|-candidate|-installer|-installers|-installed|-dosbox|-scummvm)\.js$/,
  /^test-(?:wordpad|mspaint|notepad|calc|winamp|pinball|spider|solitaire|freecell|funtris)-/,
  /^test-(?:minesweeper|taskman|web|cli|control|winrar|winhelp|cwordzap|cursor|blobby|empipe|generated)-/,
  /^test-win16-(?:dde|dialog|entertainment|hearts|idlewild|jigsawed|menus|minesweeper|pipe|solitaire|vb|web|wep)/,
  /^test-find-(?:cancel|mouse|typing)/,
  /^test-vlan-(?:browser|loopback|match|tetrinet)/,
  /^test-worker-(?:guest|thread-stuck-detect)/,
]);

// Names caught by an E2E convention whose implementation is intentionally a
// fast structural/in-process check. Keeping this list small and validated is
// the cost of useful broad conventions without evicting unit coverage from
// `run-all.sh quick`.
const UNIT_EXCEPTIONS = Object.freeze([
  'test-control-variant-gate.js',
  'test-pinball-web-lifecycle.js',
  'test-retina-scale2x-web.js',
  'test-solitaire-web.js',
  'test-web-fullscreen-consent.js',
  'test-web-page-fullscreen.js',
  'test-web-pinball-assets.js',
  'test-web-pwa-metadata.js',
  'test-web-touch-input.js',
  'test-winhelp-wat-parser.js',
]);

// Existing integration tests whose older names predate the conventions. New
// tests should prefer a descriptive -web/-gameplay/-candidate suffix instead
// of growing this compatibility list.
const E2E_EXCEPTIONS = Object.freeze([
  'test-about-cancel.js',
  'test-aoe-menu.js',
  'test-baldurs-gate-demos.js',
  'test-bricks-drag.js',
  'test-caesar3-fullscreen-metrics.js',
  'test-class-menu-from-dll.js',
  'test-combobox-pinball.js',
  'test-cruel-maximized-launch-layout.js',
  'test-cs-owndc-stats-font.js',
  'test-deus-ex-demo.js',
  'test-diablo-shareware-art.js',
  'test-dos-corpus-live-page.js',
  'test-entertainment-menu-client-layout.js',
  'test-fontview.js',
  'test-gdi-stock-select.js',
  'test-help.js',
  'test-heroes3-demo-launch.js',
  'test-icewind-dale-demo.js',
  'test-les-flat.js',
  'test-listbox-ownerdraw.js',
  'test-local-candidates-playability.js',
  'test-mplay32-dual-mode.js',
  'test-nethack-win32.js',
  'test-notepad.js',
  'test-open-cancel.js',
  'test-pyramid-menu.js',
  'test-regedit-deep.js',
  'test-shell-arrange-windows.js',
  'test-skifree-showwindow-startup.js',
  'test-sound-recorder-audio.js',
  'test-statusbar-surface.js',
  'test-sysmon-perfstats.js',
  'test-tapi-line-init.js',
  'test-tetrinet-connect.js',
  'test-tworld-launch.js',
  'test-volume-control-audio.js',
  'test-wat-windowposchanged.js',
  'test-winamp.js',
  'test-window-show-state.js',
  'test-wm-setcursor-on-show.js',
]);

const SMOKE_TESTS = Object.freeze([
  'test-all-exes.js',
  'test-d3dim-globe-go-menu.js',
  'test-d3dim-globe-render-menu.js',
  'test-d3dim-viewer-open-web.js',
  'test-d3dim-viewer-selection.js',
  'test-notepad-dialogs.js',
]);

// A quarantined test remains visible to the manifest gate but is not run. Map
// it to a measured failure reason; an empty reason is rejected. This is empty
// today, which is the desired state.
const QUARANTINE_REASONS = Object.freeze({});

const unitExceptions = new Set(UNIT_EXCEPTIONS);
const e2eExceptions = new Set(E2E_EXCEPTIONS);
const smokeTests = new Set(SMOKE_TESTS);

function normalizeTestName(relative) {
  const normalized = String(relative).replace(/\\/g, '/');
  const base = path.posix.basename(normalized);
  return TEST_NAME.test(base) ? base : null;
}

function conventionTier(base) {
  return E2E_PATTERNS.some(pattern => pattern.test(base)) ? 'e2e' : 'unit';
}

function classifyTest(relative) {
  const base = normalizeTestName(relative);
  if (!base) return null;
  if (Object.prototype.hasOwnProperty.call(QUARANTINE_REASONS, base)) return 'quarantine';
  if (smokeTests.has(base)) return 'smoke';
  if (unitExceptions.has(base)) return 'unit';
  if (e2eExceptions.has(base)) return 'e2e';
  return conventionTier(base);
}

function discoverTests(root = ROOT) {
  return fs.readdirSync(path.join(root, 'test'), { withFileTypes: true })
    .filter(entry => entry.isFile() && TEST_NAME.test(entry.name))
    .map(entry => `test/${entry.name}`)
    .sort();
}

function validateTiers(root = ROOT) {
  const errors = [];
  const actual = discoverTests(root);
  const actualBases = new Set(actual.map(file => path.posix.basename(file)));
  const configured = [
    ...UNIT_EXCEPTIONS,
    ...E2E_EXCEPTIONS,
    ...SMOKE_TESTS,
    ...Object.keys(QUARANTINE_REASONS),
  ];
  const seen = new Set();
  for (const base of configured) {
    if (seen.has(base)) errors.push(`${base} appears in more than one explicit tier list`);
    seen.add(base);
    if (!actualBases.has(base)) errors.push(`${base} is an explicit tier entry but no test file exists`);
  }
  for (const base of UNIT_EXCEPTIONS) {
    if (conventionTier(base) !== 'e2e') errors.push(`${base} is a redundant UNIT exception`);
  }
  for (const base of E2E_EXCEPTIONS) {
    if (conventionTier(base) !== 'unit') errors.push(`${base} is a redundant E2E exception`);
  }
  for (const [base, reason] of Object.entries(QUARANTINE_REASONS)) {
    if (!String(reason).trim()) errors.push(`${base} is quarantined without a measured reason`);
  }

  const tiers = { unit: [], e2e: [], smoke: [], quarantine: [] };
  for (const file of actual) {
    const tier = classifyTest(file);
    if (!tier || !tiers[tier]) errors.push(`${file} was not assigned to a known tier`);
    else tiers[tier].push(file);
  }
  const placed = Object.values(tiers).reduce((sum, files) => sum + files.length, 0);
  if (placed !== actual.length) {
    errors.push(`placed ${placed} tier entries for ${actual.length} test files`);
  }
  return { actual, errors, tiers };
}

function main() {
  const command = process.argv[2] || '--check';
  const result = validateTiers();
  if (result.errors.length) {
    for (const error of result.errors) console.error(`test tiers: ${error}`);
    process.exitCode = 1;
    return;
  }
  if (command === '--check') {
    const { unit, e2e, smoke, quarantine } = result.tiers;
    console.log(`test tiers: OK (${result.actual.length} files: ` +
      `${unit.length} unit, ${e2e.length} e2e, ${smoke.length} smoke, ` +
      `${quarantine.length} quarantined)`);
    return;
  }
  if (!Object.prototype.hasOwnProperty.call(result.tiers, command)) {
    console.error('usage: tools/test-tiers.js [--check|unit|e2e|smoke|quarantine]');
    process.exitCode = 2;
    return;
  }
  process.stdout.write(result.tiers[command].join('\n') +
    (result.tiers[command].length ? '\n' : ''));
}

if (require.main === module) main();

module.exports = {
  E2E_EXCEPTIONS,
  E2E_PATTERNS,
  QUARANTINE_REASONS,
  SMOKE_TESTS,
  TEST_NAME,
  UNIT_EXCEPTIONS,
  classifyTest,
  conventionTier,
  discoverTests,
  normalizeTestName,
  validateTiers,
};
