# SkiFree Assert Debug — ski2.c lines 1205/1206

## Current Status

Assert fires on EVERY frame during sprite rendering. Game still runs (1442 blts,
630 rects) but shows MessageBox dialogs every frame.

## What the asserts check

Function at `0x401540` — composite sprite renderer. Takes a parent sprite (EDX)
and renders children within parent's bounding box:

```asm
; At 0x40175a:
sub bp, [esp+0x3c]    ; bp = child_X - parent.left → ASSERTS >= 0 (line 1205)
sub di, [esp+0x18]    ; di = child_Y - parent.top  → ASSERTS >= 0 (line 1206)
```

Child sprite world positions fall outside their parent's bounding box.

## Eliminated causes

### GetTickCount ✓
Was returning constant 100000, now increments properly (+16 per call).
Delta at first assert = 16ms — **perfectly normal**.

### FindResourceA ✓
Was returning fake pointers. Now walks PE resource directory. But SkiFree only
uses FindResource for WAVE sound resources (custom type "WAVE"), not sprite data.

### Viewport / GetClientRect ✓
```
Global client rect at 0x40c6b0: {0, 0, 474, 435}  ← correct
GetSystemMetrics SM_CXSCREEN=640, SM_CYSCREEN=480  ← correct
```

### BSS initialization ✓
All SkiFree sections have RawSize >= VSize — no BSS to zero.

### SETcc memory bug ✓
All 26 SETcc in SkiFree use mod=3 (register) — bug doesn't apply.

### Stock bitmap / GetObjectA ✓
Fixed by adding real objects at handles 0x30001, 0x30002 in `_gdiObjects`.
Assert 933 no longer fires.

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
            0x401540 — composite sprite renderer ← ASSERT HERE
            0x401410 — get sprite bitmap data
```

## Sprite list structure

Global `[0x40c618]` → linked list of sprite groups:
```
[+00] next pointer
[+04] child/related pointer
[+08] parent pointer
[+0c] data pointer
[+10] allocation (HeapAlloc result)
[+14] bitmap info pointer
[+20..2c] bounding rect (left, top, right, bottom) as dwords
[+30..3c] clip rect (set during render pass)
[+40..44] velocity/movement data
[+4c] flags (bit 0=visible, bit 1=active, bit 2=has_bitmap, bit 4=needs_update)
```

At assert time, sprite rects look valid (40×35, 44×36 etc — matching bitmap sizes).
Example: Sprite[0] rect=[217,50,257,85] = 40×35, flags=0x34.

## Sprite positions at first assert

```
Sprite[0] rect=[217,50,257,85]   vp=[217,50,257,85]   flags=0x34
Sprite[1] rect=[155,49,199,85]   vp=[155,49,199,85]   flags=0x34
Sprite[2] rect=[277,49,317,85]   vp=[277,49,317,85]   flags=0x34
Sprite[3] rect=[206,117,269,149] vp=[206,117,269,149]  flags=0x04
Sprite[4] rect=[191,115,283,145] vp=[191,115,283,149]  flags=0x04
```

These are game-world coordinates. The renderer tries to draw child sprites
relative to parent — child X=100 with parent left=217 → rel_X = -117 → ASSERT.

## Key question

Why do child sprite positions fall outside parent bounding boxes? On real Windows
this invariant holds. The `0x401060` sprite update function (called from game loop)
is supposed to keep parent/child positions in sync.

## Remaining hypotheses

1. **ADC/SBB flag corruption** — Gemini report confirms `flag_res` is set to 0 on
   intermediate carry, destroying ZF/SF for subsequent instructions. SkiFree uses
   hundreds of ADC/SBB (many in sprite code at 0x401000-0x401500). If a comparison
   after ADC/SBB reads wrong flags, branching goes wrong and positions diverge.

2. **16-bit arithmetic bug** — The sprite coords use 16-bit (word) operations
   extensively (`66` prefix). Previous sessions fixed MOV r16,r16 but there may
   be remaining 16-bit ALU issues (CMP, SUB with 16-bit operands).

3. **MOVSX/MOVZX edge case** — `0f bf` (MOVSX r32,r/m16) is used heavily in
   sprite position calculations. If sign extension is wrong, coordinates flip sign.

4. **Linked list traversal bug** — The sprite tree walk in 0x401060 might traverse
   nodes in wrong order due to a comparison/branch bug, causing parent/child
   mismatch.

## Next steps

- Trace the `0x401060` sprite update function with per-instruction EIP logging
  to find where sprite positions diverge from expected values
- Compare register state at key branch points against expected behavior
- Check ADC/SBB flag logic in `05-alu.wat` for the corruption described in
  Gemini report
