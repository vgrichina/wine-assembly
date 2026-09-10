# Heroes of Might and Magic II (demo)

`test/binaries/candidates/heroes-2-demo/files/H2DEMOW.EXE`, registry id
`heroes2_demo` (`lib/apps.js`). Reaches the adventure map headlessly — see
*Reproduction* below.

This app is the reference workload for the interpreter dispatch work
(`docs/interpreter-dispatch-perf.md`, `docs/loop-idiom-superops-design.md`).
Most of the fusions in `src/06b-core-handlers.wat` and `src/07-decoder.wat`
name it in their comments. These notes say what the cited addresses actually
*do*, so the next person does not disassemble them again.

## Idle menu CPU / interleaved clock contexts (2026-09-10, local fix)

Production298 main menu measured107% renderer CPU (one core); isolated303
with the Rodent/modal/blocked-helper fixes still108%. The actual player-turn
adventure map is22.5%, screenshot-verified after NEW GAME / STANDARD / OKAY.
Do not exclude the menu: the user explicitly wants it fixed too.

An uninstrumented10s menu sample had clock parks44 ->44 and peek parks0 ->0.
Subsequent500ms API tracing counted39,201 GetTickCount,3,709 PeekMessageA,
159 TranslateMessage/DispatchMessage pairs,107 each QueryPerformanceCounter /
SuspendThread / ResumeThread, but only2 DirectDrawSurface_Blt and2 Lock/Unlock
pairs. Counts are from instrumented execution, not an unperturbed rate.

The hottest block family is the clock wrapper `0x45c9fa`:
`call [0x52b4ec]` calls GetTickCount; return PC `0x45ca06`. Its timed idle
service `0x45dbb0` tests deadlines at globals0x519548(+13ms),0x51954c
(+110ms in some modes) and0x519544(+30ms). Most visits take no-work branches.

Root cause is **alternating stack contexts**, not a clock API missing from
the detector. Actual trace at0x45ca06 shows this repeated cycle within the
same guest millisecond (ESP quoted after the API has returned):

```
ESP074ffca8: callers45dbd7,45dc0f,45dcb4          counts1,2,3
ESP074ffca0: callers45dbd7,45dc0f,45dcb4,467f37   counts1,2,3,4
ESP074ffcd8: callers45dbd7,45dc0f,45dcb4          counts1,2,3
ESP074ffcb8: caller45c1e2                       count1
repeat
```

The old `$clock_spin_step` remembers only the immediately previous return-PC/ESP
pair, so each depth change resets its count; none reaches K=8. The common
wrapper makes the API return PC identical, but the ESP guard still resets it.
Local304 retains four bounded per-instance MRU contexts, keyed by return-PC/ESP.
Each context independently needs K reads of the same clock value with no real
API activity. The active scalar state has three alternate i64-packed histories;
eviction only loses proof. The one-park-per-millisecond latch remains shared
across contexts. No guest addresses, Heroes policy, shared regions or clock
delay defaults changed. `test-clock-spin-contexts.js` covers interleaving without
pooled counts, eviction, time/activity changes, intact ABI and independent WASM
instances sharing memory; existing 43 clock-park tests also pass.

Headless renderer CPU falls from108% to13.68% in the menu and22.51% to7.36%
on the actual map. Menu parks now grow1111 ->3459 in10s (235 wakes/s).
Visible/headful Chrome at load3.42 measures **16.15% renderer** vs **0.005%**
on a blank page in the same browser. This is a major improvement, **not final
idle acceptance**. Residual profiling shows scheduling, palette presentation
and guest execution, rather than a single saturated loop. An experimental
per-page8ms clock-park delay gives12.08% headful renderer; not applied to source
because longer delays need cadence/input evidence and are not a complete fix.

A headful production298 confirmation gives105.59% renderer and zero new clock
parks in10s (host load7.73, so use as saturation evidence, not a precise speedup
ratio). Local304 repeats at14.99%, 2334 parks/10s. A separate3s DX census sees
15 palette updates, all changing RGB after the initial sample, and11 each
Lock/Unlock/Blt,26 presents. The palette changes19 entries (214..221,
231..241); therefore an identical-palette fast path would not fix this menu.
The menu has subtle real animation despite looking static. Do not freeze its
palette or drop writes based on sampled pixels to reduce the CPU number.

Evidence harness `/private/tmp/audit-idle-games.js`; JSON/PNG directories
`/private/tmp/wa-idle-heroes-menu`, `wa-idle-heroes-clock-sites`, and
`wa-idle-heroes-map`. The clock-site trace records160 samples including ESP,
outer caller, returned clock and detector count. Post-fix evidence:
`wa-idle-heroes-headful304`, `wa-idle-heroes-residual304`, `wa-idle-heroes-park8`.
These changes are local only, not deployed.

## Modules and address arithmetic

`H2DEMOW.EXE` is not relocated: `imageBase = 0x400000` and it loads there, so
**runtime VA == file VA** for everything in the exe. Two DLLs are, and are not:

| Module | Runtime base | origBase | runtime → orig |
|---|---|---|---|
| `H2DEMOW.EXE` | `0x400000` | `0x400000` | identity |
| `MSS32.DLL` (Miles Sound System) | `0x541000` | `0x20000000` | `+0x1FABF000` |
| `SMACKW32.DLL` | `0x569000` | `0x400000` | `-0x169000` |

So a profile address of `0x0054eae8` is `MSS32.DLL 0x2000dae8`. `tools/*.js`
take `module+0xORIG_VA` directly (`--count=mss32+0x2000dae8`).

Sections: `.text 0x401000..0x4df412`, `.rdata 0x4e0000`, `.data 0x4e2000..0x52a6c0`
(90816 bytes BSS), `.idata 0x52b000`, `.rsrc 0x52d000`.

Command line carries `/R0` (added by the registry entry).

## Reproduction

```bash
node test/run.js --app=heroes2_demo --batch-size=20000 --max-batches=2600 \
  --repaint-every=50 --quiet-api \
  --input='400:click:535:225,700:click:528:68,1200:click:283:373' \
  --png=/tmp/h2.png
```

`NEW GAME` → `STANDARD GAME` → `OKAY` on the scenario picker (Broken Alliance).
Plain `click` works — Heroes II takes the down/up pair out of one PeekMessage
pass, unlike Caesar III (see `feedback_mousedown_gap_mouseup`).

**Batches 1400..2600 is the gameplay window.** Everything below was measured in
it. A run that stops at the menu exercises none of the 640x480x8 DirectDraw
primary, the per-frame palette rebuild, or the Miles mixer.

Profiling commands:

```bash
# deterministic, load-immune: counts, not milliseconds
node test/run.js --app=heroes2_demo ... --handler-hist-thread=0 \
  --handler-hist-start=1400 --handler-hist-stop=2600
# self time (needs --repaint-every=50, see the trap below)
node --cpu-prof --cpu-prof-dir=/tmp/prof test/run.js --app=heroes2_demo ...
node tools/cpuprof-top.js /tmp/prof/*.cpuprofile 20
node tools/func-index.js 320        # resolve wasm-function[N]
```

## Named addresses

### `0x004c7260` — the ICN sprite decoder. The hot function.

Its blocks are **~20% of all dispatches** in the gameplay window and hold the
single hottest block in the profile (`0x004c7341`, 4.98%).

It is a byte-code interpreter over a compressed sprite stream, and the thing
that matters for us is how it holds its instruction pointer:

```asm
004c7341  xor  eax, eax                    ; <- hottest block in the app
004c7343  mov  ecx, [0x525d80]             ; cursor is a GLOBAL, not a register
004c7349  inc  ecx
004c734a  mov  [0x525d80], ecx             ; ...written back every single byte
004c7350  mov  al, [ecx-0x1]               ; the fetched command byte
004c7353  test al, al
004c7355  jge  0x4c7651                    ; sign clear -> literal run
004c735b  test al, 0x40
004c735d  jnz  short 0x4c737d
```

That five-instruction fetch is repeated verbatim at `0x4c7392`, `0x4c73a3`,
`0x4c73bc`, `0x4c73d5` — the decoder is *written entirely out of this idiom*,
which is what `src/06b-core-handlers.wat:632` means. `$th_ptrvar_fetch8`
(H403) is the fusion of exactly this, and the pair `H18->H403`
(`xor r,r` → ptrvar fetch) is the top adjacent pair in the profile at 1.78%.

Command byte encoding, as the branches read it:

| Test | Meaning |
|---|---|
| `al >= 0` (sign clear) | literal run, length `al` → `0x4c7651` |
| `al & 0x3f == 0` after `test al,0x40` clear | end / long form → `0x4c7746` |
| `al & 0x40` set | transform run, sub-decoded at `0x4c737d` |
| `al == 0xc1` | length follows in the next stream byte |
| `al & 0x80` with `[esp+0x34]` set | shadow/alpha path → `0x4c750e` |

Three terminal loops hang off it, and they are very different animals:

**`0x004c7700` — literal run. Already optimal.**
```asm
004c7700  mov  ecx, edx / shr ecx,2 / rep movsd
004c7707  mov  ecx, edx / and ecx,3 / rep movsb
```
A `rep movs` pair, not a byte loop. **This is why COPY_RUN was never worth
anything on Heroes II** — the copy the loop-idiom matcher was built to lower
does not exist here; the app already uses the string instruction, which
`src/05b-string-ops.wat` handles in bulk.

**`0x004c755d` — the shadow blit. This is LUT_RUN's real target.**
```asm
004c7521  and  eax, 0x3c
004c7528  shl  eax, 0x6
004c752d  lea  ecx, [eax+0x4e9348]         ; table = 0x4e9348 + (cmd & 0x3c)*64
...
004c755d  xor  eax, eax
004c755f  inc  esi
004c7560  mov  al, [esi-0x1]               ; read destination pixel
004c7563  mov  [0x525d94], esi             ; cursor spilled to a global, per byte
004c7569  dec  edx
004c756a  mov  [0x525d88], ecx             ; table pointer spilled too, per byte
004c7570  mov  al, [eax+ecx]               ; table[pixel]
004c7573  mov  [esi-0x1], al               ; write it back in place
004c7576  jnz  short 0x4c755d
```
`dst[i] = table[dst[i]]` in place, table selected by four bits of the command
byte out of an array of 64-byte tables at `0x4e9348`. Section 1.3 of the
loop-idiom design calls `0x004c755d` "Heroes II's shadow blit"; this is it.
Note the two stores to globals **inside** the loop body (`0x525d94`,
`0x525d88`) — the compiler spilled both live pointers to memory every
iteration, which is free instruction count for us to remove but is also why
the body is 8 ops rather than 4.

`0x004c7607` is a separate entry into the same tail (literal-run fast path,
`0x4c7651` block at 2.42%).

### `0x004998eb` — palette rebuild. Second hot cluster, and the worst code.

```asm
0049992a  cmp  dword [ebp-0x4], 0xf6       ; loop over palette entries 0x0a..0xf5
00499931  jge  0x499997
00499937  mov  eax, [ebp-0x4]              ; reload i
0049993a  lea  eax, [eax+eax*2]            ; i*3 (RGB triples)
0049993d  mov  ecx, [ebp-0xc]              ; reload src
00499940  movsx eax, byte [eax+ecx]
00499944  shl  eax, 0x2                    ; 6-bit VGA -> 8-bit
00499947  mov  ecx, [ebp-0x4]              ; reload i AGAIN
0049994a  mov  [0x508084+ecx*4], al
   ... the same seven instructions twice more for G and B ...
00499987  mov  eax, [ebp-0x4]              ; and a fourth reload
0049998a  mov  byte [0x508087+eax*4], 0x4  ; alpha
00499992  jmp  0x499927
```

Converts a 236-entry 6-bit VGA palette into the BGRA table at `0x508084`, and
**reloads the loop counter from `[ebp-0x4]` eight times per iteration**.
Unoptimised debug-shaped code in a per-frame path: 140,656 hits on each of its
two blocks in the window ≈ **596 full palette rebuilds**, i.e. it runs about
every other frame (Heroes II palette-cycles continuously).

This single loop is why `H344 $th_load32_ro_base_ebp` is the **#1 handler in
the whole app at 8.22%**, and it supplies the `movsx8 [eax+ecx*1]` that is
**37.68%** of every SIB effective address the app computes.

### `0x004d35f0` — CRT `memcpy`.

Overlap check, `rep movsd`, then `jmp [0x4d3628+edx*4]` into a 0/1/2/3-byte
tail table. Four of its blocks sit at 1.36% each. Already efficient; nothing
to do.

### `MSS32.DLL 0x2000d9d0` — Miles mixer voice scan.

Hot blocks `0x2000da61` (runtime `0x54ea61`) and `0x2000dae8` (`0x54eae8`),
2.27% + 2.34%.

```asm
2000da61  mov  eax, [0x20020908]           ; loop index in a GLOBAL
2000da66  mov  ecx, [0x20020900]           ; voice array base, also a global
2000da6c  mov  edx, [ecx+eax*4+0x56c]
2000da73  lea  eax, [ecx+eax*4]
2000da76  cmp  edx, esi
2000da78  jz   short 0x2000dae8
2000da7a  dec  [eax+0x66c]                 ; per-voice countdown
...
2000dae8  mov  eax, [0x20020908] / inc eax / mov [0x20020908], eax
2000daf5  jl   0x2000da61                  ; 32 voices (ebx = 0x20)
```

A 32-slot voice table walked with **both** the index and the base held in
globals and re-read several times per iteration. `dec [mem]` + `jg` is the
`H409->H320` pair at 1.70%, the second-highest pair in the app. Runs off the
multimedia-timer callback, so its share is a function of the mixer rate, not
of the frame rate.

## Where the time actually goes

Two `--cpu-prof` runs of the identical command, differing only in
`--repaint-every`:

| | `=1` | `=50` |
|---|---|---|
| wall | 75.7s | 10.4s |
| **wasm total** | 3569ms (**4.7%**) | 3193ms (**31.0%**) |
| `drawImage` `lib/raster-canvas.js:288` | 47692ms (63.1%) | 1377ms (13.4%) |
| `putImageData` :260 | 8076ms (10.7%) | 461ms (4.5%) |
| `fillRect` :159 | 6791ms (9.0%) | 226ms (2.2%) |

**The wasm time is the same in both** (3569 vs 3193ms). The extra 65 seconds
is entirely `lib/raster-canvas.js` compositing frames the guest already drew.

> **Trap: do not profile this app at `--repaint-every=1`.** The general rule in
> `feedback_repaint_every_skews_profiles` — that a throttled repaint hides the
> presentation path — inverts here. Heroes II presents a full 640x480 8bpp
> DirectDraw primary every frame, and the CLI's *pure-JS* canvas then costs
> more than the emulator by a factor of 20. At `=1` you are measuring
> `raster-canvas.js`, not Heroes II. The browser uses a real canvas and has no
> equivalent cost, so a CLI number from `=1` describes nothing anybody runs.
> Use `tools/profile-web-frames.js --headful` for a presentation number.

Inside wasm at `--repaint-every=50` (of 3193ms self):

| fn | ms | % of wasm |
|---|---|---|
| `$next` | 693.6 | **21.7%** |
| `$g2w` | 245.8 | 7.7% |
| `$jcc_end` | 236.3 | 7.4% |
| `$set_reg` | 171.0 | 5.4% |
| `$gs32` | 138.8 | 4.3% |
| `$branch_end` | 132.6 | 4.2% |
| `$get_reg` | 124.4 | 3.9% |
| `$th_test_jcc` | 111.3 | 3.5% |

Dispatch is a fifth of guest execution — and `project_next_dispatch_negative`
already records that tail calls and branch-stripping both measured *zero*
there, because the cost is the mispredicted indirect call itself.

## Handler histogram, gameplay window

37,789,647 dispatches, `--handler-hist-thread=0 --handler-hist-start=1400
--handler-hist-stop=2600`. Deterministic; unaffected by machine load.

```
H344 $th_load32_ro_base_ebp   8.22%   <- the palette loop's [ebp-0x4] reloads
H404 $th_test_jcc (fused)     4.24%
H43  $th_jmp                  4.11%
H21  $th_store32              4.05%
H312 $th_jcc_nz               4.00%
H18  $th_xor_r_r              3.63%
H11  $th_mov_r_r              3.47%
H20  $th_load32               3.28%
H148 $th_lea_sib              3.19%
H53  $th_shift_r              2.63%
```

Top blocks: `0x4c7341` 4.98%, `0x4c735b` 2.62%, `0x4c7651` 2.42%,
`mss32+0xdae8` 2.34%, `mss32+0xda61` 2.27%, `0x4c755d` 2.27%,
`0x499927`/`0x499937` 1.75% each.

SIB consumers (1,739,510 recorded): `movsx8 [eax+ecx*1]` **37.68%** (palette
loop), `store8 [none+ecx*4]` 24.26%, `load8 [eax+ecx*1]` 16.24%.

**The profile is flat.** Nothing is above 8.2%, and the fusions already landed
(H400/H401/H403/H404/H405) are sitting in the top ten doing their job. There is
no remaining Heroes-II idiom of the size the earlier ones had.

## Block cache behaviour (post page-compile)

Since `perf/page-compile` merged (`9b9a98c9`), the same window reports:

```
block decodes 49344 of which evicted a live block 0
pages: compiled 200 | index hits 13077364 misses 96571 (99.3% hit)
runs: extended 1581 | blocks chained 2535 | free fall-throughs 2103407
page invalidations 4654 that dropped a block 0
```

Zero live evictions. Heroes II is not decode-bound (unlike Total Annihilation,
`docs/loop-idiom-superops-design.md` §10.7).

## Ruled out

- **COPY_RUN is worthless on this app, and the reason is structural, not a
  tuning failure.** Heroes II's literal-run copy at `0x004c7700` is
  `rep movsd`/`rep movsb`. There is no byte-copy loop for the matcher to lower.
- **LUT_RUN's target exists but is small.** `0x004c755d` is real and is the
  shadow blit, but only 6 of 89 self-loop blocks match here, the static match
  rate on H2DEMOW is 4 of 1215 (1.2%), and an A/B over this window came back
  inconclusive (median ~1%). Recorded in the design doc §10.4 and §10.
- **The lowering is disabled on main anyway** (`$loop_emit_enabled = 0`,
  commit `bbf4ca05`); `--loop-superops` turns it on for an A/B.
- **The block cache is not the constraint here** — see above, zero evictions.
