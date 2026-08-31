# Wine-Assembly — Architecture & Performance Review

Three passes, newest first. **Pass 3 (2026-08-30)** is a delta review three
days after Pass 2; **Pass 2 (2026-08-27)** and the **2026-08-18 pass** follow
unchanged, each with its action log, as the record of what was found and fixed
then.

---

# Pass 3 — 2026-08-30

*Reviewed at HEAD `ae1d42f1`, 204 commits after Pass 2's `60097710` — three
days, ~70 commits a day, one git author but several agent sessions coordinating
on `messageboard.txt`. Working tree dirty (47 files, +1,712 lines, nothing
staged); **line numbers are working-tree numbers as of 2026-08-30.** Seven
parallel area reviews (gates/invariants, CPU core + super-ops, Worker backend +
JS host, Win32/console/DX layer, toyvm, tools/tests, and a re-verification of
all 24 Pass-2 recommendations) followed by a verification pass on every
load-bearing new claim. Three reviewer claims were refuted before they reached
this text and are listed at the end of the section.*

## Verdict

The Pass-2 list was worked hard and mostly honestly: of 24 recommendations,
**6 done, 5 partial, 13 open**, and Tier 1 is closed except for the long tail of
WAT↔JS constants. What the three days added is a different shape of risk. The
gates that now exist are real, but two of them were initially *worked around by
process* rather than by code. The silent-stub ratchet was re-pinned one commit
after each stub removal, so `build.sh` was red on `main` for 22 of the 204
reviewed commits; §P3-3.4 now closes that gap with broad body hashing, a
ready-to-paste pin, and a clean-commit boundary check. Section P3-3.5 now closes
the other gap too: fixture absence becomes exit 77, `run-all.sh` reports a
separate SKIP column, and the manifest gate rejects child budgets above its
300-second wall-clock cap. Three real bugs landed
with new features and are now fixed: `ReadConsoleOutputA/W` wrote past the
caller's buffer for an oversized region (§P3-3.1), the MW3 grid-filter super-op
stored through guest memory without scalar-store SMC invalidation (§P3-3.2),
and a `--threads` run lost `--fault-null`, `--count`, `--trace-eip-range` and
the MMX flag on every worker instance (§P3-3.3). The performance items got worse
on purpose — the DirectDraw slot walk is now 4096 wide and the GL immediate-mode
path calls the per-word `DataView` allocator from eight more sites — and the two
biggest WAT files both crossed 16k lines. The healthy side is also real: the
MW3 folds are byte-proofs with differential tests against the scalar path, the
console became a subsystem with `last_error` on every failure, and the mutex
model is one lock across both backends.

## P3-0 — Numbers

| | 08-27 | 08-30 | note |
|---|---|---|---|
| `src/*.wat` lines / parts | 187,764 / 59 | **192,238 / 60** | +4.5k in 3 days |
| Handler table | 437 | **442** | H439 fnstsw/test/jcc, H440 rgb565 colour-key, H441 MW3 grid filter |
| `api_table.json` | 3,012 | **3,071** | 59 new, all with `nargs` |
| `crash_unimplemented` sites | 98 | **137** | D3D9 flip + new DX rows |
| Silent-handler ratchet pin | — | **506 broad** (was 315 exact-shape) | see §P3-3.4 |
| Tests / unlisted | 631 / 48 | **677 / 0** | gate in `build.sh:25` |
| SKIP accounting | — | **exit 77, separate total** | §P3-3.5 |
| `test/run.js` / `host.js` / `index.html` | 8,612 / 2,553 / 2,324 | 8,672 / 2,553 / **2,477** | index regrew |
| `?v=` tags / `SOURCE_VERSION` | 44 / `234` vs `'228'` | **45 / `248` vs `'239'`** | now four counters (§P3-3.10) |
| `lib/apps.js` entries | 141 | **146** | |
| `tools/` files / `lib/` files | 155 / 52 | 158 / 53 | |
| Build gates in `build.sh` | 14 | **16** | + `check-wat-js-constants`, `check-test-manifest` |
| Full build, dirty tree | — | 17.3 s wall / 7.8 s user | |
| Biggest WAT parts | 09a 14,888 / 09c3 ~15k | **09c3 16,782 / 09a 16,006** | both over 16k |
| toyvm | ~15.6k lines | **18,099** | `dos.js` 4,209, `emit.js` 4,202 |
| `docs/dos-corpus` tracked | 12 programs | **84 programs, 5.1 MB** (11 MB with shots) | |

## P3-1 — What the 204 commits were

By subject: ~49 Win98 API implementations (console screen buffers, titles,
device files, OEM tables, VkKeyScanEx, WaitForInputIdle, recursive mutex,
WaitMessage, registry disposition, owned-popup visibility, ShowScrollBar,
listbox scrolling, Unicode CREATESTRUCT); 38 DOS/toyvm (an 18-commit ANGEL
protected-mode diary, VESA 640x480, a Trident bank register, corpus 199→194
passing, the corpus page from 12 to 84 runnable demos); 14 MechWarrior 3
super-ops and profiling; 14 GOG/Baldur's Gate/Icewind Dale/Half-Life acceptance
and Worker fixes; 9 Far Manager console work; 8 gates and fixes taken straight
off the Pass-2 list; 5 stub-ratchet re-pins. Peak cadence 26 commits in one
hour.

## P3-2 — Pass-2 recommendations, re-verified

| # | item | status | evidence |
|---|---|---|---|
| 1 | memory-map gate | DONE | `build.sh:15`; but see §P3-3.6 |
| 2 | WAT↔JS constants gate | PARTIAL | `tools/check-wat-js-constants.js` (`build.sh:22`) covers GUEST_BASE at 5 named sites, RPC/SYNC, DX base/stride/MAX, WIN16_DYNAMIC_BASE, the OpenProcess tag (`:124-135`), GL `ARG_WORDS`. Not covered: `THUNK_BASE`, `CONTROL_TABLE` stride, the hwnd base literal `0x10001` (`host.js:1071`, `thread-manager.js:39-40,1040`), and ~20 more `0x12000` literals (`dll-loader.js:44,75,127,267,356,391,464,499`, `filesystem.js:551,881`, `host-imports.js:144,1437,1473,2448-2557`, `app-profiles.js:131,236`) |
| 3 | cs_wait fall-through | DONE | `2ac6df83`, holds at `host.js:2203` |
| 4 | test-manifest gate | DONE | `build.sh:25`; 677 files, `QUARANTINE=()` empty (`run-all.sh:748`) |
| 5 | DLL_TABLE bound | DONE, WAT side too | `08b-dll-loader.wat:31` refuses before any write; `01-header.wat:2548` |
| 6 | `i32.and` gate | DONE | `build.sh:45`, green |
| 7 | A/W + family divergences | DONE | EnumDisplaySettings `09a3:1243-1310` (`d079ab95`); GetCommandLineA cached `09a:549-553`; RegisterClipboardFormatW interns `10-helpers:3602`; RegSetValue shared `09a:10443` (`1cb53d8b`); GetTextExtentPointW wide `09a4:2241-2252`; CreateWindowExW wide CREATESTRUCT `09a:7648-7689`, `09a5:569-573` (`67bc959c`); listbox WM_VSCROLL/WHEEL `09c3:11530,11543` (`84fabc9b`); MoveWindow/SetWindowPos preserve repaint flags and derive changed-only WM_MOVE/WM_SIZE (`5d0abb15`, `test-movewindow-child-size.js`) |
| 8 | symbolic handler/api ids | OPEN, grew | 371 bare literals in `07-decoder.wat` (+37 in `07b`), H440/H441 added as bare `:666,:706`; stale "handler 422/424" comments still at `07-decoder.wat:50,152,416,2132` and `13-exports.wat:3037,3045` (422/424 are now `$th_mmx_rr/_mr`); `0xCACA0010` hand-stored `09a8:985,1018` |
| 9 | app-literal gate / `copySuperops` | PARTIAL | MW3 VAs are out of the decoder (byte-hash predicates, §P3-3.9); `browser-shell.js:566` honors the flag; **`test/run.js --app=mw3` still does not** (only `--copy-superops`, `:188,4035,7429`); no allowlist tool |
| 10 | one globals table / hwnd base / `yr===9` | PARTIAL | `lib/worker-imports.js` exists but is a *ctx-key* list, not the WASM-global table; setter sets still diverge (§P3-3.3); hwnd base still two formulas (`thread-manager.js:416-418` vs `:1040`); duplicate `yr === 9` moved to `thread-manager.js:2276-2287` / `:2303-2309` (second still unreachable) |
| 11 | silent stubs | PARTIAL | DONE: WaitMessage `09a:13588-13600` (`5237ac44`), ReleaseMutex `09a:12056-12071` (`1e76e8ab`), HeapCreate per-call `09a:2123`, CreateConsoleScreenBuffer `09a7:2914`, CreateIconFromResourceEx `09a:11456`, DirectDrawEnumerateA CACA `09a8:1043`, EnumDisplayModes `09a8:1833`. RegisterHotKey FIXED `2b27e407` (real registration list, modifier matching, WM_HOTKEY through the queue — `09a:11184-11238`). DirectPlayEnumerate[A] FIXED `0064c7fc`, pushing the real DPSPGUID_TCPIP provider through the guest callback. Viewport lights FIXED `14b75f42`: D3D v1-v3 now retain an ordered eight-light list, enforce ownership/capacity, AddRef/Release and enumerate HEAD/NEXT/TAIL; `LightElements` fails honestly with `E_NOTIMPL`; the ratchet fell 524→514 in the same commit. `IDirectDrawSurface::EnumAttachedSurfaces` FIXED `bfa0f9b3`: it now calls back with the live direct backbuffer/attachment, matching legacy descriptor, and callback-owned AddRef; the pin fell again to 513. DirectInput enumeration FIXED `ba441430`: `EnumDevices` now reports the Win98 system mouse/keyboard with legacy GUID/type/filter semantics, `EnumObjects` reports mouse axes/buttons and mapped keyboard DIKs, and both honor guest `DIENUM_STOP` through reentrant stack frames; `GetDeviceInfo`/`GetCapabilities` now fill caller-sized legacy structures and the pin fell to 509. DirectInput `GetObjectInfo` FIXED `c559b8fd`: offset and enumerated-object-ID lookup share the canonical mouse/key descriptors, legacy non-HID usage lookup reports no object, caller-selected DX3/full sizes are bounded, and invalid pointers/sizes/selectors fail with the documented errors; the pin fell to 508. `DIPROP_BUFFERSIZE` FIXED `9c91f509`: `GetProperty` and `SetProperty` validate the documented `DIPROPDWORD`/`DIPROPHEADER` device selector, round-trip the exact configured queue capacity, and reject unmodeled properties instead of returning false success; the pin fell to 507. `IDirectDraw::EnumSurfaces` FIXED `f55bd764` plus the immediate follow-up: `DOESEXIST` enumerates only live surfaces created by that DirectDraw object, filters `ALL`/`MATCH`/`NOMATCH` against canonical descriptors, AddRefs callback interfaces, and honors callback continue/cancel through reentrant stack state. The documented `CANBECREATED|MATCH` path now uses real temporary surface creation, passes the usable object and canonical descriptor to the one callback, releases the enumerator's reference afterward, and preserves a callback-retained AddRef; invalid objects and flag combinations fail. The pin fell to 506. OPEN: hooks `09a7:488` / `09a:9348-9360`; DDE trio `09a:1188,1198,1245`; 8 DX enumerations returning 0 without a callback (`09a8:5279,5357`…) |
| 12 | dead code / tools / requires | PARTIAL | WAT dead list deleted (`71191bed`); `wat-func.js` still has no `--dead`; all 6 superseded tools present; 3 broken requires unchanged (`tools/trace-assert.js:6`, `render-desktop.js:9`, `test/call-func.js:10`); `win16-v86-compare.js:265` still greps `[CreateWindowEx` |
| 13 | per-block counters / atomic gate | OPEN | `04-cache.wat:741,797`, `05-alu.wat:773`, `13-exports.wat:52-58` |
| 14 | cached DataView / live-surface set | DONE | GL command decoding caches one memory view (`f4e5b79b`). DirectDraw now caches its view too, bootstraps the 4096-slot table once, then walks an allocation/free/traffic-fed live set; the common WAT DX allocator covers DirectDraw and D3D9, including high recycled slots (`test-dx-live-surface-index.js`) |
| 15 | SMC bitmap inline | OPEN | `03-registers.wat:374,393,404`; `$code_page_clear` deleted rather than wired |
| 16 | `$mmx_binop` br_table | OPEN | `06c-mmx.wat:262` |
| 17 | free lists / `_flush_if_safe` | OPEN | `13-exports.wat:64-68`; `04-cache.wat:889-896` now `fn >= 442` |
| 18 | EditState / split wndprocs / GDI out of 09a | **WORSE** | `09c3` 16,782 lines, `$edit_wndproc` at `:13827` (~1,570 lines); `09a` 16,006 / 802 handlers; WordPad tail `10-helpers.wat:3403-4161` |
| 19 | `renderer.windows` → WAT | OPEN | `host-window.js:344-380,596,655,681` |
| 20 | page-viewport / settings split; one version | **WORSE** | `index.html` 2,477 (+155), ~1,095 inline JS lines after `:1382`, picker CSS inline `:84-224`; §P3-3.10 |
| 21 | runSlice/threads in `apps.js` | OPEN | `autoRunSliceFor` 17 cases `browser-shell.js:216`, plus a new Half-Life registry-path regex there |
| 22 | one `check_input` / `makeWorkerImports` | OPEN | `renderer-input.js:3131/3165`; `host.js:1000` / `run.js:3060` |
| 23 | toyvm vectors + gate; `disasm.js` shared | OPEN | `toyvm/gate.js:18` still fetches; `decode.js` drifting further (§P3-6) |
| 24 | `run.js --json-summary` | OPEN | 0 hits; scrapers unchanged |

P2-2 (the 08-18 list) is unchanged except line drift: EditState `~:12900/:13827`, window rect `10-helpers:2968-3029`, scroll state `01-header:3050` vs `09c-help:441,447`, raw api ids `09b-dispatch.wat:921,932,946`.

## P3-3 — New findings, ranked

**3.1 `ReadConsoleOutputA/W` writes past the caller's buffer — bug (`3ba9e8ea`); FIXED `9d12c589`.**
`$console_read_output` (`09a2-handlers-console.wat:988-1030`) takes
`dwBufferSize` as `arg2` but uses only its low word (`$bw`, `:1000`); the
buffer *height* is never read, and `lpReadRegion` (`:1005-1008`) is never
clamped to it. The destination offset
`((row-top)+by)*bw + (col-left)+bx` (`:1017-1022`) is bounded by nothing, so a
region taller than the buffer, or a `dwBufferCoord` past its edge, stores
CHAR_INFO cells beyond `lpBuffer` in guest memory. The source side checks only
`soff < width*height` (`:1023`), so columns past `console_width` wrap into the
next row instead of clipping, and `lpReadRegion` is never written back with the
clipped rectangle (Win32 does). Same wrap in `ReadConsoleOutputAttribute`
(`:1018-1034`). *Fix:* read `bh` from `arg2 >> 16`, intersect the region with
both the buffer rectangle and the screen buffer, write it back.

**3.2 H441 stores skip self-modifying-code invalidation — bug-class; FIXED `c5ceec02`.**
`$th_mw3_grid_filter_run` (`07b-loop-match.wat:3108-3330`) writes through
`i32.store16 offset=2 $eax_wa` (`:3271`) and `i32.store $stack_wa` (`:3283`)
directly. Every scalar store goes through `$gs16/$gs32`
(`03-registers.wat:376-395`), which call `$invalidate_code_write`; the other
bulk folds do it explicitly (`07b:2326,2620,3502,3958`). A grid row that lives
in a page that ever held decoded code would not invalidate it. Correct today
only because MW3's grid is not in a code page; the fold is byte-matched, so any
binary containing the same 101 bytes gets the same omission. The sibling H440
stays per-pixel `gs16` and is fine.

**3.3 Worker instances get none of the debug/feature flags — FIXED
`3bb856a6`, `acc7334a`.** `lib/worker-imports.js` now owns one declarative
21-setter runtime configuration. The same ordered snapshot is applied when
`ThreadManager` creates a cooperative instance and when `guest-worker.js`
initializes a real Worker instance. This includes MMX via `get_cpu_mmx` (so
`--no-mmx` and its zero value survive), WinVer, bp/watch, fault handling,
counting, tracing, and loop flags. `test/test-worker-wasm-globals.js` proves the
two backends receive the same values, including `set_cpu_mmx(0)`; the CLI
Worker lifecycle test covers the inherited fault/count/trace behavior.

Requested Worker diagnostics now use the accurately named `forwardGuestLogs`
channel. CLI verbose/API/count/loop-match/Win16/FPU diagnostic modes opt into
it; ordinary runs intentionally keep `log`, `log_i32`, and `log_api_exit`
local instead of adding RPC traffic. `forwardGlLogs` remains only as a legacy
option/wire alias for cached callers. `test/test-worker-api-batching.js` covers
the opt-in, the no-RPC fast path, the compatibility alias, and both Worker host
constructors.

**3.4 The stub ratchet is bypassed by process — FIXED.** The original finding
remains in history: four older re-pins landed as separate commits *after* their
removals (`694e2ab2`, `1535d918`, `1a21921d`, `0626553b`), leaving `build.sh`
red on `main` for intervening commits. Current practice improved first:
`4a08c267`, `e3ff3e4c`, `2b27e407`, `0064c7fc`, `32590db9`, and the
`SetConsoleWindowInfo` fix each remove stubs and lower the pin in the same
commit. `32590db9` also repairs the omitted pin for `c6d52424` while replacing
`FlushInstructionCache` with Win98-compatible current-process validation,
range/full decoded-code invalidation, and a shared generation that reaches all
real Workers. The two-instance generated-code regression proves that a sibling
Worker cannot keep executing a stale decoded block after the flush.
`SetConsoleWindowInfo` removes the next silent success: its per-buffer viewport
now validates absolute/relative inclusive rectangles, round-trips through
`GetConsoleScreenBufferInfo`, clips painting and mouse coordinates to the
viewport, and resizes the browser console client like the Win98 console.

The code now closes both remaining gaps. The classifier (`:31-68`) inventories
all 506 straight-line handlers with no call, control-flow branch, fail-loud
trap, or memory write and hashes each complete normalized body, rather than
matching only `eax=const; esp+=N`. Thus the stateful-looking
`SetFileApisToOEM/ANSI` escape is in the pin even though it touches a global;
implemented handlers that delegate, publish output, or branch are outside it.
Classifier self-checks cover constant/stateful quiet bodies and each excluded
effect class (`:51-62`). `--list` exposes the complete reviewed bodies and
`--print-pin` plus mismatch output prints the exact replacement count/hash
lines (`:80-97`). Finally, a clean-checkout Git audit compares changed WAT
inventories with `HEAD^` and rejects a pin-only catch-up commit unless the
classifier itself changed (`:99-157`). Source archives and dirty development
trees retain the ordinary content ratchet without depending on Git.

**3.5 250 of 677 tests can pass without running — FIXED.** Historically,
fixture tests logged a leading `SKIP` and then returned or called
`process.exit(0)`, which `run-all.sh` counted as PASS; the reviewed tree could
therefore report 37% green-by-absence. `test/skip-exit.js` now defines that
existing log convention as a process protocol: natural completion and explicit
exit 0 become status 77 after a leading SKIP, while any real nonzero failure is
preserved (`:5-32`). The tier runner preloads it for each direct child
(`run-all.sh:828-864`), classifies 77 separately (`:895-908`), and carries
per-tier and global skipped counters through the summary (`:918-949`). The
focused regression covers natural completion, explicit exit, failure
precedence, and non-protocol prose (`test-skip-exit.js`).

The impossible timeout half is closed by the manifest gate too.
`tools/check-test-timeouts.js` reads the runner's named 300-second default,
scans every listed test for numeric `timeout*` declarations and
`--max-seconds=N`, ignores JS comments, and fails on values above the cap
(`:11-94`). `check-test-manifest.sh:41-43` runs it before reporting a complete
suite. Seventeen listed files whose 330–900 second child budgets could never
outlive the runner were reduced to the already-enforced 300-second ceiling;
the checker regression covers equality, both over-cap forms, comments, and
manifest wiring (`test-test-timeout-manifest.js`).

**3.6 The memory-map gate sees only `_SIZE`-paired globals — FIXED `8ed5ae8c`.**
Every `0x07xxxxxx` constant-address global must now either publish its own
`_SIZE` or appear in an explicit, range-checked alias-to-owner table. A new
unclassified high global fails the build even when its address happens to fall
inside some existing region. The gate also ties declared extents to the counts
and strides that index the DLL, Win16, console, code-page, GDI, COM-wrapper and
vtable tables; shrinking `_SIZE` no longer makes an overflowing implementation
look safe.

Turning the 55 formerly invisible globals into checked regions/aliases exposed
three live layout errors: `DLL_RSRC_TABLE`'s declared 512 bytes covered the
untracked `DLL_PATH_TABLE` even though its 16 × 8-byte implementation needs
128; the 2,048-entry `WIN16_THUNK_TABLE` occupied 8KB from 0x079C7000 and
overwrote `WND_Z_ORDER_TABLE` at 0x079C8000; and `COM_WRAPPERS_AUX`'s declared
tail covered the first four bytes of `DX_VTBL_REGISTRY`. Their extents are now
correct, the thunk table moved to the complete 0x079D8000 gap, and the registry
starts exactly after the padded aux pool. The new capacity assertion also
stopped an in-flight 4→6 Win16 app-DLL expansion from extending 0x07A00000
through the API/console/GDI/DX tables; that six-megabyte staging arena now lives
in the checked 0x04A00000..0x05000000 gap before `THREAD_CACHE_BASE`.

**3.7 `tools/check-parens.js` is red on HEAD and nothing runs it — FIXED `1166907c`; it was a real stray paren, see the addendum.** On a fresh
`concat-wat.js` it reports `final depth -1` at `build/combined.wat:192307`; per
part, `10d-gdi-region-path.wat` goes from depth 3 to -1 on a line that closes
five (`:2849`) inside a function body — so the checker lost count *earlier* in
that file, while the in-house compiler compiles the same text clean. `build.sh`
never invokes it (`concat-wat.js` at `:67`, no check), CLAUDE.md lists it as the
balance checker, and `02b`-style edits are exactly where it is reached for.
Either its string/comment stripping (`:43-47`) is wrong or a part has a stray
`)` the compiler tolerates; both are worth knowing.

**3.8 Performance items went the wrong way, knowingly — PARTIAL.** The two
memory-view/table regressions are now closed. `f4e5b79b` gives the buffered GL
command path one identity-checked `DataView`. DirectDraw's fallback presenter
now does one compatibility census of the 4096-slot table, then walks only an
allocation/free/Lock/Blt/Present-fed live set with one cached view. The common
`$dx_alloc`/`$dx_free` path publishes lifecycle records after releasing
`LOCK_DX`, so DirectDraw and D3D9 surfaces created in real Workers are covered;
freed/recycled high slots and an allocation observed before CreateSurface has
filled its fields are regression-tested (`test-dx-live-surface-index.js`).

Allocation leftovers remain. The GL immediate-mode compiler
(`gl-command-stream.js:36-90,151-240`, good design) pushes a JS array per vertex
(`:162`) that is copied twice (`:89,:187`); `_setColor` allocates per `glColor*`
(`:137-149`). `gl-compat.js:298-309` does three `.slice(-1)` per draw.
`renderer-input.js:303-306` now posts a `WM_NCHITTEST` on
**every** mousemove ahead of `WM_SETCURSOR` (two posts per move into the 64-slot
ring) and `:214-221` sends one synchronously before every button-down — an
owner-thread round trip per click in Worker mode. Nit in the same file: flat
`GL_QUADS` take triangle 1's colour from vertex i+2 where GL's provoking vertex
is i+3 (`gl-command-stream.js:60`); `LINE_STRIP/LOOP` ignore flat entirely.
*(Provoking-vertex nit FIXED `758263a2` — both QUADS triangles and QUAD_STRIP
now name provoking `i+3` explicitly, `gl-command-stream.js:141-153` — and
`6cc2dcaa` deleted the dead immediate replay path outright.)*

**3.9 The MW3 folds — gate split FIXED `fab6546d`.** H436/H440/H441 are now
address-independent byte proofs: H440 compares its entire 19-byte body
literally (`07-decoder.wat:638-675`), H436 and H441 anchor four dwords and then
FNV-1a the whole body (`:586-636` == `0xe93ce905` over 0xAD bytes; `:677-718`
== `0x11ad09b2` over 101 bytes). A different binary folds iff it contains the
identical loop, and the handler replays exactly those bytes, so folding it is
correct. The tests (`test/test-mw3-*-run.js`) are true differentials —
`set_loop_copy_emit(0)` vs `(1)` on the same build, `deepStrictEqual` on memory
+ 8 registers + flags, with overlap and near-miss cases — the standard every
fold should be held to. The process-shared state word now has independent bits:
production `set_loop_copy_emit` enables only those three exact MW3 folds, while
the generic `COPY_RUN`/avg recognizers remain default-off behind the explicit
`set_loop_generic_copy_emit` test/benchmark gate. The regression turns the
production bit on and proves a generic bounded-copy block is recognized but
not lowered. **AoE span proof FIXED `6bbf1543`:** the cheap register-layout
anchors are now followed by FNV-1a over every byte of the authentic 0x6b-byte
AoE I or 0x6a-byte AoE II prefix; an interior-byte mutation that the sampled
matcher accepted is pinned as a near miss in the differential regression.
H441 also reloads its count from
`[ESP+0x10]` each cell but H440 reads `[EBP+0xc]` once (`:3013`) where x86
re-reads it per iteration — diverges only if the row aliases the frame. H439
(`06-fpu.wat:947-979`) is correct and has no differential test.

**3.10 Four version counters.** `index.html` has 45 hand-bumped `?v=` (20 of
them bumped in this window); `host.js?v=248` (`index.html:1379`) vs
`SOURCE_VERSION='239'` (`host.js:29`); `guest-worker.js:27` imports
`gl-command-stream.js?v=3` while index says `?v=4`; `host.js:1245,1252` carry
their own (`sigs?v=3`, `guest-worker.js?v=10`). A worker can load a different
build of the GL encoder than the page that spawned it.

**3.11 Small correctness items — FIXED.** DirectSound 3D buffer/listener
`GetAllParameters` and `SetAllParameters` now validate the caller's exact
64-byte structure contract and reject null/short/oversized inputs without
touching adjacent memory (`391fe732`, `test-directsound3d-listener.js`). Named
mutex creation uses bit 31 only as private host-return metadata, strips it from
the issued handle, and reports `ERROR_ALREADY_EXISTS` through `last_error`
(`1e76e8ab`, `test-open-mutex-w.js`). `ToAscii` delegates to the shared
translator without reading a nonexistent sixth argument and corrects the
stdcall frame to five arguments (`5c7b14a5`, `test-to-ascii.js`).

Standard console streams now have process-shared, generation-tagged
`DuplicateHandle` aliases rather than returning the same small handle number;
`FlushConsoleInputBuffer`, output routing, `GetFileType`, and `CloseHandle`
resolve them, while closing one alias leaves sibling aliases and the original
stream alive and makes the stale generation fail (`4a812854`,
`test-console-input.js`). `CreateWindowExA/W` marks the HWND actually allocated
before callbacks and honors `WM_NCCREATE`/`WM_CREATE` rejection with the
Win98 `WM_NCDESTROY` abort sequence (`3bdb921f`). Finally, `WaitMessage` parks
with its call frame live until queue work arrives, then completes exactly once;
real Worker slices leave that yield parked instead of clearing and re-entering
the API as a busy poll (`5237ac44`, `42f10d02`,
`test-getmessage-teardown-quit.js`, `test-worker-thread-scheduler.js`).

**3.12 Duplication and drift, new.** `readSyncObjectName` + `win32ThreadId` +
the mutex/event trampolines are verbatim in `host.js:807-838` and
`run.js:2826-2852`; the `wait_single/wait_multiple` switch likewise
(`host.js:849-862` / `run.js:2856-2866`) — a dozen lines copied in the window
that also *removed* a duplicate (`vfs.ensureParentDirs`, `host.js:1467`,
`run.js:3518`). The thread-id is derived three ways (`host.js:820`,
`run.js:2844`, `thread-manager.js:1814`), equal by hand. `lib/debug-app-picker.js`
(446 lines, clean, `?debug`-only, no test) keeps its own `OTHER_APP_IDS`/
`OTHER_GAME_IDS` lists (`:276-280`) outside `apps.js`, and `index.html:1180-1184`
adds five `<option>`s inline. `png-pixel.js` joins `png-probe.js` as the sixth
PNG inspector. Stale text: CLAUDE.md:223 says "128 MB flat WASM linear memory"
— `01-header.wat:830` is `(memory 8192 8192 shared)`, 512 MB, with
`THREAD_RPC` at 0x1FF00000; `04-cache.wat:403-409` still describes a fallback
to the deleted hash cache; the four new build gates, `check-test-manifest.sh`,
`png-pixel.js`, `fetch-candidate-corpus.js`, `run-daggerfall-gameplay.js` have
no CLAUDE.md line, so the next session hits a failing gate with no pointer; the
`--handler-hist` and `render-png.js` rows are still wrong.

## P3-4 — Areas, briefly

**Win32/console/DX.** The console is a subsystem now: an 8-slot screen-buffer
table at 0x07E0F840 (`01-header.wat:3417-3422`, stride 48, handles
`0x0031xxxx`), cells from `$heap_alloc`, `$console_buffer_create`
(`09a2:113-140`) bounded with `ERROR_NOT_ENOUGH_MEMORY`; `CONIN$/CONOUT# Wine-Assembly — Architecture & Performance Review


(`09a:1586-1604`) return the `GetStdHandle` numbers 1/2 and VFS handles start
at `0xF0000001` (`filesystem.js:24`), so no collision; titles bounded on both
Set forms. `aw-census.js`: 212 pairs, 140 shared, 55 delegating, 16 divergent
(was 14 — the two new are census heuristics, not re-verified). New handlers set
`$last_error` on failure uniformly; no non-saturating `i32.trunc` in any DX
file; no copy-paste between `09a8` and `09ab`. The mutex (`thread-manager.js:
576-646`) is one SAB record for both backends: recursion count, non-owner
`ERROR_NOT_OWNER`, abandonment on thread exit with `WAIT_ABANDONED_0` once,
covered by `test-open-mutex-w.js`.

**Worker backend.** 208 imports, `ASYNC_SAFE` gained only `paint_begin/end`
(`guest-rpc.js:89-90`); DirectDraw still unbatched. `_workerPeMeta` re-reads
exports on every spawn (`:1096-1102`) — deliberate, named Diablo's Storm
worker. `minPolls` floor now exists on the cooperative side too
(`:2381-2387`) but the two wait state machines remain forked (`resolveWait :1339`
vs `checkMainYield :2270+`). Main-thread `WaitMessage` cannot deadlock on a
timer-only wake (`$has_pending_message`, `13-exports.wat:2745-2762`, checks
timers). `activeStepsPerSlice` lost its 1000 floor (`host.js:2290`) — safe
today only because `browser-shell.js` returns ≥1000. The `DI_MOUSE_INPUT_STATE`
ring (`renderer-input.js:104-182`, `09a8:356-420`) is a proper single-producer
Atomics FIFO at 0x07F20400, in the map.

**toyvm.** `dos.js` is one 3,500-line `class Machine` (DOS 21h, BIOS, VESA,
Trident, PIT/PIC, XMS, EMS, keyboard scripting) with banner comments as its only
structure; it still shares nothing under `src/`, and `decode.js` moved further
from `07-decoder.wat`'s 16-bit path (benign-self-patch set, lgdt/cr0/LDT). The
WATX plan is still `Status: proposed`, zero references. The committed browser
bundle `docs/dos-corpus/live/toyvm-bundle.js` is **stale** (regenerates
differently; last built 08-27, sources changed 08-30) and
`test-toyvm-browser-bundle.js:22-39` only checks it loads; `bundle-browser.js`
has no `--check`, and `:236` `path.join(ROOT, out)` turns an absolute `--out`
into a path inside the repo. The corpus moved to `~/dos-demos` with `/tmp/demos`
a symlink (`84c3ad1c`) but `fetch-demos.js:7`, `sweep-dos.js:8`,
`bundle-programs.js:7` still say `/tmp/demos`. 84 demoscene binaries (5.1 MB)
are now tracked under `docs/` — weight and licensing worth a decision. The ANGEL
investigation (`docs/dos-corpus-blockers.md:64-488`) is a diary with withdrawn
readings kept inline; its actual end state — SETUP/D-bit/LDT fixes done, spins
at `5f85:0da6` waiting on `int FFh` service 0, music channel-0 position stuck at
1, two known LDT gaps — takes three lines and should be the section's first
paragraph, not its last.

**tools/tests.** `fetch-candidate-corpus.js` is offline-by-default, sha1-pinned
(40 entries, `:371-379`), gitignored destination, path-traversal-guarded (`:35`);
one `mkdtemp` in `os.tmpdir()` (`:133`). Tests pin extracted fixtures by sha256
before asserting. Graded: `test-mw3-rgb565-colorkey-run.js` A (x86 oracle),
`test-console-screen-buffers.js` A- (real handlers via `extraWat`; some layout
constants are ours, not Win98's), `test-icewind-dale-demo.js` B (title + pixel
heuristics tuned to current output; the `icewind.gam` containing `codex\0` is
the one true oracle; rolls its own PNG analysis). 10 of 10 sampled new tests
assert something real. No `--dead` in `wat-func.js`; the three broken requires,
the six superseded tools and the `[CreateWindowEx` grep are untouched from
Pass 1.

## P3-5 — What's healthy (keep doing this)

- Six of the Pass-2 gates were built and are green: memory-map, WAT↔JS
  constants, test-manifest (0 strays, empty quarantine), logical-AND,
  silent-stub ratchet with a content hash, DLL table bound on both sides.
- The MW3 folds set a new bar: byte-hash predicates, address independence,
  and differential tests against the scalar path with overlap and near-miss
  cases. `6bbf1543` applied it backward to `aoe_span_prefix`; keep applying it
  forward to every fold.
- Every new Win32 handler in the window sets `$last_error` on its failure
  path; console and mutex are real subsystems, not shims.
- Both spawn paths and the Worker stack zero-fill use `guest_to_wasm`
  (`thread-manager.js:1514,1565`, `guest-worker.js:432-434`).
- `resolveWait` no longer wakes a plain `WaitForMultipleObjects` on a queued
  message (`:1348-1355`); `filesystem.js:227-236` grows geometrically.
- The crash dump (`host.js:2506-2531`) prints prev_eip, registers and the top
  of stack.
- GL uniform dirty-tracking (`gl-compat.js:318-322,377-404`) and packed
  immediate-mode draws are real savings.
- All 59 new `api_table.json` rows carry `nargs`; ESP gates pass on them.
- `docs/re-notes/mechwarrior3-demo.md` (+810 lines) records what was measured
  and what was not claimed ("no FPS claim under host load").

## Pass-3 recommendations

**Tier 1 — bugs and the two process gaps (a day):**
1. ~~Clamp `$console_read_output` to both `dwBufferSize` words and the screen
   buffer; write back `lpReadRegion`.~~ **FIXED** (3.1)
2. ~~Invalidate H441's two stores and test a grid row in a code page.~~
   **FIXED** (3.2)
3. ~~Use one inherited-globals table for both Worker spawn paths and diff the
   setter sets in a test.~~ **FIXED** (3.3)
4. ~~Re-pin the stub ratchet in the same commit, print the replacement pin,
   and widen coverage to handlers with no call/branch/store.~~ **FIXED** (3.4)
5. ~~Use a SKIP exit code with its own runner column and refuse per-test
   timeouts above the runner cap.~~ **FIXED** (3.5)

**Tier 2 — gates that are one rule short:**
6. Memory-map gate fails on any high-range global without `_SIZE`. (3.6)
7. Fix or delete `check-parens.js`; if kept, run it in `build.sh`. (3.7)
8. `bundle-browser.js --check` in `build.sh`; fix the absolute `--out`. (§P3-4)
9. One version string: generate `?v=` from `SOURCE_VERSION` at deploy, and
   make `guest-worker.js` import the same list. (3.10)
10. ~~The COPY opt-in should enable the three proved folds only; the generic
    `COPY_RUN` matchers get their own flag until the Storm divergence is
    resolved. Hash `aoe_span_prefix`'s whole body.~~ (`fab6546d`, `6bbf1543`;
    3.9)

**Tier 3 — carried from Pass 2, still the right list:** items 8 (symbolic
handler/api ids — 442 handlers and 3,071 apis addressed by literal), 9 (`run.js
--app` honors `copySuperops`), 11 (8 DX enumerations, hooks, DDE),
12 (three broken requires, six dead tools), ~~14 (live-surface set instead of a
4096-slot walk; `_memoryView()` for `u32At`)~~ **FIXED** (3.8), 18 (split `09a`/`09c3` — both over
16k now), 20, 24.

**Struck during verification.** Three reviewer claims did not survive: the
`LOOP_PROCESS_STATE` opt-in "leaks into the next app in the same session" (no —
`host.js:967` allocates a fresh `WebAssembly.Memory` per launch);
`LOOP_PROCESS_STATE` "has no `_SIZE` twin" (it does, `07b:75`); and "the
OpenProcess tag is not in the constants gate" (it is, `:124-135`). Counts that
moved between reviewers were resolved by reading: 204 commits, 677 test files,
250 SKIP paths, 60 unpaired globals.

---

## Pass-3 addendum — 2026-08-30, +24 commits (HEAD `973589a1`)

*Three hours and 24 commits after the pass above. Three area reviews (Pass-3
status, D3D render Worker + GL + input, toyvm decoder + WinRAR dialogs) and a
verification of every new claim below. Numbers moved little: src 192,914 lines,
api 3,075, handlers 442, tests 681 (251 with a SKIP path, 37 over the 300 s
runner cap), stub pin 323, build 7.6 s on the dirty tree.*

**Pass-3 scoreboard.** Of findings 3.1–3.12 and recommendations 1–10, two were
closed within the hour of this addendum being written — **3.1 FIXED
`9d12c589`** (`$console_read_output` reads `bh` from `arg2>>16`, clips to both
the buffer and the screen, writes `lpReadRegion` back; test added) and **3.2
FIXED `c5ceec02`** (both H441 fast-path stores now call
`$invalidate_code_write`, `07b:3275,3289`). Three more closed by 08:20:
**3.7 FIXED `1166907c`** — and the finding was better than written: the
checker was *right*. Its rewritten lexer (WAT strings, nested block comments)
kept reporting `10d-gdi-region-path.wat`, and the cause was a real stray `)`
that closed `$gdi_path_widen_join` early, so the geometric-join branch had been
unreachable — the in-house compiler had accepted unbalanced text without a
word. `check-parens` is now a build gate (`build.sh:71`) with its own test,
and the join renders again. New follow-up for `tools/build-compile-wat.js`:
reject a module whose paren depth is not zero at EOF — closed same day by
`9faa2299`, which makes `lib/compile-wat.js` throw on the imbalance with
file:line and adds `test/test-compile-wat-structure.js` to the tier. **A.4
FIXED `d9bee7ca`**
— the `$restore_destroyed_dialog_owner` heuristic is deleted; `EnableWindow`
now returns nonzero iff the window was previously disabled (`09a:4923`), which
is what COMCTL32's own PropertySheet loop needed, with `test-enable-window.js`.
**A.1 WORSE** — `f2dc80d2` (toyvm ALU+Jcc fusion, 192 fused handlers, +8.3%
geomean) changed `emit.js` again without a bundle rebuild; `bundle-browser.js`
still omits `emit-decoder.js`, and the committed bundle is still `6b015971`'s.
The rest stands; two moved. The stub ratchet was subsequently re-pinned *in the
same commit* as its removals repeatedly (`4a08c267`, `e3ff3e4c`, `2b27e407`,
`0064c7fc`, `32590db9`, and the `SetConsoleWindowInfo` fix). Section 3.4 is now
closed in code too: 506 broad bodies are hashed, replacement pin lines are
printed, and clean pin-only follow-up commits fail. The
GL encoder's `?v=` now agrees between page and worker (`index.html:1367`,
`guest-worker.js:27`, both `v=5`) — one of the four counters of 3.10. H441's
stores changed shape (`07b:3271-3286` now pick `i32.store16`/`i32.store` when
`$g2w_affine_span` mapped the row, `gs16/gs32` otherwise) but the fast branch
still has no `$invalidate_code_write` — the gate is "is it mapped", not "was it
ever code", so 3.2 stands. `DX_PROCESS_STATE` gained its `_SIZE` (`09a8:284`,
0x1C) — still in the uncommitted tree, and the header comment at
`01-header.wat:1330` says 32 B. At this addendum checkpoint, 3.1, 3.3, 3.5,
3.6, 3.7, 3.9, 3.11, and 3.12 were still open; the current statuses above
supersede this historical snapshot.

**By 16:16 (+5 commits, HEAD `e43a4699`)** three more closed from the board:
the compile-wat strictness follow-up under 3.7 (`9faa2299`), the console-key
half of A.7 (`e43a4699`), and item 11's DirectPlay enumeration (`0064c7fc` —
the stub ratchet again re-pinned in the same commit, the second observation of
3.4's process fix). `f8382045` closes an MW3 terrain-erasure bug next door to
A.2's reopened convergence report: `d3dim_texture_sample_prepared` now
canonicalizes non-finite U/V to zero before the packed-colour lerp receives
NaN fractional weights, with a re-note and test. `2a5d979f` runs both Rodent
editions under browser threads. On the board: GTA2's COM_WRAPPERS_AUX
relocation claim was retracted (crash identical after the move — honest
process), and a new stub lead — `IDirect3DDevice_Pick`/`GetPickRecords` empty
successes leave Viewer object selection inert — already has a 148-line real
implementation sitting uncommitted in the dirty tree (not reviewed here).
A.1's stale toyvm bundle stands untouched.

**By the next morning (+54 commits, HEAD `f3ae5c76`)** the fix sessions began
recording closures in this document themselves; this tick verified each in
code rather than taking the tag. All hold: **3.6** (`8ed5ae8c` — the memory
gate now fails any `0x07xxxxxx` global without a `_SIZE` or an alias entry,
`test-wat-memory-map.js:246-263`, and converting the 55 invisible globals
exposed three real layout errors, among them `COM_WRAPPERS_AUX`'s tail over
`DX_VTBL_REGISTRY`'s first dword — so the retracted GTA2 relocation claim had
found a real overlap, just not GTA2's crash); **3.9 + rec 10** (`fab6546d`
gates all five generic COPY/avg recognizers behind default-off
`loop_generic_copy_emit`, `07b:1592-2260`; `6bbf1543` FNV-hashes the full
0x6b/0x6a-byte AoE prefixes); **3.11** (DS3D size validation `391fe732`;
mutex bit-31 stripped + `last_error` `1e76e8ab`; ToAscii pads the missing hkl
then delegates — net −4+28 is a correct five-arg frame; console aliases
`4a812854`; rejection path anchored at `09a:13331`). One overstatement:
"Worker slices no longer busy-poll `WaitMessage`" — the resume check did move
in-worker (`resume_message_wait`, `guest-worker.js:148`), but the coordinator
still issues one `clear_yield` per slice for a parked yield-7 thread
(`thread-manager.js:1325-1330`). A.1 and most of 3.3 also closed (headings
above). New and unreviewed: the **BYO-media subsystem** landed whole — design
`ba7a2511`, read-only ZIP mount `3da72782`/`6a876ff0`, ISO 9660 CD-ROM
`60407f55`, byte-provider VFS `4d7497ed`, writable C:\ overlay `29dab90a`,
save-bundle export/import/sync `0995b5a7`/`b91e3738`, CLI + tier wiring
`9c1003b9` — a full review of it is owed next pass. Process: two stale-index
races in one evening (`29d1ecd0` silently reverted five console files, restored
byte-identically by `4a812854`; a toyvm commit swept seven peer files and was
amended away) — the shared-dirty-tree cost is now visible in history, and both
were caught and corrected by their authors within minutes. The toyvm
dead-flags work (`98612ab2`, `c5fb121f`) stays toyvm-only; no `src/` risk.

**By midnight (+33 commits, HEAD `a670a669`)** every Tier-1 recommendation is
struck through: the fix sessions recorded 3.3, 3.4, 3.5 and item 14 closed and
crossed out recs 1–5 themselves, and each survives re-verification. 3.3: one
declarative 21-setter table in `lib/worker-imports.js` (MMX included, via
`get_cpu_mmx`) applied identically by both spawn paths, with
`test-worker-wasm-globals.js` diffing the backends — plus the
`forwardGuestLogs` rename with CLI opt-in (`acc7334a`). 3.4: the ratchet
classifier now hashes all 506 quiet bodies (any handler with no call, branch,
trap or store), prints its replacement pin, and a clean-checkout audit rejects
pin-only catch-up commits. 3.5: `SKIP` is a real protocol — exit 77 via a
preloaded `test/skip-exit.js`, its own runner column, and
`check-test-timeouts.js` fails the manifest on child budgets above the 300 s
cap (17 were quietly impossible). 3.2 is genuinely done now too: both of
H441's reshaped fast branches invalidate before their raw stores
(`07b:3322,3336`). And last tick's WaitMessage qualifier was answered in code
within hours — `42f10d02` leaves yield-7 parked and `resumeMessageWait` checks
at the top of each Worker slice. Beyond the scoreboard: `32590db9` makes
`FlushInstructionCache` real cross-Worker (range/full decoded-code
invalidation plus a shared generation, with a two-instance stale-block
regression) — the SMC-across-Workers hazard 3.2 gestured at, now closed at
the API too; `941c3cf5` fixes a real pump gap (the CACA0004 modal-dialog loop
never delivered WM_TIMER — mIRC's installer scan hung on a live 25 ms timer);
Civ2 runs from local media (`1b1b5069`, a large Win16 push); AUTORUN.INF +
worker io_wait (`29c8b016`); and the toyvm trace-JIT grew a tier-3 micro-op
lowering *and* honest accounting — `a670a669` bills compile cost against
speedup and reports that 4 of its 9 core-ten traces never repay one compile.
Still open: 3.10 version counters, 3.12, Pass-2 items 8/9/12/18, A.2
parity/FPS A/B + MCM reopen, A.5, A.8, rec 8 (`bundle-browser.js --check` is
still not in `build.sh` — re-checked), and the BYO-media subsystem review.
Process: a third stale-shared-index incident (19 foreign reversal entries,
caught and restored before staging) — the pattern now has a name on the board
and authors check for it.

**By 04:30 (+58 commits, HEAD `7ffa5af7`)** the window belongs to the WATX
migration and to item 11. Item 11's OPEN list shrank from 12 DX enumerations
to 8 in seven closures the fix sessions recorded in this doc themselves, and
the sample I re-verified holds in code: viewport lights `14b75f42` (eleven
LIGHT sites in `09aa`), EnumAttachedSurfaces `bfa0f9b3`, DirectInput
enumeration/object-info/buffer-size `ba441430`/`c559b8fd`/`9c91f509`
(reentrant `DIENUM_STOP` resume at `09a8:6086`), EnumSurfaces
`f55bd764`+`c6a262e0` (a real CANBECREATED temporary-surface path,
`09a8:2638-2711`) — each re-pinning the ratchet in its own commit (524→506;
now **505** at HEAD after `34b4f08f` gave CreateProcessA a real body and
`49305a19` ratcheted), with tier rows for the new tests
(`run-all.sh:338-340,351-352`). The Pick/GetPickRecords WIP I was watching
landed in `15b60e49` — before my last tick, so that watch item closes as
already-stale. The WATX migration ran as a coordinated multi-milestone push:
`src/main.watx` is now the authoritative source order gated against
`WAT_FILES` (`38ef42b4`), the `(module)` wrapper moved out of the sources
into `concat-wat.js` (`b1c221d8`) behind a strict per-fragment paren gate
(`e5327df2`, wired at `build.sh:17`), the vendored compiler is
provenance-sealed with REQUIRED_FILES hard-coded in code after a
manifest-shrink exploit was found and closed (`f2ef3390`), a four-artifact
differential matrix (`4aeb0970`) plus a decoded-ABI comparator (`35a405fb`,
validation moved into the library on review follow-up, `ab5544f9`) gate
legacy-vs-WATX identity, and all eight census gaps closed (`7ffa5af7`) — with
two verdicts reversed by the agents' own adversarial checks: G5's detached
`else` was *behavior-changing*, not cosmetic (`compile-wat.js` inlines a
standalone else, so a Win16 module id was clobbered unconditionally on the
VBRUN100 path; re-attached in `65961f32`, +1 byte, 28 Win16 tests identical),
and G8's bare `(drop)` at `09a8:4449` is load-bearing (deletion proof:
stack-verify failure in `$dx_blit_entry_rect_to_hdc`; census corrected
`3aa8310f`). Two new findings of my own from the fallout. **A.9:**
`b1c221d8` silently broke every `extraWat` test harness — the
`source.replace(/\n\)\s*$/…)` splice matches nothing once the trailing paren
is gone, so injected exports vanish and tests die with a misleading
"`e.test_x` is not a function". `49305a19` fixed `render-helper.js` (covers
186 tests), but **18 test files still carry a private copy of the dead
splice** (verified by grep at tick time: `test-compile-wat-unknown-name`,
`test-directdraw-surface3-desc`, `test-ole-storage`, `test-vsnprintf`, 14
more) — one line each. **A.10:** `run-all.sh` at HEAD names six tests that
exist only as untracked WIP in the shared worktree (`test-abedemo-gameplay`,
`test-aoe2-gameplay`, `test-browser-critical-section-yield`,
`test-directdraw-enum-lowres`, `test-keyboard-hook`,
`test-mem-utils-hidden-shared-buffer` — all six re-verified untracked), so
`check-test-manifest` is red on every clean checkout until their owners
commit. Process: the stale-index pattern escalated to a fourth incident that
left **HEAD unbuildable in a clean worktree for about two hours** — an
index-collision commit swept half of the DX process-state conversion
(committed `09a8` removed `$dx_coop_hwnd` while committed `09ad:197` still
set it), caught on the board at 01:59 and finished properly by `e87d8325`,
which also fixed the real regression the same WIP shipped: `36c78d79` gated
BeginPaint's fErase on the erase-owed NC bit, but storm creates its menu
dialog hidden and repaints only via `InvalidateRect(NULL, FALSE)`, so the bit
never re-arms and Diablo's flaming menu went black; the board's
clean-worktree bisection first proved the symptom dirty-tree-only, then
caught it going live at the half-landing. Honesty note from toyvm: the "2x on
daretro" in `041ab7cb` was retracted as an artifact of keying trace regions
by bare ip (`3a4332bc`/`0559c6df` key by cs:ip; honest result across 7
demos: +2.2% to −8.1%, a null). Still open: 3.10, 3.12, Pass-2 items
8/9/12/18, A.2 parity/FPS A/B, A.5, A.8, the new A.9/A.10, rec 8
(re-checked: no `bundle` reference in `build.sh`), and the BYO-media review —
that subsystem keeps growing unreviewed (`29dab90a` writable C:\ overlay,
`34b4f08f`/`a5b2928c` installer chain launches from the caller's VFS,
`853cf729` installer UI flows in both browser modes).

**By 08:00 (+13 commits, HEAD `c8d2c8e2`)** the differential matrix earned its
keep: an audit of the six remaining code-body diffs found **six shipped
Wine-source defects of the G5 class** — a bare instruction in the else slot of
an else-less `(if)`, which `lib/compile-wat.js` silently discards and WATX
compiles as the else arm; *both* are wrong, differently, and the disagreement
is what surfaced them. The headline: `$menu_group_set_disabled` **never wrote
MF_GRAYED** — one paren at `09c5:1338` closed the state-remembering `if` early,
so EnableMenuItem walked the group, returned the previous state, and changed
nothing; `483f305a` fixes it and corrects
`test-d3dim-globe-render-menu.js`, whose expectations had encoded the broken
behavior. `95e7263b` restored two more dropped tails (the palette-less 8bpp
texel greyscale fallback in `09ab`, a treeview free in `09c2`). Five of six
are fixed; the sixth (`09a5:225` in `$handle_CreateWindowExA`, matrix body
#2496, 3633 B legacy vs 3642 B WATX) is the **last real code-body diff** and
waits on its file's owner, who also has an uncommitted working-tree edit the
board isolated as regressing the new globe test. Note the residual hazard:
`compile-wat.js` is unchanged this window and still discards bare tails
silently — WATX now warns on the positional else (`155ff750`) and the matrix
diffs the bodies, but the matrix lives in the UNIT tier
(`test-watx-matrix.js`), not `build.sh`. Milestone 3 went ACCEPTANCE GREEN
after two more compiler-fidelity fixes (`3fdae908`: exports emitted in
declaration order, and negative hex i64 literals were being **zeroed**), and
round-4 review hardening landed (strict whole-token numeric literals; a test
failing on *both* matrix columns is now MATRIX RED instead of silent green,
`f2f99acd`). Milestone 4 was answered with numbers, honestly
(`8e5ac289`+`55ed2211`): a disposable Worker compiles the full 11.29 MB /
60-include closure in node and Chrome with byte-identical outputs, ~1.5 s
cold, **249 MB (tail) / 265 MB (compat) peak RSS — ~2.5× the plan's sub-100 MB
mobile target, which the doc keeps OPEN** while noting the number matches
what scaling the Android corpus predicts and that compiler memory is released
before Wine's 512 MB allocation; the Safari/iOS half of the gate is
explicitly not done. toyvm: regions now compile their branches
(`776c20dd`), refuse guest code rewritten under them (`9b67633d`), and were
priced against four other wasm engines (`c9a73d30`); one live OPEN —
ACCIDENT.EXE's region diverges at 12 M dispatches. My items re-checked, all
unchanged: **A.9 still 18 dead-splice tests, A.10 still six untracked
manifest rows, rec 8 still absent from `build.sh`**.

**By 13:00 (+2 commits, HEAD `fd1b0244`)** a quiet consolidation window with
one HIGH-grade hole closed: `--allow-baseline-fail` could excuse an
*asymmetric* legacy-FAIL/watx-PASS matrix row, because the excusal read the
legacy column alone — the same silent-green shape `f2f99acd` had closed,
re-entered through the escape hatch. `07ce65f2` requires the second column to
have failed too, reports an asymmetric row as its own DIVERGENCE kind, and
keeps it red in both directions even when allow-listed (verified at
`watx-matrix.js:436-437,457,517`; the fixture had to be purpose-built,
because every real test fails on both artifacts or neither). Same commit,
LOW: bare `+42`-style atoms now parse like their parenthesized forms. The
closure bytes are unchanged and the WATX build now emits **exactly one
positional-else warning — `09a5-handlers-window.wat:216`, the still-open
sixth bare-tail defect**: the compiler itself now names the last known
dropped-code site every time it runs, and the shipped build meanwhile never
applies a class-registered window's style there. That file's owner has not
surfaced; the wine-assembly-fd session pinged this one directly asking to
commit the gating dirty state (`09a5`, `host.js`, `index.html`,
`lib/apps.js`, the six A.10 untracked tests) — none of it is mine, which I
answered on the board; M4's mechanical `host.js` wiring and the M5
clean-checkout gate stay blocked on those owners. toyvm: `fd1b0244` grew
eight bisector flags for the ACCIDENT divergence and eliminated whole
suspect classes (not ops, passes, successors, SMC, or the loop protocol —
narrowed to region *edges*; still open), and fixed a real `splitBranch`
top-level-`(if` cut on the way. A.9 (18), A.10 (six), rec 8: unchanged
again.

**By 15:00 (+35 commits, HEAD `71bee6c7`) the one-way door was taken.**
`23ed9639` flipped `DEFAULT_COMPILER = 'watx'` at byte identity with the
rollback exercised; then the M6 region work deliberately killed that
rollback — wave-1 `region.addr` spellings compile to `unreachable` under
legacy, so `24b79256` made `WINE_WAT_COMPILER=legacy` a hard error and the
plan now says rolling back means reverting commits, not setting an env var.
**Deploy is NOT done — live site sign-off is explicitly pending the user.**
Before the door: the sixth bare-tail defect closed (`957208b1`, verified —
one paren at `09a5:224` moved so the five window-seed statements at
`:225-229` run inside the guard; WATX warning census 2→0). A correction to
my 13:00 paragraph, which repeated the fd session's phrasing: the shipped
build did **not** permanently lose the window style — all five seeds repeat
unconditionally at `:277`/`:407` after the host call, so the defect was what
the host read *during* `host_create_window`, an ordering bug, not a lost
store. M3 finished honestly: 8 apps × screenshot pairs at 0/307200 px,
Safari 26.4 compiles the closure in a Worker byte-identical to node, and a
**CORRECTION worth quoting** — the earlier "40 of 45 both-fail tests pass at
clean HEAD" reading was 40 *SKIPs* from missing fixtures (a worktree with
only tracked binaries; a missing fixture exits 0), exactly the 3.5 SKIP
failure mode this review documented; re-swept with 10,295 symlinks
provisioned: 45/45 fail on *both* artifacts identically, zero behavioral
difference, and "full behavior matrix green" stays unticked because those
45 are ordinary app-area reds. Gate integrity also hardened: a pinned
`--wasm`/`$WINE_ASSEMBLY_WASM` that cannot be honored is now **fatal** in
`run.js` instead of silently compiling from src (`1c3e5104`) — the pin was a
promise honored in name only. Then M6 proper: `src/00-regions.wat` declares
all 160 fixed regions, `check-region-decls --strict` and a per-file
`region-census --gate` **ratchet** are wired into `build.sh:27,31`, the
allocator got laws and a shake mode (`6e894591`, though the real map cannot
shake yet — 512 MB is full), the JS mirror is generated
(`lib/region-map.generated.js`, `b0c869b1`), and a five-agent symbolization
fan-out converted ~100 raw literals to `region.addr` across font/truetype/
GL/core/JS files with byte-identity proofs per commit. Two caveats the
fan-out itself surfaced: the census is 50–90 % false positives in some
clusters (flag constants at 0x1000/0x2000/0x4000 — it is a candidate
finder, as this repo's tools usually are), and a **fifth shared-worktree
contamination incident, the worst kind yet: the wave's byte-identity
oracle itself was polluted** — the "canonical" wasm pair had a peer's
uncommitted keyboard-hook host import baked in, so HEAD blobs alone
compiled to *different* bytes all the way back to the cutover; `7afc6890`
root-caused it and the oracle is now drift-immune (paired HEAD vs
HEAD+file). Open wiring items on named owners: `index.html` needs the
region-map script tag before `mem-utils.js` (browser-blocking, file
peer-dirty), `$CLASS_NAME_STRINGS` is declared 0x80 bytes but its block
runs past 0x3240, and the sub-field alias retirement is blocked by
`wat-memory-map.js`'s regex reader. toyvm: CMA_SHRT divergence **fixed**
(`4e0bedd3`, regions leave after an unlowered transfer), the ACCIDENT 0.94x
was retracted as a warm-up artifact (really 2.2–2.4×, `7f3f01a4`), regions
mark CODE_BITMAP (`2ec3f34b`), and the ladder now says lowering is the
common factor (`71bee6c7`). `600be0ed` adds TerminateThread for installers.
A.9 (18), A.10 (six untracked, unchanged despite the fd ping — owners
still silent), rec 8: all unchanged.

**By 15:30, on user direction ("if owners are silent they abandoned"), the
whole open-items list above is CLOSED — most of it by the owners in a burst,
the remainder by this session.** A.10: all six tests are tracked
(`f2c4bb43` reviewed and kept the three stranded ones). A.9: m6-test-infra's
`6cafd7d3`/`aa36a10a` moved every full-tree `compileWat` in `test/` to
`compileSrcWasm` with the fragment *appended*, taking the census from 18 to
one real site plus one comment; the last one — `test-compile-wat-unknown-name`,
whose injected ghost had been silently dropped so all three assertions passed
**vacuously** — is fixed by this session (`96bb3bc3`, append; the ghost
genuinely fails the build again, 3/3). The browser-blocking `index.html`
region-map tag landed (`9ae617cb` — every browser launch had been dead since
wave-1) and the M4 Worker wiring is in `host.js:1219`. And rec 8 is CLOSED by
this session (`b967a547`): `bundle-browser.js --check` rebuilds the bundle in
memory and fails on any difference, wired into `build.sh` beside the other
gates — and its **first run caught two live breaks**: `vm.js` had grown a
`require('crypto')` the browser shim could not resolve (the emit-decoder
failure mode of A.1, one dependency later — the committed bundle loaded only
because it predated the dependency), and the committed bundle was 21 KB
stale. The shim now serves a deterministic FNV `createHash` (the hash only
keys `compileWat` memoization), the bundle is regenerated, and
`test-toyvm-browser-bundle` runs the program to "HI". Every finding this
review has carried as "open, owner silent" is now closed; what remains open
is the analytical tail (3.10, 3.12, Pass-2 items 8/9/12/18, A.2, A.5, A.8)
and the BYO-media review.

**New in this window, ranked.**

**A.1 FIXED `d5cf1afb`: `bundle-browser.js` now discovers modules by walking
relative `require` literals instead of a hand-kept list, and the bundle was
regenerated — and stayed regenerated through four later toyvm commits
(`c5fb121f`, `79188a8c`, `4ab65722`, `2e16725e`). Rec 8 stands: still no
`--check` in `build.sh`, and the test still reads only the committed artifact.
Original finding:**
`docs/dos-corpus/live/toyvm-bundle.js` was last generated in `6b015971`, before
the wasm decoder existed (678,721 B committed vs 699,901 B from HEAD, first
difference at byte 103,097). Worse: `tools/toyvm/bundle-browser.js:37-49`
`MODULES` does not list `emit-decoder.js`, which `emit.js:3620` now `require`s,
so a fresh bundle throws `cannot resolve ./emit-decoder` at `makeVm`. The
committed one loads only because it predates the dependency, and
`test-toyvm-browser-bundle.js:3` reads the committed artifact, so the gate is
green on bytes the source can no longer produce. Pass-3 rec 8 (`--check` in
`build.sh`) would have caught this the same hour.

**A.2 The D3D render Worker (`b5baede5`, `?d3d-worker`) — a good prototype
with one unmapped write. Slot-63 half FIXED `92b6a9b4`: `init_thread(63,…)` is
replaced by a renderer-only `d3dim_worker_init(imageBase)` that claims no
thread's page/cache partitions; image parity and the FPS A/B are still owed
(re-notes :608), and the board reopened MCM terrain convergence after
`8dddcda7`.** Design is right: `lib/d3d-command-stream.js` copies
a 4 KiB device-state snapshot plus 32 B × N canonical vertices per
`DrawPrimitive` into a 3-slot × 2 MiB private `SharedArrayBuffer` ring (not
guest memory, so no map entry needed); `lib/d3d-render-worker.js` instantiates
the **same wasm module** over the shared memory with inert imports and replays
through a new `d3dim_worker_draw` export (`09ab:88-95`) that sets a
per-instance `$d3dim_state_override` — no second rasterizer. Opt-in from the URL
only (`index.html:2012` → `host.js:1256` → `guest-worker.js:252`), and every
failure path returns 0 so WAT runs `$d3dim_draw_primitive` synchronously
(`09a8:7264-7270`); the consumer never calls the main thread, so there is no
cycle. The problem: `d3d-render-worker.js:41` calls `init_thread(63, …)`.
Worker slots are 1..7 (`thread-manager.js:30`) and `PAGE_DIR_BASE` is sized for
8 (`01-header.wat:1451-1452`, 0x04900000 + 0x20000); slot 63 puts its page
directory at 0x049FC000 and `$page_dir_reset` (`04-cache.wat:420-445`) zeroes
16 KB there on every image-base change — an address in no map and in no gate,
unmapped today by luck. Same slot arithmetic gives `THREAD_BASE=0x14C00000` and
`PAGE_INDEX=0x08000000`. Also: the render instance `guest_alloc`s 4 MiB + 4 KiB
from the shared guest heap per image-base change and never frees it; fence
coverage is by enumeration (~25 `$d3dim_worker_fence` sites) with texture
`Unlock` not among them; per-draw it allocates 1 + 1 `DataView` and 3
`Uint8Array` views plus the 4 KiB state copy (~3 MB/frame at MW3's ~750
draws); and when the mode is *off* every fence site still makes one host call
(`09ab:63-64`). The only test (`test-worker-api-batching.js:102-152`) uses a
synchronous fake consumer — no image parity against the synchronous path, no
second-instance run; the re-notes admit both are still owed. *Fix:* a named
slot with its own sized regions in the map, or an assertion that
`init_thread`'s slot is below `PAGE_DIR_BASE_SIZE/0x4000`; a parity test before
any FPS claim.

**A.3 `FindFirstChangeNotificationA/W` is a silent stub with a body — FIXED
`b260ed8c`: `lib/filesystem.js` signals the watch from every mutation
(`_notifyChange` at write/resize/attrs/delete/mkdir), registered from WAT via
`$host_fs_register_change_notification` (`09a:1669`)**
(`09a:1647-1685`, `4a08c267`). It creates a manual-reset event that nothing
ever signals ("VFS mutations do not signal the object yet"), so a guest that
`WaitForSingleObject`s on the handle waits forever — WinRAR's directory watch
happens to poll. It passes the stub ratchet because the body calls host
imports, which is Pass-3 3.4's regex gap in one line. `FindCloseChangeNotification`
closes through `$host_fs_close_handle` and works only because
`lib/filesystem.js:1082-1087` routes sync handles first — an implicit coupling
with no comment on the WAT side.

**A.4 "Restore owners after modal dialogs close" is a heuristic, not owner
tracking — FIXED `d9bee7ca` (heuristic deleted; EnableWindow returns prior state)** (`$restore_destroyed_dialog_owner`, `09a:3241-3275`, `9fa3a664`). On
`DestroyWindow` of any owned `WNDPROC_DIALOG` it clears `WS_DISABLED` on the
owner unless another *visible*, parentless owned dialog remains. Nothing
records *who* disabled the owner: an app that called `EnableWindow(owner,
FALSE)` itself (`:4965-4983` is the only setter) and then destroys a modeless
owned dialog gets its owner re-enabled behind its back, with a synthetic
`WM_ENABLE` (`:3266`) and a paint. A hidden-but-live modal does not block the
restore (`wnd_is_effectively_visible`, `10-helpers.wat:2017`). `EndDialog`
already has its own restore (`:4980`) — two conventions for one state.

**A.5 The toyvm now has the repo's third x86 decoder** (`45f35101`,
`tools/toyvm/emit-decoder.js`, 706 lines of WAT text spliced in at
`emit.js:3620`; `07-decoder.wat` 5,326 and `toyvm/decode.js` 1,098 remain).
The design is defensible — `compile.js:104-168` tries `compile_block` and falls
back to the JS `decodeOne` per instruction, handler ids come from one `H` map
with -1 refusal — and it is on by default (`run-dos.js:686`, `dos-loop.js:80`).
But equivalence is manual: `tools/toyvm/decode-diff.js` (a real differ, exit 1
on mismatch) is in neither `run-all.sh` nor `build.sh`, the 146-program
frame-hash sweep in `docs/toyvm-decoder-in-wasm.md:185-192` has no script, and
`gate.js`/`bench.js:114` call `compileProgram` without the wasm decoder, so the
8088 vector gate never exercises it. Hand-duplicated tables (`ALU_ROWS/SHAPES/
CC_NAMES` `emit-decoder.js:38-52`; the 8-prefix limit `decode.js:208`; `STOP`
codes as bare literals `compile.js:162`, `decode-diff.js:40`) are where a typo
silently lowers coverage rather than failing. `1b2ba62e` "Stay in wasm across a
far transfer" is toyvm-only (`emit.js:3606` `$jlook`) — no `src/` risk — and
fixed a jump-table probe with the wrong stride that had reported MISS for
everything (`run-dos.js:1018-1038`).

**A.6 GL views — item 14, half done** (`f4e5b79b`). `u32At` now takes a cached
view (`gl-command-stream.js:55,243-250`) at all eight immediate-path sites, and
`gl-compat.js:482-497` caches `_dv/_stackDv`, with an identity test. Still per
call: `_setColor` arrays (`:261-272`), `_pointerFloats` (`:256`), the per-vertex
`push` then `Float32Array` copy (`:158-160,286`), `new Uint8Array` per
`glColor3ub/4ub` (`:270,378`), and six `.slice(-1)` per draw/getFloatv in
`gl-compat.js:305-316,731-733`.

**A.7 Pointer capture — regressed and fixed inside 25 minutes.** `c2177936`
requested `{unadjustedMovement:true}` with an async retry, which lost the
transient user activation; `440bd27c` restored one optionless synchronous
`requestPointerLock()` inside `onmousedown` (`lib/browser-input.js:112-127,
324-338`) and the test pins `lockRequests === [undefined]`. Correct now. The
every-mousemove `WM_NCHITTEST`+`WM_SETCURSOR` posts (`renderer-input.js:
2511-2514`) and the synchronous `WM_NCHITTEST` before every button-down
(`:1911-1916`) from Pass-3 3.8 are unchanged. Console keys (`57b05dea`) reuse
the one input queue — console APIs poll `$host_check_input` themselves
(`09a2:704-745`) and park GUI events in `$pending_input_packed` for
GetMessage (`09a5:1550`) — but only WM_CHAR and VK 0x21-0x2F/0x70-0x87
key-downs become records (`09a2:737-744`): no key-ups, no modifier state, so
`bKeyDown=0` and `dwControlKeyState` readers see nothing; and in Worker mode a
`PeekConsoleInput` spin is one owner-thread RPC per call. **Console half FIXED
`e43a4699`:** records keep the original key lParam at +16, so `bKeyDown`
down/up edges, repeat counts, scan codes, the enhanced bit and a
`dwControlKeyState` snapshot all survive (`09a2:637-693`);
`test-console-input.js` pins an F9 up/down pair, Shift+A scan codes, autorepeat
and `RIGHT_CTRL_PRESSED|ENHANCED_KEY`. The Worker-mode RPC spin stands.

**A.8 Small.** `$menu_header_width` (`09c5-menu.wat:721`) selects the menu font
into `hwnd+0x40000` as a side effect of a width *query* called per repaint and
hit-test from `renderer.js`/`renderer-input.js`. `$tab_native_page_top`
(`09c3:792`) returns a magic 21. The MCM `EnumTextureFormats` change (dirty
tree) hand-matches an index range (`idx<3`) to a table that grew 2→4, and a
mode-table count went 18→19 at one literal (`09a8:1916`). `dx_trace` moved to
`ASYNC_SAFE` with an ordering test — healthy. `09a` 16,132 / `09c3` 16,849.

**Addendum recommendations** (in front of the Pass-3 tiers, not instead of
them): fix `bundle-browser.js` MODULES, regenerate the bundle, and add `--check`
to `build.sh` (A.1); give the render Worker a real slot or assert the bound
(A.2); signal or crash in `FindFirstChangeNotification` (A.3); record the
disabler in `EnableWindow` and restore only what a dialog disabled (A.4); put
`decode-diff.js` over the corpus into a tier (A.5); the 3.1/3.2/3.3 bugs are
still the first three things to do.

---

# Pass 2 — 2026-08-27

*Reviewed at HEAD `60097710` ("Name the code that keeps rewriting itself"), 815
commits after the first pass. Working tree was dirty (62 modified files, +1,847
lines, plus 14 untracked); **all line numbers are working-tree numbers as of
2026-08-27**, not HEAD. Four parallel deep reviews again — status
re-verification of every open item, CPU core + super-ops + the new toyvm
subsystem, the Win32/GDI/controls WAT layer, and the JS host + Worker-thread
backend + tools/tests — with a fifth sub-review on the Worker backend alone.
Every claim below was read in the code; items marked PLAUSIBLE were not
measured.*

*Verified 2026-08-28 by two adversarial passes that tried to refute every
concrete claim. Two were wrong and are struck below (the `10c-truetype.wat:4155`
AND was benign; EnumDisplaySettingsW refuses a short struct rather than
overwriting it), a handful of counts had drifted, and — because other sessions
began acting on this document within hours — many findings were already fixed
by the time they were re-checked. Those carry a **FIXED** tag with the commit;
the full list is in "Pass-2 status" at the end of this section.*

## Verdict

The first pass's Tier 1–2 work held: all nine build gates still pass, the A/W
delegation pattern is now the norm (194 of 210 pairs share a core or delegate),
table access goes through one function per table, and none of the deleted dead
code came back. That work was done in the first two days after the review.

The following 813 commits went somewhere else entirely — real Worker threads, a
page-based decoded-code store, twelve loop super-ops, a 15.6k-line DOS VM with
its own 199-program corpus, GOG launchers, per-game fixes — and **every item on
the 08-18 "Still open" list received zero commits**. That is fine as a choice;
it is recorded here so the list stops looking like it is in progress.

What the new work brought with it is the same three drift categories as before,
in new places:

1. **Hand-kept invariants without a gate, now crossing the WAT/JS boundary.**
   Two memory-map collisions were live in the tree (§P2-3.2 — five, once the
   map was actually intersected), a JS copy of a WAT constant was 1 MB stale
   (§P2-3.1), and the test-manifest gate that was added on 08-18 is wired into
   the one script nobody runs (§P2-3.6). The first two were fixed on 08-28
   (`2959ea35`); the third is still open.
2. **The "app-specific literal in generic code" pattern came back.** The
   first pass removed two Diablo EIPs from the decoder; Jazz2's `0x57BAE0` and
   MechWarrior 3's `0x528064`/`0x528111` are now in it (§P2-4.2).
3. **Two schedulers, two hosts, two of everything.** The cooperative and Worker
   backends fork the spawn path, the slice path, the wait policy and the set of
   globals a thread inherits; the CLI and browser fork the yield state machine
   and `check_input`; `renderer.windows` still shadows WND_RECORDS (§P2-5, P2-6).

Plus one category the first pass under-counted: **silent success stubs.** 98
`$crash_unimplemented` sites against ~45 confirmed return-TRUE-do-nothing
handlers, and `git log -S` on ten of them shows every one was *born* that way
in the commit that added the API — the fail-fast rule is in CLAUDE.md, not in
the build (§P2-7).

## P2-0 — Numbers

*Working-tree snapshot on 08-27; by 08-28 morning these had already moved
(643 tests / 55 unlisted, `run.js` 8,612, `src` 188,289 lines, api_table
3,035, handler table 439). Read them as scale, not as invariants.*

| | 2026-08-18 | 2026-08-27 |
|---|---|---|
| `src/*.wat` | 45 parts | 60 parts, 187,463 lines |
| `api_table.json` | 2,462 | 3,034 |
| Handler table | — | 437 (zero headroom; gated) |
| `lib/*.js` | — | 51 files, 35,799 lines |
| `index.html` | 2,671 → 1,136 after the pass | **2,322** (1,094 lines inline JS) |
| `test/run.js` | — | 8,591 lines; `main()` is 7,850 of them; 158 flags; 109 input-DSL actions |
| `test/test-*.js` | 352 (145 unlisted) | 631 (**48 unlisted**, ~37 committed) |
| `tools/` | — | 153 entries, 217 files, 54,855 lines; 56 documented in CLAUDE.md |
| `tools/toyvm/` | did not exist | 32 files, 15,591 lines, 116 handlers |
| Build gates | 5 | 10 (`gen-host-import-sigs --check`, `esp-epilogue --check`, `wasm-data --overlaps` new) |
| A/W pairs | 184: DIVERGENT 4 | 210: **DIVERGENT 14** |

## P2-1 — What the 815 commits were (so the rest reads in context)

By files touched: test/ 463, src/ 376, lib/ 261, tools/ 242, docs/ 149,
index.html+host.js 149, tools/toyvm 84, thread-manager/worker-imports 55.
Themes: real Worker threads (~60 commits, the `worktree-real-threads` merges);
per-app corpus work (~76 — Diablo 31, Heroes III 11, Winamp 8, Jazz 7, Caesar
5); the toy DOS VM (84 commits from `09fa5a40` 08-24 on); GOG/DOSBox/ScummVM
launchers (~15 — GOG's own Win32 `DOSBox.exe`/`scummvm.exe` run *as guests*,
payloads gitignored at 2.2 GB); super-ops and the page-compile arc (~60 —
`c30b6bf4` → `9c257a88` "delete the hash block cache" → `6e80eb2f` chunk
classes); DirectX/OpenGL (~43); controls/GDI/fonts (~114); iPhone/Safari (~18);
recorder (~24); Win16 (~28); docs (149 commits). A WATX dual-compiler migration
is proposed in `docs/watx-migration-plan.md` (audited 08-25, not started).

## P2-2 — The 08-18 open list, re-verified

| § | Item | State | Evidence |
|---|---|---|---|
| 3.7 | EditState accessors | **OPEN** | `09c3-controls.wat:12743` comment; `$edit_wndproc` (`:13744`, 1,535 lines) has 110 bare `offset=N ($sw)` reads, all `$edit_*` 157. Bare-offset census is 460 (was 740); what remains is **EditState 157, ToolbarState 89, TooltipState 43** — the last two were never on the list and never named either. |
| 3.8 | Window rect dual-owned | OPEN | `10-helpers.wat:2852-2925` (child → CONTROL_GEOM, else `$host_get_window_rect`) mirrors `lib/host-window.js:530-595`; `sync_window_client` seam `:668-679`. |
| 3.8 | Scroll state twice | OPEN | `$help_scroll_y` `01-header.wat:3023` mirrored at `09c-help.wat:441,447`; `$edit_publish_scroll_info` `09c3:12855`. |
| 3.8 | WS_VISIBLE by comment | OPEN | `09a5:1102-1109`, `09a:12175`. |
| 4.3 | Win32 semantics in JS | OPEN | `host-window.js:336-389` GW_* walk, `:416` cascade/tile, `:596-650` `move_window` (CW_USEDEFAULT, SWP flags, a dialog-template height heuristic at `:617-622`), `:651-680` `set_window_zorder`; modality decided in `renderer-input.js:209-225` and used at `:1271,1891`. WAT now exports 30 `wnd_*` accessors that JS reads in 33 places while `renderer.windows` still carries x/y/w/h (9-10 writers each), `visible` (8), `zOrder` (5), `_minimized` (6). |
| 4.1 | Hash block cache / arena wipe | **WRONG PREMISE** | The 4,096-slot hash cache was deleted (`9c257a88`, 08-24; "not faster" on interleaved A/B). Decoded code lives in per-page chunks (`PAGE_INDEX_ARENA`, `01-header.wat:1426-1453`) through a 1,024-slot direct-mapped `PAGE_DIR` per thread (`04-cache.wat:411-416`). Invalidation is per-offset. **The arena-full policy is still a full wipe**: `13-exports.wat:64-68` and `$thread_arena_flush_if_safe` (`04-cache.wat:823-832`) reset everything, free lists included — see P2-4.4. `04-cache.wat:403-409` still documents the hash cache as the fallback. |
| 4.1 | Memory-form ALU specialization | OPEN | `$th_alu_m32_r_ro` (`06b-core-handlers.wat:1592-1600`, handler 127) and siblings `:1602/1616/1626/1636` still unpack op+reg at runtime. What landed instead was pair fusion. |
| 2.3 | tools hand-parsing PE | PARTIAL | 24 tools use `lib/pe.js`. Still hand-walking: `tools/disasm.js:470`, `hexdump.js:24-33`, `pe-exports.js:33-46` (written *after* pe.js), `wep32-compare.js:234-237` (pe.js exposes no data-directory accessor). NE headers walked 3× (`ne-dump.js:35`, `ne-exports.js:98`, `render-fon-benchmark.js:18`) + `lib/dll-loader.js` — no `lib/ne.js`. |
| 5 | Raw api ids in dispatch | OPEN | `09b-dispatch.wat:896/907/921` (490/491/470); `978` at `09a8:834`. `$restore_caller_regs` now exists (`03-registers.wat:564`) but the epilogue is still copied four times in the fast paths. 491 is redundant now that PeekMessageW delegates. |
| 1.5 | `$host_gdi_*` non-imports | OPEN, miscounted | The "249" was every function in 01-header. It is 76 `$host_gdi_*` there + 11 in `10f-gdi-dc.wat`, 528 call sites, 7 real imports left. **23 of the 76 have zero callers** (`01-header.wat:174-520`). |
| 2.1 | Others | OPEN | `hdc = hwnd + 0x40000` literal: 30 sites in 09c3 (was 24). `$ctrl_get_wh_packed` inline unpack: 56 sites vs 7 accessor calls. 43 `$host_gdi_draw_edge` callers vs 4 through `$gdi_draw_edge_desc`. 47 `$emit_*` in the decoder. |
| 2.1 | mixer A/W | DONE | W bodies at `09a7c-mixer.wat:153,181,238` are 4-6-line delegates. |

## P2-3 — Hand-kept invariants without a gate (the next mystery bug, ranked)

**3.1 A JS constant disagreed with its WAT twin — FIXED `2959ea35`, gate still
partial.** On 08-27 `lib/mem-utils.js:12` said "must match … 01-header.wat"
and defined `DIB_GUEST_CAPACITY = 0x04000000` while `src/01-header.wat` had
`0x03F00000` (shrunk so the DIB pool stops overlapping `THREAD_RPC`), so JS
`g2w` still mapped guest `0x53F00000+` onto the per-thread RPC blocks.
`2959ea35` set the JS side to `0x03F00000` and `host-imports.js:91` now imports
it from mem-utils rather than keeping its own. `test/test-wat-memory-map.js`
now runs in `build.sh` and checks the DIB/RPC pair; `test-wat-rpc-region.js` is
in `run-all.sh:182`. What is still not gated is the rest of the class, holding
by luck: `DX_MAX` 1024/stride 32 (`09a8:16-27` vs `host-imports.js:375`,
`run.js:8223,8499`),
`WIN16_DYNAMIC_BASE` 13 (`08c:139` vs `dll-loader.js:666`; the comment at
`08c:130` says 12), OpenProcess tag `0x000E2000` (`09a:2591` vs
`thread-manager.js:658`), `gl-command-stream.js:34-39 ARG_WORDS` vs
`gen_dispatch.js:36-56 gpuApis` (index 54 is 2 vs nargs 3, masked by
`09a8b:20-37`), `RPC_BASE 0x1FF00000` and `0x07F14000` (`guest-rpc.js:50,55`),
`GUEST_BASE 0x12000` inlined at `guest-worker.js:434,495` and
`thread-manager.js:225,1399,1447,1773,1938`.
*Fix:* extend the new gate to those pairs — parse the named globals out of
`01-header`/`09a8`/`08c` and assert against the JS files.

**3.2 Two live memory-map collisions — FIXED `2959ea35`, which found five.**
On 08-27 `tools/wat-memory-map.js` existed, was not in `build.sh`, and printed
no overlap markers; intersecting its sized ranges found:
- `SCROLL_AUX_TABLE` 0x07FEB000+4KB (`01-header.wat:2071`, added `d22010df`
  07-14) sits on `D3DIM_UNIMPL_EXEC_OP`/`_DRAW` strings at 0x07FEB000,
  `D3DIM_EB_CACHE_PTRS` 0x07FEB040 (512×4), `D3DIM_STATEBLOCKS` 0x07FEB840,
  `D3DIM_MATRIX_USED` 0x07FEBF00 (`09ab-handlers-d3dim-core.wat:59-68`, from
  `f9152a37` 06-12). Both sides are written. Any window's SCROLLINFO
  nPage/nTrackPos corrupts D3DIM state; slot 0's h_page overwrites the crash
  message string.
- `EXTRA_CMDLINE_BUFFER` 0x07F0A500+256 (`01-header.wat:1312`) overlaps
  `COURIER.FON`'s path data at 0x07F0A4FC+29 and the `TERMINAL.FON` state at
  0x07F0A5B0-0x07F0A5D4 (`10b-gdi-font.wat:22-25,49-50`, `23380fbc` 08-13).
  Any `--args` clobbers Courier's path from byte 4; one over 176 bytes clobbers
  Terminal's.
Both are the mechanism the first pass found three instances of: an address
picked from 01-header's map while the colliding table is declared in the file
that uses it. `1151b196` (08-27, AoE2's heap growing into the page indexes at
0x04100000) is a third instance found at runtime.
Done on 08-28: `2959ea35` moved `SCROLL_AUX_TABLE` to 0x07F21000 and
`EXTRA_CMDLINE_BUFFER` to 0x07F20200, and in sizing every region for the gate
found three more live overlaps this pass had not — the TreeView family
(`TV_TABLE`/`TV_IMAGE_TABLE`/`TV_OWNER_TABLE`, now at 0x07F22000-0x07F27000)
and the shared timer block (`TIMER_SHARED`, 0x07F20100). `test/test-wat-memory-map.js`
now runs as the second gate in `build.sh:15` and fails on any sized-range
intersection (132 regions, 215 data segments at the time).

**3.3 `DLL_TABLE` has 16 slots and no bound — FIXED `2959ea35`.**
`08b-dll-loader.wat:4` (32-byte stride, 16 max); `$dll_idx = dll_count` at
`:84`, `dll_count++` at `:103`, no check anywhere, JS included;
`lib/dll-registry.js` lists 38 loadable DLLs. The 17th DLL wrote over
`DLL_RSRC_TABLE` (0x07992200). Now `$DLL_TABLE_CAPACITY` (`01-header.wat:2539`)
and `lib/dll-loader.js:27-31` throws before the write. Not verified: whether the
WAT-side `$load_dll` (called from `09c9-winhelp-ui.wat:2032`, bypassing JS) got
the same check.

**3.4 Decoder handler indices are 368 bare literals.** `(call $te (i32.const N))`
appears 368 times in `07-decoder.wat` (405 with `07b`'s 37, 321 distinct); the `;; N`
comment on each `02-thread-table.wat` elem entry is the only cross-reference,
and `07b` has three symbolic globals (`LOOP_SUPEROP_LUT/COPY/AVG`) while `07`
has none. `check-handler-count.js` checks the *count*, so an insert before 395
renumbers 40 handlers silently. Already-drifted comments: `13-exports.wat:3022,3030`
and `07-decoder.wat:152,416,1991` call rect_run/rle_run "handler 422/424"; they
are 427/429 (422/424 are now `$th_mmx_rr/_mr`).
*Fix:* generate `src/02b-handler-ids.generated.wat` with
`(global $H_lut_run i32 (i32.const 418))` from the elem list, gated like
`gen_dispatch --check`; the comments then go away.

**3.5 Continuation-thunk markers and api ids by hand.** 31 `0xCACA00xx`
literals matched in `09b-dispatch.wat:62-821` against ~200 producer sites in 12
files with no central enum; `0xCACA0010` (`09a8:846`) is not in the chain and
dispatches only because the resolved-ordinal test at `:859` happens to catch
bit 31. The unresolved-ordinal formatter (`:831-849`) writes digits at absolute
`0x2DA..0x2DE` into the `0x2D0` data string — a hand offset outside
`check-data-strings` — and labels every DLL's ordinal `KERNEL32.#`.
*Fix:* `gen_dispatch.js` emits `$API_ID_*` and `$CACA_*` globals.

**3.6 The test-manifest gate is in the wrong script.** `tools/check-test-manifest.sh`
(added `e2bc3a31` 08-18) works and **fails today** — 48 of 631 files were in no
tier on 08-27, 55-57 of 643 on 08-28 — but it is called only from
`test/run-all.sh:659`, and the documented practice is to skip run-all.sh.
`build.sh` never runs it. The toyvm tests (`test-toyvm-live.js`,
`test-toyvm-browser-bundle.js`, `test-dos-corpus-live-page.js`) and every GOG
launcher test are among the unlisted. Also (order of magnitude, from timeout
literals): ~80-100 tests hard-code budgets over 120 s and 10-17 exceed the
runner's own 300 s kill (`:689`).
*Fix:* call it from `build.sh` (it is a 2 ms `comm`); list the strays.

**3.7 A committed generated bundle with no freshness check.**
`docs/dos-corpus/live/toyvm-bundle.js` (526 KB) is `bundle-browser.js`'s
output, in git; `test-toyvm-browser-bundle.js` checks it *loads*, not that it
matches `tools/toyvm/*.js`. `docs/dos-corpus/programs.js` (584 KB) embeds 12
demo binaries. *Fix:* `bundle-browser.js --check` in build.sh.

**3.8 Super-op flags reach one instance.** `run.js:7349-7369` propagates 9
decoder flags to cooperative threads; the Worker spawn path (`thread-manager.js:904-925`
→ `guest-worker.js:411-460`) propagates 10 globals and **none** of the decoder
flags, `cpu_mmx`, `fault_unmapped`, `trace_eip_range`, or `count`. In the
browser `set_rle_run` (`host.js:945`) and `set_loop_copy_emit`
(`browser-shell.js:565`) reach slot 0 only. 53 `set_*` exports exist; the
cooperative spawn propagates 15 (`thread-manager.js:1361-1535`). And
`$tls_next_index` (`01-header.wat:2552`, bumped by `09a-handlers.wat:7894`) was
copied at spawn only (`guest-worker.js:449`), so a `TlsAlloc` on any thread
after spawn handed out an index another instance already gave away — both
backends. **The TLS half is FIXED** (`2959ea35`: `$tls_reserve` does an atomic
on `$TLS_NEXT_INDEX_SHARED` at 0x07F20300, and TlsGetValue/SetValue/Free now
reject an index ≥ 64); the flag-propagation half is open.
*Fix:* one inherited-globals table in `lib/worker-imports.js` read by both
spawn paths, plus a test that diffs the two setter sets.

**3.9 Stale invariant comments** (each names a rule that no longer exists):
`04-cache.wat:403-409` (hash cache), `tools/toyvm/isa.js` header ("handler
bodies here" — they are in `emit.js`), `09c3:16035-16038` (Tab traversal gated
on a JS call that has no reference), `09a8:1711-1712` ("app-profiles.js rounds
identically" — it does not), `09c5-menu.wat:3375` ("menu subsystem is a stub"),
`08c:130` (12 vs 13), `09c3:12741-12746` (calls `$edit_wndproc` "STEP 4 —
dormant … unreachable"; it is the live edit control), CLAUDE.md:263 (`run.js`
input DSL help is at `:817-889`, not 82-159; 8 parsed actions have no help
entry — `dblclick, dlg-paint, dlg-png, dump-msgq, dump-windows,
hwnd-png-pixels, rclick, wait-title`; bare `--handler-hist`, which CLAUDE.md
names five times, is a no-op — only `-thread/-start/-stop` parse,
`run.js:371-383`).

## P2-4 — CPU core and super-ops

**4.1 The design changed; the fixed cost moved, and it is now dominated by
statistics.** `$branch_end` (`04-cache.wat:781-821`) and `$jcc_end`
(`05-alu.wat:752-770`) `return_call $next` on a resolved page hit, so `$run`
(`13-exports.wat:8-238`) is the slow desk only. Per block on the fast path:
one 4-global OR, `block_budget<=0`, two SBH EIP compares, `$page_resolve`, two
`dbg_prev` stores — and **three global read-modify-writes that are pure
counters**: `$page_hits` (`04-cache.wat:745`), `$page_fast` (`:808`), `$page_ft`
(`05-alu.wat:765`). On the desk: ~20 conditionals including an **unconditional
`i32.atomic.rmw.xchg` on `$THREAD_RPC+36` when `current_thread_id==1`**
(`13-exports.wat:52-60`) — a locked RMW on every main-thread desk entry, in
single-threaded mode too — and a 6-way `yield_reason` OR (`:143-154`).
`--decode-stats` prints index hits/misses (`run.js:7652`); what it cannot say
is the share of blocks that entered `$run` rather than tail-calling `$next`,
which is the number that prices the desk.
*Fix:* gate the three counters behind `$handler_hist_enabled` (already tested
per block); print desk share in `--batch-stats`; gate the atomic on a
`$threads_active` global; fold the OR into one bitmask.

**4.2 App literals are back in the generic decoder.** Two removed on 08-18,
two new: Jazz2's LUT table base `0x0057BAE0` compared at `07-decoder.wat:834`
and emitted as an operand at `:880` (mode-2 of `$th_lut_span`, handler 431), and
MechWarrior 3's `0x00528064`/`0x00528111` at `07-decoder.wat:590,611` and
`07b-loop-match.wat:2904` (`$th_rgb565_alpha_run`, 436). The Diablo
`$stack_packet_*` addresses still live as globals (`01-header.wat:2364-2376`).
The MW3 fold is gated on `$loop_copy_emit_enabled`, which `lib/apps.js:1712`
turns on via `copySuperops: true` and `browser-shell.js:565` honors — **and
`test/run.js --app=mw3` ignores** (0 references), so the CLI and the browser run
MW3 with different decoders. Two more findings from the inventory: `--no-mmx`
only steers CPUID (`05-alu.wat:2464`), MMX handlers 422-425/432-434 always
decode; and the Smacker/Storm folds (395/396) have no enable flag at all.
*Fix:* the first pass's fix — a JS-populated `(addr → fold)` table from
`app-profiles.js`, byte signatures kept as the safety check — plus a
`tools/check-app-literals.js` that fails on any `i32.const 0x00[4-9A-F]xxxxx`
in `07*.wat` outside an allowlist; make `run.js --app` read `copySuperops`.

**4.3 Every guest store pays the self-modifying-code check three calls deep.**
`$gs32/$gs16/$gs8` (`03-registers.wat:376-405`) → `$invalidate_code_write`
(`:345`) → `$code_write_is_code` (`:327`) → `$code_page_test`: ~8 branches
before the store. MMX/SSE multiply it — `$mmx_store64` is 2× `$gs32`
(`06c-mmx.wat:249`), `$xmm_store128` 4× (`:98`), loads likewise with 2/4
`$g2w` calls. The code-page bit is **never cleared** (`$code_page_clear`,
`04-cache.wat:99`, zero callers), so a page that was once code pays the range
walk on every later data store for the rest of the run (Borland CodeSeg, RCT —
named at `03-registers.wat:353-361`). PLAUSIBLE cost; measure with
`bench-loops.js --shapes=store_stream`.
*Fix:* inline the bitmap test into `$gs*`; one page check per 8/16-byte MMX
access; clear the bit in `$page_dir_drop`.

**4.4 Arena-full is still a full flush, and the free lists cannot prevent it.**
`6e80eb2f` added 4/8/12/16 KB chunk classes with free lists
(`04-cache.wat:148-290`) — but the 4 KB margin check on `$thread_alloc`
(`13-exports.wat:64-68`) fires regardless of what is on them and calls
`$clear_cache` = `$page_dir_reset` (`:95-98`) for every page of every thread.
`--decode-stats` prints `full clears`; sol shows 0, and no corpus sweep of that
line exists. The free lists only slow the approach to the margin; they are not
consulted once it is reached. Also: the `$next` guard `fn >= 437` (`04-cache.wat:889`;
439 since the table grew on 08-28) flushes
*without* the `$sync_msg_depth` deferral that `$thread_arena_flush_if_safe`
exists to provide — a corrupt handler word inside a nested wndproc reproduces
the wild jump that function was written to prevent.
*Fix:* try the free lists (an LRU cursor exists at `:141`) before
`$clear_cache`; route the guard through `$thread_arena_flush_if_safe`.

**4.5 `$mmx_binop` is a 45-way if-chain on `$sub`** (`06c-mmx.wat:262-375`),
executed per MMX op for a sub-op the decoder knew. Jazz2 and AVS are the
MMX-heavy apps (1.53× and 23.6% of dispatches, per memory). *Fix:* `br_table`,
or split the 6 hot subs into handlers (the histogram names them).

**4.6 Dead and duplicated.** Zero references module-wide, not exported: 26 in
the core (23 `$host_gdi_*` wrappers at `01-header.wat:174-520` — 76 defined
against 64 distinct names called; the exact dead subset was not re-verified,
`$code_page_clear`, `$decode_sib` `07-decoder.wat:1191`, `$cdecl_return`
`13-exports.wat:4`) + 19 in the Win32 layer (257 lines: `$gdi_diagonal_wide_line_desc`
`10g:1334-1430`, `$gdi_dc_path_append_mask` `10d:1123-1175`,
`$gdi_metafile_empty_wmf/emf` `10e:506/2532`, `$find_dll_by_name`,
`$guest_strcmp`, `$paint_flag_first`, `$clipfmt_name_of`, `$rsrc_match_eid`
(whose comment at `10-helpers:1039` says "used"), `$lv_ctrl_id` `09c3:6413`,
`$d3dim_viewport_clear` `09ab:2650`, 7 wrappers `12-wsprintf.wat:287-305`) + 5
transitively dead (74 lines). Duplicates: 16 `$th_jcc_*` differing only in the
predicate (`05-alu.wat:771-`); `$gl32/$gl16/$gs32/$gs16` each hand-roll the
page-cross split; `$run` re-implements `$branch_end`'s guard set in a different
order. *Fix:* `wat-func.js --dead` as a run-all step; delete the 45.

**4.7 Bitwise-AND scan, core: 23 mixed sites, all benign** (each raw operand is
clamped or 0/1 by construction). Nothing enforces that; the 60-line scanner in
the scratchpad would have caught the SysLink and statusbar bugs the first pass
found by hand and the 29 confirmed in P2-7.3. **Done on 08-28:**
`tools/check-wat-logical-and.js` is a build gate (`build.sh:38`, `1c72223b`).

## P2-5 — The Worker-thread backend (new since the first pass)

One `ThreadManager`, `backend = workerBackend ? 'worker' : 'cooperative'`
(`lib/thread-manager.js:82-85`, 2,284 lines; `guest-rpc.js` 575,
`guest-thread-host.js` 706, `guest-worker.js` 694). Shared: handles, the SAB
sync table (`:110-127`), `waitSingle`/`waitMultiple` (`:653-700, :800-855`).
**Forked:** `spawnPending :1347-1577` vs `_spawnPendingWorkers :894-961`;
`runSlice :1579+` vs `runWorkerSlices :970-1013`; 71 `backend ===` branch sites
(thread-manager 22, host.js 27, run.js 22).

Confirmed semantic divergences between the two:
- Cooperative throttles a Sleep-looping thread to every 8th slice
  (`:1637-1641`); Worker honors only `sleepUntil` (`:984`).
- Worker-mode main waits require `minPolls` before WAIT_TIMEOUT
  (`:1245-1247`, `bc48a84d`); cooperative `checkMainYield` (`:2118+`) does not.
- Two hwnd-base formulas, both live: `:407-409` (`workerHwndBase`,
  `_appHwndBase()+0x8000+(tid-1)*0x1000`, used by the cooperative spawn at
  `:1439`) vs `:923` (`0x10001 + tid*0x10000`, sent to Workers and consumed at
  `guest-worker.js:442`); the comment at `:1421-1428` names the second as the
  one that leaks windows past app close.
- `checkMainYield` handles `yr === 9` twice (`:2143-2154` ends
  `clear_yield(); return false` unconditionally; `:2166-2172` is unreachable, so
  `_mainWaitPolls` is never counted for CS waits).
- `_clearWorkerCacheSlot` (`:436-446`, called from both spawn paths) zeroes
  `0x07152000 + tid*0x8000`, a region `01-header.wat:1406-1408` says "used to be
  CACHE_INDEX_BASE … is free". Dead work today; wrong the day something is
  placed there.

RPC: 208 imports — 9 local (GL batched, `get_ticks`, 7 math), 8 `ASYNC_SAFE`
(`guest-rpc.js:83-103`), **191 blocking including 46 void**. DirectDraw is *not*
batched (`371175d3` sets `_dxDirty`; the browser presents at most once per
display frame via `host.js:483-506`, called from `:2123`; a DOM-less host
presents every dirty slice).
Per call: a rest-args array and a message literal; `log` builds the API-name
string byte-by-byte on every Win32 call (`:298-308`); the slice reply is ~35
fields / ~30 export calls (`guest-worker.js:343-392`); the f64 result is
type-sniffed (`:500`). In the CLI, `--threads` main runs `run(N)` in-process so
parked workers stall for the batch (`run.js:7387`).

Selection is a page-global toggle (`index.html:1087`, localStorage
`wine-assembly.threads`); on failure `host.js:1197-1234` falls back to
cooperative with only a debug-pane `logToUI` line. No per-app
field in `lib/apps.js`; `72fda8d8` pinned Diablo cooperative and `3984dd98`
removed the pin and its test (`browser-shell.js:234-244` says don't re-add).
The one per-app knob is `autoRunSliceFor`, a hand-kept switch over 17 app ids
(`browser-shell.js:216-262`).

Coverage: 16-28 worker-path tests depending on how you count, all listed; 3
pass `--threads`, 2 compare both modes; **0 diff a
PNG across modes**; `--threads-serial`, `--thread-batch-size`, `--rpc-census`
have 0 tests. A notepad run in both modes is byte-identical — notepad has no
threads.

*Fixes, in order:* the inherited-globals table (P2-3.8); one hwnd-base
function; delete `:2166-2173`; route the cooperative wait policy through
`resolveWait`; derive `ASYNC_SAFE` from the sigs and batch DirectDraw like GL;
`test-cli-worker-threads.js` gets `--rpc-census` + `png-diff`, and
`test-winamp-audio.js --threads` joins E2E; `runSlice`/`threads` fields on the
apps.js entry replace the 17-id switch.

## P2-6 — JS host and the two hosts

**6.1 One first-pass fix regressed — FIXED `2ac6df83`, and it was worse than a
clamp.** The MessageChannel drive loop was in place (`host.js:2217-2240`
`_scheduleStep`) except on the `cs_wait` yield path, where `host.js:2398`
rescheduled with `setTimeout(step, 0)` — clamped to 4 ms once five retries
chain (the clamp counts timer nesting, and each retry starts from a
MessageChannel task), so a persistently contended section, not every retry.
The real cost was that the early `return` skipped the thread-manager block
below it, so the main thread retried and re-parked forever without the
critical-section owner ever getting a slice — the Deus Ex demo startup hang.
`2ac6df83` clears the yield and falls through (`host.js:2392-2400`).

**6.2 index.html regrew.** 1,136 → 2,322 lines; 1,094 of inline JS at
`:1227-2320`: page fullscreen + iOS scroll-collapse (`1229-1470`), presentation
settings (`1585-1700`), the threads toggle (`1851-1970`), debug MIDI/input
profiling (`2074-2147`), `resizeCanvas` (`2148-2310`). None testable from Node.
44 hand-bumped `?v=` cache busters; `host.js?v=234` vs `SOURCE_VERSION='228'`
(`host.js:29`) already disagree (`?v=237` vs `'231'` a day later — the two
counters move independently). *Fix:* `lib/page-viewport.js` +
`lib/page-settings.js`, the browser-shell pattern; one version constant.

**6.3 Still-forked between browser and CLI:** 31 host imports overridden in
both; `check_input` diverges (`host.js:747` `renderer.takeInput` vs
`run.js:2665-2689` `renderer.checkInput` + its own queue priority, and
`renderer-input.js` exports both, `:2982/:3016`); `makeWorkerImports`
(`run.js:3022-3195` vs `host.js:963-1019`); the yield-reason state machine
(`run.js:6952-7602` vs `host.js:2359-2480`); `installingFiles` NSIS sniff still
CLI-only (`run.js:2622-2630`). Per-app policy in generic JS: `autoRunSliceFor`
(above) and `_snapWinampEqButtonPoint` keyed on `win.title === 'Winamp
Equalizer'` (`renderer-input.js:302-329`), called on every mouse down/up.

**6.4 Still-unfixed from 08-18:** `check_input` allocates two closures per
GetMessage poll (`host.js:728-746`) and `logToUI`s every non-mousemove event
(`:758`); `host.js:521` builds a `TextDecoder` per traced API call;
`browser-shell.js` has 14 `log.textContent +=` sites (`:542` fires per progress
stride during app load) — the quadratic pattern moved, not died; `_hasOpenMenu`
still `Object.keys(windows)` per step (`host.js:1962`, again at `:2406`).

**6.5 New hot-path costs.**
- DirectDraw present: `_presentBestDxOffscreen` (`host-imports.js:959-968`)
  walks all 1,024 `DX_SLOT_COUNT` slots every dirty display frame, `_surfaceInfo`
  (`:559-574`) builds a `DataView` per slot plus a second one for flags
  (`:965`), and `_surfacePresentSignature` (`:670-692`) samples through a fresh
  full-memory `Uint8Array` view (no copy) and builds a string key. ~1k DataViews
  per frame for a 60 fps DX app. *Fix:* one cached view (memory is fixed-size);
  track live surfaces on create/release.
- OpenGL encoder: `gl-command-stream.js:58-60` `u32At` allocates a DataView
  **per word read** (`_f32` at `:239` already uses the cached `_memoryView()`,
  so the pattern for the fix is three lines away); `gl-compat.js:445-446`
  `_dv()/_stackDv()` per accessor, `:216-220` `slice()` per vertex. Immediate-mode
  guests (quake2, uplink) pay this per GL call.
- `filesystem.js:199-204` grows exactly to `newEnd` — appending writes are
  O(n²) (PLAUSIBLE on installers). Geometric growth.
- Full-memory typed views per call at `host-imports.js:1815,1832,1961,2054`;
  67 `new DataView/Uint8Array` sites in the file.

**6.6 Empty `catch` census:** host-audio 53, host-imports 20, host.js 15,
renderer-input 12, thread-manager 7. Notable: `host-imports.js:690` swallows
inside the DX present signature (a bad `dibWa` presents nothing, silently);
`host.js:1576,1644,1725` turn a DLL fetch 404 into a later "DLL not found";
`host.js:1983` swallows `menu_open_hwnd` traps per step.

**6.7 A second region model.** The "chain-of-Path2D (Approach A)" HRGN model
(`host-imports.js:1003-1177`) is live via `gdi_set_region_bands` (`:1823`),
`gdi_set_window_rgn` (`:1848`), `invalidate_rgn`/`validate_rgn` (`:1868,1875`)
beside `src/10d-gdi-region-path.wat`. PLAUSIBLE deletion once bands are the
only input.

## P2-7 — Win32/GDI/controls layer

**7.1 File names, second round.** `09c3-controls.wat` (16,657 lines, 388
functions) is on-topic but 38% of it is six wndprocs: `$edit_wndproc` 1,535
(`:13743`), `$listview_wndproc` 1,419 (`:7244`), `$listbox_wndproc` 1,004
(`:10641`), combobox 813, button 789, toolbar 734. `09a-handlers.wat` (14,888)
is still the residual bucket: of 791 handlers, 205 window/dialog/msg, 100 file,
77 clip/atom/env/version, 70 thread/process, 68 string, 48 heap, 37 Reg, **36
GDI-named** (GetDC, DrawText*, LoadBitmap*, ExtCreatePen, Set/GetWindowRgn,
InvalidateRgn…) that `185afb3` missed. `10-helpers.wat` (5,476) still carries
`richedit` 14 + `wordpad` 6 functions. `09a5` has `$handle_CreateWindowExA` at
795 lines. *Fix:* `wat-split.js --names=` for the 36 and the wordpad tail; split
the three 1,000+-line wndprocs by message family — every 7.4 finding is inside
them.

**7.2 A/W drift came back: DIVERGENT 4 → 14.** `git log -S` dates 10 of the 14
W-sides to 08-25/26 (`704f1cd0`, `312d4894`, `ea2c39ba`): each was written with
the correct contract *next to* an A that was never fixed. 7 are equivalent on
read; **7 confirmed:**

| Pair | Divergence |
|---|---|
| GetSystemDirectoryA `09a:11537-11548` / W `:11553-11573` — **FIXED `2959ea35`** | A wrote 18 bytes unconditionally, ignored `uSize` and NULL; `GetSystemDirectoryA(buf,0)` overflowed. W guarded. |
| GetWindowsDirectoryA `:11576` / W `:11590` — **FIXED `2959ea35`** | same shape |
| GetUserNameA `09a7:2619` / W `:2635`; GetComputerNameA `:2657` / W `:2672` — **FIXED `2959ea35`** | A ignored `*pcb` and NULL; W returns 122/111 |
| EnumDisplaySettingsA `09a3:1243` / W `:1266` | A never reads `dmSize` and never zero-fills; W rejects `dmSize<220` outright (`:1278`), so a legal 156/188-byte DEVMODEW gets 0 — it is never written, but never served either |
| GetCommandLineA `09a:549-552` / W `:6999` | A calls `$store_fake_cmdline` (`10-helpers.wat:1290`, unguarded `heap_alloc 512`) **every call** — a 512-byte leak and a new pointer per call; W is guarded. `__p__acmdln` `:6731` / `__getmainargs` `:5852` build a third command line with no `C:\` prefix and no `--args`, so `argv` ≠ `GetCommandLineA()` |
| RegisterClipboardFormatA `10-helpers:3485` / W `:3495` | W short-circuits "Rich Text Format" to `$clipboard_get_rtf_format_id` (`:3427`), minting `0xC000+n` outside CLIPFORMAT_TABLE; A interns. W→A yields two ids for one name; `GetClipboardFormatName(0xC001)` → 0 |

BOTH_STUB: `SetConsoleTitleA/W` (`09a2:91-100`) drop the title; no
`GetConsoleTitle*` exists.

**7.3 Bitwise-AND on raw values: 29 confirmed in the Win32 layer** (4,402 sites
scanned, 245 flagged; the review first listed 30 — the `10c-truetype.wat:4155`
row was wrong, `$tt_entry_pixel` already returned a 0/1). **All FIXED on 08-28**
(`1c72223b`, `56bae14c`; 36 sites normalized in all). With app-visible effect:

| file:line | consequence |
|---|---|
| `09a:3646`, `:7224` — `(i32.and (ctrl_table_get_class hwnd) (…))` | SetWindowTextA/W on **even class ids** (Edit=2, ListBox=4, TreeView=8, ListView=18) skipped WM_SETTEXT and took the caption path |
| `09b-dispatch.wat:116` — hwnd & DLGTEMPLATE.style | post-WM_INITDIALOG native-child paint drain (NSIS pages) practically never fired |
| `09c3:6190` — `(style & 0x100) & pred` | SBARS_SIZEGRIP grip never drawn |
| `09d-winsock.wat:1053` — two guest pointers | FD_READ for an accepted child only when the pointers shared a bit |
| `09a9-comctl32.wat:276` — `$buttons & $button_count` | CreateToolbarEx added no buttons unless `ptr & count` |
| `09a:725` — `$long` is `arg1 & 2` | GetDateFormatA never produced DATE_LONGDATE from the flag (only an explicit `dddd` format reached it) |
| `09a8` `IDirectDrawSurface3_SetSurfaceDesc` (`entry & lpDDSD`) and the palette copy (`pal_wa & src_wa`, `:3651`); `09a6:1224` (IsEqualGUID, ptr & ptr); `09a7b-ole.wat:678/707/1254/5923/6257` | no-op SetSurfaceDesc; IsEqualGUID FALSE on disjoint pointers; missed E_NOINTERFACE / leaked interfaces |
| `09aa:1010`, `09c7:3297`, `09c8:209`, `09c9:628`, `09e:1169/3210/4524`, `09e2:438/844/894/906`, `10c1:2703`, `10d:3674`, `10g:2509` | dead validation branches; DlgDirList routed by hwnd bit 4 |

The gate that keeps them out is `tools/check-wat-logical-and.js` (`build.sh:38`).

**7.4 Parallel families with measured divergence** (41 confirmed across 10
families; highest impact):
- **RegSetValueA/W is a no-op** (`09a:9657-9660`) while RegSetValueEx stores and
  RegQueryValue reads: set-then-query → ERROR_FILE_NOT_FOUND.
  RegCreateKeyEx{A,W} always write disposition 1 (`:9727,:9740`) though
  `storage.js:1166` computes it.
- **GetTextExtentPointW / 32W don't measure**: `09a4:2244-2245`, `:3092-3093`
  do `count × tmAveCharWidth`; A (`:541`) and GetTextExtentExPointW (`:1175`)
  call `$host_measure_text`, which already takes `$wide` (`10f-gdi-dc.wat:1501`).
  ExtTextOutW alone sniffs "packed ANSI" (`09a4:1909-1915`) — measure ≠ draw.
- **CreateWindowExW** (`09a:7011`, 27 lines over the 795-line A) stores ANSI
  heap copies into CREATESTRUCT `+0x124/+0x128` so a Unicode `OnNcCreate` reads
  ANSI as WCHAR; leaks 768 bytes per call (`:7019,:7025`, no free).
- **MoveWindow vs SetWindowPos** (`09a:4466` vs `:5081`): MoveWindow ignores
  `bRepaint` (esp+=28, the 6th arg never loaded), posts WM_SIZE and never
  WM_MOVE; SetWindowPos sends WM_WINDOWPOSCHANGED and never WM_SIZE/WM_MOVE.
- **SHGetSpecialFolderPathA** (`09a:5502-5511`) ignores `nFolder`; SHGetFolderPathW
  (`:5526`) has the real CSIDL table.
- **Listbox / combo dropdown / listview / treeview** share no row, hit-test or
  scroll code (visible-rows: 6 inline listbox copies vs `$lv_visible_rows_for_h`
  vs tv `:659`; y→index 5 non-identical copies). Listbox has **no WM_VSCROLL
  and no WM_MOUSEWHEEL** (`:10641-11956`); LB_SETCURSEL never scrolls into
  view; click past the last row selects it *and closes the combo* (`:11072`,
  `:12440`); lv/tv never write SCROLL_TABLE so `GetScrollPos` is stale; the
  highlight colour is literal `0x800000` in lb/tv and stock brush 14 in lv.
- **Scrollbars**: arrow layout ×3 (`09c3:16141, :16600, 09c4:524`), two WAT
  hit/drag models (`$scrollbar_* :16180-16222` vs `$sb_page_* :16234-16336`,
  disagreeing on track length by 4 px) plus a JS one (`renderer-input.js:834-870`)
  that routes NC-bar clicks against the window rect while WAT paints at the
  client rect (`09c4:682`); NC arrows never show pressed; `EnableScrollBar`/
  `ShowScrollBar` store nothing; `$defwndproc_paint_standard_scrollbar` still
  carries two inline thumb copies (`09c4:556-579`) beside `$paint_sb_thumb`.

**7.5 Silent success stubs are the norm, not the exception.** 98
`$crash_unimplemented` sites on 08-27 (`09ad` 54, `09a` 32; **0** in console,
audio, gdi, window, crt, ole, mixer, opengl, comctl32, winsock, win16, `10*`;
118 by 08-28 after the D3D9 flip, `09ad` 87 / `09a` 31) against 617
constant-return bodies, ~45 confirmed policy violations. Every one sampled was
born a stub in the commit that added the API. Worst:

| API | where | does |
|---|---|---|
| EnumWindows / EnumThreadWindows / EnumSystemLocalesA / EnumSystemCodePagesA — **FIXED `1c72223b`** (`$enum_window_walk_begin`, CACA thunks) | `09a:13146/13155/10504/13163` | TRUE, callback never called (`:13141` documented the CACA fix never done) |
| GetMenuItemInfoA / SetMenuItemInfoA — **FIXED `1c72223b`** (`$dynamic_menu_item_info_get/set`) | `09c5-menu.wat:3375/3368` | TRUE, wrote nothing; comment said "menu subsystem is a stub" |
| RegisterHotKey | `09a:10311` (08-22) | TRUE, no WM_HOTKEY ever |
| SetWindowsHookA | `09a7:501` | fake HHOOK `0x00DEAD02`, keeps nothing |
| SetWindowsHookExA / CallNextHookEx | `09a:8694/8642` | HHOOK `0xBEEF`; only WH_KEYBOARD/WH_CBT kept |
| HeapCreate / CreateConsoleScreenBuffer / CreateIconFromResourceEx | `09a:1980`, `09a7:2897`, `09a:10627` | the same fixed handle for every call |
| WaitMessage | `09a:12619` | returns immediately — busy loop |
| ReleaseMutex | `09a:11184` | no state; wrong under `--threads` |
| DdeGetData / DdeNameService / DdeUninitialize | `09a:1204/1147/1157` (08-23) | 0 bytes / TRUE |
| Shell_NotifyIconA, SetConsoleCtrlHandler, DragQueryFileA, RegisterDragDrop, SetFileTime, waveOutPause, ICInfo/ICOpen | `09a:10253/10430/5670/12719/9530`, `09a3:481`, `09a8:7116-7127` | success, nothing done |
| DDraw/DInput enumerations, ~30 IDirectPlay3/Lobby methods `09a8:5435-5702`, viewport lights `09aa:1105-1580` | | OK, no callback / no effect |
| **D3D9 `ret:'OK'` block, 100 methods** — CreateTexture `09ad:399`, CreateDepthStencilSurface `:429`, LockRect `:1022/1113`, GetRenderState `:604` — **FIXED `56bae14c`** | | `tools/d3d9-methods.js:13-19` said the default is CRASH *because* a NULL resource is worse — yet Create*/Get*/LockRect were tagged OK with out-pointers untouched (08-23). Now CRASH. |

Done on 08-28: the D3D9 rows, the four enumerations, the menu-item pair, and
`tools/check-silent-stubs.js` as a build gate (`build.sh:43`) so a new
`$handle_*` whose body is `eax=const; esp+=N` with no other effect fails the
build. Still open: RegisterHotKey, the hooks, the fixed-handle trio,
WaitMessage, ReleaseMutex, the DDE trio, the shell/console/file row, and the
DDraw/DInput/DirectPlay/viewport-light enumerations. *Fix:* CACA thunks for the
remaining enumerations (the pattern now exists 35 times); per-call slots for
the fixed handles.

## P2-8 — The toy DOS VM (`tools/toyvm/`)

A second x86 interpreter, 16-bit real mode + 386 extensions, decoder in JS
(`decode.js` 1,085 lines, 92 opcode cases) with handler bodies as WAT string
fragments (`emit.js` 3,942 lines, 116 handlers, four dispatch shells), a trace
cache (`compile.js`), a DOS/BIOS/VGA machine (`dos.js` 2,945 lines, 105
INT/port cases), and a browser bundle. It shares **nothing under `src/`** with
the main emulator — only `lib/compile-wat.js`, `tools/disasm.js`,
`tools/fnt-read.js` and `tools/fetch-cputests.js` — deliberately, as a
dispatch-shape measurement rig (`docs/toyvm-dispatch-shootout.md`). It shares
no decoder, flag model, or memory map with `07-decoder.wat`'s own 16-bit path
(`$code16`, handlers 370-388), and `tools/disasm.js` is a third decode of the
same ISA (toyvm's `dos-disasm.js` reuses it for display only). The rig has grown a product: XMS, protected-mode `d32`
segments, an FPU, a 199-program corpus page with 12 binaries embedded in git.

Correctness is checked by hand-run tools (`gate.js` against SingleStepTests
silicon vectors, default `--ops=00-05`; `fpu-check.js` 48, `bitops-check.js`
20), none in `run-all.sh`; its three repo tests are among the 48 unlisted
(P2-3.6). *Fix:* vendor one opcode's vectors and gate `--ops=00-05 --limit=500`
+ fpu/bitops in run-all; `bundle-browser.js --check` (P2-3.7); make
`tools/disasm.js` the reference for `decode.js`'s length/ModRM logic.

## P2-9 — tools/ and test/

- **Broken:** `tools/trace-assert.js:6`, `render-desktop.js:9` and
  `test/call-func.js:10` require the deleted `lib/resources.js`;
  `win16-v86-compare.js:265` greps `[CreateWindowEx` but every host prints
  `[CreateWindow]` (`run.js:2554`, `host.js:693`, `host-window.js:195` — window
  count always 0); `wep32-compare.js:109-118` regex-scrapes `lib/apps.js` *source*.
- **Superseded, no code references:** `headless-run.js` (a 480-line second
  run.js), `cdp-eval.js`, `batch-timing-stats.js`, `wasm-exports.js`, `run.sh`;
  `render-png.js` likewise, though CLAUDE.md:368 still lists it.
- **Duplicates:** five PNG inspectors (`png-crop/probe/rows/stats/window`);
  `func-index.js` vs `wasm-func-name.js`; three hand-rolled CDP clients
  (`profile-winamp-web.js` 2,302 lines, `profile-aoe-web.js` 1,432) beside
  puppeteer-based `profile-web-frames.js`; five `aoe-*` census tools (~3k lines)
  for an abandoned design; six tools with private app lists. Three app lists
  coexist: `lib/apps.js` (141 entries), `corpus-apps.sh` (35), `test-all-exes.js`
  (114 cases).
- **9 tools regex-scrape run.js stdout** (`caller_census`, `cpuprof-sweep`,
  `loopmatch-sweep`, `menu-sweep`, `startup-modal-sweep`, `wep32-compare`,
  `win16-v86-compare`…); the `[CreateWindowEx` drift is what that costs.
  *Fix:* `run.js --json-summary=FILE`.
- `check-parens.js` fails on `build/combined.wat` (depth −1 at 187,464): the
  artifact has 10 more lines than `src/*.wat` and every dirty part balances on
  its own — a stale build from another session, PLAUSIBLE. Worth making
  `check-parens` regenerate before checking.

## P2-10 — What's healthy (keep doing this)

- All ten build gates pass and are wired in; `check-handler-esp` covers 1,382
  epilogues; `api_table.json` append-only holds at 3,034.
- 194 of 210 A/W pairs share a `$wide` core or delegate. The 10 new divergences
  are old A-sides, not new copies.
- `$paint_scratch_take`, `$scroll_bar_addr`/`$scroll_aux_bar_addr`/
  `$ctrl_geom_addr`, `$wnd_record_addr`: one function per table, still.
- `tools/d3d9-methods.js` — spec-driven stubs with CRASH as the documented
  default is the right shape; only the row tags are wrong.
- toyvm binds handlers by *name* (`emit.js:33-36`, `decode.js:15`) — better
  than the WAT decoder's literals (P2-3.4).
- `$branch_end`/`$jcc_end` tail-calling `$next` on a page hit — the desk is
  genuinely off the hot path now.
- The trunc audit is clean: every `i32.trunc` in the core is NaN/range-guarded
  (`06-fpu.wat:273-297, 499-506`; `06c-mmx.wat:110-117` uses `trunc_sat`).
- `28e5830`'s sweep hygiene (signal-killed runs are not passes; per-case load
  sampling) is the model the DOS corpus sweep should copy — it has no retry
  and a `blank/vga/text` verdict only.

## Pass-2 prioritized recommendations

*Struck items were done on 08-28 — see "Pass-2 status" below.*

**Tier 1 — live bugs and missing gates (a day; each is small):**
1. ~~Move `SCROLL_AUX_TABLE` and `EXTRA_CMDLINE_BUFFER` off their collisions;
   `wat-memory-map.js` exits non-zero on intersection and runs in build.sh.~~ (P2-3.2, `2959ea35`)
2. ~~`mem-utils.js` `DIB_GUEST_CAPACITY` = `0x03F00000`~~ (`2959ea35`); extend the
   new constants gate to the remaining WAT↔JS pairs listed in P2-3.1.
3. ~~`host.js:2398` → fall through to the thread block.~~ (P2-6.1, `2ac6df83`)
4. `check-test-manifest.sh` into build.sh; tier the ~55 strays. (P2-3.6)
5. ~~Bound `DLL_TABLE`.~~ (P2-3.3, `2959ea35`; verify the WAT-side `$load_dll` path)
6. ~~The 29 confirmed `i32.and` sites, then the scanner as a gate.~~ (P2-7.3, `1c72223b`/`56bae14c`)
7. The 3 remaining A/W divergences (EnumDisplaySettings, GetCommandLineA's leak,
   RegisterClipboardFormatW's RTF id) and the 4 worst family divergences
   (RegSetValue, GetTextExtentPointW, CreateWindowExW's ANSI CREATESTRUCT,
   listbox WM_VSCROLL). (P2-7.2, 7.4)

**Tier 2 — the pattern fixes (each closes a class):**
8. Generated handler-id and api-id/CACA globals; delete the drifted comments. (P2-3.4, 3.5)
9. App-literal allowlist gate; `(addr → fold)` table from app-profiles; `run.js --app` honors `copySuperops`. (P2-4.2)
10. One inherited-globals table for both spawn paths; ~~shared TLS cursor~~ (`2959ea35`); one hwnd-base; delete the unreachable `yr===9`. (P2-3.8, P2-5)
11. ~~`check-silent-stubs.js`; flip the D3D9 Create/Get/LockRect rows; CACA-thunk the four system enumerations~~ (`1c72223b`, `56bae14c`); the DDraw/DInput/DirectPlay enumerations and the fixed-handle stubs remain. (P2-7.5)
12. Delete the 45 dead functions and the 6 dead tools; fix the 3 broken requires; `wat-func.js --dead` in run-all. (P2-4.6, P2-9)

**Tier 3 — performance (measure first, levers named):**
13. Gate the three per-block counters; print desk share; gate the atomic. (P2-4.1)
14. Cached DataView + live-surface set in the DX present path; same in the GL encoder. (P2-6.5)
15. Inline the SMC bitmap test into `$gs*`; one check per MMX/SSE access; clear the code-page bit. (P2-4.3)
16. `$mmx_binop` → `br_table`. (P2-4.5)
17. Free lists before `$clear_cache`; the `$next` guard through `_flush_if_safe`. (P2-4.4)

**Tier 4 — structural (the 08-18 list, unchanged, plus the new ones):**
18. EditState/ToolbarState/TooltipState accessors; split the six wndprocs by message family; move the 36 GDI handlers and the wordpad tail. (P2-2, P2-7.1)
19. `renderer.windows` → canvas bookkeeping only; `move_window`/`set_window_zorder`/GW_* into WAT. (P2-2 §4.3)
20. `lib/page-viewport.js` + `lib/page-settings.js` out of index.html; one version constant. (P2-6.2)
21. `runSlice`/`threads`/`inputHooks` on the apps.js entry; delete `autoRunSliceFor` and the Winamp title match. (P2-5, P2-6.3)
22. One `check_input`, one yield state machine, one `makeWorkerImports` for both hosts. (P2-6.3)
23. toyvm: vendor test vectors and gate; `disasm.js` as the shared reference decoder. (P2-8)
24. `run.js --json-summary`; retire the stdout scrapers. (P2-9)

## Pass-2 status — what was acted on

*Updated 2026-08-28. Another session (coordinating on `messageboard.txt`)
picked the document up within hours; the two verification passes then found
these already in HEAD or staged. Commit hashes are on `main`.*

| § | Item | Commit |
|---|---|---|
| 3.2 | Every fixed region sized and the map intersected as a build gate (`test/test-wat-memory-map.js`, `build.sh:15`). Five live overlaps moved, not two: `SCROLL_AUX_TABLE` → 0x07F21000, `EXTRA_CMDLINE_BUFFER` → 0x07F20200, and the TreeView family + `TIMER_SHARED` this pass had not seen; D3DIM's strings/caches/state declared as one sized `$D3DIM_AUX` region | `2959ea35` |
| 3.1 | `mem-utils.js` DIB capacity 63 MB to match WAT; `host-imports.js` imports it instead of redefining; JS DIB/RPC constants checked by the same gate | `2959ea35` |
| 3.3 | `$DLL_TABLE_CAPACITY`; the 17th DLL fails in `lib/dll-loader.js:27-31` before any write | `2959ea35` |
| 3.8 | TLS index cursor process-wide and atomic (`$TLS_NEXT_INDEX_SHARED`, `$tls_reserve`); TlsGetValue/SetValue/Free reject index ≥ 64 instead of walking past the 256-byte vector | `2959ea35` |
| 7.2 | GetSystemDirectoryA, GetWindowsDirectoryA, GetUserNameA, GetComputerNameA honor their buffer sizes like their W twins | `2959ea35` |
| 7.3, 4.7 | 36 raw-value logical `i32.and` sites normalized (29 of this pass's list plus 7 more the scanner found); `tools/check-wat-logical-and.js` as a build gate (`build.sh:38`) | `1c72223b`, `56bae14c` |
| 7.5 | EnumWindows / EnumThreadWindows / EnumSystemLocalesA / EnumSystemCodePagesA call back through CACA thunks; Get/SetMenuItemInfoA real for dynamic menus (honest FALSE otherwise); `tools/check-silent-stubs.js` as a build gate (`build.sh:43`); D3D9 Create*/Get*/LockRect rows flipped to CRASH in `tools/d3d9-methods.js` | `1c72223b`, `56bae14c` |
| 6.1 | The `cs_wait` yield path no longer reschedules-and-returns; it falls through to the thread block so the section owner gets a slice (this was the Deus Ex startup hang) | `2ac6df83` |

**Still open from Tier 1:** the test-manifest gate in `build.sh` (3.6); the
remaining WAT↔JS constant pairs (3.1); the three A/W and four family
divergences in item 7.

**What the verification changed in this document:** the `10c-truetype.wat:4155`
AND row was struck (the callee already returned a 0/1); EnumDisplaySettingsW
refuses a short DEVMODEW rather than overwriting it; `$mmx_binop` is 45-way,
not 64; the decoder literal count is 405/321, not 415/319; `$page_misses` *is*
printed; `_f32` in the GL encoder already caches its view; `render-png.js` is
still documented in CLAUDE.md; a third file (`test/call-func.js`) requires the
deleted `lib/resources.js`; and a dozen line numbers had drifted by a few lines
under the day's commits.

---

# Pass 1 — 2026-08-18 (unchanged, with its action log)


*2026-08-18. Reviewed at commit `ab4aae3` ("Finish DDEML: wildconnect, busy, real timeouts, and an error code fix"). Four parallel deep reviews: CPU/emulator core, Win32/controls WAT layer, JS host layer, tools/build system — plus focused deep-dives into the three largest files (`10-helpers.wat`, `09a7-handlers-dispatch.wat`, `09c3-controls.wat`) and the state-table layer. All claims carry file:line evidence; line numbers are as of the reviewed commit.*

---

## Verdict

The macro-architecture is sound. The threaded-code interpreter, the generated br_table dispatch, the append-only API table, the yield mechanism, and the "logic in WAT, JS only rasterizes" principle all hold up under scrutiny, and several subsystems are in genuinely good shape (string ops, WND_RECORDS encapsulation, the build gates that do exist, the tool families that share code).

The problems are almost all **drift**, in three forms:

1. **File organization has drifted from file names.** The three biggest files are mislabeled: a 17k-line "helpers" file that is 74% a complete GDI implementation, a 12.6k-line "dispatch" file that is 81% OLE/COM, and the core window table living in a file named "help".
2. **Parallel hand-copies have diverged into real bugs.** A/W API pairs, the browser-vs-CLI host paths, control paint code, and ~24 PE parsers in tools/ are maintained by copy — and the copies measurably disagree (five confirmed behavioral divergences listed below).
3. **Invariants are kept in sync by discipline, not by the build.** The WAT_FILES manifest, the generated dispatch/hash tables, api_table.json ids, ordinal string offsets, and the slot-parallel window tables all have "keep in sync" contracts with no checker — and one (WAT_FILES) has already bitten once.

On performance, there are a small number of concrete, high-leverage issues: a per-block pattern-scan tax and a per-block debug gauntlet in the interpreter's hottest loop, generic re-dispatch of decode-time constants in memory-form ALU ops, a 4ms timer clamp capping the browser drive loop, an unconditional full-desktop composite per step, and per-call garbage in hot import wrappers.

---

## Part 1 — File organization: the names lie

The build is a pure concatenation of `src/*.wat` in filename order, so every fix in this section is a zero-risk mechanical file move/rename (plus the `WAT_FILES` update in `lib/compile-wat.js`).

### 1.1 `10-helpers.wat` (17,156 lines) is a mislabeled GDI subsystem

Of its 538 functions, **336 are `$gdi_*` (~12,700 lines, 74%)**, forming a complete GDI implementation:

- Region allocator + polygon scan-converter — `src/10-helpers.wat:451-1060`
- Full path engine incl. flatten/widen/stroke — `10-helpers.wat:1288-3290`
- Palettes — `10-helpers.wat:3648-3850`
- WMF/EMF metafile recorder+player — `$gdi_metafile_play_wmf` alone is ~594 lines (`10-helpers.wat:4570-5164`), `_emf` ~562 lines (`5552-6114`)
- DC state/save/restore — `10-helpers.wat:6250-6720`
- Software rasterizer with clip bands and brush sampling — `10-helpers.wat:8000-10800`

The tail (`14564-16218`) is richedit/clipboard/WordPad/menu-command logic — app/UI-level code (`$wordpad_colorref_for_index:15437`, `$wordpad_richedit_paste_clipboard:16032`, `$menu_try_edit_command:16164`, `$menu_try_wordpad_color_command:16134`) that belongs with the 09a4/09a5 handler files, plus message-layer code (`$wnd_child_from_point_deep:15235`). Only ~1,000 lines (strings/heap/DIB alloc at top, resource walker `13414-13610`, guest string helpers `13680-14015`) match the documented purpose "String/memory helpers, heap allocator, resource walker" (CLAUDE.md).

**Cost:** the project's most substantial single subsystem — the software GDI rasterizer — is invisible behind the least informative filename. **Fix:** split into `10d-gdi-region.wat`, `10e-gdi-path.wat`, `10f-gdi-metafile.wat`, `10g-gdi-raster.wat`, etc.; move the wordpad/menu tail next to the richedit/menu code.

### 1.2 `09a7-handlers-dispatch.wat` (12,631 lines) is 81% OLE/COM

All 622 functions categorized:

- **OLE/COM: 489 funcs, 10,190 lines (81%)**, contiguous at `09a7:669-10567`. Sub-blocks: ROT/Moniker/BindCtx 669–2580; IFont 2583–2979; storage/stream/CFB 2980–5559 (the CFB serializer alone is 4116–4862); IDataObject/clipboard 5560–7650; IOleObject/IOleCache/IViewObject 7650–10061; misc OLE 10062–10567.
- Misc late handlers: 93 funcs, 1,729 lines. mixer/winmm: 18 funcs (`12157-12571`). Atoms: 18 funcs (`11421-11634`).
- **Actual sub-dispatchers — the file's namesake: 4 funcs, 111 lines** (`09a7:8, :29, :55, :127`). The header comment at `09a7:2` describes <1% of the file.

**Fix:** carve the OLE/COM block into its own `09a7b-ole.wat` (or several); move mixer handlers next to audio (09a3), atoms next to their kin.

### 1.3 `09c-help.wat` — the core window table lives in a file named "help"

Lines 21–774 (50 of 77 functions) are core windowing: the window table and `$wnd_record_addr` (`09c-help.wat:21`), parallel-table resets, GWL/cbWndExtra, dialog-state table, sibling walk, style accessors, the class table (`:672,701,716`), `$wat_wndproc_dispatch:727`, and `$set_focus:763`. Help proper only starts at `:775`. The single most central windowing data structure in the project is filed under "help", and CLAUDE.md's file table already has to explain the mismatch. **Fix:** split into `09c0-window-table.wat` + help remainder.

### 1.4 `09a-handlers.wat` (13,905 lines) is a residual bucket

893 handlers with every topical bucket spanning the whole file; median handler is 9 lines and ordering is chronological-by-need:

- **GDI: 132 handlers here vs 109 in the dedicated `09a4-handlers-gdi.wat`** — the "misc" file holds more GDI surface than the GDI file. Contiguous slabs at `09a:9458-10152`, `6215-6560`, `7536-7885`.
- **comctl32: a 720-line slab** (ImageList/toolbar/statusbar/DSA/DPA) at `09a:12552-13270`, while `09c3-controls.wat` has zero `$handle_*` entry points.
- **Menu: 38 handlers scattered** (`09a:1813, 2804, 2971-3021, 10579-10623, 11438-11548, 11842-11970`) while `09c5-menu.wat` has 75 `menu_*` helpers and zero entry points.
- Conversely, `09a4-handlers-gdi.wat:681` holds `$handle_SetMenu` — a USER API.

**Fix:** relocate the three contiguous slabs first (GDI→09a4, comctl32→09c3 or a new file, menu→09c5) — that alone moves ~2k lines to where a reader would look for them.

### 1.5 `01-header.wat` — 249 functions pretending to be imports

The file contains 181 genuine `(import "host" ...)` declarations and **249 `(func $host_gdi_* ...)` definitions** that are no longer imports — WAT reimplementations (calling the 10-helpers GDI code) that kept their import-era `$host_` names and their spot in the "module declaration, host imports" file (`01-header.wat:142+`). Both the name and the location actively lie: a reader tracing `$host_gdi_fill_rect` assumes a JS boundary crossing that doesn't exist. **Fix:** rename to `$gdi_*` shims, move next to the GDI code as part of the 1.1 split; keep 01-header to real imports, memory layout, globals.

### 1.6 `06-fpu.wat` carries non-FPU core handlers

The nominal x87 file carries the entire 16-bit ALU/MOV handler family (`$th_alu_r16_m16:968`, `$th_mov_m16_i16:1040`) plus core non-FPU handlers (`$th_call_r:1051`, `$th_jmp_r:1067`, `$th_lea_sib:1130`, `$th_compute_ea_sib:1149`, all the `*_ro` ALU forms `1175+`) that duplicate 05-alu patterns at another width. **Fix:** file-move into 05-alu at minimum.

---

## Part 2 — Copy-paste with measured divergence

This is the dangerous kind of duplication: not verbose-but-identical, but parallel copies that have already drifted apart. Five confirmed behavioral divergences are marked **[BUG]**.

### 2.1 WAT layer

**The W message pump is a diverged parallel copy of the A pump, in a different file.**
`GetMessageA` (`src/09a5-handlers-window.wat:1396`, ~235 lines) vs `GetMessageW` (`src/09a-handlers.wat:11194`, ~188 lines); `DispatchMessage` `09a5:1892` vs `09a:10870` (similarity ~0.64); `PeekMessage` `09a5:1630` vs `09a:10996`; `DefWindowProc` `09a5:2127` vs `09a:4992`. GetMessageW reimplements the 11-phase delivery pipeline documented in CLAUDE.md rather than delegating, and **[BUG-adjacent]** is already missing phases the A side has (8 vs 6 matches on timer/paint/startup markers). The comment at `09a:10916` literally says "Keep this in sync with DispatchMessageA". Any message-ordering fix must currently be applied 2–3 times across two files.
*Fix:* extract `$getmessage_core(msg_ptr, wide)`; make the W handlers 10-line wrappers converting WM_CHAR/text payloads.

**A/W handler pairs: 44 of 184 split across files; 47 fully independent reimplementations.**
Split pairs edited independently include CreateWindowEx (09a5 / `09a:4903`), MessageBox, CreateFont (`09a4:598` / 09a), TextOut, RegOpenKeyEx, CreateDialogParam (09a5 / `09a7:12572`). Of the within-file pairs, ~60 are byte-identical bodies differing only in a wide flag (e.g. `handle_CreateFileA` `09a:759` vs `W` `09a:7378`); 47 are independent reimplementations, including:
- **[BUG]** `SystemParametersInfoW` at `09a:6733` is a 6-line stub shadowing an 84-line A implementation at `09a:6739`.
- `RegisterClass{,Ex}{A,W}` is a 4-way ~30-line copy (`09a:4347/4308/4932/4960`).
- `GetModuleFileNameA` `09a:1473` vs `W` `09a:4869` write the same path-copy loop twice.
The codebase already has the right pattern — `LoadImageW` (`09a7:214`), `MapVirtualKeyW`, `SetWindowsHookW`, `AddAtomW`, `GetAtomNameW` are thin wrappers; `$crt_itoa` (`09a6:429`) takes a `$wide` param.
*Fix:* adopt the wide-flag-core pattern; co-locate each W next to its A; fix SystemParametersInfoW as a correctness bug.

**wsprintf formatter family cloned wholesale for wide chars.**
`src/12-wsprintf.wat:5-225` (`$write_uint/$write_int/$write_hex/$apply_pad/$wsprintf_impl`) vs `:227-520` (`*_w` twins) — the entire ~220-line formatter duplicated with only store-width changes. *Fix:* parameterize on wide as crt_itoa does; halves the file.

**~969 hand-written stdcall epilogues, 100% derivable from api_table.json.**
Every `$handle_*` ends with `esp += 4*(nargs+1)`; 749/750 checkable handlers use exactly that formula with `nargs` already present in `src/api_table.json` (the one exception, `handle_LoadLibraryExA` at `09a:630`, is deliberate delegation). Project memory confirms epilogue drift is a recurring bug class ("drift causes wild jumps later").
*Fix:* have `tools/gen_dispatch.js` emit the ESP adjustment in the generated br_table after each handler call, with an opt-out for EIP-redirecting handlers. Deletes ~969 lines and the entire bug class.

**Control paint duplication with drift (09c3-controls.wat, 14,840 lines, 228 funcs):**
- **[BUG]** Two check-glyph implementations: button `09c3:4540-4578` (12×12, pen strokes) vs `$lv_paint_check_box` `:5872-5901` (13×13, fill_rect loop). The comment at `:5868` says "compose them the way the BUTTON painter does" — yet doesn't. 12 vs 13 px is a visible mismatch.
- **[BUG]** `$edit_view_metrics` (`09c3:11591`) subtracts 16 for WS_HSCROLL (`:11602-11605`); the same 8-line block re-derived inline at `:12367-12388`, `:12930-12938`, `:13176-13184` does **not** → divergent scroll extents.
- Scrollbar paint: `$scrollbar_ctrl_wndproc` re-implements `$paint_vscrollbar_rect` (`:14277-14322`) inline at `:14746-14838` and disagrees on thumb width (helper full-width, wndproc insets 2px). The helper *is* shared correctly at 4 other sites plus treeview — this one path bypasses it. `09c4-defwndproc.wat:480` re-implements the same fill/edge drawing a third time; `09c3:10006/12689/14385` carry comments promising to match "the same arrow=16 / track=h-32 geometry" painted elsewhere. `track_len` is computed 3× inline (`:14344,14361,14528`) and differently in `$sb_track_len` (`:14389`).
- fill+3D-edge: 31 `host_gdi_draw_edge` sites; the 5-line fill+edge block verbatim at 8+ sites; the shared `$gdi_draw_edge_desc` (`10-helpers.wat:9032`) is bypassed by all 31.
- God functions: `edit_wndproc` (1,393 lines), `listview_wndproc` (1,311), `listbox_wndproc` (952), `toolbar_wndproc` (730), `combobox_wndproc` (714), `button_wndproc` (681) — 6 functions ≈ 40% of the file.
- Repeated geometry: `hdc = hwnd + 0x40000` hardcoded 24×; `ctrl_get_wh_packed` unpacked inline ~29–32× (~90 lines, no accessor); ListBox re-derives `visible=(h-4)/16` inline 5× while ListView has helpers.

**[BUG] Duplicate Win98 system palette, already drifted.**
`$gdi_chrome_sys_color` (`10-helpers.wat:8642`) vs `$win98_sys_color` (`:16398`) encode the same palette twice; the chrome copy lacks entries 21/23/24 (3DDKSHADOW/INFOTEXT/INFOBK), so chrome paths return `0xC0C0C0` for tooltip backgrounds where the sys-color path returns `0xE1FFFF`. *Fix:* delete the chrome variant.

**Width-triplicated shift helpers.** `$do_shift32/8/16` (`src/05-alu.wat:66-306`) are three ~80-line copies differing only in width constants/masks — flag-semantics fixes must be applied three times. ~45 decoder `emit_*` functions (`src/07-decoder.wat:319-739`) are ~9 identical lines each differing only in handler indices; could be one emitter taking a handler-id pair. Total realistic core consolidation ≈ 1–1.5k of 33.5k lines — the cost is drift risk more than size.

**mixer A/W clones.** `mixerGetLineControlsA/W` (`09a7:12339/12387`, 42 of 48 lines identical), `mixerGetControlDetailsA/W` (`:12435/12457`), `mixerGetLineInfoA/W`, `mixerGetDevCapsA/W` — ~90 duplicated lines.

### 2.2 JS host layer

**Process boot/lifecycle implemented three times, diverged.**
`test/run.js:2256-2431` (stage→load_pe→init_dx_com_thunks→set_exe_name→set_winver→DLL graph walk→VFS seed) + `:5505-5692` (COM-DLL/LoadLibrary yield handlers); `host.js:966-1012` + `:1180-1360` (same boot + `handleComDllLoad`/`handleLoadLibrary`); a third slice at `index.html:2447-2517`. Divergence is behavioral, not stylistic: the CLI walks the DLL dependency graph transitively (`run.js:2377-2391`) and auto-preloads the exe's directory into the VFS (`:2441-2460`); the browser resolves only EXE-level imports through a hard-coded `availableDlls` URL map (`index.html:2483-2512`) and needs explicit per-app `files` lists.
*Fix:* `lib/process-boot.js` (load exe, resolve/load DLLs, seed VFS, pump yield reasons) consumed by both hosts; each host supplies only a `fetchFile` callback.

**Per-app config and hacks live in three places, per-host divergent.**
`index.html:1427-1710` (apps registry incl. `startupRegistry`/`startupIni` — browser-only), `test/run.js:223-276` (`applyExeCompatibilityPatches`, QuickBlackjack byte patches — CLI-only), `run.js:1892-1901` (NSIS title-sniffing inside `set_window_text`), `run.js:5049-5104` (Winamp IPC injection), `host.js:88-179` (`_cleanupWinampVisualizerThread` poking hard-coded guest addresses 0x458060/0x4595ac — browser-only). The same app gets different fixes depending on host.
*Fix:* one per-app profile module (JSON + one applier in lib/) both hosts load; guest-memory hacks move into profiles or WAT compat handling.

**Triplicated wiring inside the hosts.** Worker-import factory (`run.js:2153-2238` vs `host.js:727-800`); thread-import wiring (`run.js:2047-2059` vs `host.js:553-571`); API-name log decode (`run.js:1354-1370` vs `host.js:321-339`); the `ctx._windowText` Map maintained in **three copies** (`run.js:1843-1907`, `host.js:440-474`, `lib/host-imports.js:2986-2989`); `check_input` has three implementations (`run.js:1926-1972`, `host.js:477-550`, stub at `host-imports.js:3549-3551`). Of run.js's 6.4k lines, roughly 5k is genuine harness (flags, tracing, input DSL, debug REPL, dumps — fine where it is) and ~1–1.5k is duplicated host lifecycle/wiring that belongs in lib/.

**index.html embeds ~2,000 lines of application logic.** Apps registry (`1427-1710`), launch orchestration incl. hwnd-base allocation and LAN lobby (`2380-2530`), the whole DOM→renderer input bridge `wireCanvasInput` (`1821-2230`), debug MIDI player, canvas resize policy, SAB/threads gating — none of it markup, none testable from Node. Script loading uses hand-bumped cache-busters `?v=168`…`?v=207` (`index.html:657-677`) with a matching hand-maintained `SOURCE_VERSION = '207'` in `host.js:5`.
*Fix:* `lib/browser-shell.js`, `lib/browser-input.js`, and an `apps.json` shared with the CLI.

**lib/host-imports.js is six subsystems in one 4.3k-line closure.** Audio mixer/voice manager/MCI+MIDI sequencer (`208-1950`, ~1,700 lines of a software audio stack), HRGN region model (`1952-2185`), drawing + window management (`2948-3556`), GDI presentation (`3558-3830`), VLAN (`2499-2530`), tracing (`3918-4320`). The `require`-vs-`window.*` dual-loading dance (`:26-29`) is the structural reason nothing splits out — but the split pattern already exists and works (dib.js, gdi-surface.js, api-format.js).
*Fix:* extract `host-audio.js` and `host-window.js` the same way; import names stay one flat namespace.

### 2.3 Tools

**~24 hand-copied PE header/section parsers; no `lib/pe.js` exists.**
18 tools plus 6 test files each independently do `readUInt32LE(0x3c)` → section-table walk → VA↔offset mapping: `xrefs.js:32-52`, `find-refs.js:37`, `find_string.js:26`, `find_fn.js:24`, `dump_va.js:24`, `find_bytes.js:60-70`, `file2va.js:23`, `pe-imports.js`, `pe-sections.js`, `pe-exports.js`, `parse-rsrc.js`, `find_field.js:40`, `find_vtable_calls.js:47`, `vtable_dump.js:27`, `scan_fn_bounds.js`, `disasm_fn.js`, `aoe-hot-block-report.js:53`, `superinstruction-census.js:32`, plus test/. Subtle fixes exist in exactly one copy each: only `xrefs.js:28-29` knows the Borland "CodeSeg flagged as data" rule; only `dump_va.js` marks BSS ranges. The other ~20 copies silently lack them.
*Fix:* `lib/pe.js` with `{sections, imageBase, va2off, off2va, isCode}`; each tool drops ~30 lines and inherits the fixes uniformly.

**Three overlapping 4-byte-literal scanners.** `xrefs.js`, `find-refs.js:7-13`, and `find_bytes.js --imm32` all scan the image for the LE literal; two of the three also independently scan rel32 branches. Their real differences are flag-level (section filtering, classification, `--base=` exists only in find-refs) — and the Borland rule has already diverged between them. *Fix:* one `refs.js` over `lib/pe.js` with `--kind=data|branch|imm`; keep old names as aliases.

**caller_census.js scrapes another tool's human stdout.** `tools/caller_census.js:52-60` spawns `xrefs.js` and regexes its formatted output (`/^\s+(0x…)\s+\[.+?\]\s+branch/`); any print-format tweak silently yields "0 callers found". The aoe-* family shows the right pattern (imports `scanFile` from superinstruction-census). *Fix:* export the xref scan as a function.

**Instruction-classification duplicated alongside the shared disassembler.** `disasmAt` is properly shared (9 importers), but classification (what opcode precedes this literal / what ModRM shape) is re-derived per tool with different opcode coverage: `xrefs.js` `classifyDataRef`, `find_field.js:80-138`, `find_vtable_calls.js`, `find-refs.js`. *Fix:* expose `classify(buf, off)` from disasm.js.

---

## Part 3 — Hand-maintained invariants with no build check

The most likely source of the *next* mystery bug. Ordered by risk.

**3.1 Two build manifests, zero consistency check — and the documented build is not the real build.**
The shipped wasm compiles from the hand-maintained 45-entry `WAT_FILES` array (`lib/compile-wat.js:6-22`) via `tools/build-compile-wat.js` (`build.sh:22`); the `src/*.wat` glob only feeds `build/combined.wat` (`build.sh:18-19`), used by debug tools (`func-index.js`, `check-parens.js`, `wasm-func-name.js`). A new src file lands in combined.wat — so grep and check-parens see it — while the real build silently omits it. This has already happened once (project memory "WAT_FILES registry"). No checker compares the glob to WAT_FILES anywhere. Additional hazard: glob order can diverge from WAT_FILES order, shifting function indices in combined.wat vs the real module — `wasm-func-name.js:9-11` works around this by re-reading WAT_FILES, but `func-index.js` trusts combined.wat. CLAUDE.md's build section is wrong on both counts ("concatenates `src/parts/*.wat` … compiles with wat2wasm" — the directory is `src/` and wat2wasm appears nowhere in build.sh).
*Fix:* assert set-equality between glob and WAT_FILES in `build-compile-wat.js`; generate combined.wat *from* WAT_FILES order; update CLAUDE.md.

**3.2 Generated files regenerate manually; no freshness gate.**
Three artifacts must stay in lockstep — `api_table.json`, `01b-api-hashes.generated.wat` (name→id), `09b2-dispatch-table.generated.wat` (id→handler) — but `build.sh:8-22` runs only check-handler-count, check-handler-esp, cat, compile; never `gen_dispatch.js`/`gen_api_table.js`. `tools/check-hash-table.js` exists and is wired nowhere. CLAUDE.md's add-an-API recipe omits `gen_api_table` entirely, so following the documented procedure leaves the hash table stale and the new API unfindable. (Currently in sync — 2,462 entries each, verified — but only by discipline.)
*Fix:* build.sh regenerates both (generation is deterministic and cheap), or at minimum runs check-hash-table.js.

**3.3 api_table.json id fragility; gen_api_table is a second source of truth that rewrites its own input.**
Ids are literally array position (`id == index` for all 2,462 entries, verified); `gen_api_table.js:1064-1076` renumbers on every run, so a mid-array insert rewrites thousands of lines and invalidates every compiled hash table — the append-only rule lives only in a memory note. Worse, `gen_api_table.js:44-1058` carries ~1,000 lines of embedded API definitions merged into the json it also reads, so "which is authoritative" depends on what was edited last. And the one structural invariant that matters at runtime — COM vtable methods contiguous per interface — is checked but only **warned** (`gen_dispatch.js:138-144` prints WARNING and keeps generating a broken table).
*Fix:* `check-api-table.js` in build.sh asserting `id === index` + append-only-vs-git-HEAD; promote the contiguity warning to `exit(1)`; long-term drop the stored `id` field.

**3.4 Ordinal-import strings addressed by hand-computed absolute offsets.**
`$system_ordinal_api_id` (`src/08b-dll-loader.wat:264-306`) maps ~40 ordinals to API ids via literal offsets (`0x1130C`, `0x11317`, …) into 01-header's data segment. Inserting or lengthening any earlier string silently shifts every later offset and breaks ordinal resolution at *runtime*. `tools/data_offsets.js --check` exists precisely to audit this but is manual-only.
*Fix:* run it as a build gate, or resolve these strings through the existing FNV hash table.

**3.5 14 slot-parallel window tables reset by a hand-written 13-call list.**
`src/09c-help.wat:65-78`. A new per-slot table not added there means stale state on slot reuse — silent, timing-dependent. *Fix:* a data-driven slot-reset registry (table base + stride pairs walked in a loop).

**3.6 Control-class identity implemented 3–4×; the authoritative id list exists only as a comment.**
`09c-help.wat:422-455` (packed LE dwords + atoms 0x0080–0x0085), `09a5-handlers-window.wat:336-400` (same → numeric ctrl ids 1..21 — the id mapping lives **only in the comment** at `:340-342`), a third resolver at `09a:5461`, and `$richedit_class_version` (`09c-help.wat:463`) as a fourth matcher. Consumers: `$ctrl_table_get_class` has 67 calls across 8 files. *Fix:* one `$class_name_to_ctrl_id` used by all.

**3.7 State-table encapsulation is inconsistent.**
The good news: table *bases* are always reached via globals (no bare `0x7000` literals), and WND_RECORDS is well-encapsulated — `$wnd_record_addr` (`09c-help.wat:21`) is the only `global.get $WND_RECORDS` site, field accessors used ~230×. The leaks:
- **SCROLL_TABLE: zero encapsulation** — 17 raw `base + slot*24` sites across 4 files (`09a:10637-10795`, `09c3:5522…14799`, `09c4:643`, `13-exports:3484-3500`), plus 5 SCROLL_AUX sites at a *different* stride (16) for the same slot.
- **CONTROL_TABLE: accessors exist and are re-implemented anyway** — `09a5:562` and `13-exports:3623` re-implement `$ctrl_table_set_id`/`get_id` (canonical at `09c3:571/560`); `09a:2207` is a third copy; 13 raw `slot*16` sites in 4 files.
- **The state struct is the real magic-number problem**: 481 raw `offset=N ($sw)` + 259 `offset=N ($state_w)` accesses over 19 distinct offsets with no named accessors (`offset=20` means "top index" in listbox, combobox, *and* edit).
- ~~**PAINT_SCRATCH**: one shared 16-byte RECT used at 136 sites in 7 files; the reentrancy hazard is acknowledged in a comment (`01-header.wat:1239`) and unenforced.~~ Fixed in `2c4ef73` — a ring of 16 rects handed out by `$paint_rect`/`$paint_scratch_take`, with `$wnd_send_message` bracketing the one place painting actually nests.

**3.8 Duplicated state / dual ownership.**
- Window rect has two owners: children in CONTROL_GEOM, top-levels in the JS host via `host_get_window_rect` — branch at `10-helpers.wat:15144-15158`; `renderer.windows` is a second window tree mirroring WND_RECORDS with sync seams both directions (`lib/host-imports.js:3477-3492` `sync_window_client`; `get_window_rect:3335-3400` prefers WAT exports for children, JS `win.x/y/w/h` for top-levels).
- Main-window geometry lives in globals parallel to WND_RECORDS: `$main_hwnd, $pending_wm_size, $main_win_cx/cy, $main_nc_height` (`01-header.wat:1767-1788`); `09a:11216-11231` fills CREATESTRUCT from them. Forks every code path into main-vs-other and adds per-thread propagation burden (per-instance globals!).
- EDIT scroll state stored twice (`state_w+20` then mirrored to SCROLL_TABLE via `$edit_publish_scroll_info` `09c3:11571-11584`); LISTVIEW same; WinHelp scroll is a third form (global `$help_scroll_y`, 20 sites in 4 files).
- GWL_STYLE's WS_VISIBLE synced with host visibility by promise-comments at `09a:3169` and `09a:3418`.

---

## Part 4 — Performance

### 4.1 Interpreter hot loop (every app, all the time)

**`$fast_msvc_sbh_scan` runs before every block dispatch, forever.**
`src/13-exports.wat:156` → `src/10-helpers.wat:163-235`. Per dispatched block: a `g2w(eip)`, ~17 memory loads and 16 compares against the byte signature of one specific MSVC small-block-heap loop — with no early-out (all 8 checks of variant 1 run, then all 8 of variant 2, via `local.set $match` instead of branching). At tens of millions of blocks/sec this is likely the single largest fixed tax in the outer loop, paid by every app whether or not it is MSVC-compiled.
*Fix:* the bytes are static code and decode already reads them — detect the pattern once in `$decode_block` and emit a dedicated handler opcode. Steady-state cost drops to zero.

**~15 debug conditionals per basic block in release mode.**
Every block ends by unwinding to `$run` (`$th_jmp`/`$th_jcc*`/`$th_ret` at `05-alu.wat:749-880` do not continue the tail-call chain), so per block the loop re-runs: watchpoint (`13-exports.wat:23`), yield_flag (30), bp compare (37), hit-counter loop head (50), two code16 checks (69, 99), a 4-way yield_reason OR (87), thunk-range check (110), two `dbg_prev` stores (136-137), trace_esp/trace_eip (139, 147), hist (154), the SBH scan (156), `cache_lookup` (158); plus `steps` reset to 1000 (165) and re-tested per instruction inside `$next` (`04-cache.wat:107-108`). With typical 5–10 instruction blocks, that's a large constant per instruction.
*Fix:* collapse the rarely-true flags into one `$any_debug` global tested once, cold-path the chain; longer-term, block chaining (patch the decoded successor pointer into the thread stream on first execution) lets unconditional jmp/fallthrough skip the outer loop and cache_lookup entirely.

**Memory-form ALU handlers re-dispatch decode-time constants at runtime.**
Register-register/immediate forms are specialized per opcode (`$th_add_r_r` etc., `05-alu.wat:378-440`) — but all memory forms funnel through generic handlers (`$th_alu_m32_r_ro`, … at `06-fpu.wat:1175-1243`) that per execution unpack the ALU op and walk the 7-branch chain in `$do_alu32` (`05-alu.wat:5-64`), plus 1–3 calls to `$get_reg`/`$set_reg`, each itself a 7-branch chain (`03-registers.wat:4-24`). A single `cmp [ebp+8], esi` costs ~7 calls and ~15 data-dependent branches for information the decoder knew statically.
*Fix:* specialize the hottest memory forms per-op (the handler table has headroom; the handler histogram at `04-cache.wat:135` can identify which); convert `$get_reg`/`$set_reg` to `br_table`.

**App-specific accelerations baked into the generic core.**
`$decode_block` special-cases two literal guest EIPs `0x0049D9D1`/`0x0049DD20` (`07-decoder.wat:771-784`, gated by `stack_packet_enabled`) — one binary's function addresses compiled into every app's decoder; the MSVC SBH scan is the same category by byte-signature. Neither is registered anywhere discoverable; a different build of the target exe silently stops matching.
*Fix:* a small data-driven table (addr → handler id) populated from JS at load; the WAT core stays app-agnostic.

**Secondary (measure before investing):** the 4,096-entry direct-mapped block cache (`01-header.wat:1546-1547`) collides at 16KB stride, and the arena-full policy wipes *all* decoded code (`13-exports.wat:18-21`, `04-cache.wat:69-77`) — apps with >4MB of hot decoded code pay periodic full re-decode. Check the `0xCA00F10F` overflow-marker frequency first.

### 4.2 Browser run loop

**The `setTimeout(step, 0)` chain hits the 4ms nested-timer clamp.**
`host.js:1560,1571,1576,1675`; no MessageChannel/postTask anywhere. Browsers clamp nested timers to ≥4ms after depth 5, capping the drive loop at ~250 steps/s; with the documented p50 step of 2.3ms the main thread idles >50% of each cycle.
*Fix:* drive the fast path with a MessageChannel port (unclamped macrotask, still yields to input/rAF); keep rAF for repaint coalescing. Probably the single biggest guest-throughput lever available.

**Repaint is scheduled unconditionally every step and is always a full-desktop composite.**
`host.js:1525-1527,1646-1648` → `renderer.js:1429-1433` (unconditional `scheduleRepaint`) → `_repaintOnce` (`renderer.js:1475-1576`): `Object.values(windows)` + filter + sort + per-window `_syncWindowStyle`, then full back-canvas blits — even for a fully idle app, at 60Hz, with per-frame garbage. Dirty knowledge already exists one layer down (`surface.takeDirtyRect()`, `host-imports.js:154`) and is discarded at the compositor.
*Fix:* renderer-level dirty flag set by the paths that mutate pixels/geometry; skip when clean; optionally clip composite to the union dirty rect.

**Per-call garbage in hot imports; per-step allocations.**
- `draw_text` constructs a **new TextDecoder per call** (`host-imports.js:2958`).
- 61 `new DataView`/`new Uint8Array` sites in host-imports despite fixed-size memory (`run.js:2038`: initial=maximum → a cached view never invalidates).
- `host.js:1438-1461` `_hasOpenMenu` builds a Set + array + calls a WASM export per instance **every step** with active threads.
- `host.js:477-530` `check_input` allocates closures per call on the GetMessage poll path.
- `run.js:1987-2035` installs trace shims on `get_window_rect`/`get_mouse_position`/`get_async_key_state` (games poll these hot) even when the flags are off — the `wrap`/`waveWrap` pattern already shows flag-gated installation.

**`logToUI` is quadratic DOM append on the input path.**
`host.js:579-586` does `el.textContent += msg` — re-materializes the entire unbounded log text and forces layout per call — fed by every non-mousemove input event (`:527`), every CreateWindow/SetWindowText (`:445,468`), and the `[run]` heartbeat (`:1543`). Long sessions degrade steadily. *Fix:* append text nodes / capped ring buffer; gate behind debug mode.

**Synchronous XHR on the browser main thread.** `host.js:263-271` — `xhr.open(..., false)` when the VFS misses; blocks the UI thread on a network round trip, invisible to the perf HUD's phase marks. The yield mechanism exists for exactly this (it's how DLL loading works). *Fix:* yield → async fetch → resume.

### 4.3 "All logic in WAT" violations (architecture + perf both)

`lib/host-imports.js` implements real Win32 semantics in JS: `get_window_related` implements GetWindow GW_* walks over `renderer.windows` (`3150-3199`); `arrange_windows` implements Cascade/Tile math (`3230-3310`); `move_window` carries SWP flag semantics, CW_USEDEFAULT policy, z-order policy, plus MFC class-name-specific clamps for `toolbarwindow32`/`afxcontrolbar42` (`3401-3475`, clamp duplicated in `set_parent:2975-2983`; the duplication is gone as of `4b9c952` — three renderer methods now — though the clamp itself is still JS policy); `renderer-input.js` decides modal blocking, dialog hit-tests, capture/focus routing (`951-1100`). Every geometry heuristic patch lands in JS because authority is split (see 3.8). `host.js:588-630` `_getVersionInfo` linear-scans 2MB of guest memory for `VS_VERSION_INFO` in JS — a scan, not a resource-tree walk, contradicting the resources-in-WAT principle. (Deleted in `f7f3401`: it had no caller at all, the About box having moved to `$create_about_dialog`.)
*Direction:* make WAT the single authority for geometry/z/visibility (exports already exist: `wnd_window_screen_x/y`, `wnd_screen_w/h`, `get_client_rect_wh`); shrink JS window records to canvas/back-canvas bookkeeping.

---

## Part 5 — Dispatch-layer inconsistencies

Five competing dispatch styles coexist:

1. The generated br_table (`09b2-dispatch-table.generated.wat:6`, pages `:52/:1084/:2116/:3148`) — the good one; all 364 `$handle_*` in 09a7 reachable, **zero orphans** against api_table.json.
2. Char-offset name-sniffing sub-dispatchers: `$dispatch_local` (name+5), `$dispatch_global` (name+6), `$dispatch_lstr` (name+4), `$dispatch_reg` (name+3) — `09a7:8/29/55/127`. Callers are already name-resolved stubs (`09a:4210-4234` etc.), so the table resolves the name and the sub-dispatcher re-parses the string — a redundant second layer with three different offsets. Documented cost: the Win16 bridge "has no name to give it" (`09e-win16-api.wat:360-365`) and so reimplements lstrcpy/lstrcat/lstrlen instead of bridging, while its neighbors cleanly call `$handle_GetPrivateProfileIntA`.
3. The `0xCACA00xx` continuation-thunk if/else chain, ~25 branches (`09b-dispatch.wat:23-730`) — fine, it's a different mechanism.
4. Hardcoded numeric api_id fast paths before the table: ids 490/491/470 = PeekMessageA/W, MsgWaitForMultipleObjects (`09b-dispatch.wat:786,800,812`) — raw positional ids with no guard in gen_dispatch.js, each re-duplicating the register-restore epilogue (`:794,806,833,851`). A silent break if ids ever renumber (see 3.3).
5. COM vtable→api_id arithmetic (`gen_dispatch.js:138-168`) — fine, and auto-computed.

Membership in style 2 is historical, not principled: all 6 wide `lstr*` are plain handlers while 6 ANSI ones route through `$dispatch_lstr`; `LocalSize` is plain but `GlobalSize` routed. Latent hazard: `$dispatch_global` keys on byte 6, aliasing GlobalAddAtomA↔GlobalAlloc and GlobalFindAtomA/GlobalFlags↔GlobalFree — safe today only because those happen to have separate handlers. And `GlobalCompact`'s branch (`09a7:52`) is unreachable (its handler crashes unimplemented).
*Fix order:* delete `$dispatch_reg` (dead, see Part 6); inline the 17 remaining sub-dispatch branches into their `$handle_*` and delete the three sub-dispatchers; emit named api_id constants from gen_dispatch.js for 09b's fast paths and factor the epilogue.

---

## Part 6 — Dead code

Confirmed zero call sites module-wide and not JS-exported (~160 lines, 10 functions):

| Function | Location | Note |
|---|---|---|
| `$dispatch_reg` | `09a7:127-150` | all 26 Reg* APIs have real handlers |
| `$ole_bindctx_bound_find` | `09a7:3026` | |
| `$post_queue_dequeue` | `09a:166` | leftover of the shared_post_queue refactor; siblings at `:185/:200` are live |
| `$create_stub_dialog` | `09c3:1691` | callers at `:1723/:1771` build their own |
| `$edit_wrapped_line_count` | `09c3:12028` | superseded by `:11614` |
| `$help_navigate` | `09c-help:1339` | |
| `$help_subslice` | `09c6:911` | |
| `$menu_first_selectable` | `09c5:2240` | |
| `$menu_subchild_shortcut_ptr/_len` | `09c5:783/795` | |

Plus `tools/check-hash-rt.js` (hardcodes obsolete address `0x01362000`, prints advice rather than checking anything). Careful negatives, verified live: `$stub_wndproc` (dispatch class 13), the `tab_native_*`/`statusbar_native_*` families (called from 09a5 and 10-helpers), the exported `menu_handle_*` functions (called by `lib/renderer-input.js:1019,1213,2200`), and `lib/canvas-compat.js` (18-line alias, kept for the filename).

---

## Part 7 — What's healthy (keep doing this)

- **String ops** (`05b-string-ops.wat`): bulk `memory.copy`/`fill` fast paths with correct contiguity/overlap guards.
- **WND_RECORDS**: single address-computation choke point, ~230 accessor uses. The model the other tables should copy.
- **`check-handler-count.js` / `check-handler-esp.js`**: real build gates, wired into build.sh, fail loudly. The model the other invariants should copy.
- **The generated dispatch**: zero orphans, COM start-ids auto-computed.
- **Tool-family sharing where it exists**: aoe-* imports `scanFile`; hlp-* shares `lib/hlp-parser.js` (hlp-dir.js's standalone parser is deliberate — it must read files the parser rejects); `disasmAt` shared by 9 tools.
- **skia-canvas removal is complete**: deps are `wabt` + `pngjs` only; `lib/raster-canvas.js` is the pure-JS surface.
- **The A/W wrapper pattern exists** (LoadImageW, crt_itoa, etc.) — it just needs to be applied to the other 47 pairs.

---

## Prioritized recommendations

**Tier 1 — build gates (an afternoon; closes the silent-drift category):**
1. Assert WAT_FILES ↔ `src/*.wat` glob set-equality in the build; generate combined.wat from WAT_FILES order. (§3.1)
2. Regenerate (or verify) `01b`/`09b2` from api_table.json in build.sh; wire in check-hash-table.js. (§3.2)
3. `check-api-table.js`: `id === index` + append-only vs git HEAD; promote gen_dispatch's COM-contiguity warning to a hard failure. (§3.3)
4. `data_offsets.js --check` on the ordinal-string offsets as a build gate. (§3.4)
5. Fix CLAUDE.md's build section (src/ not src/parts/; compile-wat.js not wat2wasm) and the add-an-API recipe; delete check-hash-rt.js. (§3.1, §3.2, §6)

**Tier 2 — mechanical deletions and generation (low risk, high payoff):**
6. Generate the ~969 ESP epilogues from api_table.json nargs. (§2.1)
7. Delete the 10 dead functions and the three name-sniffing sub-dispatchers; named api_id constants for 09b's fast paths. (§5, §6)
8. Fix the five confirmed divergence bugs: SystemParametersInfoW stub, edit WS_HSCROLL metrics, tooltip palette entries, 12/13px check glyph, GetMessageW's missing phases. (§2.1)

**Tier 3 — performance (measured levers):**
9. Browser: MessageChannel drive loop; dirty-flag repaint; cached TextDecoder/DataViews; event-driven `_hasOpenMenu`; async VFS-miss reads; ring-buffer logToUI. (§4.2)
10. Interpreter: move the MSVC-SBH scan to decode time; `$any_debug` gate for the per-block checks; then per-op specialization of hot memory-form ALU and br_table register access. (§4.1)

**Tier 4 — structural (do gradually, file moves are zero-risk here):**
11. Split the three mislabeled giants: 10-helpers → gdi-* files (+ move wordpad/menu tail), 09a7 → ole file, 09c-help → window-table file; rename the 249 `$host_gdi_*` non-imports; relocate 09a's GDI/comctl32/menu slabs and 06-fpu's non-FPU handlers. (§1)
12. Unify the A/W pumps around `$getmessage_core(wide)`; wide-flag the 47 independent A/W pairs and wsprintf. (§2.1)
13. Extract `lib/process-boot.js`, a shared per-app profile registry, `lib/browser-shell.js`/`browser-input.js`; split host-audio/host-window out of host-imports.js. (§2.2)
14. Accessor layer for SCROLL_TABLE + named state-struct offsets; data-driven slot-reset registry; single control-class id table; move main-window geometry into WND_RECORDS. (§3.5–3.8)
15. Longer arc: single geometry/z/visibility authority in WAT; JS window records shrink to canvas bookkeeping. (§4.3)

---

## Status — what was acted on

*Updated 2026-08-18 after a pass over this review. Commit hashes are on `main`;
a few unrelated commits from a parallel session are interleaved in the log.*

**Done**

| § | Item | Commit |
|---|---|---|
| 3.1–3.4, 6 | All four missing build gates (WAT_FILES↔glob, api_table id/append-only, generated-dispatch freshness, hash table, ordinal data strings); COM-contiguity warning promoted to fatal; `check-hash-rt.js` deleted; CLAUDE.md build section and add-an-API recipe corrected | `5ac7943` |
| 2.1 | SystemParametersInfoW stub (+ the A path's NONCLIENTMETRICS layout, which placed five LOGFONTs inside each other), 12/13px check box, edit WS_HSCROLL metrics, duplicated Win98 palette | `0652b8a` |
| 5, 6 | `$dispatch_local/global/lstr` deleted, 17 handlers given their own bodies; 10 dead functions removed; new `tools/wat-func.js`. Exposed a wrong `nargs` for GlobalSize in api_table.json | `964df31` |
| 4.1 | MSVC-SBH scan moved to decode time; six per-block debug flags behind one `$dbg_any`; br_table for `$get_reg`/`$set_reg`/`$do_alu32`; the two hardcoded guest EIPs out of `$decode_block` | `f7f719f`, `6a9a229`, `55b637d` |
| 4.2 | MessageChannel drive loop (the 4ms nested-timer clamp), dirty-gated repaint, cached TextDecoder, ring-buffer `logToUI`, cached `_hasOpenMenu`, memoized VFS-miss fetch, flag-gated trace shims in run.js | `b724a89` |
| 2.3 | `lib/pe.js` — one PE reader for 17 tools, carrying the Borland code-section rule and BSS marking that each lived in one copy; `scanXrefs()` exported so `caller_census.js` stops parsing printed output | `5ed4e2e` |
| 1 | `10-helpers.wat` → four `10*-gdi-*.wat` files; `09a7` → `09a7b-ole.wat` + `09a7c-mixer.wat`; `09c-help` → `09c0-window-table.wat`; `06-fpu`'s non-FPU handlers → `06b-core-handlers.wat`; 09a's comctl32 slab → `09a9-comctl32.wat`. New `tools/wat-split.js` | `1c75b2f`, `661b8c1`, `6eb9ece`, `430d3ed` |
| 2.1 | wsprintf: one formatter parameterized on `$wide`, 520 → 290 lines | `9a9987a` |
| 2.1 | The W message pump deleted — GetMessageW/PeekMessageW/DispatchMessageW were stale forks missing WM_NCPAINT, the VLAN pump, timers, the post queue, and status-bar/tab dispatch | `75bf280` |
| 2.1 | The independent A/W pairs, in two batches, measured by the new `tools/aw-census.js`: 184 pairs went DIVERGENT 35 / STUB 6 → DIVERGENT 4 / BOTH_STUB 1, with 52 pairs now delegating and 127 sharing a `$wide`-parameterized core. Drift found on the way: PostMessageW was stale, WriteConsoleA wrote to the console buffer's *old* addresses, the ANSI `lstr*` family was NULL-unsafe, GetShortPathNameA ignored the VFS, DrawStatusTextW drew nothing, GetVersionExW hardcoded Win98, and SetEnvironmentVariableA was a crash stub (the environment APIs now share one real block). The 5 pairs left are not duplication: separate ANSI and wide command lines, wsprintf's two entry points over one `_x` formatter, RegisterClipboardFormatW narrowing into the A helper, and IsBadStringPtrA/W as a deliberate fail-fast pair | `aaf8af5`, `c57666b` |
| 3.7 | PAINT_SCRATCH is a ring of 16 rects instead of one shared RECT, converted at all ~136 sites in 8 files; `$wnd_send_message` marks/resets around the nesting point. Two bugs found on the way: the statusbar caption guard ANDed a pointer with a length, and two sites wrote past the end of the shared rect into MENU_DATA_TABLE. Auditing the map for a free address then turned up three live overlaps — WND_CLASS_SLOT_TABLE on the WSOCK32 ordinal-import names, CLASS_EXTRA_TABLE on DI_DIK_VK_TABLE, and the Win16 EnumFonts faces on the oleaut32 ordinal names — each caused by picking an address from 01-header's map while the colliding table was declared in the file that uses it | `2c4ef73`, `8860cdb`, `3c6e302` |
| 3.5, 3.7 | SCROLL_TABLE/SCROLL_AUX accessors; one `$wnd_slot_reset` — which turned out to be missing four tables, so a recycled slot inherited scroll range, flash and maximized state | `0b6fa45`, `5c59649` |
| 3.7 | The last sites that still open-coded a table stride: the six Set/Get Scroll{Pos,Range,Info} handlers multiplied the slot by 24 (record) or 16 (SCROLLINFO aux) by hand — two different strides over the same slot index, which is the exact way that arithmetic goes wrong — and `$ctrl_table_reset_slot` did its own `slot * 8` into CONTROL_GEOM. All now call `$scroll_bar_addr` / `$scroll_aux_bar_addr` / `$ctrl_geom_addr` | `1675bea` |
| 3.7 | ButtonState's fields named: `$btn_text_ptr/_len`, `$btn_flags`, `$btn_ctrl_id`, `$btn_image_*` and `$btn_drawitem_guest` for the embedded owner-draw scratch, with the wndproc's 18 message cases, the three sibling-default walkers, `$ctrl_get/set_check_state` and the three JS-facing exports in `13-exports.wat` reading through them instead of bare `offset=8`. Every class puts something different at each offset, so a bare offset mid-file named nothing | `ad9b3de` |
| 3.7 | Three more classes named: StaticState (read by both the static and the SysLink wndproc, which allocate the same 16-byte layout — invisible while both spelled `offset=8`), ProgressState with `$prog_state_init`/`$prog_clamp` for the duplicated default-init and the range clamp five PBM_* handlers open-coded, and TrackBarState, whose min/max/pos sit on the same three offsets as ProgressState with a different total length. Found on the way: SysLink's WM_GETTEXT guarded its copy with `i32.and(text_ptr, len != 0)`, and an aligned heap pointer ANDed with a 0/1 predicate is always false, so it returned a length and wrote nothing | `92217e4` |
| 3.7 | The three big classes named, closing the per-class half except for EditState (held by a parallel session): ListBoxState, ComboBoxState — whose drop-down list is a second window with its own state — and ListViewState, whose columns, items and subitems are three strides over one block | `4682d5a`, `da4a7ac`, `f3d2f45` |
| 3.8 | Window show state had two owners and no guest-facing one: the renderer's `win._minimized/_maximized` composited, WAT's MAX_TABLE drew the caption glyph, and IsIconic/IsZoomed returned 0 while GetWindowPlacement reported SW_SHOWNORMAL and SetWindowPlacement dropped showCmd. MAX_TABLE becomes SHOW_STATE_TABLE with an independent minimized bit (a maximized window that is minimized comes back maximized), and one `$wnd_apply_show_state` SW_* fold serves ShowWindow, WM_SYSCOMMAND and SetWindowPlacement. `host-window.js`'s `sys_command` was a drifted second copy of the JS transition table and now delegates to `renderer.showWindow`, which did not handle SW_SHOWMINIMIZED at all | `1ba6a38` |
| 4.3 | `host.js`'s `_getVersionInfo` — 44 lines that walked 2MB of guest memory two bytes at a time looking for the UTF-16 `VS_VERSION_INFO`, then walked it again per field name. A byte scan rather than a resource-tree walk, and dead: the About box has been WAT-side (`$handle_ShellAboutA` → `$create_about_dialog`) since before it stopped being called, and `h.shell_about` only logs | `f7f3401` |
| 4.3 | The MFC toolbar width clamp, written out longhand at five sites in two files (`set_parent`, `move_window` twice, `sync_window_client`, both branches of `_computeClientRect`) and already drifted in which copies recomputed the client rect. Now `_toolbarWidthLimit`/`_clampToolbarWidth`/`_clampToolbarClientWidth` on the renderer, beside the geometry they act on. The clamp exists because MFC caches a toolbar's ideal button span and then moves the child with SWP_NOSIZE — WordPad's formatting toolbar is 1512px wide inside a 394px frame | `4b9c952` |
| 3.6 | `$class_name_to_ctrl_id` in `09c0-window-table.wat` — one resolver for "which built-in control is this class name". CreateWindowExA, GetClassInfo and the class-hash path each answered it separately and could disagree about what "SysLink" is; USER's six now resolve through their atom first, as Windows does, and the comctl32/riched names stay string compares in one place | `da03204` |
| 2.2 | `renderer.takeInput(owns)` and `inputEventHwnd` — one queue dequeue and one "which window is this for" rule instead of three and two. The browser host's own dequeue had lost `_asyncPressedKeys`, so GetAsyncKeyState's press bit never fired for events it took, and its multi-app branch skipped the WM_PAINT repaint as well | `6869a72` |
| 2.1 | One `$paint_sb_thumb` for both scrollbar painters (the control inset its thumb 2px, the shared painter did not); `$ctrl_get_w`/`$ctrl_get_h` | `83fef1b`, `7ddc9fa` |
| 2.2 | `lib/dll-registry.js` — one loadable-DLL list; the browser's copy had 14 names to the CLI's 32; window-title bookkeeping collapsed from three copies to one | `125e25d`, `53b4e4e` |
| 2.2 | `lib/process-boot.js` — one `resolveDllGraph()` for both hosts, each supplying only a `loadSpec` callback (readFileSync over the search dirs / fetch over the URL map). The browser resolved EXE-level imports only, so Kodak Imaging's IMGCMN → OIFIL400 → siblings chain loaded headless and trapped in the page on the first cross-DLL ordinal; it now also walks its per-app `dlls` seeds and finds app-local dependencies in the app's own `files` list | `b1c5e45` |
| 2.2 | `stageAndLoadPe`/`setExeName`/`setExtraCmdline` in `lib/process-boot.js` — each host had its own transcription of the staging clamp that keeps an installer's appended archive off the API hash table | `ea8be43` |
| 2.2 | `THREAD_EXIT_HOOKS` in `lib/app-profiles.js` — Winamp's visualizer-thread cleanup poked hard-coded guest addresses from `host.js`, so it ran in the browser and never headless; both hosts now run it | `8f30fa8` |
| 2.2 | `lib/app-profiles.js` — one per-app compat patch table; QuickBlackjack's three byte patches existed twice (`run.js` and `host.js`), so a patch only ever landed in whichever host was being debugged. `test/test-qblackjack-web.js` now covers the browser side, which nothing did | `9278133` |
| 2.2 | `lib/host-audio.js` — the mixer/voice/waveIn/MIDI/MCI half of the 4.3k-line `createHostImports` closure, behind a `createAudioHost(ctx, shared)` factory whose import entries are spread back into the same flat namespace. The seam is five helpers and one `getHost()` thunk; `lib/host-imports.js` is 4,347 → 2,578 lines | `5950986` |
| 2.2 | `lib/host-window.js` — the window/scrollbar/capture/cursor/input imports, same shape. `lib/host-imports.js` is 4,347 → 1,975 lines across both cuts, and what remains is GDI | `49d2c9b` |
| 2.2 | `lib/apps.js` — the app registry (118 entries + the desktop icon list) out of index.html, which drops 752 lines of it, and `test/run.js --app=<id>` so the CLI mounts exactly what the icon mounts: exe, DLL seeds, data files at their real VFS paths, command line. `tools/check-apps-registry.js` gates the paths | `7f55b29`, `6590806` |
| 2.2 | `lib/browser-input.js` — the 380-line DOM→renderer input bridge out of index.html, `runningApps`/`DEBUG_MODE` passed in as deps, the wired-once latch exposed as `browserInput.isWired()` for the pre-launch icon handlers | `760b79f` |
| 2.2 | `lib/browser-shell.js` — the process lifecycle (launch, stop, tab-local LAN join, run-slice policy, startup-dialog dismissal) out of index.html, behind `createBrowserShell(deps)` taking only the four page-owned things plus an `onStopAll()` hook. index.html: 2,671 → 1,225 lines over the arc | `e58b93a` |
| 2.2 | `handleLoadLibraryYield`/`handleComDllYield` in `lib/process-boot.js` — the two runtime-DLL yield pumps, behind a `findDll` callback so each host keeps only its own idea of where bytes come from. The browser's COM copy passed its log function in `patchExeImports`' `dlls` slot (per-DLL matching never ran), and only the CLI looked in the VFS, so a plugin the app had mounted was found by LoadLibrary and missing for CoCreateInstance | `1310435` |
| — | Extras this pass earned: the build now validates the wasm with `WebAssembly.Module` (it was shipping modules that failed to instantiate), `check-handler-esp` reads every part instead of ten named files, and `test/run-all.sh` runs a tier N-at-a-time | `83fef1b`, `f93ebba`, `dc37c8d` |

**The three I first declined, then did**

- **09a's scattered GDI and menu handlers (§1.4).** Declined because they could
  not be moved as a range; that was a tool limitation. `wat-split.js --names=`
  moves a set in one pass, so all 35 menu handlers went to `09c5-menu.wat` and
  all 116 GDI handlers to `09a4-handlers-gdi.wat` (`185afb3`). 09a-handlers.wat:
  12,940 → 11,012 lines.
- **`$do_shift32/16/8` (§2.1).** Declined because the three differ in
  sign-extension, rotate-modulo and RCL/RCR carry width. They are now one
  `$do_shift(bits, …)`, merged under a differential test: the originals were
  kept as `_ref` copies and every one of 29,376 (width, op, value, count,
  carry) combinations was compared on result *and* CF/ZF/SF before the copies
  were deleted. `test/test-shift-equivalence.js` keeps the coverage against an
  independent model (`747ddd1`).
- **Generating the ~969 epilogues (§2.1).** Done, but *into the handler*, not
  into the dispatch table (`a33f44a`). The caller-side version was implemented
  and backed out after it broke WordPad and TWorld; the four reasons are in
  that commit and in `tools/esp-epilogue.js`. The last one is worth repeating:
  with 113 of the "provably simple" handlers converted WordPad crashes in
  HeapAlloc, with 112 it does not, and the 113th is safe on its own. Static
  shape does not predict it. `--check` now verifies all 1,325 epilogue lines
  against `nargs` in the build, and `--sync` rewrites drift.

- **The corpus PASS count flapping between runs (bug, found during this
  work).** Two causes, both fixed. A run killed by the wall-clock backstop
  exits by *signal*, so `result.status` is `null` rather than non-zero and the
  case fell through to the success path — where the pixel gate is skipped
  because the PNG was never written. A *slower* box therefore passed more apps.
  Second, the load factor scaling those backstops was computed once at module
  load, and a sweep takes twenty minutes on a box that moved 23.9 → 28.9 →
  16.3 → 8.6 within one hour, so late cases were budgeted against a machine
  that no longer existed. It is now sampled per case at spawn, a timeout
  retries once at double budget rather than being reported as a verdict, and
  every run prints the cases whose result depended on finishing in time — an
  empty list is the claim that the count means something (`28e5830`).

- **The worker/thread import wiring (§2.2).** `lib/worker-imports.js` now
  states what a thread inherits from its process, and both hosts read it
  (`5f8cbf3`). The review read the `_waveStats`/`audioStatsStride` vs
  `sharedMixer` split as an unmade decision; it is not. `host-audio.js:27`
  falls back from `sharedMixer` to `sharedAudio`, so the CLI already had mixer
  sharing, and the browser needs its own object only because several apps play
  audio in one page. The list is what *may* cross, so both hosts stay correct.
  What was worth catching is the other half: the twelve thread and sync
  imports are return-0 stubs in `host-imports.js` so the import shape is always
  complete, which means a host that misses one hands the guest a wait that
  never waited and returns success. Adopting a name the main table does not
  implement now throws.

- **The VFS-seed tail, which closes §2.2.** Two of the seeding rules are not
  about where bytes come from — they are things the *guest* believes — and each
  had a copy in both hosts: an image must be findable at `c:\app.exe` (what
  `GetModuleFileNameA` reports regardless of the real filename) *and* under its
  own basename; and a Win16 module name can live on disk as `NAME.DLL`,
  `NAME.dll` or `NAME.EXE`. `lib/vfs-seed.js` states both once and
  `test/test-vfs-seed.js` asserts neither host has re-inlined them (`a43be3a`).
  The rest stays two implementations on purpose: the CLI indexes a directory
  lazily and HTTP has no readdir, so there is no shared mechanism there.

  With that, §2.2 is done: `host-audio`, `host-window`, `browser-input`,
  `browser-shell`, `app-profiles`, `worker-imports`, `debug-midi`, `vfs-seed`,
  the shared apps registry, `resolveDllGraph`, `stageAndLoadPe` and both DLL
  yield pumps. index.html is 1,136 lines, down from 2,671, and holds no
  application logic.

- **The synchronous VFS-miss read (§4.2).** A file no app-registry entry
  listed was fetched with a *synchronous* `XMLHttpRequest` on the page's main
  thread, so the tab froze for a whole network round trip — and invisibly,
  because the stall was inside a host import rather than a phase the perf HUD
  marks. The old comment (and this review) called yield-and-resume the real
  fix; it turned out none is needed. Only two callers can reach a miss, and
  neither needs the bytes in the same turn: a wallpaper may appear a beat late
  without any caller noticing, and real MCI is free to still be preparing a
  device when `open` returns — so the sequencer opens, the SMF attaches when
  it lands, and a `play` issued in between is remembered rather than dropped.
  The miss is now an off-thread fetch that mounts its result, hits and 404s
  both still remembered. The CLI, whose VFS is a real directory and where a
  miss is final, is byte-identical (`bdef7d3`).

- **The main-window geometry globals (§3.8, second bullet).** Read out, the
  dual ownership was not the interesting part: `$main_win_cx`, `$main_win_cy`
  and `$main_nc_height` were *write-only*. `nc_height` was assigned once and
  read nowhere; `cx`/`cy` were read only by `nc_height`'s own assignment and
  by two exports no JS calls. There was no second owner of the geometry to
  reconcile — only three globals to delete, and with them three values every
  thread spawn had to carry. What does the work stays: CreateWindowExA asks
  `$defwndproc_do_nccalcsize` and seeds `$pending_wm_size` from the resulting
  client rect, and MoveWindow refreshes it through
  `$host_get_window_client_size` — both read the real rect, which is why the
  mirror was dead (`18dd07b`).

**Still open**

- §3.7 named accessors for the *remaining* per-class state structs. The
  offsets mean different things per class, so this is a per-class job, not one
  rename, and ButtonState is the first class done (`ad9b3de`): text ptr/len,
  flags, ctrl_id, image type/handle and the embedded owner-draw
  DRAWITEMSTRUCT, with the wndproc, the three sibling-default walkers,
  `$ctrl_get/set_check_state` and the three JS-facing exports all reading
  through them. StaticState (shared with SysLink), ProgressState and
  TrackBarState followed in `92217e4`, then the three big ones: ListBoxState
  (`4682d5a`), ComboBoxState (`da4a7ac`) and ListViewState (`f3d2f45`). Only
  EditState is left, and it is held by a parallel session that owns
  `$edit_wndproc`.
  The table-level half is finished: the CONTROL_TABLE row is `$ctrl_slot_addr`
  plus documented field offsets, GetDlgCtrlID and the exported `ctrl_get_id`
  stopped re-implementing `$ctrl_table_get_id` (`f0ac4b6`), and the six
  Set/Get Scroll{Pos,Range,Info} handlers that still open-coded both scroll
  strides — 24 for the legacy record, 16 for the SCROLLINFO fields — now call
  `$scroll_bar_addr` / `$scroll_aux_bar_addr` (`1675bea`), and PAINT_SCRATCH is
  now a ring rather than one shared rect (`2c4ef73`).
- §3.8's remaining bullets and §4.3, the dual-ownership and JS-authority arcs
  — window rect owned by CONTROL_GEOM for children and by the JS host for
  top-levels, the EDIT/LISTVIEW/WinHelp scroll state stored twice. These are
  real second owners, unlike the geometry globals, and multi-session. One of
  them is closed: show state (`1ba6a38`), which was the worst of the set
  because the second owner was not merely redundant — the guest-facing half
  did not exist at all, so IsIconic and IsZoomed answered with a constant.

**Declined, with reasons**

- **The "still-CLI-only per-app hacks" (§2.2).** The NSIS title sniffing in
  `run.js:1983-2034` and the Winamp IPC injection at `:852-857` are not host
  divergence: the first gates *injected* input off while an installer copies
  files, and the second is a pair of `--input=` DSL verbs. Both exist because
  the CLI has no hands. A browser user clicks, so porting them would mean
  giving the page a scripted-input DSL with no caller.
