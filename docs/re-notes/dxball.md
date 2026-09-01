# DX-Ball (`dxball.exe`)

App id `dxball`. `test/binaries/candidates/dxball/installed/dxball.exe`,
`imageBase=0x400000`, loads at `0x400000` (delta 0, so original VAs are runtime
VAs). Sections: `.text 0x401000`, `.rdata 0x415000`, `.data 0x416000` (BSS from
`0x437290`), `.rsrc 0x438000`.

## Headline: it is a ~59 Hz clock-limited game, not a frame-locked one

This file exists because the frame-pacing census first classified DX-Ball as
FRAME_LOCKED and that verdict was **wrong**. It has a software frame limiter —
a real `while (timeGetTime() - last < 17)` busy-wait — that the headless batch
clock defeats completely. See "The limiter" below for the disassembly and
"Proving it" for the numbers.

## The time source

`0x0040db20` is `GetTimeMs()`, the app's only clock. It has two backends chosen
by the flag at `[0x435cf8]`:

```
0040db20  mov eax, [0x435cf8]        ; use-QPC flag
0040db28  test eax, eax
0040db2a  jz   0x40db71              ; -> timeGetTime fallback
0040db2c  mov eax, [0x435d00]        ; cached (freq/1000)
0040db33  jnz  0x40db56
0040db3a  call [0x415074]            ; QueryPerformanceFrequency
0040db42  jz   0x40db71              ; no QPF -> timeGetTime fallback
0040db44  mov eax, 0x10624dd3
0040db49  mul  [esp+0x0]
0040db4d  shr  edx, 0x6              ; freq / 1000  (ticks per ms)
0040db50  mov  [0x435d00], edx
0040db5b  call [0x415070]            ; QueryPerformanceCounter
0040db67  div  [0x435d00]            ; -> milliseconds
0040db70  ret
0040db71  call [0x415174]            ; timeGetTime   <-- the path we take
0040db7a  ret
```

Under this emulator `[0x435cf8]` is 0, so **QPC is never called** and every
clock read is `timeGetTime`. Measured: 609 `timeGetTime` calls in a 3000-batch
run, 0 `QueryPerformanceCounter`.

There are exactly **two** `timeGetTime` import call sites in the binary and they
are both wrappers, reached through the IAT slot at `0x415174`:

| site | what it feeds |
|---|---|
| `0x0040ae30` | `srand`-style seed: `timeGetTime() % 300` pushed to `0x40ea60`. Called once, from `0x0040ad96`. |
| `0x0040db71` | the `GetTimeMs()` fallback above — **every** runtime clock read |

`0x0040db80` is `deadline_check(deadline, slack)`: returns 1 when
`now < deadline` **or** `now >= deadline + slack`, and 0 only inside the
`[deadline, deadline+slack)` window.

`GetTimeMs()` has 15 static callers. A `caller_census.js` run (3000 batches)
shows only five ever fire, and 606 of the 609 hits are one pair:

```
callsite_va   hits
0x402270      303     <- frame limiter, loop head
0x402295      303     <- frame limiter, commit
0x40adb0        1     <- startup vblank benchmark, t0
0x40adce        1     <- startup vblank benchmark, t1
0x40ae0f        1     <- startup, seeds [0x4349c4]
```

## The limiter

`0x00402240` is `WaitFrame(n)`. It has a hardware arm and a software arm:

```
00402240  mov eax, [0x4349c0]        ; "vblank really blocks" flag
00402248  jz   0x402266              ; not set -> software limiter
                                     ; set -> n x IDirectDraw::WaitForVerticalBlank
0040225c  call [ecx+0x58]            ; slot 22 = WaitForVerticalBlank(1, 0)
```

The software arm at `0x00402266` is the frame limiter:

```
00402270  call 0x40db20              ; now = GetTimeMs()
00402275  mov  ecx, [0x4349c4]       ; last frame time
0040227d  jb   0x402295              ; now < last (wrap) -> don't wait
0040227f  add  ecx, 0x11             ; last + 17 ms
00402284  jbe  0x402295              ; 17 ms already elapsed -> don't wait
00402286  call 0x40db20              ; SPIN: now = GetTimeMs()
00402293  jnb  0x40227f              ;   ...until last + 17 <= now
00402295  call 0x40db20
0040229b  mov  [0x4349c4], eax       ; last = now
004022a0  jnz  0x402270              ; repeat n times
```

`0x11` = 17 ms = **58.8 frames per second**. This is a textbook
`while (timeGetTime() - last < N)` limiter, and `0x402286` is its spin body.

## Why the hardware arm is never used

`0x0040adb0` is a startup calibration:

```
0040adb0  call 0x40db20              ; t0
0040adb7  mov  esi, 0x20             ; 32 iterations
0040adc8  call [ecx+0x58]            ;   WaitForVerticalBlank(1, 0)
0040adce  call 0x40db20              ; t1
0040add9  sub  eax, ebx              ; delta
0040addb  mov  edx, 0x190            ; 400
0040ade0  cmp  edx, eax
0040ade2  sbb  eax, eax
0040ade4  neg  eax                   ; eax = (delta > 400) ? 1 : 0
0040ade9  mov  [0x4349c0], eax       ; "vblank really blocks"
0040ae05  mov  dword [0x4349c8], 1   ; ...and if not: "slow machine"
```

32 vertical blanks on real hardware at 60 Hz take ~533 ms, so `[0x4349c0]`
becomes 1 and the game syncs to the display. **Headless, this calibration comes
in under its 400 ms threshold and the game falls back to its software limiter.**
Confirmed in the trace: exactly 32 `IDirectDraw_WaitForVerticalBlank` calls in a
whole run, all with `ret=0x0040adcb` — all from this benchmark, none from the
frame loop — and **zero `Flip` calls**.

That holds at *both* headless clock rates: 32 waits and 0 `Flip` at
`--tick-ms-per-batch=200` and again at `=1`. **Why is unresolved.** Our
`WaitForVerticalBlank` is not a stub: it parks on `yield_reason=13`
(`$vblank_block`, `src/09a8-handlers-directx.wat:3039`) and `test/run.js:7999`
charges the owed guest milliseconds through the same `pausedMs` seam as
`--dx-lock-pause-ms`. The likely explanation is that several parks landing
inside one batch collapse to one charge, so 32 back-to-back waits cost far less
than 32 vblank intervals — but that has not been measured. The browser wakes the
park on a real `rAF` callback instead (`host.js _awaitVblank`), so DX-Ball may
take the **hardware** path there and behave differently from every headless
capture of it. That is worth a browser measurement before anyone treats a
headless DX-Ball frame rate as the app's.

`[0x4349c8]` (slow machine) also disables `0x00401650`, the `Flip`-based
present path (vtable `+0x2c` = `IDirectDrawSurface::Flip`, with a retry loop on
`DDERR_WASSTILLDRAWING 0x8876021c` and a surface-lost check for
`0x887601c2`). That is why DX-Ball emits **zero `Flip` calls** here and presents
entirely through `BltFast`.

## Proving it: the limiter engages the moment the clock is slow enough

Three runs, same app, same 3000 batches, `--count` on the limiter addresses.

| arm | `0x402286` (spin body) | `0x402295` (frames) | guest seconds | frames/guest-s |
|---|---|---|---|---|
| default (`--tick-ms-per-batch=200`) | **0** | 303 | 600 | 0.51 |
| `--tick-ms-per-batch=1` | 88,658 | 36 | 3 | 12.0 |
| `--tick-ms-per-batch=1 --batch-size=100000` | 47,347,690 | **176** | 3 | **58.67** |

- At the default headless clock the spin body **never executes once**: guest
  time advances 200 ms per batch, so `now - last >= 17` is already true on the
  first read and the limiter is bypassed at `0x402284`. This is exactly the trap
  CLAUDE.md documents for `--tick-ms-per-batch`, in its other direction.
- At 1 ms per batch the limiter engages: the guest burns 88,658 spin iterations
  and frame production falls 303 → 36.
- With 100x the op budget it saturates at **58.67 frames per guest second**
  against a design cap of 1000/17 = 58.82 — within 0.3%, and it does not go
  higher no matter how many ops it is given.

The 47.3M spin iterations in the last arm are the limiter working as intended:
that is the CPU a real machine would also burn, because DX-Ball busy-waits
rather than sleeping.

## What this means for a frame cap

- **In the browser this is already self-limiting.** `host.js:223 _guestTickMs`
  derives the guest clock from real elapsed wall time, so `timeGetTime` deltas
  are real and the 17 ms limiter engages. DX-Ball should be sitting at ~59 fps
  in the browser on its own.
- A **display-refresh (60 Hz) cap is what the game already asks for** and cannot
  change its speed. A cap *below* refresh would slow it, because the simulation
  advances once per limited frame.
- The remaining cost is not frames: it is ~113 `$dx_present` calls per frame
  (every sprite `BltFast` to the primary reaches `$dx_present`,
  `src/09a8-handlers-directx.wat:3779,3924`).

## Reproducing

```bash
node tools/find_bytes.js <exe> --imm32=0x15934        # timeGetTime IAT thunk array
node tools/disasm_fn.js  <exe> 0x40db20 40            # GetTimeMs
node tools/disasm_fn.js  <exe> 0x402240 30            # WaitFrame + software limiter
node tools/disasm_fn.js  <exe> 0x40adb0 30            # vblank calibration
node tools/caller_census.js --exe=<exe> --module=exe --callee=0x40db20 \
     --app=dxball --quiet-api --max-batches=3000 --no-close

node test/run.js --app=dxball --quiet-api --max-batches=3000 --no-close \
     --tick-ms-per-batch=1 --batch-size=100000 \
     --count=0x402270,0x402286,0x402295
```

## Ruled out

- **"It ignores the clock."** It does not. It reads the clock twice per frame
  and gates the frame on the delta; the default headless clock just makes the
  gate always pass.
- **"It uses QPC."** `QueryPerformanceCounter` is imported and never called —
  `[0x435cf8]` is 0 on this path.
- **"It presents with `Flip`."** Zero `Flip` calls in either headless clock arm.
  The `Flip` path (`0x401650`) is disabled by the slow-machine flag the vblank
  calibration sets. Unverified in the browser.
- **"Our `WaitForVerticalBlank` is a stub that returns instantly."** It is not —
  it parks and is charged guest time. The calibration still comes in under
  400 ms; the mechanism is open (see above).
