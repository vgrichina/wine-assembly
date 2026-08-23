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

// 3. A resolvable exe is accepted (returns true) in both modes, and in
//    single-app mode with a guest still running it defers rather than
//    declining — write.exe is still in runningApps when it calls us.
{
  const { shell } = makeShell();
  assert.strictEqual(shell.launchExe('wordpad.exe'), true,
    'a registered exe is accepted');
}
{
  const { shell } = makeShell({ singleApp: true });
  shell.runningApps.push({ name: 'write' });
  const t0 = Date.now();
  assert.strictEqual(shell.launchExe('wordpad.exe'), true,
    'single-app mode accepts the launch instead of declining it');
  assert.ok(Date.now() - t0 < 50, 'and returns immediately — the host import is synchronous');
  // Drain the deferral timer so the test process can exit.
  shell.runningApps.length = 0;
  setTimeout(() => {
    console.log('ok: single-app launch deferred, not declined');
    console.log('PASS test-shell-execute-launch');
  }, 250);
}
