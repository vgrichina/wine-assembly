const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'run.js');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-cli-vfs-'));

function run(extra = [], exe = path.join(temp, 'probe.exe')) {
  const result = spawnSync(process.execPath, [
    RUN,
    `--exe=${exe}`,
    '--no-build', '--no-renderer', '--max-batches=1', '--dump-vfs',
    '--quiet-api', '--quiet-blocks',
    ...extra,
  ], { cwd: ROOT, encoding: 'utf8' });
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

try {
  fs.copyFileSync(path.join(__dirname, 'binaries', 'notepad.exe'), path.join(temp, 'probe.exe'));
  fs.mkdirSync(path.join(temp, 'assets'));
  fs.mkdirSync(path.join(temp, 'unrelated'));
  fs.writeFileSync(path.join(temp, 'root.dat'), 'root');
  fs.writeFileSync(path.join(temp, 'assets', 'keep.dat'), 'keep');
  fs.writeFileSync(path.join(temp, 'assets', 'drop.txt'), 'drop');
  fs.writeFileSync(path.join(temp, 'unrelated', 'outside.bin'), 'outside');
  const captured = path.join(temp, 'captured');
  fs.mkdirSync(path.join(captured, 'windows', 'temp', 'wzs1.tmp'), { recursive: true });
  fs.writeFileSync(path.join(captured, 'windows', 'temp', 'wzs1.tmp', 'setup.dat'), 'setup');

  const bare = run();
  assert.match(bare, /c:\\probe\.exe \(/i);
  assert.doesNotMatch(bare, /root\.dat|keep\.dat|drop\.txt|outside\.bin/i,
    'a bare arbitrary --exe must not scan its host directory');

  const included = run(['--vfs-include=assets/*.dat']);
  assert.match(included, /c:\\assets\\keep\.dat \(/i);
  assert.doesNotMatch(included, /root\.dat|drop\.txt|outside\.bin/i,
    'an include glob must not mount non-matching or unrelated files');

  const mirrored = run(['--vfs-include=assets/*.dat', '--vfs-drive=D']);
  assert.match(mirrored, /d:\\probe\.exe \(/i);
  assert.match(mirrored, /d:\\assets\\keep\.dat \(/i);

  const registered = run([], path.join(__dirname, 'binaries', 'notepad.exe'));
  assert.match(registered, /c:\\notepad\.hlp \(/i);
  assert.match(registered, /c:\\notepad\.cnt \(/i);

  const replayed = run([
    `--vfs-tree=${captured}`, '--cwd=C:\\windows\\temp\\wzs1.tmp',
  ]);
  assert.match(replayed, /c:\\windows\\temp\\wzs1\.tmp\\setup\.dat \(/i);
  assert.doesNotMatch(replayed, /c:\\captured\\windows/i,
    'a captured tree root must map to the guest drive root, not become a directory');
  assert.match(replayed, /\[vfs\] working directory: c:\\windows\\temp\\wzs1\.tmp/i);

  console.log('CLI VFS include tests: 11 passed, 0 failed');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
