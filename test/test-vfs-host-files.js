const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { expandIncludePatterns } = require('../lib/vfs-host-files');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-vfs-include-'));
try {
  const appDir = path.join(root, 'app');
  const siblingDir = path.join(root, 'Shared');
  fs.mkdirSync(path.join(appDir, 'plugins', 'nested'), { recursive: true });
  fs.mkdirSync(siblingDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, 'game.exe'), 'exe');
  fs.writeFileSync(path.join(appDir, 'readme.txt'), 'text');
  fs.writeFileSync(path.join(appDir, 'unrelated.bin'), 'unrelated');
  fs.writeFileSync(path.join(appDir, 'plugins', 'input.dll'), 'dll');
  fs.writeFileSync(path.join(appDir, 'plugins', 'nested', 'visual.dll'), 'dll');
  fs.writeFileSync(path.join(appDir, 'plugins', 'nested', 'notes.txt'), 'text');
  fs.writeFileSync(path.join(siblingDir, 'shared.dat'), 'data');

  assert.deepStrictEqual(
    expandIncludePatterns(appDir, ['readme.txt']).map(file => file.guestPath),
    ['readme.txt'],
    'an exact include should mount only that file');

  assert.deepStrictEqual(
    expandIncludePatterns(appDir, ['plugins/**/*.dll']).map(file => file.guestPath),
    ['plugins/input.dll', 'plugins/nested/visual.dll'],
    'a recursive include should retain the matching directory layout');

  assert.deepStrictEqual(
    expandIncludePatterns(appDir, ['../Shared/*.dat']).map(file => file.guestPath),
    ['Shared/shared.dat'],
    'an explicit sibling include should mount below the sibling directory name');

  assert.throws(() => expandIncludePatterns(appDir, ['missing/*.dat']),
    /matched no files/, 'a typo must not silently produce an incomplete VFS');
  assert.throws(() => expandIncludePatterns(appDir, [path.join(root, '**')]),
    /must be relative/, 'absolute patterns must not broaden the host boundary');

  console.log('VFS host include tests: 5 passed, 0 failed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
