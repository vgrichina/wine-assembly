# Sid Meier's Alpha Centauri Classic (Windows 95 ISO)

Established against `SidMeierAlphaCentauriClassic-Windows95.iso`, Joliet
volume `SMAC-E1_0Z` (2,781 files).

## The autorun error is on the disc

The root `AUTORUN.INF` launches `AUTOMENU.EXE`. That wrapper reports:

> There was a problem loading one or more graphic images. Did you forget to
> copy the DATA directory?

The mounted ISO has no directory named `DATA`. Its `AUTOMENU.APM` also embeds
registry paths for an unrelated Jane's Combat Simulations title, so this is a
bad third-party menu packaged into the image, not a failed ISO mount. The
disc's copy of `D:\PROGRAMS\TERRAN.EXE` is the original v1 executable, while
`D:\Patch\smacp4e.exe` is Firaxis's official v4 WinZip self-extractor. The
production path must run that original updater inside Wine-Assembly; mounting
its ZIP payload directly was useful for compatibility diagnosis but is not an
acceptable replacement for installer emulation.

## Startup API sequence

`TERRAN.EXE` ships `D:\PROGRAMS\ARIALN.TTF` and creates the relative resource
name `ARIALN.FOT` while its current directory is `D:\PROGRAMS`. The CD-ROM is
immutable, so `CreateScalableFontResourceA` validates the TTF and records a
process-local FOT-to-TTF association even when it cannot persist the FOT next
to the source. Subsequent `AddFontResourceA("arialn.fot")` and
`RemoveFontResourceA` resolve through that association.

The next startup stage opens multimedia content and calls
`mmioSetBuffer(hmmio, NULL, 16384, 0)`. Wine-Assembly's host-backed VFS reads
are synchronous, but the API must still accept and reserve the requested
internal storage. With both calls implemented, the exact ISO runs for the
full 180-second probe without an unimplemented-API crash (104,697 API calls,
2,721 batches) and creates the main 640x480 DirectDraw surface.

The diagnostic v4 profile used the documented `DisableOpeningMovie=1`
fallback in `Alpha Centauri.ini`. Without it the 30 MB opening WVE can appear
as a logo followed by a permanent black screen. The Firaxis splash still
renders, then the game advances to its menu.

Focused coverage lives in `test/test-wat-font-resource.js` and
`test/test-wat-mmio.js`.

## Menu and Quick Start gameplay

The v4 game menu draws its labels with WinG `DIBINDEX` COLORREFs
(`0x10ff0000 | paletteIndex`). Keeping that qualifier through
`SetTextColor`/`SetBkColor` and resolving it against the selected 8-bit DIB
palette restores all seven formerly missing menu labels.

Quick Start also exposed three independent `PeekMessageA` contract violations.
Host input excluded by one of the game's disjoint filters was being consumed
instead of left for the later general poll, while synthetic `WM_PAINT` and
timer messages were returned even when the requested range contained only
`WM_USER+1`. Finally, timer and posted results left `MSG.time` untouched. SMAC
peeks three disjoint ranges, sorts the three records by that timestamp, then
removes the selected message; the missing timestamp made a due timer lose to
an empty record and remain due forever. Filtered input is now retained,
synthetic messages obey the same range, and every returned timer/posted
message has a complete `MSG` tail. Ordinary empty peeks return within the
current slice; the existing repeated-call spin detector still parks true idle
loops.

After Planetfall, Alpha creates more than 300 simultaneous GDI objects. The
old emulator-only 256-object table returned NULL for a valid 105x20x8
`CreateDIBSection` despite 14,634 free backing pages, producing “Unable to
allocate draw-buffer.” GDI object and DC-state capacity is now 512. The exact
ISO with the official v4 executable was driven in Chrome through Quick Start,
Planetfall, base naming, and into the interactive Mission Year 2101 map with
the tutorial and its map unit visible and no runtime crash; the final native
census was 314/512 objects and 225/512 DC states.

## Gameplay frame production

A browser-controlled complete turn advanced Mission Year 2101 to 2102. The
page compositor remained around 26 fps, but the 800x600 game image changed in
bursts at roughly 6--7 fps, with multi-second gaps while the turn simulation
ran. Idle map pixels do not change at all, as expected for this turn-based
game, so page/rAF fps must not be reported as Alpha's gameplay fps.

This is not a low frame cap in `TERRAN.EXE`. The active animation loop at
`0x0045bc3b..0x0045bdbd` draws one frame, services messages through
`0x005e5700`, and repeats until `timeGetTime() - frame_start` reaches the
global interval at `0x00671a58`. That interval is initialized to 20 ms (50
fps), with one state using half the interval. Exact counters over one measured
turn saw 975 passes through the clock/pump wait but only five completions of
this particular short animation; the whole turn made 1,179 `timeGetTime`
calls. No `Sleep`, `GetTickCount`, DirectDraw `Flip`, `Lock`, or `Unlock` call
occurred in the measured window.

Guest execution is the limiting work. A handler-histogram repeat retired
about 142--157 million guest basic blocks in 17.5--17.8 seconds. The leading
blocks are game-state evaluators, not timing or host presentation:

- `0x005a8ab0` tests flags in the 52-byte vehicle table, about 2.1--2.5M calls.
- `0x005aa710` reads vehicle/prototype/faction state, about 1.6--1.9M calls.
- `0x005a9f60` and its `0x005a9a90` helper graph repeatedly compute vehicle
  attributes, about 1.1--1.3M calls.
- `0x005688fa..0x00568912` is a 25-entry record search and executes about
  4.2M loop blocks, but is only a few percent of the full block count.
- `0x00615aa0`, `0x00615ac0`, and `0x0061eb70` are polled around 1.5--1.9M
  times while the same synchronous game work runs.

Therefore changing canvas upload or browser presentation cannot recover the
missing game frames: Alpha redraws only after large synchronous rule and map
evaluation passes, and those passes run at interpreter throughput. The next
useful optimization target is the repeated vehicle-evaluation call graph (or
general dispatch/register throughput), not the 20 ms clock wait. The
25-record search is measurable but too small on its own to explain the gap.
These absolute timings came from a loaded development machine and profiling
adds overhead; the attribution and call-count ordering were stable across
repeats.

### Chrome CPU sampling and clock A/B

A 200-us Chrome CPU sample over the same complete turn put 13.2% of self time
in threaded-interpreter `$next`, 11.1% in `PeekMessageA`, and 10.3% in the
host `performance.now()` wrapper reached through `get_ticks`. Generic branch,
register, effective-address, and guest-memory handlers account for much of the
remaining profile. By contrast, `$decode_block` was 1.1%, `$g2w` 1.1%, and
page resolution 1.6%; neither decode churn nor address translation is the
primary limit. The sampling harness's `getImageData` consumed 2.7% and is not
emulator work.

The timer path contained a real duplicate clock sample: `$timer_check_due`
refreshes `$tick_count`, then its no-WM_TIMER fallback called
`$mm_timer_due_slot`, which refreshed it again. An isolated build reused the
first sample for that fallback while retaining a fresh sample for standalone
multimedia-timer polling. Host clock self time fell from 10.3% to 5.9%, but
the measured turn changed only from 17.55 s to 17.39 s (about 0.9%, within
run-to-run noise). The game simply performs more polls while waiting for the
same wall-clock deadline. This cleanup may still be worthwhile, but it is not
the frame-rate lever.

An isolated spin-park prototype then let repeated clock reads retain their
evidence across `PeekMessageA`, while every other Win32 call still reset the
run. At the production confidence threshold (`K=8`), 1 ms and 5 ms parks fired
only 75 and 62 times and changed nothing measurable. At `K=2`, a 1 ms request
completed the turn in 17.53 s with 24.7% Chrome-profiler idle time; 5 ms took
17.64 s with 26.2% idle. The unparked profile had about 1% idle. Content kept
changing and Mission Year advanced in both arms. Thus yielding after two
identical same-site/same-millisecond reads can reclaim roughly one quarter of
browser CPU without lengthening this turn, but 5 ms is no better than the safer
1 ms request because browser timer scheduling already coarsens the yield. This
remains a prototype: pure guest computation between two clock calls is
invisible to the API-only detector, so `K=2` needs broader game-corpus false-
park testing before becoming a global default.

The remaining frame-rate work is reducing dispatches with narrowly measured
instruction fusion or moving to a native/dynamic translation tier. Making
`$next` cheaper, source-inlining it, and splitting hot memory-accessor fast
paths have already measured neutral or slower on other games; they are not
experiments to repeat. Optimizing canvas presentation, growing the decode
cache, or special-casing only the 25-record search likewise has little support
in this profile.
