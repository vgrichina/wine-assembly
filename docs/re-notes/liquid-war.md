# Liquid War 5.6.2

Binary: `test/binaries/candidates/liquid-war/LW5/lwwin.exe`, image base
`0x00400000`.

## DirectDraw startup across guest threads

Liquid War creates its only window (`hwnd 0x18001` cooperatively, `0x20001`
with real Workers) on Allegro thread T1. Video-mode selection later runs on the
main guest thread. Allegro bridges the two with a synchronous private window
message:

- `0x00445f60` calls `SendMessageA(hwnd, 0x004bbfa4, callback, 0)`.
- Its callback at `0x0045d470` invokes `IDirectDraw2::SetCooperativeLevel` and
  the mode-selection operations on the HWND owner thread.
- `0x0045d390` treats a zero/failed callback result as an unavailable mode, so
  all fullscreen and windowed candidates eventually become “Unable to
  initialize graphics.”

Before cross-thread `SendMessageA` routing, the callback happened to execute on
the caller's WebAssembly instance. Correct owner-thread routing exposed that
DirectDraw's display width, height, depth, selected-mode flag, cooperative HWND,
exclusive flag, and primary palette were mutable WebAssembly globals. Each guest
thread has a separate instance, so T1 successfully selected 640x480x8 while the
main thread still observed its private 640x480x16 defaults and rejected the
driver.

Those fields now live in the atomic shared-memory `DX_PROCESS_STATE` record.
The window callback therefore retains Win32 thread affinity while subsequent
DirectDraw calls and `GetSystemMetrics` see the same process device state.
`test/test-cross-thread-send.js` writes the record from a real owner Worker and
asserts that a peer instance reads every field.

Acceptance on 2026-08-26:

- `test/test-liquid-war-candidate.js`: 640x480 textured menu, 63 colors, packed
  data/custom assets loaded, and fullscreen `DirectDraw accel` mode succeeds.
- Node `--threads`: three guest threads in Workers, live 640x480x8 primary with
  59 sampled colors, and the same textured menu.
- Isolated Chrome Worker backend: status reports `3 threads in workers`; the
  visible `Liquid War 5.6.2` window reaches the textured Play/Map/Options menu
  without compatibility errors. Diagnostic screenshot:
  `/private/tmp/lw-browser-worker-fixed.png`.

## Network startup

- The executable imports MSVCRT `_beginthread` through IAT VA `0x0046e114`.
  `node tools/xrefs.js .../lwwin.exe 0x46e114 --code` finds its five call sites.
- MSVCRT's runtime `CreateThread` entry is always its wrapper. In the on-disk
  `test/binaries/dlls/msvcrt.dll`, original VA `0x7800b93e` calls the real
  routine stored at private-block offset `+0x48` with the argument at `+0x4c`.
  This was obtained with `tools/disasm_fn.js` after translating the traced
  runtime VA by the DLL load delta.
- The network retry worker's real entry is `0x00414d40`. It calls
  `0x00419090`, which creates a TCP socket, binds it, connects it, applies
  socket options, and enables `FIONBIO`. Its argument structure contains the
  server address inline at `+0x04` and the port at `+0x14`.
- `0x00414c50` allocates that structure, starts the worker through
  `0x0041aeb0`, waits on status at `+0x18`, and reads the result at `+0x24`.

## Ruled out

The short-lived thread stream seen after entering Net game is not a thread
scheduler failure. It is Liquid War retrying `127.0.0.1:8035` after a queued
Enter remains logically down across the transition to the network-settings
menu and activates Start game there too. Loopback is deliberately local to one
emulator process, so that address cannot reach the separate server process.

For headless input, a one-batch `keydown` followed by `di-keyup` releases the
DirectInput state without leaving a delayed `WM_KEYUP`. This reaches the
settings screen, where `10.77.0.1` can be entered before Start game. The fixed
reproduction is encoded in `test/test-vlan-match.js`.
