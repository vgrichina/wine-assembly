# Abe's Oddysee demo

## Package and registered launch

The registered `abedemo` payload launches
`test/binaries/shareware/abe/installed/abedemo.exe` and explicitly mounts its
four DDV movies plus `c1.lvl`, `r1.lvl`, `s1.lvl`, and `readme.txt`. These nine
files are produced by `tools/install-abe-demo.js` running the unchanged
32,219,648-byte `ABEODD.EXE` inside the emulator. The 914,432-byte PE32 and
all companions are hash-verified before export. The older `abe/ex` fixture
is retained locally but is no longer the registered launch or smoke target.

## Original self-extractor recheck (2026-09-09)

Run the original installer reproducibly (build first; the command does not
build or use a host archive extractor):

```bash
node tools/install-abe-demo.js --screenshot=/private/tmp/abe-install-success.png
ABE_INSTALLED_DIR="$PWD/test/binaries/shareware/abe/installed" \
  node test/test-abedemo-gameplay.js --frozen-route
```

`--installer=PATH` and `--output=DIR` override the original package and export
destination. Existing output directories are refused rather than replaced.
The command verifies the original package hash, the guest success notice,
the automatic launch path/working directory, and all nine output hashes
before copying the guest-produced tree. It runs frozen with a CLI-internal
180-second deadline and no build timeout. Failures retain the temporary
capture and log for diagnosis. The CLI capture alone only proves the launch
request; the separate live browser handoff is verified below.

Verified the command with `--output=/private/tmp/abe-tool-installed`:
all nine files and the launch request pass validation, the success screenshot
was inspected, and `--frozen-route` on that fresh output passes gameplay and
rightward movement (cyan X 204.15 -> 219.21 -> 267.63). The resulting gameplay
capture was visually inspected. Existing-output and wrong-original rejection
checks also pass without starting the CLI.

The unchanged `Abes_Oddysee_demo/ABEODD.EXE` has SHA-256
`179a2d7c0bab674cb28167d0a37ec74570fd2d6b589094d045a400633f2a33ab`.
On source `ee965802`, PE loading stages 8 MiB and prehydrates 23831040
section-tail bytes. The real WinZip Self-Extractor opens successfully.

A frozen CLI session with `--batch-size=100000 --no-threads` reaches the
initial notice after 30 steps. `dlg-cmd:1` and 50 more steps dismiss the
notice and show the extraction dialog with its original default destination.
Both screens were captured and visually inspected.

Do not drive Unzip with `dlg-input-click:1`: this route calls the dialog
procedure synchronously and abandons WM_COMMAND at `0x00403bd1` after 64
rounds. The first level is then only 8617984 bytes, versus 10663936 expected.
Increasing the test's batch count cannot recover that abandoned invocation.

`dlg-post-cmd:1` instead queues the command for the guest message loop. After
1000 steps it has emitted the complete `s1.lvl`, whose SHA-256 matches the
reference payload (`74249ff3841325b91f412090ac9aa04bae63ced82b9bf752ddb442111d6293ed`),
and has begun `c1.lvl`, without an abandoned-call diagnostic. Export these
guest-produced files with `--save-vfs`, not a host archive extractor.
Continuing to 5000 extraction steps reaches the original "9 file(s) unzipped
successfully" dialog, which was captured and visually inspected. All nine
guest-produced files match the previous reference payload byte-for-byte:
three LVLs, four DDVs, `abedemo.exe`, and `readme.txt`, totaling 54625942 bytes.
The installed executable SHA-256 is
`21a5a8ddd021293f091c9bcee41cb729c52c73f6b79bfed0ecf18cce6176c343`.

The successful probe used `--max-seconds=180 --no-build --no-close
--quiet-api --quiet-blocks --control-stdin --frozen`, exported with
`--save-vfs=/private/tmp/abe-original-complete`, and drove:

```text
step 30
dlg-cmd:1
step 50
dlg-post-cmd:1
step 1000 (five times, checking for the success notice between steps)
png /private/tmp/abe-original-complete.png
quit
```

The export is under `program files/abe's oddysee demo/`. This run stopped
at the success notice, before dismissing it to allow automatic game launch;
`--capture-launch` therefore correctly reported no child launch. Later probes
below verify the launch request and installed gameplay; the registered app
now uses those files. The synchronous input-path abandonment above remains
open. The original large-PE blocker is not current.

### Automatic launch request

Dismissing the success notice with `dlg-cmd:1` causes the unchanged installer
to call `WinExec("abedemo", 1)`, with no file extension. Before the fix,
`resolveShellLaunchPath` only applied the current directory; both the browser
launch lookup and CLI capture therefore missed `abedemo.exe`.

The shared resolver now supplies `.exe` for an extensionless WinExec basename,
including absolute paths and paths with dotted directory names. Explicit
extensions, trailing dots, empty commands, and non-WinExec document opens
are preserved. CLI capture uses that same resolver instead of independently
resolving only the directory. Microsoft's [WinExec reference](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-winexec)
also illustrates executable-stem resolution in its `Program.exe` example.
The new stem regression fails before the change and passes afterward;
existing WinExec ABI/VFS and shell launch tests pass too.

Repeating the real installer to batch 5080, dismissing success, stepping 50,
then quitting with `--capture-launch=/private/tmp/abe-handoff-fixed` produces
`launch.json` for `c:\\program files\\abe's oddysee demo\\abedemo.exe`.
All nine captured game files are byte-identical to the first guest-produced
tree (54625942 bytes total). No host archive extraction was used. This proves
the automatic launch request and captured payload, not a live browser child
reaching gameplay; the later live browser handoff check below supplies that evidence.

## Loader-thread deadlock

Before the CreateThread contract correction, the demo created its window and
two DirectDraw surfaces but stayed almost black indefinitely. A 4,000-batch,
100,000-block run ended at `0x0049b4ab` on the main thread and `0x0049b502` on
the worker. Those addresses belong to:

- `0x0049b490`: wait for a loader request's active byte to clear, calling
  `Sleep(0)` in the inner loop;
- `0x0049b4f0`: loader-thread message loop, filtered for `WM_USER` (`0x400`).

The first level open made the fault explicit. Main opened `s1.lvl`, called
`PostThreadMessageA(0xE1000, 0x400, 0x115c, 0x15b3)`, then waited forever.
`0xE1000` was the thread HANDLE returned by CreateThread. The same handler had
incorrectly copied that handle into `lpThreadId`; Win32 requires a distinct
numeric thread id there. The per-thread USER queue accepts ids 1..8 and the
worker's `GetCurrentThreadId` is 2, so the post correctly failed and the loader
never saw work.

`create_thread` now receives the translated `lpThreadId` output pointer. The
host still returns the independently allocated HANDLE, but writes worker cache
slot + 1 to the output—the same value installed as that instance's
`current_thread_id`. The exact replay then calls
`PostThreadMessageA(2, 0x400, 0x115c, 0x15b3)`, reads chunks throughout
`s1.lvl`, renders the copyright screen by batch 40, and continues normally.

This is a generic Win32 namespace fix, not an Abe special case. The focused
ThreadManager regression asserts HANDLE `0xE1000` and thread id `2` are both
published and are not equal.

## Deterministic gameplay route

### Current-source acceptance recheck

On source `1554ebe1` with the `ee965802` build, the installer-produced tree
loads the animated main menu but does not pass the old gameplay schedule.
The strong acceptance correctly rejects all four captures as menu-only:
loading-to-level changed share is 0.009 and the supposed Abe sprite has
only 135 pixels. Replacing Enter with X at batch 420 produces the same
result, so that attempted input change was discarded. A separate frozen
probe captures the menu at 570, holds Enter for ten batches, releases it,
and captures at 680; this also remains in the menu. Do not promote the
installer tree as gameplay-verified yet or weaken the image assertions.

The test now launches Node directly with `--no-build --max-seconds=240`,
without an external SIGKILL wrapper. Build separately first. Set
`ABE_INSTALLED_DIR` to the guest-produced directory to mount only its
executable, LVLs, DDVs, and readme, rather than the registered reference
payload. An explicitly missing directory is a failure, not a skip.
The renderer logs keyboard events delivered to focus HWND `0x10001`, and
the loader worker receives numeric thread ID 2 normally. The next probe
must distinguish guest key-state polling from menu-state/timing behavior;
the earlier large-image and thread-ID faults are not reproduced here.

The route below records the earlier passing build, not current proof.

### Input delivery isolation

The game callback at `0x44b710` records key-down through `0x498150`, which
writes `0x81` at `0xac37a0 + virtualKey`. The primary window is subclassed
through `0x4999a0`; the underlying callback pointer at `0xa59f98` is correct.
With Enter held through normal renderer input, both physical and async host
states read `0x8000` but guest byte `0xac37ad` remains zero, even after five
batches. Posting WM_KEYDOWN to the owning HWND through `post_message_q`
sets that byte to `0x80` after the game consumes its press bit and starts
the level. Thus the input has not merely arrived too early.

In the same frozen process, posted Enter at batch 576 starts the game;
after 80 steps it has read `r1.lvl` and `gamebgn.ddv`. Posted Escape reaches
the pause panel, Enter resumes it, and posted Right moves Abe into the next
room. The installed-payload level and moving captures were visually inspected
(`/private/tmp/abe-installed-level.png`, `/private/tmp/abe-installed-moving.png`).
No executable or game-state bytes were patched. This proves installed data
and game simulation work, but is a diagnostic route, not acceptance of the
normal keyboard path.

A related synthetic regression proves GetMessage/PeekMessage can consume
hardware input belonging to a different window-owning thread. Their shared
input-owner routing now forwards such input to the owner's queue and retains
it for retry when that queue is full. The focused filter/ownership/full-queue
test, teardown-quit test, and canonical/compat build pass. However, the full
Abe normal-keyboard test still fails identically after that fix. Further
delivery tracing is required; do not claim this queue fix resolves Abe.

### Verified smaller-batch normal keyboard route

On source `de50ad22`, the original-installer output reaches RuptureFarms
and walks right without tracing, posted messages, or guest-memory writes.
Launch the installed `abedemo.exe` with these CLI options:

```text
--vfs-include=*.lvl,*.ddv,readme.txt
--no-build --no-threads --quiet-api --quiet-blocks --no-close
--max-seconds=180 --batch-size=100000 --control-stdin --frozen
```

Use stdio `step` commands and normal `keydown`/`keyup` commands in this
order (batch numbers are the parked boundary before issuing each command):

| Batch | Action |
| --- | --- |
| 0 | step 50 |
| 50 | Enter down; step 1 |
| 51 | Enter up; step 1 |
| 52 | Escape down; step 2 |
| 54 | Escape up; step 150 |
| 204 | Enter down; step 1 |
| 205 | Enter up; step 100 |
| 305 | Escape down; step 2 |
| 307 | Escape up; step 30 |
| 337 | capture before; Right down; step 3 |
| 340 | capture moving; step 3 |
| 343 | Right up; step 2 |
| 345 | capture after; quit |

Visually inspected `/private/tmp/abe-small-level-check.png`,
`/private/tmp/abe-small-moving.png`, and `/private/tmp/abe-small-after.png`:
all show the live first room, with Abe walking right. The existing gameplay
test's bounded cyan-pixel detector measures 1148/1361/1189 sprite pixels and
X centroids 204.15 -> 219.21 -> 267.63. The CLI exits normally after quit.
An earlier identical untraced route through batch 305 showed the story movie,
so this result does not require API tracing to alter execution.

This is functional evidence for normal input on the installed payload, not
a resolution of the larger-batch failure. Batch size changes both guest
work per clock advance and scheduler boundaries; the underlying difference
is not yet isolated. The existing automated one-million-block gameplay test
still fails and must not be presented as passing. Registry promotion and
live browser installer auto-launch are now verified separately below.

The opt-in frozen acceptance route uses the same normal keyboard sequence:

```bash
ABE_INSTALLED_DIR="/private/tmp/abe-original-complete/program files/abe's oddysee demo" \
  node test/test-abedemo-gameplay.js --frozen-route
```

This runs the CLI directly with its own deadline and quits over stdio.
Captures go to `build/abedemo-frozen-gameplay/` and the log to
`build/abedemo-frozen-gameplay.log`. For compatibility
with the existing scorer, `loading.png` holds the entry menu on this route;
the legacy route captures the loading card. Both require a distinct rich
level frame, Abe's cyan sprite, rightward movement, and movement through
release. The frozen route also asserts every parked batch boundary. Omit
`--frozen-route` to reproduce the still-failing large-batch regression.
The installed-payload run passes: entry-to-level changed share 0.773,
right-key 0.030, post-release 0.032, and the same sprite centroids recorded
above. The automated before/after captures were also visually inspected.

### Browser frozen-clock investigation (2026-09-09)

The registered browser launch is not yet gameplay acceptance. A fresh
headless Chrome page at `?debug&app=abedemo&frozen&no-log`, cooperative mode,
100000 blocks/slice and 200ms/frozen step, stays black through 1050 steps.
The CLI schedule cannot be assumed portable to browser slices.

Read-only diagnostics find main EIP `0x4978e0`, immediately after `Sleep(16)`
inside `0x4978d0`; the caller is `0x41d40d` in the resource-loading loop.
Guest `0x4e886c` reports two pending loads. The loader thread at `0x49b502`
does receive numeric thread-ID-2 posts and performs ReadFile calls, so this
is not the old CreateThread HANDLE/ID bug. All eight registered companions
finish browser fetching before guest startup.

`host.js` supplies ThreadManager's `now` from renderer `_profileNow` (wall
time), while frozen GetTickCount advances with stepped guest time. Thus
1050 rapid steps advance the visible guest clock to 210000ms but do not
equivalently advance scheduler Sleep deadlines. As a diagnostic only,
replacing that instance's `_now` with `() => host.frozenGuestMs()` before the
first step lets the same 1050-step run finish loading: pending loads become
zero and the animated main menu appears. Screenshot
`/private/tmp/abe-browser-1050.png` was visually inspected. Probe and trace:
`/private/tmp/abe-browser-check.js`, `/private/tmp/abe-browser-check.log`.

No guest code/data was patched. This host override is NOT a proposed final
fix: ThreadManager also uses `_now` for wall-clock execution budgets and
profiling. A correction must give guest wait deadlines their own coherent
clock while preserving bounded worker execution. Live browser movement and
original-installer child handoff remain unverified. The temporary browser
and server were closed after each probe.

### Browser wait-clock fix and gameplay (2026-09-10)

ThreadManager now accepts a separate `waitNow` clock for main/worker Sleep
and timed waits; its default delegates to the existing `now` clock so CLI
callers keep their behavior. The browser supplies its stepped guest audio
clock. Execution-budget deadlines, elapsed-time profiling, and audio-hot
priority remain on the original wall clock. No game-specific override is
needed. The focused split-clock test fails before the fix (Sleep deadline
9016 instead of 116) and passes afterward. It covers main and cooperative
worker Sleep, timed isolated-main waits, and a frozen wait clock alongside
a still-enforced wall execution budget. ThreadManager, cooperative browser
budget, and all 48 Worker scheduler tests pass.

Actual headless Chrome, registered installed payload, cooperative mode,
100000 blocks/slice, 200ms/frozen step, no tracing or scheduler override:

1. Step 1050: animated menu, zero pending resource loads.
2. Focus `#screen`; Enter down 2 steps, up 200 steps (1252).
3. Escape down 2 steps, up 100 steps (1354): story movie.
4. Escape down 2 steps, up 50 steps (1406): live RuptureFarms.
5. Right down 6 steps, up 2 steps (1414): Abe walks right.

`/private/tmp/abe-browser-before.png` and `abe-browser-after.png` were
visually inspected: the first room renders and Abe's pose/position responds
to normal browser keyboard input. The browser and temporary server close
cleanly. This establishes direct registered browser gameplay, not yet the
original installer's live browser child handoff. The larger-batch CLI input
regression also remains open.

### Original installer through live browser gameplay (2026-09-10)

On source `a5a648bc`, a fresh headless Chrome page registers a temporary
installer entry pointing only to the original `ABEODD.EXE`, not the installed
game fixture. With frozen cooperative 100000-block slices and 200ms ticks,
the same 30/50/5000-step dialog route reaches the authentic nine-files-success
notice. Unzip is delivered with queued WM_COMMAND; this does not claim the
known synchronous helper abandonment is fixed.

Dismissing success invokes the real `WinExec("abedemo")`. The installer
exits after two more steps, and the asynchronous browser shell creates
`vfs:c:\\program files\\abe's oddysee demo\\abedemo.exe`. This is a fresh guest
with HWND `0x20001`, adopting the caller's filesystem (58 entries). No
registered game files are fetched as substitutes. The probe must allow the
parent to exit before its requested step count; requiring ten completed
parent steps incorrectly aborts before observing the child.

The child then follows the browser gameplay sequence above: level at its
step 1406 and normal Right input through 1414. Both child gameplay images
were visually inspected, including Abe's changed pose and rightward position:

- `/private/tmp/abe-browser-installer-success.png`
- `/private/tmp/abe-browser-installed-before.png`
- `/private/tmp/abe-browser-installed-after.png`

The bounded probe is `/private/tmp/abe-browser-installer.js --isolate`; its
trace is `/private/tmp/abe-browser-installer.log`. It uses the actual page
shell and keyboard input, no guest byte patches or scheduler overrides, and
closes its browser/server at completion. Remaining Abe issues are the legacy
large-batch CLI input failure and the synchronous Unzip helper route, not
original-package extraction, registered gameplay, or live child handoff.

### Historical larger-batch route (CLI)

At `--batch-size=1000000`, the registered route reaches the main menu near
batch 390. These normal keyboard events reach gameplay:

1. Down at 405 selects `BEGIN`; Enter at 420 accepts it.
2. The loading card is visible at batch 570.
3. Escape at 600 skips the skippable story movie.
4. A live RuptureFarms level with Abe is visible at batch 610.
5. Holding Right from 612 advances Abe in the level.

The full visual/input acceptance is:

```bash
node test/test-abedemo-gameplay.js
```

It asserts a rendered loading card, a distinct rich 640x480 gameplay frame,
the cyan Abe sprite in the playfield, and rightward sprite movement. This is
the gameplay gate; `test-all-exes` remains only the cheap title-art smoke.

## Ruled-out explanations

- The old black frame was not a missing DDV or level manifest: VFS enumeration
  found every registered file, and the corrected run reads the same `s1.lvl`.
- It was not a DirectDraw allocation/presentation failure: both surfaces were
  live before the fix, but the offscreen surface was uniform because level
  loading had never run.
- Increasing batch size alone cannot repair it. Before the fix, 4,000 batches
  only execute more `Sleep(0)` calls while the rejected thread post remains
  absent from the target queue.
