# Liquid War 5.6.2

Binary: `test/binaries/candidates/liquid-war/LW5/lwwin.exe`, image base
`0x00400000`.

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
