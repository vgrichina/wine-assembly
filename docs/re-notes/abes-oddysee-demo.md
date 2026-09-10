# Abe's Oddysee demo

## Package and registered launch

The registered `abedemo` payload launches
`test/binaries/shareware/abe/ex/AbeDemo.exe` and explicitly mounts its four DDV
movies plus `c1.lvl`, `r1.lvl`, and `s1.lvl`. The executable is a 914,432-byte
PE32 extracted from the separate 32,219,648-byte `ABEODD.EXE` self-extractor.
The old large-image blocker is superseded by the original-installer probe
below. The registered gameplay fixture still uses the earlier extracted
payload; do not equate that with a completed original-installer workflow.

## Original self-extractor recheck (2026-09-09)

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
`--capture-launch` therefore correctly reported no child launch. Remaining
acceptance is the automatic handoff, gameplay from this installer-produced
tree, promotion of that tree into the registered app, and the synchronous
input-path abandonment above. The original large-PE blocker is not current.

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
