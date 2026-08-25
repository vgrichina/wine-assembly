# Heroes of Might and Magic III Demo

## Local payload

The local-only candidate is the March 1999 demo. `h3demo.exe` is a PE32 image
based at `0x00400000`; its three native middleware DLLs are loaded from the
same candidate directory:

- `BINKW32.DLL`
- `MSS32.DLL`
- `SMACKW32.DLL`

The game also needs the `Data`, `Maps`, and `MP3` payload listed by
`heroes3DemoFiles` in `lib/apps.js`. The large archives are intentionally local
and gitignored.

The downloaded package is an outer InstallShield wrapper. The runnable setup
entry is the extracted `installer-engine/_ins5576._mp`, with the Disk1 cabinet
files mounted beside it. Starting the outer `Setup.exe` only tries to spawn a
second process, which this runtime does not yet support.

## Reproductions

Game startup:

```sh
node test/run.js --app=heroes3_demo --screen=800x600 \
  --max-seconds=45 --max-batches=10000000 --stuck-after=1000000 \
  --quiet-api --quiet-blocks --repaint-every=500 \
  --reg-export=/tmp/heroes3-game-registry.json
```

Installer Welcome (startup can take roughly 13,500 small batches):

```sh
node test/run.js --app=heroes3_demo_installer --screen=800x600 \
  --max-seconds=150 --max-batches=25000 --stuck-after=1000000 \
  --quiet-api --quiet-blocks --no-close \
  --input=1:wait-dlg-control:1:25000,2:dlg-dump:welcome
```

Record and inspect installer registry changes with:

```sh
node tools/registry-snapshot-diff.js defaults /tmp/heroes3-installer-registry.json
node tools/registry-snapshot-diff.js defaults /tmp/heroes3-installer-registry.json --manifest
```

The second form produces candidate `startupRegistry` records. Treat them as a
review list, not something to paste blindly: shell/MRU/uninstall values may be
installer bookkeeping rather than game launch requirements.

## Named addresses

Addresses below are original image VAs, obtained with `objdump -d -Mintel`.

- `0x004d1880`: WinMain wrapper. Creates the 800x600 window and calls the main
  initialization/game routine at `0x004c92d0`.
- `0x004c92d0`: main initialization and message/game loop.
- `0x004c9480`: calls the first virtual method on the object in `0x005fc828`.
- `0x0052f200`: that first virtual method. It initializes/tests the Miles
  digital driver using real `MSS32.DLL` exports (`_AIL_startup`, preferences,
  `waveOutOpen`, digital configuration, and sample allocation).
- `0x00505d90`: DirectPlay lobby initialization/registration helper. The byte
  at `0x005fcb0c` is the "launched by lobby" flag.
- `0x0059a7c2`: CRT `ExitProcess` call after WinMain has returned.

At the current DLL load order the native modules are normally relocated to
approximately `BINKW32=0x00617000`, `MSS32=0x00643000`, and
`SMACKW32=0x0069c000`. Re-check the loader log before using those runtime bases.

## Current result and ruled-out hypotheses

The game loads all three real middleware DLLs, patches their imports, reads the
LOD/SND/VID/MP3 assets, creates the Heroes III window, loads `mp3dec.asi`, and
initializes DirectSound buffers. It then returns through the CRT and calls
`ExitProcess`; the CLI canvas remains blank.

- This is not a missing `_AIL_startup@0` shim. The real decorated MSS export is
  found and patched.
- The DirectPlay lobby flag at `0x005fcb0c` remains zero under a byte watch.
  Pre-seeding a DirectPlay Applications registry key does not change the exit.
- Importing the complete registry snapshot written by a first game run does not
  change the second launch.
- Pre-seeding `First Time=0` and `Show Intro=0` does not change the exit.

The first game run adds the settings key
`HKLM\SOFTWARE\New World Computing\Heroes of Might and Magic® III Demo\1.0`.
The installer writes no game-specific registry values before the Welcome page.
A registry snapshot taken only at Welcome is therefore not an installed-state
snapshot.

The completed installer snapshot adds exactly six values across three keys:

- the default value and `Path` under
  `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\h3demo.exe`;
- `DisplayName` and `UninstallString` under the matching Uninstall key;
- `AppPath=C:\Program Files\3DO\Heroes III Demo\` and `CDDrive=C:` under the
  New World Computing `1.0` key.

Importing this completed installer snapshot still produces the same clean
early game exit, so missing installer registry state is ruled out as the game
launch blocker.

## Audio callback and intro progress

The later startup stall was an audio-completion callback gap, not a Smacker
decoder failure. MSS opens wave output with `CALLBACK_FUNCTION` and callback
runtime address `0x651300` (MSS original VA `0x2100e300`). Before the fix,
`waveOutWrite` recycled 34,635 buffers while that callback had zero hits;
Smacker advanced only 13-22 frames before its audio-position cap stopped and
`SmackWait` spun indefinitely.

The browser audio host now queues `WOM_DONE` function callbacks when buffers
finish. A cooperative guest entry between slices invokes the callback through
the existing `CACA000A` save/restore continuation, so it never re-enters x86
on top of a live guest frame. The focused waveOut test covers that contract.

With the fix, a 15-second run recorded 17,081 callback entries, 162 Smacker
draws and 160 next-frame advances. A 45-second run crossed both post-video
returns (`0x4c96af` and `0x4c96dd`) and rendered the full Heroes III main menu:
`/private/tmp/h3-after-45s.png`. This proves middleware startup and intro/menu
progress, not adventure-map or combat gameplay; that stronger acceptance is
still open.

InstallShield's Welcome handler yields for much longer than the synchronous
host `dlg-cmd` bridge permits. Repeated synchronous commands eventually corrupt
its in-flight stack and crash near `0x0040902e`. A `dlg-post-cmd` message remains
queued because this InstallShield loop is polling host input rather than the WAT
post queue; a raw command is polled but defaults to the top-level window instead
of the child dialog. Giving the command the dialog HWND explicitly is also not
enough. A real button notification also supplies the live button HWND in
`lParam`. The `dlg-input-click` action now finds that child and injects the full
`WM_COMMAND` through `check_input`; it deterministically advances Welcome to the
License page. Do not increase the synchronous round limit merely to force the
click through.

After accepting the license, `chkreqs.dll` imports COMCTL32 ordinal 17. The
Win98 COMCTL32 export table identifies that ordinal as `InitCommonControls`.
Before the ordinal resolver knew this mapping the generic unresolved-ordinal
diagnostic mislabeled it as `KERNEL32.#00017`; the import table in `chkreqs.dll`
is the authoritative module assignment.

The requirements helper then calls `ImageList_ReplaceIcon` and
`ImageList_GetIcon`; the runtime now retains per-entry icon handles and supports
the API's `i=-1` append behavior. With those paths implemented, setup reports
that the machine meets its requirements, accepts the default destination,
copies the complete game payload, and reaches the final shortcut/readme page.
The installer-produced tree contains `h3demo.exe`, the four middleware files,
the map, all 14 MP3s, and the complete SND/LOD/VID data set. No runtime crash or
unimplemented API occurs along that path.
