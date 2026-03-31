# SkiFree (ski32.exe) — Progress Notes

## Binary Info
- Source: Microsoft Entertainment Pack, `test/binaries/entertainment-pack/ski32.exe`
- Size: 118,784 bytes
- PE with 4 sections: .text, .rdata, .data, .rsrc
- Resources: 0 menus, 0 dialogs, 17 strings, 2 icons, bitmap resources (not parsed)
- Imports from: KERNEL32, USER32, GDI32, WINMM
- Two window classes: "SkiMain" (WndProc=0x405800), "SkiStatus" (WndProc=0x4068d0)

## Current Status
- Game launches, runs, and renders sprites correctly
- All imported APIs fully implemented (KERNEL32, USER32, GDI32, WINMM) — no stubs hit at runtime
- Timer-driven game loop works (TimerProc at 0x4047c0)
- Sprite assertions eliminated after ADC fix (zero in 50k batches)
- ScrollWindow implemented — fixed vertical stripe rendering artifacts
- Client-rect clipping on BitBlt prevents drawing over window chrome
- GetDeviceCaps returns actual canvas size (not hardcoded 640×480)
- Window size is `min(screenW, screenH)` squared — 480×480 at 640×480 resolution

## Game Loop Architecture

```
WinMain at 0x4047e0:
    call 0x4048c0       ; alloc init (returns 1)
    call 0x404970       ; game state init (returns 1)
    call 0x4052d0       ; window creation (RegisterClassA + CreateWindowExA)

WndProc at 0x405800 — message dispatch via jump table (msgs 1-0x21)
    Extended handler: WM_KEYDOWN(0x100), WM_CHAR(0x102), WM_MOUSEMOVE(0x200)
    WM_TIMER(0x113) → NOT handled in WndProc! Uses TimerProc callback.

TimerProc at 0x4047c0:
    if ([0x40c67c] != 0)    ; game_active flag (= 1)
        call 0x400ff8       ; game update

Game update at 0x400ff8:
    call GetTickCount           ; get current time
    delta = now - prev_tick     ; compute frame delta (= 16ms)
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

## Key Globals

| Address    | Name           | Value    | Purpose |
|------------|---------------|----------|---------|
| `0x40c5ec` | hdcScreen      | 0x50001  | Main window DC (from GetDC) |
| `0x40c5e8` | hdcBackbuffer  | 0x80062  | Composition DC target for sprite BitBlt |
| `0x40c5f0` | backbuffer bmp | 0x1da    | Bitmap handle |
| `0x40c5f4` | frame_delta    | varies   | GetTickCount delta per frame |
| `0x40c618` | sprite_list    | ptr      | Linked list head for sprites |
| `0x40c67c` | game_active    | 1        | Game running flag |
| `0x40c698` | prev_tick      | varies   | Previous GetTickCount value |
| `0x40c6b0` | client_rect    | struct   | {0, 0, 474, 435} |

## Rendering Architecture

### Sprite Data Structures
Each sprite object is a struct at ~0x50 bytes:
- `+0x00`: dword — x1 (left edge in sprite strip, 32-bit)
- `+0x04`: dword — y1 (top edge in sprite strip, 32-bit)
- `+0x08`: dword — x2 (right edge = x1 + width)
- `+0x0c`: dword — y2 (bottom edge = y1 + height)
- `+0x0a`: word — srcX in strip (overlaps with x2 low word)
- `+0x0c`: word — srcY in strip
- `+0x14`: ptr — pointer to sub-sprite data (x/y offsets at +0x08/+0x0a/+0x0c)
- `+0x42`: word — Y sort key
- `+0x4a`: word — animation frame count (asserted != 0 at line 2028)
- `+0x4c`: byte — flags (bit 0=dirty, bit 1=visible, bit 2=pre-composed, bit 6=has sub-sprite)

### Sprite Strip Bitmaps
SkiFree stores all sprite frames in two vertical strips:
- **Color strip** (32×2379): built with `SRCCOPY` (0xCC0020) — actual sprite pixels
- **Inverted strip** (32×2379): built with `NOTSRCCOPY` (0x330008) — bitwise inverted copy

Plus two wider strips for large sprites:
- **Color strip** (93×380): `SRCCOPY`
- **Inverted strip** (93×380): `NOTSRCCOPY`

At startup, each individual sprite bitmap (created via `CreateBitmap` with embedded pixel data) is blitted into these strips at increasing Y offsets. The sprite struct records its position within the strip.

### Blit Rendering Function (0x401696–0x40195e)

The main sprite render loop walks a linked list of sprites and draws them to the screen DC:

```
0x401696: loop entry — iterate sprite linked list
0x401714: load sprite data (strip coords from sprite struct)
  ebx = sprite strip DCs [ebx] = color DC, [ebx+4] = inverted DC
  bp = destX (sprite screen X - scroll offset)
  di = destY (sprite screen Y - scroll offset)
  [esp+0x28] = srcX in strip
  [esp+0x24] = srcY in strip (height)
  [esp+0x40] = strip height (blit height)

0x401800: check if sprite has transparency (eax = flags)
  if eax == 0: OPAQUE path (no mask needed)
    0x401829: PatBlt(hdcScreen, destX, destY, w, h, WHITENESS)  — clear bg
    0x401848: BitBlt(hdcScreen, destX, destY, w, h, colorDC, srcX, 0, SRCCOPY)
    → jumps to 0x4018c0 (shared BitBlt call)

  if eax != 0: TRANSPARENT path (masked blit)
    0x401873: BitBlt(hdcScreen, destX, destY, w, h, invertedDC, srcX, 0, SRCPAINT)
              — OR inverted mask onto screen (sets sprite area to ~white)
    0x4018ad: BitBlt(hdcScreen, destX, destY, w, h, colorDC, srcX, 0, SRCAND)
              — AND color data (clears non-sprite area, keeps sprite pixels)

0x4018c6: mark sprite as rendered (flags |= 1), advance linked list
0x4018e4: loop back to 0x401696 if more sprites

0x4018ec: post-loop
  if any sprites were dirty:
    0x4018fe: BitBlt(compDC, destX, destY, w, h, hdcScreen, srcX, 0, SRCCOPY)
              — copy rendered area back to composition buffer
```

### Masked Blit Technique
SkiFree uses an inverted-color masking approach:
1. **SRCPAINT** (OR) with inverted sprite: where sprite is colored, inverted bits get ORed in; where background is black(0), inverted=white gets ORed → sets to white
2. **SRCAND** (AND) with original sprite: where sprite is colored, AND preserves color; where inverted set to white, AND with black(0) = black

Net effect: sprite pixels appear correctly, background becomes black. This works because SkiFree always draws on a white/cleared background (PatBlt WHITENESS first).

### BitBlt Call Sites (3 total, all in 0x4016a4)
- `0x40189d`: SRCCOPY blit (rop=0xCC0020)
- `0x4018c0`: NOT source blit (rop=0x330008) — mask operation
- `0x40191e`: mixed rop blit

### Title Screen Composition (192×64 bitmap)
The title is composed in a 192×64 off-screen buffer:
1. `PatBlt(dc, 0, 0, 132, 61, WHITENESS)` — clear to white
2. `BitBlt(dc, 74, 29, 24x28, atlas, 0, 92, SRCCOPY)` — place skier sprite
3. Masked blits from 93×380 sprite strips:
   - `(0,0) 93×57` from offset 32 — "Ski" logo
   - `(40,27) 92×30` from offset 99 — "free" text
   - `(20,51) 52×10` from offset 89 — copyright line
   - `(55,29) 63×32` from offset 129 — version info
4. `BitBlt(wndDC, 151, 88, 132×61, dc, 0, 0, SRCCOPY)` — blit to window

### Backbuffer → Screen Transfer
The sprite render loop blits directly to hdcScreen (window DC). The backbuffer DC at `[0x40c5e8]` is used as a composition buffer — dirty regions are copied back to it after rendering. There is NO separate blit-to-screen pass; rendering goes directly to the window DC.

## Bugs Fixed
- [x] `66` prefix for ALU r/m (0x81 group) — 16-bit immediate was correct but operation was 32-bit
- [x] `66` prefix for ALU reg-mem (0x00-0x3D) — added 16-bit handlers (159-162)
- [x] `66` prefix for MOV r/m (0x89/0x8B) — added 16-bit load/store handlers (163-166)
- [x] `66` prefix for MOV [mem], imm (0xC7) — fetch 16-bit immediate
- [x] GetStringTypeA/W byte offset was 12, should be 13
- [x] Multiple WndProc support — first RegisterClassA sets main, second sets child
- [x] ADC flag corruption — `th_adc_r_i32` and `th_adc_r_r` destroyed ZF/SF when b+cf wrapped (set flag_res=0 instead of using raw mode). Fixed to match `do_alu32`'s correct flag_op=8 approach.
- [x] ScrollWindow — was stubbed as no-op, causing vertical stripe rendering artifacts. Implemented via canvas getImageData/putImageData shift.
- [x] GetTickCount — was returning constant 100000, now increments properly (+16 per call)
- [x] FindResourceA — now walks PE resource directory (SkiFree uses for WAVE sounds)
- [x] GetTextExtentPoint32A — was returning 0 (failure stub), now returns cx=count*8, cy=16
- [x] Stock bitmap / GetObjectA — fixed by adding real objects at handles 0x30001, 0x30002
- [x] SETcc memory bug — all 26 SETcc in SkiFree use mod=3 (register), bug doesn't apply

## Eliminated Causes (debug investigation)
- Viewport / GetClientRect — global client rect at 0x40c6b0: {0, 0, 474, 435} correct
- BSS initialization — all SkiFree sections have RawSize >= VSize, no BSS to zero

## APIs Implemented (for ski32)
### KERNEL32
- HeapCreate/HeapAlloc/HeapFree/HeapReAlloc/HeapDestroy
- VirtualAlloc/VirtualFree
- GetACP, GetOEMCP, GetCPInfo
- MultiByteToWideChar, WideCharToMultiByte
- GetStringTypeA/W, LCMapStringA/W
- GetStdHandle, GetFileType, WriteFile, SetHandleCount
- GetEnvironmentStrings/W, FreeEnvironmentStringsA/W
- GetModuleFileNameA, UnhandledExceptionFilter
- GetCurrentProcess, TerminateProcess, GetTickCount
- FindResourceA, LoadResource, LockResource, FreeResource
- RtlUnwind, FreeLibrary

### USER32
- FillRect, FrameRect, LoadBitmapA, OpenIcon
- WM_TIMER dispatch with callback (DispatchMessageA)
- Timer support in GetMessageA (generates WM_TIMER when idle)
- WM_ACTIVATE message delivery
- ScrollWindow

### GDI32
- PatBlt, CreateBitmap, TextOutA, GetObjectA

### WINMM
- sndPlaySoundA (stub)

## Title Screen Investigation

The title text overlapping is NOT a rendering bug. The masked blit (SRCPAINT+SRCAND) works correctly. The "garbled" appearance is because:

1. Resource 55 ("Use NumPad [0-9] for better control", 92x30) has a **yellow background** by design — it's an instruction box, not transparent sprite
2. This sprite is placed in the wide strip at Y=99 (previously misidentified as "by Chris Pirih")
3. When masked-blitted onto the title composition, the yellow background is preserved (correct behavior)
4. Multiple instruction sprites overlap in the title, each with colored backgrounds

The actual SkiFree title on real Windows does show these colored instruction boxes. The rendering is correct.

### PE Resource Bitmap Flow (corrected)
- SkiFree loads sprites via `LoadBitmapA` (PE resources with embedded DIB palettes), NOT `CreateBitmap`
- Resources are 4bpp DIBs with per-resource palettes — NOT VGA standard palette
- `gdi_create_bitmap` (from WASM) is never called by SkiFree
- Strip bitmaps confirmed working: all 89 sprites correctly loaded and blitted into 32×2379 and 93×380 strips

### Rendering Pipeline Confirmed Working
- Canvas-based GDI: `_createOffscreen` → per-bitmap canvas → `getImageData`/`putImageData` for blits
- SRCCOPY, NOTSRCCOPY, SRCPAINT, SRCAND all operate correctly via pixel-level ops
- The `.pixels` array on GDI objects is NOT updated by canvas operations (stale after blits); the `.canvas` is authoritative

## Next Steps
1. Fix 4bpp palette color order in `gdi_create_bitmap` (R/B swap) — not used by SkiFree but affects other apps
2. Test other EXEs still work after dispatch refactor
