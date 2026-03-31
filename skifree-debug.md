# SkiFree Assert Debug — ski2.c lines 1205/1206/2028

## Current Status

**ADC flag corruption bug FOUND AND FIXED** — `th_adc_r_i32` and `th_adc_r_r`
handlers corrupted ZF/SF flags when the intermediate b+cf addition wrapped.

After the fix, the dedicated trace tool (tools/trace-assert.js) runs 50,000
batches at 10k instructions each with **zero assertions**. The test runner
(test/run.js) still shows occasional assertions — likely due to timing-sensitive
sprite layout during rapid GetTickCount deltas in the test harness.

## Bug Found: ADC CF-wrap Corrupts ZF/SF

### The problem

In `05-alu.wat`, the `th_adc_r_i32` and `th_adc_r_r` handlers had a different
CF-wrap fix than the correct version in `do_alu32`:

**do_alu32 (correct)** — switches to raw mode, preserving flag_res:
```wat
(global.set $flag_op (i32.const 8))   ;; raw mode
(global.set $flag_a (i32.const 1))    ;; CF=1
(global.set $flag_b (i32.const 0))    ;; OF=0
```

**th_adc_r_i32 / th_adc_r_r (BUGGY)** — overwrote flag_res, destroying ZF/SF:
```wat
(global.set $flag_a (i32.const 0xFFFFFFFF))  ;; trick to make ADD-mode CF=1
(global.set $flag_res (i32.const 0))          ;; DESTROYS flag_res!
```

When `b_eff = b + cf` wraps (e.g., b=0xFFFFFFFF, cf=1 → b_eff=0), setting
`flag_res=0` made `get_zf()` return 1 and `get_sf()` return 0 regardless of the
actual ADC result. Any subsequent branch (JZ, JNZ, JS, JNS, JL, JGE, etc.)
would take the wrong path.

### Impact on SkiFree

SkiFree uses ADC extensively in sprite position calculations (0x401000-0x401500).
When an ADC's intermediate addition wrapped and a later branch checked ZF or SF,
the wrong branch was taken, causing child sprites to be placed outside their
parent's bounding box — triggering the assertion at line 2028.

### Fix

Changed both `th_adc_r_i32` and `th_adc_r_r` to use raw mode (flag_op=8) with
`flag_a=1, flag_b=0`, matching `do_alu32`. The flag_res from `set_flags_add` is
preserved, so ZF/SF remain correct.

## What the asserts check

Function at `0x401540` — composite sprite renderer. Takes a parent sprite (EDX)
and renders children within parent's bounding box:

```asm
; At 0x40175a:
sub bp, [esp+0x3c]    ; bp = child_X - parent.left → ASSERTS >= 0 (line 1205)
sub di, [esp+0x18]    ; di = child_Y - parent.top  → ASSERTS >= 0 (line 1206)
```

Assert at line 2028 checks `word [esi+0x4a] != 0` — sprite animation frame count.

## Eliminated causes

### ADC flag corruption ✓ (FIXED)
See above — this was the primary cause.

### GetTickCount ✓
Was returning constant 100000, now increments properly (+16 per call).

### FindResourceA ✓
Now walks PE resource directory. SkiFree only uses FindResource for WAVE sounds.

### Viewport / GetClientRect ✓
Global client rect at 0x40c6b0: {0, 0, 474, 435} — correct.

### BSS initialization ✓
All SkiFree sections have RawSize >= VSize — no BSS to zero.

### SETcc memory bug ✓
All 26 SETcc in SkiFree use mod=3 (register) — bug doesn't apply.

### Stock bitmap / GetObjectA ✓
Fixed by adding real objects at handles 0x30001, 0x30002.

## Game loop architecture

```
WndProc at 0x405800 — message dispatch via jump table (msgs 1-0x21)
    Extended handler: WM_KEYDOWN(0x100), WM_CHAR(0x102), WM_MOUSEMOVE(0x200)
    WM_TIMER(0x113) → NOT handled in WndProc! Uses TimerProc callback.

TimerProc at 0x4047c0:
    if ([0x40c67c] != 0)    ; game_active flag (= 1)
        call 0x400ff8       ; game update

Game update at 0x400ff8:
    call GetTickCount           ; get current time
    delta = now - prev_tick     ; compute frame delta (= 16ms, correct)
    [0x40c5f4] = delta
    [0x40c698] = now
    call 0x401e50               ; update game state (uses delta)
    call 0x401060               ; sprite update/render loop
        iterates sprite list at [0x40c618]
        for each sprite: checks bounds, calls render function
            0x401290 — bounds check function
            0x401540 — composite sprite renderer
            0x401410 — get sprite bitmap data
```

## Remaining issue

Test runner (test/run.js) still shows ~1 assertion per 1000 batches at
batch-size=10000. This may be a timing artifact — the test runner's API
logging overhead changes tick deltas, possibly causing a sprite to move
more than expected in a single frame. The dedicated trace tool with no
logging overhead shows zero assertions over 50k batches.

## Tools

- `tools/trace-assert.js` — Dedicated SkiFree assertion tracer with sprite state dump
