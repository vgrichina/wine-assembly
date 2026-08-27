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

The browser needs the same cooperative completion pump as the CLI harness.
`lib/host-audio.js` deliberately queues `WOM_DONE` rather than re-entering x86
from an AudioContext timeout, but the page's `WineAssembly.run` loop originally
never called `hostCtx.pumpAudioCompletions()`. The result was a valid but frozen
3DO frame for at least 95 seconds. Pumping at the slice boundary makes the
startup movies advance and a normal dropdown launch reaches the main menu. In
page fullscreen the 800x600 guest surface is scaled to 1024x768, so the New
Game centre at guest `(650,80)` maps to page `(832,102)`. That click produces
the authentic Heroes III loading screen; the browser capture is
`/private/tmp/h3-browser-drive/after-new-game.png`.

The suspected 750ms last-window teardown is not involved on that successful
path. Instrumentation from startup through New Game found one live top-level
`Heroes of Might and Magic III` window throughout and `_lastWindowStopAt == 0`.
Do not add an H3-specific `windowlessGraceMs` without a different trace that
actually observes a windowless transition.

For deterministic CLI input, do not use the `click` action to skip these
movies: it queues mouse-down and mouse-up in the same synchronous harness
batch, while the successful browser gesture holds the button for about 120ms.
Use paired `mousedown`/`mouseup` actions in separate batches. With
`--batch-size=200000 --thread-slices=1 --tick-ms-per-batch=100`, held centre
clicks around batches 700, 1300, 1900, and 2500 cross the 3DO/NWC segments and
the menu is visible around batch 3050 (`/private/tmp/h3-path-3050.png`). A
500000-block slice is not an equivalent shortcut: it starves the completion
cadence, leaves a blank surface, and retires only 172 MMX instructions instead
of the codec's millions. Likewise `--thread-slices=0` prevents the Miles worker
from advancing startup. These are invalid acceptance/performance recipes.

Startup-video MMX counts and intro frame rates are not evidence about the
reported slow adventure map. The later replay below now reaches and interacts
with the map; keep profiling windows after the objective dialog is gone.

### Direct adventure-map replay and fixed blocker

A root-owned replay on 2026-08-25 used the valid held-input path rather than
same-batch `click` events:

```sh
node test/run.js --app=heroes3_demo --screen=800x600 \
  --max-batches=5205 --batch-size=200000 --thread-slices=1 \
  --tick-ms-per-batch=100 --quiet-api --quiet-blocks --no-close --no-build \
  --input=700:mousedown:400:300,702:mouseup:400:300,\
1300:mousedown:400:300,1302:mouseup:400:300,\
1900:mousedown:400:300,1902:mouseup:400:300,\
2500:mousedown:400:300,2502:mouseup:400:300,\
3050:png:/tmp/h3-menu.png,\
3500:mousedown:650:80,3502:mouseup:650:80
```

The menu capture is valid. New Game also registers: later frames move the H3
hourglass cursor onto the New Game artwork and the guest remains busy in its
map-loading path. This rules out a missed CLI click, frozen input queue, and
last-window teardown as the reason the map was never captured.

The first concrete post-click blocker occurs at batch 5161. Execution is in
the game's inflate-style decode routine at original VA `0x00597780`; the last
batch enters at `0x005979c9`, then the decoder reports an impossible next EIP
of `0x00000018` (previous decoded block `0x005977dc`) and traps on the zero page.
The last visible frame is still the main menu with the busy cursor. Treat this
as an emulator correctness failure during map loading, not as adventure-map
FPS evidence.

The exact stack-relative branch tail from `0x005979c9` has a focused synthetic
regression in `test/test-cmp-memory-jb.js`. It correctly exits when an unsigned
remaining count falls from 258 to 257, including the normal page-chain path.
Therefore the basic `CMP dword [ESP+14h],102h` / `JB` semantics are ruled out;
the remaining failure is not the guest decompressor's unsigned exit test.

The decisive comparison completed with a single passive hit counter at
`0x005979c9`. Arming any counter sets the generic debug-boundary flag, which
preserves guest state but makes both decoded-page fast paths return through the
main dispatch loop. Under otherwise identical input and batch timing, this run
survived batch 5161, hit the loop tail 6,460,520 times, and reached the authentic
adventure map by batch 4000. Captures at batches 4000 and 5150 show the complete
map UI and the demo's Welcome objective dialog:
`/private/tmp/h3-root-count-{4000,5150}.png`.

This A/B localizes the impossible `EIP=0x18` transfer to the decoded-page
fast-chain family rather than CPU flags, input, registry state, middleware, or
the game data.

The fast path exposed a run-loop boundary bug, not a bad page index. `$next`
parks a decoded-stream pointer in `resume_ip` when its 1,000-handler quantum
expires mid-block. If the enclosing fast chain had also spent the final block
budget, `$run` checked the exhausted budget first and returned to the host with
that non-architectural pointer still armed. The slice boundary then injected a
queued Miles `WOM_DONE` callback by saving registers and replacing EIP/ESP. On
the next `$run`, `resume_ip` took priority over the callback's EIP, so the
decompressor resumed on the callback stack and eventually returned through the
garbage value `0x18`.

The run loop now drains an already-started block before honoring an exhausted
block budget. `test/test-run-budget-completes-resume.js` directly seeds the
zero-budget/partial-block state and verifies no resume pointer escapes the call.
The existing multimedia callback and browser WOM_DONE-pump regressions still
pass.

The final uninstrumented replay, with both page fast paths enabled, reached the
adventure map by batch 4000 and completed batch 5165 without a crash. At exit it
reported 112,961,938 indexed desk trips skipped, 23,690,412 free adjacent
fall-throughs, 117,375,119 page-index hits, and only four full cache clears.
Captures were `/private/tmp/h3-resume-fix-{4000,4800,5150}.png`; the first and
last contained the full adventure-map Welcome dialog. The middle CLI capture
contained the H3 frame chrome but a blank play area. The same isolated frame
appeared in the debug-boundary A/B, so it was separate from the fixed crash.

A fresh uninstrumented focused acceptance after the host reboot reproduced the
strong result: 5,166 batches completed with 112,620,349 fast desk trips, 3,270
colors in the objective frame, and no crash. The strengthened acceptance then
clicks the real check button at guest `(400,414)`, captures the unobstructed
map, parks the pointer at the left edge, and captures the resulting normal H3
map pan. In the driven sample, 64.236% of the 600x560 map region changed while
only 0.303% of the fixed 190x600 right UI changed. Artifacts are under
`/private/tmp/heroes3-map-sample/` (`objective.png`, `map-idle.png`,
`after-left-edge.png`, and `settled.png`). This is real adventure-map input,
not loading or first-dialog validation.

The same driven run supplies a load-independent presentation/work sample for
batches 4100 through 4400. It recorded 101 guest `dx_present` events over 301
batches: one per 2.98 batches overall, with interval p50 2, p90 8, p99/max 14,
and 26/100 intervals at least 1.75x the median. The main thread retired
369,686,117 handlers and 40,930,916 blocks in the window; 178/301 batches spent
the full 200,000-block budget and 123 yielded. Treat those as deterministic
CLI cadence/work measurements, not browser FPS: the host load average was
16.39 at the end, the run was not headful, and its host flush cadence was
artificially gated by `--repaint-every=50`. No FPS number is supportable from
that sample.

### RGB565 LUT renderer loops

Adventure-map profiling identified a counted `src8 -> LUT16 -> dst16` family.
Six direct-table sites processed 2,509,014 pixels in a 4,250-batch replay. The
largest variant starts at `0x004714bc` and prefixes the same nine-op pixel body
with `mov ecx,[esp+0x40]`; with H418 disabled it entered about 3.25 million
times in gameplay batches 4100..4250.

H418 descriptor bits 1/2 now cover the 16-bit output and optional stack-loaded
table pointer. The stack value and its 512-byte table mapping are resolved once
per page/budget chunk; a destination that can alias the stack page is limited
to one pixel per reload. On the exact `0x004714bc` shape, a 16 MiB same-process
alternating benchmark measured 38.7 ms median enabled versus 1,317.9 ms with
all LUT super-ops disabled (+97.0% paired median). An unrelated RECT_RUN toggle
was +3.6% in the same session. The real replay processed 8,229,384 RGB565
pixels in 533,773 H418 chunks; `0x004714bc` fell to 448,144 chunk entries.
These are primitive-local and deterministic-work results, not browser FPS.

The earlier isolated blank middle frame did not recur spontaneously. Deliberate
left-edge panning can produce a mostly starfield/shroud map view with intact
chrome, but that transition was input-driven and stable after the cursor moved
back to the center. Do not attribute the old one-off frame to a primary/back
buffer bug without a new spontaneous reproduction.

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
