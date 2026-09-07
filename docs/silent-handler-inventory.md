# Silent-handler inventory history

The build gate in `tools/check-silent-stubs.js` rejects additions or mutations
to straight-line handlers that cannot delegate work, publish output, branch, or
fail loudly. Its executable source intentionally contains only the classifier,
the current count/hash pin, and enforcement. This file preserves the historical
count changes and their behavior rationale without making every explanation a
change to gate code.

When an existing quiet handler gains real behavior, update the two-value pin in
the same commit. Append a dated explanation here when it adds useful context.

This is a ratchet, not approval of the old entries. Any addition or mutation
changes the digest and stops the build; deleting/fixing an entry deliberately
lowers the count and updates the digest after review.

2026-08-31: 506 -> 505. Commit 34b4f08f ("Fix Win98 installer chain
launches") gave handle_CreateProcessA a real implementation, so it left the
quiet inventory. Ratchet only; nothing was added.

2026-08-31: 505 -> 508. MSVCRT startup helpers _lock, _unlock, and
__lconv_init are documented compatibility no-ops for single-threaded CRT
initialization paths.

2026-09-01: 508 -> 507. handle_IDirectDraw_WaitForVerticalBlank was the
textbook silent success -- it set EAX=0 and returned, so a game that used
the display as its clock was told the retrace had already happened. It now
parks on a real vblank (yield_reason 13). Ratchet only; nothing was added.

2026-09-01: 507 -> 525. Minimal no-audio BASS compatibility handlers let
shareware games bundled with bass.dll continue to gameplay.

2026-09-01: 525 -> 526. __mb_cur_max is a documented constant for the
emulator's single-byte ANSI CRT environment.

2026-09-01: 526 -> 527. _cexit acknowledges CRT cleanup without process
termination; returning terminator callbacks need a separate future path.

2026-09-01: 527 -> 528. _getdrive is a documented constant in the default
single-drive C: process environment.

2026-09-01: 528 -> 529. _setmode acknowledges text/binary mode changes and
returns the previous text mode because stdio streams are not distinguished.

2026-09-01: 529 -> 530. keybd_event is a legacy input-synthesis probe shim;
browser-side input injection remains host-owned.

2026-09-01: 530 -> 531. joyGetPosEx mirrors joyGetPos for a no-joystick
Win98 environment so startup probes can keep keyboard/mouse input.

2026-09-02: 531 -> 529. Legacy SetWindowsHookA/W now installs the same
process-local keyboard/CBT callbacks as the Ex path, and UnhookWindowsHook
removes only a matching installed procedure instead of always succeeding.

2026-09-02: 529 -> 516. DirectPlay's bounded local session now retains
player/group identities, names, flags and memberships; its lifecycle and
four entity enumerators update or traverse that state instead of returning
success without work.

2026-09-02: 516 -> 514. SetPlayerData and SetGroupData now retain copied
local/remote application data in the DirectPlay entity repository; their
matching getters implement the Win98 size-query and readback contract.

2026-09-02: 514 -> 512. DirectPlayLobby EnumAddress now walks bounded
compound-address chunks through a cancellation-aware callback, while
EnumAddressTypes reports the local TCP/IP provider's required DPAID_INet.

2026-09-02: 512 -> 511. EnumLocalApplications validates its required
callback and reserved flags, then truthfully enumerates the browser Win98
machine's empty set of registered lobby-aware applications.

2026-09-02: 511 -> 502. Win32 DDEML now owns instance, copied HSZ,
registered-service, conversation and data-object state; invalid, stale and
cross-instance handles fail instead of fixed values succeeding silently.

2026-09-02: 502 -> 500. Begin/EndDeferWindowPos now allocate, validate,
consume and free real bounded HDWP transactions; queued geometry remains
unchanged until End applies it through the SetWindowPos behavior path.

2026-09-02: 500 -> 497. OpenClipboard/CloseClipboard now own an exclusive
USER transaction, and GetClipboardOwner reports ownership assigned by
EmptyClipboard instead of three fixed success/null answers.

2026-09-02: 497 -> 494. GetSubMenu now resolves real popup ownership,
ModifyMenu mutates dynamic items, and DrawMenuBar validates and redraws the
target window's non-client menu chrome instead of fixed success/handles.

2026-09-02: 494 -> 493. FindWindowA now searches the live top-level USER
tree by optional class atom/name and title instead of always returning NULL.

2026-09-02: 493 -> 491. SetPriorityClass/GetPriorityClass now validate the
emulated process handle and retain one shared Win98 priority class.

2026-09-02: 491 -> 489. GetThreadPriority/SetThreadPriority now validate
thread identity and retain the Win98 relative priority on the thread object.

2026-09-02: 489 -> 488. SetErrorMode now atomically replaces and returns the
shared Win98 x86 process error mode instead of always returning zero.

2026-09-02: 488 -> 483. COM/OLE initialization now owns per-thread apartment
model and nesting state; the dead duplicate OleInitialize body is gone.

2026-09-02: 483 -> 482. TranslateMessage now distinguishes the four
virtual-key messages from unrelated MSGs instead of always returning TRUE.

2026-09-02: 482 -> 480. SetThreadLocale and GetThreadLocale now retain real
per-thread LCID state and carry it into newly created threads.

2026-09-02: 480 -> 479. BringWindowToTop now changes sibling/top-level
z-order and activation state instead of reporting unconditional success.

2026-09-02: 479 -> 477. SetActiveWindow/GetActiveWindow now retain this
thread queue's active top-level and deliver real activation transitions.

2026-09-02: 477 -> 476. UnregisterClassA/W now remove the matching owned
class only after its last window is gone instead of always returning TRUE.

2026-09-02: 476 -> 473. Direct3D Device 1/2/3 GetStats now initializes all
five D3DSTATS counters and rejects a null output buffer.

2026-09-02: 473 -> 472. ImageList_Destroy now validates and invalidates its
handle and releases both the image-list record and retained icon array.

2026-09-02: 472 -> 471. CopyIcon now creates an independently owned copy of
bitmap-backed, resource-backed, and opaque system icon handles.

2026-09-02: 471 -> 470. CopyImage now owns and resamples bitmap/icon/cursor
images, including RETURNORG/DELETEORG, monochrome, and DIB-section requests.

2026-09-03: 470 -> 469. SHFileOperationA now delegates copy, move, rename,
wildcard, multi-destination, and recursive delete work to the shared VFS.

2026-09-03: 469 -> 468. FlushFileBuffers now validates a live writable VFS
file handle and reports access/handle errors instead of unconditional TRUE.

2026-09-03: 468 -> 469. Video for Windows added DrawDibOpen/Close (+2), while
GetLastActivePopup left the quiet inventory by retaining and validating
per-owner activation history (-1). The inventory records both changes.

2026-09-03: 469 -> 467. DrawDibOpen/Close now own, validate, invalidate and
free distinct opaque drawing contexts instead of returning constant success.

2026-09-03: 467 -> 466. GetLogicalDrives now queries the browser VFS's live
assignment mask instead of reporting a fixed C:/D: constant.

2026-09-03: 466 -> 463. SetFileApisToOEM/ANSI now propagate their process
code-page choice to Kernel32 filenames, and AreFileApisANSI reads it back
from the same process-shared VFS state across guest thread instances.

2026-09-03: 463 -> 462. DisableThreadLibraryCalls now validates loaded DLLs
and suppresses their future thread attach/detach notifications.

2026-09-03: 462 -> 461. WinExec now delegates the real command line and
nCmdShow to the browser child-launch path and returns its success/error code.

2026-09-03: 461 -> 460. GetWindowRgn now copies the window's retained USER
region into the caller's HRGN and returns its actual region complexity.

2026-09-03: 460 -> 459. FreeConsole now tears down the process console
window, buffers, input queue, aliases, and attachment state.

2026-09-03: 459 -> 458. SetConsoleCtrlHandler now owns a process handler
chain and delivers processed Ctrl+C/Ctrl+Break events through guest callbacks.

2026-09-03: 458 -> 457. EnableScrollBar now retains per-window arrow state,
paints disabled arrows, and suppresses their input instead of always TRUE.

2026-09-03: 457 -> 456. OpenIcon now sends WM_QUERYOPEN and restores the
guest and browser window state instead of returning unconditional success.

2026-09-03: 456 -> 453. SetCapture/GetCapture/ReleaseCapture now validate
thread ownership and deliver synchronous WM_CAPTURECHANGED transitions.

2026-09-03: 453 -> 452. GetMapMode now reads canonical per-DC state.

2026-09-03: 452 -> 450. GetStockObject validates the Win98 selector set;
GetNearestColor now rejects invalid DCs instead of silently succeeding.

2026-09-03: 450 -> 449. GetTextCharset now reports selected font state.

2026-09-03: 449 -> 448. DestroyAcceleratorTable now validates repository
handles and releases only live tables instead of always returning success.

2026-09-03: 448 -> 447. SHBrowseForFolderA now runs a classic modal shell
tree and returns the selected PIDL instead of silently reporting Cancel.

2026-09-03: 447 -> 446. Shell_NotifyIconA now owns browser notification-
area add/modify/delete state and delivers Win98 mouse callback messages.

2026-09-04: 443 -> 442. GetClipboardSequenceNumber now reads the shared
window-station serial advanced by successful clipboard mutations.

2026-09-04: 442 -> 441. SetFileSecurityW now reports the Win98
ERROR_CALL_NOT_IMPLEMENTED result instead of claiming an ACL was persisted.

2026-09-04: 441 -> 439. ExtractIconA and ExtractIconExA now enumerate and
materialize caller-owned PE/NE/ICO icons instead of returning fake success.

2026-09-04: 439 -> 438. GetForegroundWindow now queries renderer-wide
top-level z-order instead of returning this process's main HWND.

2026-09-05: 438 -> 437. The Win98 Shell32 ArrangeWindows ordinal now tiles
eligible renderer windows instead of returning an unconditional zero.

2026-09-06: 437 -> 435. Direct3D Device2/Device3 DeleteViewport now validate
ownership, clear current selection, and release attachment references.

2026-09-06: 435 -> 432. Direct3D Device 1/2/3 NextViewport now walks each
device's retained Win9x viewport list, returns AddRef'd HEAD/TAIL/NEXT
interfaces, and distinguishes invalid input, empty lists, and list end.
