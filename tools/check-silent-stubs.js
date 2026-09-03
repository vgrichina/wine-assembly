#!/usr/bin/env node

'use strict';

const crypto = require('crypto');
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const PRINT_PIN = process.argv.includes('--print-pin');
const LIST = process.argv.includes('--list');

function functions(source, prefix) {
  const clean = source.replace(/;;.*$/gm, '');
  const result = [];
  for (let start = 0; (start = clean.indexOf(`(func $${prefix}`, start)) >= 0;) {
    let depth = 0;
    let end = start;
    for (; end < clean.length; end++) {
      if (clean[end] === '(') depth++;
      if (clean[end] === ')' && --depth === 0) { end++; break; }
    }
    result.push(clean.slice(start, end));
    start = end;
  }
  return result;
}

// A handler with no call, control-flow branch, fail-loud trap, or memory write
// cannot delegate work or publish an output buffer. It may still read state and
// mutate a global: that broader shape deliberately catches stateful-looking
// no-ops such as SetFileApisToOEM/ANSI, which escaped the old exact matcher.
const effectOrControl = /\((?:call(?:_indirect)?|return|unreachable|if|block|loop|br(?:_if|_table|_on_[A-Za-z0-9_]+)?|memory\.(?:fill|copy|init|grow)|table\.(?:set|fill|copy|init)|data\.drop|elem\.drop|(?:i32|i64|f32|f64|v128)\.(?:store\d*|atomic\.(?:store|rmw|cmpxchg|wait|notify)))\b/;
const isQuietHandler = flat =>
  !effectOrControl.test(flat) && !/\bunreachable\b/.test(flat);

function quietEntries(file, source) {
  const entries = [];
  for (const body of functions(source, 'handle_')) {
    const flat = body.replace(/\s+/g, ' ');
    const match = flat.match(/^\(func \$(handle_\S+)/);
    if (match && isQuietHandler(flat)) {
      entries.push({ name: `${file}:${match[1]}`, body: flat });
    }
  }
  return entries;
}

for (const [label, flat, expected] of [
  ['constant return', '(func $handle_X (global.set $eax (i32.const 1)))', true],
  ['stateful no-op', '(func $handle_X (global.set $mode (i32.const 1)) (global.set $eax (i32.const 1)))', true],
  ['delegating handler', '(func $handle_X (call $do_work))', false],
  ['output store', '(func $handle_X (i32.store (local.get $p) (i32.const 1)))', false],
  ['conditional behavior', '(func $handle_X (if (local.get $p) (then (nop))))', false],
  ['fail loud', '(func $handle_X unreachable)', false],
]) {
  if (isQuietHandler(flat) !== expected) {
    throw new Error(`quiet-handler classifier self-check failed: ${label}`);
  }
}

const quiet = [];
for (const file of fs.readdirSync(SRC).filter(name => name.endsWith('.wat')).sort()) {
  const source = fs.readFileSync(path.join(SRC, file), 'utf8');
  quiet.push(...quietEntries(file, source));
}

quiet.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
const digest = crypto.createHash('sha256')
  .update(quiet.map(entry => `${entry.name}:${entry.body}`).join('\n'))
  .digest('hex');
// This is a ratchet, not approval of the old entries. Any addition or mutation
// changes the digest and stops the build; deleting/fixing an entry deliberately
// lowers the count and updates the digest after review.
// 2026-08-31: 506 -> 505. Commit 34b4f08f ("Fix Win98 installer chain
// launches") gave handle_CreateProcessA a real implementation, so it left the
// quiet inventory. Ratchet only; nothing was added.
// 2026-08-31: 505 -> 508. MSVCRT startup helpers _lock, _unlock, and
// __lconv_init are documented compatibility no-ops for single-threaded CRT
// initialization paths.
// 2026-09-01: 508 -> 507. handle_IDirectDraw_WaitForVerticalBlank was the
// textbook silent success -- it set EAX=0 and returned, so a game that used
// the display as its clock was told the retrace had already happened. It now
// parks on a real vblank (yield_reason 13). Ratchet only; nothing was added.
// 2026-09-01: 507 -> 525. Minimal no-audio BASS compatibility handlers let
// shareware games bundled with bass.dll continue to gameplay.
// 2026-09-01: 525 -> 526. __mb_cur_max is a documented constant for the
// emulator's single-byte ANSI CRT environment.
// 2026-09-01: 526 -> 527. _cexit acknowledges CRT cleanup without process
// termination; returning terminator callbacks need a separate future path.
// 2026-09-01: 527 -> 528. _getdrive is a documented constant in the default
// single-drive C: process environment.
// 2026-09-01: 528 -> 529. _setmode acknowledges text/binary mode changes and
// returns the previous text mode because stdio streams are not distinguished.
// 2026-09-01: 529 -> 530. keybd_event is a legacy input-synthesis probe shim;
// browser-side input injection remains host-owned.
// 2026-09-01: 530 -> 531. joyGetPosEx mirrors joyGetPos for a no-joystick
// Win98 environment so startup probes can keep keyboard/mouse input.
// 2026-09-02: 531 -> 529. Legacy SetWindowsHookA/W now installs the same
// process-local keyboard/CBT callbacks as the Ex path, and UnhookWindowsHook
// removes only a matching installed procedure instead of always succeeding.
// 2026-09-02: 529 -> 516. DirectPlay's bounded local session now retains
// player/group identities, names, flags and memberships; its lifecycle and
// four entity enumerators update or traverse that state instead of returning
// success without work.
// 2026-09-02: 516 -> 514. SetPlayerData and SetGroupData now retain copied
// local/remote application data in the DirectPlay entity repository; their
// matching getters implement the Win98 size-query and readback contract.
// 2026-09-02: 514 -> 512. DirectPlayLobby EnumAddress now walks bounded
// compound-address chunks through a cancellation-aware callback, while
// EnumAddressTypes reports the local TCP/IP provider's required DPAID_INet.
// 2026-09-02: 512 -> 511. EnumLocalApplications validates its required
// callback and reserved flags, then truthfully enumerates the browser Win98
// machine's empty set of registered lobby-aware applications.
// 2026-09-02: 511 -> 502. Win32 DDEML now owns instance, copied HSZ,
// registered-service, conversation and data-object state; invalid, stale and
// cross-instance handles fail instead of fixed values succeeding silently.
// 2026-09-02: 502 -> 500. Begin/EndDeferWindowPos now allocate, validate,
// consume and free real bounded HDWP transactions; queued geometry remains
// unchanged until End applies it through the SetWindowPos behavior path.
// 2026-09-02: 500 -> 497. OpenClipboard/CloseClipboard now own an exclusive
// USER transaction, and GetClipboardOwner reports ownership assigned by
// EmptyClipboard instead of three fixed success/null answers.
// 2026-09-02: 497 -> 494. GetSubMenu now resolves real popup ownership,
// ModifyMenu mutates dynamic items, and DrawMenuBar validates and redraws the
// target window's non-client menu chrome instead of fixed success/handles.
// 2026-09-02: 494 -> 493. FindWindowA now searches the live top-level USER
// tree by optional class atom/name and title instead of always returning NULL.
// 2026-09-02: 493 -> 491. SetPriorityClass/GetPriorityClass now validate the
// emulated process handle and retain one shared Win98 priority class.
// 2026-09-02: 491 -> 489. GetThreadPriority/SetThreadPriority now validate
// thread identity and retain the Win98 relative priority on the thread object.
// 2026-09-02: 489 -> 488. SetErrorMode now atomically replaces and returns the
// shared Win98 x86 process error mode instead of always returning zero.
// 2026-09-02: 488 -> 483. COM/OLE initialization now owns per-thread apartment
// model and nesting state; the dead duplicate OleInitialize body is gone.
// 2026-09-02: 483 -> 482. TranslateMessage now distinguishes the four
// virtual-key messages from unrelated MSGs instead of always returning TRUE.
// 2026-09-02: 482 -> 480. SetThreadLocale and GetThreadLocale now retain real
// per-thread LCID state and carry it into newly created threads.
// 2026-09-02: 480 -> 479. BringWindowToTop now changes sibling/top-level
// z-order and activation state instead of reporting unconditional success.
// 2026-09-02: 479 -> 477. SetActiveWindow/GetActiveWindow now retain this
// thread queue's active top-level and deliver real activation transitions.
// 2026-09-02: 477 -> 476. UnregisterClassA/W now remove the matching owned
// class only after its last window is gone instead of always returning TRUE.
// 2026-09-02: 476 -> 473. Direct3D Device 1/2/3 GetStats now initializes all
// five D3DSTATS counters and rejects a null output buffer.
// 2026-09-02: 473 -> 472. ImageList_Destroy now validates and invalidates its
// handle and releases both the image-list record and retained icon array.
// 2026-09-02: 472 -> 471. CopyIcon now creates an independently owned copy of
// bitmap-backed, resource-backed, and opaque system icon handles.
// 2026-09-02: 471 -> 470. CopyImage now owns and resamples bitmap/icon/cursor
// images, including RETURNORG/DELETEORG, monochrome, and DIB-section requests.
// 2026-09-03: 470 -> 469. SHFileOperationA now delegates copy, move, rename,
// wildcard, multi-destination, and recursive delete work to the shared VFS.
// 2026-09-03: 469 -> 468. FlushFileBuffers now validates a live writable VFS
// file handle and reports access/handle errors instead of unconditional TRUE.
const EXPECTED_COUNT = 468;
const EXPECTED_SHA256 = '5fa72989413e4b2bc9ac6ce7f32747a21c5a139ac10ce7cdf87de02624852c69';

const pinLines = () => [
  `const EXPECTED_COUNT = ${quiet.length};`,
  `const EXPECTED_SHA256 = '${digest}';`,
];

if (PRINT_PIN || LIST) {
  if (LIST) for (const entry of quiet) console.log(`${entry.name}\n  ${entry.body}`);
  for (const line of pinLines()) console.log(line);
  process.exit(0);
}

if (quiet.length !== EXPECTED_COUNT || digest !== EXPECTED_SHA256) {
  console.error(`Silent-handler inventory changed: count=${quiet.length}, sha256=${digest}`);
  console.error('A new straight-line handler must implement behavior, delegate it, or fail loudly.');
  console.error('If existing quiet handlers were fixed, review with --list and paste this pin:');
  for (const line of pinLines()) console.error(line);
  process.exit(1);
}

// On a clean Git checkout, reject the historical failure mode where one
// commit changes handlers and a later commit merely catches the pin up. A
// classifier change may legitimately establish a new baseline without a WAT
// edit. Dirty development trees and source archives are handled by the normal
// inventory comparison above; this commit-boundary audit is extra CI evidence.
function git(args) {
  return childProcess.spawnSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function enforceSameCommitPin() {
  const inside = git(['rev-parse', '--is-inside-work-tree']);
  if (inside.status !== 0 || inside.stdout.trim() !== 'true') return;
  const parent = git(['rev-parse', '--verify', 'HEAD^']);
  if (parent.status !== 0) return;
  // Do not compare HEAD while testing uncommitted handler/tool edits.
  if (git(['diff', '--quiet', '--', 'src', 'tools/check-silent-stubs.js']).status !== 0) return;
  if (git(['diff', '--cached', '--quiet', '--',
    'src', 'tools/check-silent-stubs.js']).status !== 0) return;

  const oldToolResult = git(['show', 'HEAD^:tools/check-silent-stubs.js']);
  if (oldToolResult.status !== 0) return;
  const oldTool = oldToolResult.stdout;
  const newTool = fs.readFileSync(__filename, 'utf8');
  const pinOnly = text => text.replace(
    /^const EXPECTED_(?:COUNT|SHA256) = .*;$/gm, '');
  const pinText = text => (text.match(
    /^const EXPECTED_(?:COUNT|SHA256) = .*;$/gm) || []).join('\n');
  if (pinText(oldTool) === pinText(newTool)) return;
  if (pinOnly(oldTool) !== pinOnly(newTool)) return; // classifier/tool change

  const changed = git(['diff', '--name-only', 'HEAD^', 'HEAD', '--', 'src']);
  if (changed.status !== 0) return;
  let inventoryChanged = false;
  for (const relative of changed.stdout.trim().split('\n').filter(
    name => name.endsWith('.wat'))) {
    const file = path.basename(relative);
    const oldResult = git(['show', `HEAD^:${relative}`]);
    const oldEntries = oldResult.status === 0
      ? quietEntries(file, oldResult.stdout) : [];
    const currentPath = path.join(ROOT, relative);
    const newEntries = fs.existsSync(currentPath)
      ? quietEntries(file, fs.readFileSync(currentPath, 'utf8')) : [];
    const serial = entries => entries
      .map(entry => `${entry.name}:${entry.body}`).sort().join('\n');
    if (serial(oldEntries) !== serial(newEntries)) {
      inventoryChanged = true;
      break;
    }
  }
  if (!inventoryChanged) {
    console.error('Silent-handler pin changed without an inventory or classifier change in this commit.');
    console.error('Re-pin in the same commit that changes the handler inventory.');
    process.exit(1);
  }
}

enforceSameCommitPin();

// D3D9 HRESULT success with an untouched output pointer is especially toxic:
// it hands the guest NULL/stale resources and the eventual failure names an
// unrelated call. Scalar-return getters are deliberately not in this set.
const d3d9 = fs.readFileSync(path.join(SRC, '09ad-handlers-d3d9.wat'), 'utf8');
const dangerous = [];
for (const body of functions(d3d9, 'handle_IDirect3D')) {
  const flat = body.replace(/\s+/g, ' ');
  const match = flat.match(/^\(func \$(handle_\S+) (?:\(param [^)]+\) )*\(global\.set \$eax \(i32\.const 0\)\) \(global\.set \$esp \(i32\.add \(global\.get \$esp\) \(i32\.const ([^)]+)\)\)\)\)$/);
  if (!match) continue;
  const name = match[1];
  if (/(?:_QueryInterface|_Create|_Lock)/.test(name) ||
      /_Get(?:AdapterIdentifier|DeviceCaps|DisplayMode|GammaRamp|RenderTarget|DepthStencilSurface|Transform|Viewport|Material|Light|LightEnable|ClipPlane|RenderState|ClipStatus|Texture|TextureStageState|SamplerState|PaletteEntries|CurrentTexturePalette|ScissorRect|FVF|LevelDesc|SurfaceLevel|Desc)$/.test(name)) {
    dangerous.push(name);
  }
}
if (dangerous.length) {
  console.error('D3D9 output/resource methods may not silently return D3D_OK:');
  for (const name of dangerous) console.error(`  ${name}`);
  process.exit(1);
}

console.log(`PASS  straight-line silent-handler inventory is pinned (${quiet.length})`);
console.log('PASS  D3D9 resource/output stubs fail loudly');
