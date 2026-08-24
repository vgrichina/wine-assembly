// The desktop shows nothing between the click and the app's first window.
// RollerCoaster Tycoon stages a PE, fetches 76 data files and walks a DLL
// graph before it paints anything, and the only progress report is status
// text in the debug toolbar — which the live site hides. So the page wears
// Windows' AppStarting cursor for exactly that interval.
//
// Two pieces decide when that interval ends, and both are testable without a
// browser: "has this guest shown a window yet" (firstTopLevelWindow) and the
// in-flight boot count that drives the body class. The count is the subtle
// one — a ShellExecute hand-off (WRITE.EXE -> WordPad) puts two boots in
// flight, and the first to finish must not clear the second one's cursor.

const assert = require('assert');
const { createBrowserShell, firstTopLevelWindow } = require('../lib/browser-shell.js');

function win(props) {
  return Object.assign({ visible: true, isChild: false, w: 300, h: 200, zOrder: 0 }, props);
}

// 1. firstTopLevelWindow: what counts as "the app is on screen".
{
  const inst = {};
  const wine = { instance: inst };
  assert.strictEqual(firstTopLevelWindow(null, wine), null, 'no renderer yet');
  assert.strictEqual(firstTopLevelWindow({ windows: {} }, null), null, 'no guest');
  assert.strictEqual(firstTopLevelWindow({ windows: {} }, wine), null,
    'a renderer with no windows means the app has painted nothing');

  // Everything that is not a top-level window of this guest is ignored: the
  // child controls it creates first, a window it has created but not shown,
  // a 0x0 placeholder, and any window belonging to another running app.
  const rejects = {
    1: win({ wasm: inst, isChild: true }),
    2: win({ wasm: inst, visible: false }),
    3: win({ wasm: inst, w: 0, h: 0 }),
    4: win({ wasm: {} }),
  };
  assert.strictEqual(firstTopLevelWindow({ windows: rejects }, wine), null,
    'children, hidden, zero-sized and other guests do not end the boot');

  // Bottom of the z-order wins, so a splash or a startup dialog stacked over
  // the main window does not change which window is reported.
  const accepts = Object.assign({ 5: win({ wasm: inst, zOrder: 7, hwnd: 0x10005 }) }, rejects);
  accepts[6] = win({ wasm: inst, zOrder: 2, hwnd: 0x10001 });
  assert.strictEqual(firstTopLevelWindow({ windows: accepts }, wine).hwnd, 0x10001,
    'the bottom-most visible top-level window of this guest is the one');
  console.log('ok: firstTopLevelWindow');
}

// 2. The boot count, which is what actually toggles the cursor.
{
  const seen = [];
  const shell = createBrowserShell({
    apps: {},
    debugMode: false,
    screenCanvasSize: () => ({ w: 640, h: 480 }),
    onAppBootingChange: b => seen.push(b),
  });
  assert.strictEqual(shell.bootsInFlight, 0);
  assert.deepStrictEqual(seen, [], 'an idle desktop reports nothing');

  const first = shell.bootTicket();
  assert.deepStrictEqual(seen, [true], 'the first boot turns the cursor on');
  const second = shell.bootTicket();
  assert.strictEqual(shell.bootsInFlight, 2);
  assert.deepStrictEqual(seen, [true],
    'a second concurrent boot does not re-announce what is already true');

  first();
  assert.deepStrictEqual(seen, [true],
    'one boot finishing must not clear the other boot cursor');
  first();
  assert.strictEqual(shell.bootsInFlight, 1,
    'releasing the same ticket twice is a no-op, not a double decrement');

  second();
  assert.deepStrictEqual(seen, [true, false], 'the last boot turns the cursor off');
  assert.strictEqual(shell.bootsInFlight, 0);

  // Every launch path spends its ticket -- a failed fetch, a cancelled LAN
  // lobby, a PE that will not load. A stray release from any of those after
  // the count is already zero must not push it negative, or the next real
  // boot would never turn the cursor on.
  second();
  const third = shell.bootTicket();
  assert.deepStrictEqual(seen, [true, false, true],
    'a later boot still gets its cursor');
  third();
  assert.deepStrictEqual(seen, [true, false, true, false]);
  console.log('ok: boot count');
}

// 3. The success path holds the cursor until a window shows up, and lets go
//    if the guest dies first -- an app that never paints must not leave an
//    hourglass over the desktop forever.
{
  const shell = createBrowserShell({
    apps: {},
    debugMode: false,
    screenCanvasSize: () => ({ w: 640, h: 480 }),
  });
  // No renderer has been created (no launch has happened), so there is
  // nothing to poll and the ticket is spent immediately rather than leaking.
  let released = false;
  shell.releaseBootCursorOnFirstWindow({ instance: {} }, () => { released = true; });
  assert.strictEqual(released, true, 'with no renderer the cursor is released at once');
  console.log('ok: boot cursor release');
}

console.log('\nPASS test-boot-cursor');
