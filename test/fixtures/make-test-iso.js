// Build a small ISO 9660 + Joliet image at test time.
//
// The fixture is generated rather than checked in because the interesting
// properties are structural — a long name that only Joliet can spell, a
// subdirectory, a file bigger than one 2048-byte sector — and a real mastering
// tool is the only honest source of those. macOS ships one: `hdiutil
// makehybrid -iso -joliet`.
//
//   const { makeTestIso } = require('./fixtures/make-test-iso');
//   const { isoPath, entries, label } = makeTestIso();   // null when unavailable

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const LABEL = 'WATESTCD';

// Contents chosen to exercise the parser: an 8.3 name, a name too long for ISO
// level 1 (so the two descriptors disagree and Joliet selection is observable),
// a file spanning several sectors, and a nested directory.
function contents() {
  const big = Buffer.alloc(5000);
  for (let i = 0; i < big.length; i++) big[i] = (i * 7 + 13) & 0xff;
  return [
    { path: 'SETUP.EXE', data: Buffer.from('MZ\x90\x00fake executable payload\n', 'latin1') },
    { path: 'ReadMe Long Name.txt', data: Buffer.from('long joliet name\r\n') },
    { path: 'BIG.DAT', data: big },
    { path: path.join('DATA', 'NESTED.BIN'), data: Buffer.from([0, 1, 2, 3, 250, 251, 252, 253]) },
  ];
}

function haveHdiutil() {
  try {
    execFileSync('/usr/bin/hdiutil', ['help'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Returns null (with a printable reason) when the platform cannot master an
// image, so a caller can skip rather than fail on Linux CI.
function makeTestIso(opts = {}) {
  if (!haveHdiutil()) return { isoPath: null, reason: 'hdiutil is not available (macOS only)' };
  const dir = opts.dir || fs.mkdtempSync(path.join(os.tmpdir(), 'wa-iso-'));
  const src = path.join(dir, 'src');
  fs.mkdirSync(path.join(src, 'DATA'), { recursive: true });
  const entries = contents();
  for (const e of entries) fs.writeFileSync(path.join(src, e.path), e.data);
  const isoPath = path.join(dir, 'test.iso');
  try {
    execFileSync('/usr/bin/hdiutil', [
      'makehybrid', '-iso', '-joliet',
      '-default-volume-name', LABEL,
      '-iso-volume-name', LABEL,
      '-joliet-volume-name', LABEL,
      '-o', isoPath, src,
    ], { stdio: 'ignore' });
  } catch (e) {
    return { isoPath: null, reason: `hdiutil makehybrid failed: ${e.message}`, dir };
  }
  return { isoPath, dir, label: LABEL, entries };
}

module.exports = { makeTestIso, LABEL };
