// ShellExecute("wordpad.exe") has to start a second guest.
//
// WRITE.EXE is a shim: its whole body is GetCommandLine, GetStartupInfo,
// ShellExecuteA("wordpad.exe"), ExitProcess(0). With the old host import
// (log + return 33) the dropdown entry rendered nothing at all. The shell
// now resolves the exe name against the same app registry the desktop icons
// read, which is the part worth pinning down here: name resolution, the
// unknown-exe decline, and the single-app deferral that exists because the
// launcher process is still in runningApps at the instant it calls us.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createBrowserShell } = require('../lib/browser-shell.js');

const apps = {
  wordpad:   { exe: 'binaries/win98-apps/wordpad.exe' },
  mspaint98: { exe: 'binaries/win98-apps/mspaint.exe' },
  write:     { exe: 'binaries/win98-apps/write.exe' },
};

function makeShell(opts = {}) {
  const launched = [];
  const logs = [];
  const shell = createBrowserShell({
    apps,
    debugMode: false,
    screenCanvasSize: () => ({ w: 640, h: 480 }),
    appendDebugLog: t => logs.push(t),
    singleApp: () => !!opts.singleApp,
  });
  // launchApp() boots a real guest against the DOM; the resolver is what this
  // test is about, so stand in for the boot itself.
  const realLaunch = shell.launchApp;
  shell.launchApp = key => { launched.push(key); };
  return { shell, launched, logs, realLaunch };
}

// 1. exe name -> app key, three ways.
{
  const { shell } = makeShell();
  assert.strictEqual(shell.appKeyForExe('wordpad.exe'), 'wordpad',
    'app key matches the exe stem');
  assert.strictEqual(shell.appKeyForExe('C:\\WINDOWS\\WordPad.EXE'), 'wordpad',
    'a full backslash path and mixed case still resolve');
  assert.strictEqual(shell.appKeyForExe('mspaint.exe'), 'mspaint98',
    'falls back to the registered exe basename when the key differs');
  assert.strictEqual(shell.appKeyForExe('nosuchprogram.exe'), null,
    'an unregistered exe resolves to nothing');
  assert.strictEqual(shell.appKeyForExe(''), null);
  console.log('ok: exe name resolution');
}

// 2. launchExe reports whether the name resolved, and declines unknown exes
//    without launching anything.
{
  const { shell, launched, logs } = makeShell();
  // launchExe closes over the module-internal launchApp, so exercise it
  // through a shell whose registry entry is what we assert on instead.
  assert.strictEqual(shell.launchExe('nosuchprogram.exe'), false,
    'unknown exe is declined');
  assert.strictEqual(launched.length, 0, 'nothing was launched');
  assert.ok(logs.some(l => l.includes('nosuchprogram.exe')),
    'the decline is visible in the debug log');
  console.log('ok: unknown exe declined');
}

// 3. VFS child launches keep the command line with the dynamic app, and the
//    real launcher passes app.args into loadExe() before the PE starts. Inno
//    bootstrap installers rely on this for their /SL4 handoff: without it the
//    child setup EXE looks for a missing sidecar .bin and shows only "Error".
{
  const { shell } = makeShell();
  const files = new Map([
    ['c:\\windows\\temp\\is-test.tmp\\child.tmp', { data: new Uint8Array([77, 90]), attrs: 0x20 }],
    ['c:\\ptanks.exe', { data: new Uint8Array([77, 90, 1]), attrs: 0x20 }],
  ]);
  const vfs = {
    files,
    dirs: new Set(['c:\\windows\\temp\\is-test.tmp']),
    readOnlyDrives: new Set(),
    cwd: 'c:\\windows\\temp\\is-test.tmp\\',
    _normPath: p => String(p).toLowerCase(),
    _resolvePath(p) {
      const value = /^[a-z]:/i.test(p) ? p : this.cwd + p;
      return this._normPath(value).replace(/\\+/g, '\\');
    },
    adoptFrom(other) {
      for (const [p, entry] of other.files) this.files.set(p, entry);
      for (const dir of other.dirs) this.dirs.add(dir);
    },
  };
  const caller = { _helpCtx: { vfs }, _runSliceAppKey: 'cue:speed-demons' };
  const ok = shell.launchVfsExe('C:\\windows\\temp\\is-test.tmp\\child.tmp',
    caller, '', '/SL4 $10001 "C:\\ptanks.exe" 2743738 52736');
  assert.strictEqual(ok, true, 'absolute child exe in the caller VFS is accepted');
  const child = apps['vfs:c:\\windows\\temp\\is-test.tmp\\child.tmp'];
  assert.ok(child, 'dynamic vfs app entry is registered');
  assert.strictEqual(child.args, '/SL4 $10001 "C:\\ptanks.exe" 2743738 52736',
    'dynamic child command line is preserved');
  assert.strictEqual(child.runSliceAppKey, 'cue:speed-demons',
    'dynamic child inherits the mounted app Auto run-slice policy');

  assert.strictEqual(shell.launchVfsExe('child.tmp', { _helpCtx: { vfs } }, '', ''), true,
    'relative child exe resolves against the caller working directory');
  assert.ok(apps['vfs:c:\\windows\\temp\\is-test.tmp\\child.tmp'],
    'relative launch registers the normalized absolute VFS executable');

  const shellSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'browser-shell.js'), 'utf8');
  assert.match(shellSource,
    /wine\.loadExe\(app\.exe,\s*\{[\s\S]*?\bargs:\s*app\.args,[\s\S]*?\}\)/,
    'browser launch must pass app.args into loadExe before PE startup');
  assert.match(shellSource,
    /vfs\.setCurrentDirectory\(app\.workingDirectory\)/,
    'browser launch must apply an imported-media executable directory before startup');
  assert.match(shellSource,
    /if \(app\.mirrorWorkingDirectoryToC && vfs\.files instanceof Map\)/,
    'browser launch must mirror imported sidecars beside its reported C:\\ executable path');
  assert.match(shellSource,
    /vfs\.copyFile\(path, alias, false\)/,
    'sidecar aliases must remain lazy but detach safely if the C: copy is written');
  assert(shellSource.indexOf('vfs.copyFile(path, alias, false)') <
      shellSource.indexOf('await attachDynamicOverlay(wine, app, sel)'),
    'base-media aliases must exist before overlay change tracking begins');
  const hostSource = fs.readFileSync(path.join(__dirname, '..', 'host.js'), 'utf8');
  assert.match(hostSource,
    /if \(absolute && shell\.launchVfsExe && shell\.launchVfsExe\(launchFile, self, launchDir, params\)\)/,
    'browser host offers relative and absolute executable names to the caller VFS');
  assert.strictEqual(
    (shellSource.match(/queuePendingLaunch\(key, SINGLE_APP\(\)\);/g) || []).length,
    2,
    'registered and inherited-VFS handoffs use the dormant process queue');
  assert.strictEqual(
    (shellSource.match(/if \(launchInFlight \|\| \(SINGLE_APP\(\) && runningApps\.length\)\)/g) || []).length,
    2,
    'all modes serialize boot while only single-app mode serializes process lifetime');
  assert.match(shellSource, /finally \{\s*launchInFlight = false;\s*dispatchPendingLaunch\(\);/,
    'ending the current boot wakes a child that was queued during synchronous startup');
  console.log('ok: vfs child launch keeps args before PE startup');
}

// DirectX 2 redistributables must not replace the newer emulated runtime.
{
  const { shell, launched, logs } = makeShell();
  assert.strictEqual(shell.launchVfsExe(
    'C:\\REDIST\\DIRECTX\\DXSETUP.EXE', null, '', ''), true,
    'legacy DXSETUP is accepted as already satisfied');
  assert.strictEqual(launched.length, 0, 'no obsolete driver installer is launched');
  assert(logs.some(line => /skipped obsolete DirectX setup/i.test(line)),
    'the DirectX no-op is visible in the debug log');
  console.log('ok: obsolete DirectX setup is already satisfied');
}

// War Wind asks to run that obsolete redistributable from its final setup
// dialog. Once the no-op succeeds, continue into the game from the completed
// installer VFS instead of leaving the Win16 bootstrap visible at 39%.
{
  const { shell, launched, logs } = makeShell();
  const installedPath = 'c:\\program files\\warwind\\ww.exe';
  const vfs = {
    files: new Map([[installedPath, { data: new Uint8Array([77, 90]), attrs: 0x20 }]]),
    dirs: new Set(['c:\\program files', 'c:\\program files\\warwind']),
    readOnlyDrives: new Set(),
    cwd: 'c:\\program files\\warwind\\',
    _normPath: p => String(p).toLowerCase(),
    _resolvePath(p) {
      const value = /^[a-z]:/i.test(p) ? p : this.cwd + p;
      return this._normPath(value).replace(/\\+/g, '\\');
    },
  };
  assert.strictEqual(shell.launchVfsExe(
    'C:\\REDIST\\DIRECTX\\DXSETUP.EXE', { _helpCtx: { vfs } }, '', ''), true);
  setTimeout(() => {
    assert.deepStrictEqual(launched, ['vfs:' + installedPath],
      'accepted final DXSETUP prompt starts the completed War Wind install');
    assert(logs.some(line => /starting installed War Wind after setup/i.test(line)),
      'the automatic handoff is visible in the debug log');
    console.log('ok: War Wind final setup prompt starts the installed game');
  }, 0);
}

// 4. An installer that exits without launching its game leaves a lightweight
//    filesystem snapshot behind for a later desktop/Start-menu launch.
{
  const { shell, launched } = makeShell();
  const installedPath = 'c:\\games\\icytower1.3\\icytower13.exe';
  const installerVfs = {
    files: new Map([[installedPath, { data: new Uint8Array([77, 90]), attrs: 0x20 }]]),
    dirs: new Set(['c:\\games', 'c:\\games\\icytower1.3']),
    readOnlyDrives: new Set(),
    cwd: 'c:\\games\\icytower1.3\\',
    _normPath: p => String(p).toLowerCase(),
    _resolvePath(p) {
      const value = /^[a-z]:/i.test(p) ? p : this.cwd + p;
      return this._normPath(value).replace(/\\+/g, '\\');
    },
  };
  const installer = { _helpCtx: { vfs: installerVfs } };
  shell.runningApps.push({ name: 'icy_tower_installer', wine: installer });
  global.window = {};
  global.document = { getElementById: () => null };
  shell.unregisterRunningApp(installer);
  delete global.window;
  delete global.document;
  installer._helpCtx = null;

  assert.strictEqual(shell.launchVfsExe(installedPath, installer, '', ''), true,
    'an installed exe remains launchable after its installer process exits');
  assert.deepStrictEqual(launched, ['vfs:' + installedPath],
    'the exited installer snapshot starts the requested installed executable');
  console.log('ok: exited installer VFS remains launchable');
}

// 5. A resolvable exe is accepted (returns true) in both modes, and in
//    single-app mode with a guest still running it defers rather than
//    declining — write.exe is still in runningApps when it calls us.
{
  const { shell } = makeShell();
  assert.strictEqual(shell.launchExe('wordpad.exe'), true,
    'a registered exe is accepted');
}
{
  const { shell, launched } = makeShell({ singleApp: true });
  const parent = {};
  shell.runningApps.push({ name: 'write', wine: parent });
  const t0 = Date.now();
  assert.strictEqual(shell.launchExe('wordpad.exe'), true,
    'single-app mode accepts the launch instead of declining it');
  assert.ok(Date.now() - t0 < 50, 'and returns immediately — the host import is synchronous');
  assert.deepStrictEqual(launched, [], 'the child remains dormant while its parent is alive');
  global.window = {};
  global.document = { getElementById: () => null };
  shell.unregisterRunningApp(parent);
  delete global.window;
  delete global.document;
  setTimeout(() => {
    assert.deepStrictEqual(launched, ['wordpad'], 'parent exit wakes exactly one queued child');
    console.log('ok: single-app launch deferred, not declined');
    console.log('PASS test-shell-execute-launch');
  }, 250);
}
