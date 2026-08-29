# Half-Life Uplink demo

## Package and installed layout

The local-only installer is
`test/binaries/candidates/half-life-uplink-installer/hluplink.exe` (50,872,079
bytes). It is a Win9x InstallShield package. The tested installed tree is staged
under the same candidate directory at `installed/`; its playable entry is
`hldemo.exe`.

The two large launch pins are:

- `hldemo.exe`: 737,280 bytes, SHA-256
  `e459ef7d19bc0690d2e2d6dca9af1d773b49f8172096e49a694f897119bc4dc1`
- `valve/pak0.pak`: 79,150,544 bytes, SHA-256
  `c9eac1391845d6fabd93d7a1cc48281275410d35e01b74bd7f02325c65c99a42`

The runtime also needs `hw.dll`, `sw.dll`, `hl_res.dll`, `a3dapi.dll`,
`valve/dlls/hl.dll`, `valve/cl_dlls/client.dll`, and the remaining Valve/media
data beside the executable.

## Installer path

Use dialog titles, not an early `wait-dlg-control:3`: the setup creates a
different control with that ID before Welcome. The deterministic path is:

1. Welcome: click ID 3.
2. End User License Agreement: click ID 5 (`I Agree`).
3. Read Me File: click ID 3.
4. Choose Destination Location: click ID 3.
5. Start Installation: click ID 3.

The installer then requires Win9x VERSION.DLL behavior:

- `VerFindFileA` chooses the current/destination directories and reports
  NUL-inclusive buffer capacities and `VFF_*` flags.
- `VerInstallFileA` moves InstallShield's generated temporary payload into the
  selected destination and returns a `VIF_*` mask.

Use a small guest batch for the large PAK. With `--batch-size=20000`, the whole
75+ MB decompression stays inside one chained batch, so `--max-seconds` cannot
take effect until after extraction and may stop before the following rename.
`--batch-size=500` lets setup finalize `valve/pak0.pak` and emit the later DLL,
WAD, CFG, and media files.

The completed local run used `--save-vfs` and `--reg-export`. Its installer
snapshot is `/private/tmp/hlu-installer-registry-complete.json`; the exported
tree was `/private/tmp/hlu-installed5.oN75DN/sierra/half-lifeuplink` before it
was staged under the candidate directory.

## Registry delta

The game-specific installer record is:

```text
HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Half-Life Uplink
  DisplayName = "Half-Life Uplink"
  UninstallString = "C:\sierra\half-lifeuplink\unwise.exe C:\sierra\half-lifeuplink\INSTALL.LOG"
```

These are uninstall bookkeeping, not launch prerequisites. The installed game
reaches its menu with or without importing them; keep them out of a minimal
`startupRegistry` manifest unless reproducing the installed Windows state is
the goal.

## Installed-game launch

Mount the whole installed directory relative to `hldemo.exe` and seed the
runtime-loaded native DLLs:

```sh
/opt/homebrew/bin/timeout -s KILL 90 node test/run.js \
  --exe=test/binaries/candidates/half-life-uplink-installer/installed/hldemo.exe \
  --vfs-include='**/*' \
  --dll-seed=test/binaries/candidates/half-life-uplink-installer/installed/hw.dll,test/binaries/candidates/half-life-uplink-installer/installed/sw.dll,test/binaries/candidates/half-life-uplink-installer/installed/hl_res.dll,test/binaries/candidates/half-life-uplink-installer/installed/a3dapi.dll,test/binaries/candidates/half-life-uplink-installer/installed/valve/dlls/hl.dll,test/binaries/candidates/half-life-uplink-installer/installed/valve/cl_dlls/client.dll \
  --no-build --max-seconds=70 --max-batches=10000000 --batch-size=1000
```

`WSAStartup` must fill the complete 400-byte Win32 `WSADATA`, including the
provider's real 64-slot socket capacity in `iMaxSockets` at offset 390. The
engine then creates DirectDraw, opens the intro AVI as MCI alias `sierravideo`,
resolves that alias with `mciGetDeviceIDA`, closes it, creates the 640x480
Half-Life child window, and renders the complete menu.

The warning was not cosmetic. `hldemo.exe` at VA `0x41068c` passes a WSADATA
at `ebp-0x22c` to `AfxSocketInit`. After the successful call, VA `0x4106a5`
reads the WORD at structure offset `0x186` (390); the check at `0x4106b5`
loads warning resource ID 22 unless the reported capacity is greater than 12.
The MFC helper at VA `0x466524` also verifies negotiated WinSock 1.1. The
virtual provider has `VSOCK_MAX=64`, so publishing 64 is both sufficient and
truthful; `iMaxUdpDg` stays zero because the virtual LAN exposes no UDP, and
`lpVendorInfo` is NULL.

`mciGetDeviceIDA` must query the same host-owned alias map populated by
`mciSendStringA`. Returning a fabricated ID or zero either breaks subsequent
MCI commands or skips the video path. The focused host regression verifies
case-insensitive lookup and alias removal on close.

Acceptance screenshot: `/private/tmp/hlu-game-mci-final.png`. The main menu
shows New game, Hazard course, Configure, Load game, View readme, Previews, and
Quit; the 70-second run ended normally with no unimplemented API or crash.

## Browser dropdown

The localhost-only dropdown keeps the original installer entry and adds
`halflife_uplink` for the installer-produced game. Its manifest pins the six
runtime DLLs and 58 data files (65 local paths including the EXE) and mounts
the PAK, WAD, configuration, AVI, and order-page assets at their runtime
`C:\` paths.

Uplink performs a relatively long renderer probe before publishing its main
window. The normal browser lifecycle grace remains 750 ms; this app opts into
60 seconds so last-window cleanup does not mistake that startup transition for
process exit. Its eventual 640x480 Half-Life menu uses a dialog-style top-level
window, which the focused browser acceptance allows explicitly before checking
rendered pixels.

The final real-Chrome run rendered 91 colors and changed 8,406 sampled pixels.
Screenshot:
`/var/folders/dz/1fqkk_jd4350qkm91pm9_q3c0000gp/T/hlu-web-mu3xoc/halflife_uplink-after.png`.

The stronger no-dismiss run confirms that the socket warning is gone. Normal
renderer pointer input at guest `(148,193)` hits the measured New Game button
(live control ID 1016, rectangle `70,180 156x26`) and reaches the Easy / Medium
/ Difficult selector. Best progress screenshot:
`/private/tmp/hlu-gameplay-click2/halflife_uplink-new-game-click.png`.
This is not yet a first-person frame; do not treat the current browser smoke as
full gameplay acceptance.

## Difficulty selection and current gameplay boundary

The difficulty dialog exposed a separate native-dialog delivery bug. A WAT
BUTTON sent its custom `WM_COMMAND` synchronously to the parent. Uplink's New
Game handler enters another modal dialog, so the bounded recursive interpreter
eventually logged
`[sync] ABANDONED wndproc msg=0x111 at 0x00459554 after 64 rounds`; clicking
Easy after that resumed a discarded x86 continuation and crashed. Custom
commands to a parent with a retained DLGPROC are now posted through the guest
message queue. `IDOK`, `IDCANCEL`, and non-dialog parents remain synchronous.
The focused regression also subclasses the dialog WNDPROC, matching Uplink's
MFC dialog rather than relying on the visible `WNDPROC_DIALOG` marker.

With that fix, normal renderer input reaches the live Easy control (ID 26) and
creates the next 640x480 Half-Life window without abandoning a continuation or
exiting the app. The post-click evidence is under
`/private/tmp/hlu-gameplay-postfix/`; `halflife_uplink-easy-loaded.png` is the
furthest frame, but it is a uniform light-grey client area, not gameplay.

The grey frame is not an active presentation or an unresponsive browser:

- `hl.dll` loads from `c:\valve\dlls\hl.dll`, `client.dll` loads from
  `c:/valve/cl_dlls\client.dll`, and passive entry counters record one call
  each to `GetEntityAPI` and `GiveFnptrsToDll`.
- The main thread repeatedly returns to VA `0x459554`, the instruction after
  MFC's `PeekMessageA` call, with a stable stack and no synchronous-abandonment
  log. This is the live top-level modal pump, not a discarded recursive frame.
- The only long-lived worker is the renderer queue waiting normally. The other
  observed worker starts at runtime VA `0x15a7e42`, which maps to
  `comctl32.dll` RVA `0x20e42`; its function returns zero at RVA `0x20e8c`, so
  its later `EIP=0` exit is normal COMCTL32 worker completion, not a failed
  Half-Life game thread.
- DirectDraw is configured only for the hidden menu HWND `0x10002`: the trace
  contains `SetCooperativeLevel(0x10002, DDSCL_EXCLUSIVE|DDSCL_FULLSCREEN)` and
  640x480x16 `SetDisplayMode`, but no later cooperative-level or display-mode
  call for the new visible HWND `0x1001d`. That new window's canonical surface
  remains untouched (`uploaded=false`, version 1) and it has no DirectDraw
  layer.

Therefore the queued-dialog fix advances the real dropdown path through Easy,
but first-person acceptance remains blocked after game-DLL initialization and
before the engine re-enters video/presentation setup. Do not paper over this by
transferring DirectDraw ownership in the host: the guest has not issued a
second `SetCooperativeLevel`, and there is not yet generic evidence that such a
host-side handoff matches Windows behavior.

### Engine frame activation

The grey window was one step downstream of an ordinary USER activation gap,
not a DirectDraw ownership handoff. Uplink selects `sw.dll` at runtime. The
post-Easy launcher bridge adds the exact `skill 1\nmap hldemo1\n` text to
`sw.dll`'s `Cbuf_AddText` once, but `Host_Frame` remains at zero. Its caller is
reached continuously and reports engine state 1, then returns because all
three run guards are zero. The primary guard at `0x484808` is written by three
MFC `WM_ACTIVATEAPP` handlers; none of those handlers executed during the menu
startup in the failing run.

The window chronology identifies why. An unseen utility HWND consumes the
first handle, then the real parent/owner-zero UI is created as dialog HWND
`0x10002` and shown. `ShowWindow` already knows how to deliver the synchronous
`WM_ACTIVATEAPP -> WM_ACTIVATE -> WM_SETFOCUS -> WM_SIZE` chain through a
retained DLGPROC, but the preceding hidden-helper promotion accepted only a
direct guest WNDPROC. It rejected USER's `WNDPROC_DIALOG` marker, left
`main_hwnd` on the invisible utility HWND, and made the correct dialog branch
unreachable.

The generic fix resolves `WNDPROC_DIALOG` to its retained application DLGPROC
for that promotion decision. It still requires a shown, unowned top-level,
an invisible old main HWND, and an unconsumed first-activation gate. Owned
popups, child dialogs, built-in procedures, and subsequent same-application
window changes keep their previous behavior. The focused regression builds
exactly this hidden-utility/retained-dialog shape and proves the real dialog is
promoted and synchronously receives all four startup messages in order. The
existing SkiFree startup sequence, custom dialog dispatch, queued custom-button
command, and installed Uplink menu gates remain green.

A normal post-fix Chrome run clicks New Game and creates the live
Easy/Medium/Difficult dialog and all four buttons. The disposable diagnostic's
old control-ID walk
does not recognize those dynamically retitled controls after main-window
promotion, so that run was not used to claim a new Easy-to-first-person pass.
The earlier guest-only counterfactual (`0x484808 = 1` immediately after Easy)
does prove the next stacked compatibility boundary: the engine immediately
enters deep `sw.dll` code and stops at unimplemented `CompareFileTime`
(`sw.dll` runtime EIP `0x0104b407`). `CompareFileTime` is a separate generic
KERNEL32 API task; first-person rendering remains unproven until it and any
later engine dependencies are implemented and the real dropdown path is
rerun.

## Browser DLL thread-attach stack translation

Safari 26.4 can advance through New Game and click Easy with a 1,000-block host
slice, but repeatedly traps while entering tiny MFC epilogue blocks. A failure
at `0x00464e4e` (`mov eax,edi; pop edi; pop esi; ret 4`) left EAX unchanged from
before the block and ESP still named the valid words `0x00459610, 0x074febc0,
0x00463aaa, 0x0043fd74`. An earlier run failed on the same shape at the `ret 4`
at `0x00456cc0`. The intact state rules out a corrupt MFC object or guest
return stack, but does not identify where the browser exception originates.

Neither disabling cross-basic-block tail calls nor preserving retired decoded
page chunks fixed the failure. A local Chrome drive with the second diagnostic
build reproduced the exact `0x00464e4e` report and finally supplied the browser
exception stack: `DataView.setUint32` at `dll-loader.js:callDllMain`, called by
`ThreadManager.spawnPending` while delivering `DLL_THREAD_ATTACH`. The sampled
EIP is the suspended main thread's current address; the exception happens in
host-side initialization of a newly created cooperative thread, before that
thread's start routine runs. That also explains the earlier worker diagnostics
which reported `Length out of range of buffer` during `initGuestThread`.

`callDllMain` translated its temporary stack pushes with the legacy contiguous
formula `guest - imageBase + GUEST_BASE`. New thread stacks are allocated in a
sparse high guest range and already have a real mapping in the virtual map, so
that formula produces an offset beyond the `DataView`. ThreadManager's normal
stack initialization was previously corrected to use `guest_to_wasm`, but the
loader-notification path retained the obsolete formula.

DllMain stack pushes and the saved SEH word now use the interpreter's exported
`guest_to_wasm` mapper when it is available, retaining the old formula only for
loader mocks and older embedders. The focused regression delivers
`DLL_THREAD_ATTACH` on a synthetic stack at guest `0x07500000`, whose real WASM
backing is `0x00050000`; this address would be far outside linear memory under
the old arithmetic. No decoded-cache policy is changed.

The post-fix Chrome browser drive reached the live Easy control, created the
next Half-Life window, and remained in the MFC pump through 269,000 reported
slices with no `ERROR` or trap. It stops the acceptance only at the
already documented two-colour/grey first-person boundary (`colors=2` against
the test's `minColors=24`), so the stack-translation fix does not reintroduce
the pre-difficulty stall.

## OpenGL renderer and gameplay throughput

The software renderer can reach the first-person corridor, but its full-frame
CPU rasterization is a poor browser path: Safari measured about 1.2 fps with
broken streamed audio. Uplink's renderer registry uses `EngineType=2` for
OpenGL and resolves `EngineGLDriver=Default` through `gldrv\\drvmap.txt` to the
system `opengl32.dll`, the same generic WGL bridge already used by Quake II.
These values now ship as the app's startup registry instead of selecting the
bundled 3Dfx mini-driver or software renderer.

The first OpenGL run entered `hw.dll` and then appeared to exit at EIP zero.
The return address `0x006522d7` was still on the guest stack. Disassembly of
`hw.dll` RVA `0x8c2d1` showed an indirect call through `0x1068a274`; renderer
initialization fills that slot with `GetProcAddress("glColor4ub")`. The bridge
implemented `glColor4ubv` but not the scalar form, so the resolved pointer was
zero and GoldSrc called it. `glColor4ub` is appended as command-stream opcode
56 to preserve the existing GL/WGL opcode ABI, normalizes its four byte
components, and folds into immediate-mode vertex colour state without a host
round trip.

GoldSrc's z-trick also calls `glDepthRange(1, 0)`. Desktop OpenGL permits that,
whereas WebGL reports `INVALID_OPERATION` when near is greater than far. The
frontend now sends WebGL the legal sorted range and negates clip-space Z in the
projection matrix; this is algebraically equivalent to the desktop mapping.

Finally, the browser's app-specific 1,000-block slice underfed both rendering
and audio. The cooperative OpenGL path now uses 10,000 blocks, matching the
responsive Quake II scale. A fresh SwiftShader browser acceptance loaded
`hw.dll`, clicked New Game -> Easy, remained active for a 90-second gameplay
settle, issued 940 `gpuPresent` calls, and captured a textured corridor plus
HUD with 4,905 sampled colours and no trap or GL bridge error:
`/private/tmp/hlu-opengl-depth-fixed/halflife_uplink-easy-loaded-gpu.png`.

### Owner-drawn dialog background

Uplink's menu resources name the registered `HalfLifeLauncher` dialog class.
The resource loader previously skipped that `OrdOrString` field, so the HWND
lost its class slot, cursor, brush, and `CS_OWNDC` state. Two later synchronous
resize helpers then treated it as a stock `#32770` dialog and erased the full
640x480 client with `COLOR_BTNFACE` after GoldSrc had painted its textured
background. The built-in erase trace identified the overwrite exactly as
`hwnd=0x10002 brush=0x10 client=640x480`.

Named DLGTEMPLATE classes now inherit the same registered-class state as
CreateWindowEx windows. MoveWindow and SetWindowPos retain the legacy
BTNFACE initialization for classless dialogs, but do not overwrite a custom
class's owner-drawn client. The focused test covers both halves. A rebuilt
real-browser capture shows the black textured menu with all labels and no
grey slab:
`/private/tmp/hlu-menu-isolated-fixed/halflife_uplink-before.png`.

### Threads-mode menu publication

The launcher animates its logo by alternately hiding two 640x100 child
windows. Hiding either child used to restore its saved parent pixels and then
invalidate the complete 640x480 top-level window twice: once in WAT and again
in the browser renderer. In Worker mode those operations are separated by
broker hand-backs, so the compositor frequently published the parent after
the full erase but before all menu controls had repainted. The visible result
was a blinking grey/black menu body even though the guest eventually drew the
right pixels.

Child uncover now invalidates only the rectangle formerly occupied by that
child. When a saved parent snapshot already repaired the exposed pixels, the
browser does not widen the invalidation back to the complete window. Direct
repaint requests also obey the Worker slice publication boundary, and a
BeginPaint/EndPaint transaction remains private even when a cooperative slice
ends between the pair. Twelve 250ms real-Worker captures keep the menu body and
badge stable while the logo animates: the changed-pixel box shrank from
`640x324` before the fix to the intended `616x88` band at y=74..161.

### In-process renderer switching

One scheduler quantum is not suitable for both GoldSrc backends. OpenGL needs
10,000 blocks per cooperative turn to feed geometry and streamed audio, while
Software's CPU rasterizer needs the earlier 1,000-block quantum to preserve
browser input and paint responsiveness. GoldSrc also retains its WGL context
while Software is active, so context existence is not an honest mode signal.

Storage now publishes successful registry writes to the owning process. The
Half-Life browser policy watches its exact `HKCU\\Software\\Valve\\HLDemo\\Settings`
`EngineType` value: `2` selects the 10,000-block OpenGL quantum and the other
renderer values select 1,000. Actual GPU and DirectDraw presentations provide
a second runtime signal. This applies while the guest is running; the emulator
process is not restarted. A fresh browser probe observed `HLU_SOFTWARE_SLICE
1000` immediately after Apply and `HLU_OPENGL_SLICE 10000` after selecting
OpenGL again.

The Software leg of the same-process acceptance reached a textured Lambda
Complex corridor and HUD after a 90-second settle:
`/private/tmp/hlu-final-both-renderers/halflife_uplink-software-gameplay.png`.
The test then opened the live pause menu, selected OpenGL, observed the quantum
return to 10,000, confirmed replacement of the active game, and captured the
same corridor through the GPU layer after another 90-second settle. That leg
issued 569 `gpuPresent` calls, loaded 1,863 textures, remained active with no
GL error or trap, and produced 34,101 sampled colours:
`/private/tmp/hlu-final-both-renderers/halflife_uplink-opengl-gameplay-after-switch-gpu.png`.

## First-run keyboard bindings and movement GL calls

Browser input focus was not the reason keyboard movement failed. A focused
gameplay probe saw physical W become `0x8000`, consumed the queued key message,
and entered GoldSrc's relocated `Key_Event`; the engine's key-down byte also
became one. The key's binding pointer was null, however. Uplink's shipped
`valve.rc` comments out `exec default.cfg`, always executes `autoexec.cfg`, and
the extracted payload contains no autoexec file. The browser install now also
seeds `valve/default.cfg` at `c:\valve\autoexec.cfg`, preserving the original
file while using GoldSrc's native first-run startup path. The resulting live
bindings are `w +forward` and mouse button 1 `+attack`.

Actually executing `+forward` exposed two previously dormant OpenGL 1.1
imports. `hw.dll` resolved `glPolygonOffset` into its slot at original address
`0x10689dc8` and `glColor3ubv` into `0x10689ad4`; both were null. They are now
append-only command-stream opcodes 57 and 58. Polygon offset reaches WebGL with
both float arguments and supports `GL_POLYGON_OFFSET_FILL`; the three-byte
colour vector is normalized into packed immediate-mode RGBA state without a
Worker round trip.

A fresh browser acceptance reached the rendered corridor, held W for 500 ms,
released it, and remained active with no trap. `Key_Event` advanced from 256
to 258, the key-down state transitioned zero -> one, and `Host_Frame` continued
from 839 to 848. Visual comparison confirms forward camera displacement: the
right-wall panels and overhead opening move toward and past the camera. The
before/held captures differ at 305,732 of 459,360 pixels (66.56%):
`/private/tmp/hlu-keyboard-color3ubv/halflife_uplink-movement-before.png` and
`/private/tmp/hlu-keyboard-color3ubv/halflife_uplink-movement-w-held.png`.
