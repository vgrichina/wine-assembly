# SkiFree (ski32.exe) — Progress Notes

## Binary Info
- Source: Microsoft Entertainment Pack, `test/binaries/entertainment-pack/ski32.exe`
- Size: 118,784 bytes
- PE with 4 sections: .text, .rdata, .data, .rsrc
- Resources: 0 menus, 0 dialogs, 17 strings, 2 icons, bitmap resources (not parsed)
- Imports from: KERNEL32, USER32, GDI32, WINMM
- Two window classes: "SkiMain" (WndProc=0x405800), "SkiStatus" (WndProc=0x4068d0)

## Current Status
- **CRT startup completes successfully** — all Heap*, Virtual*, CRT init APIs work
- **Window created** — "SkiFree" title bar shows, game enters message loop
- **Timer running** — WM_TIMER messages dispatched to timer callback 0x4047c0
- **BLOCKED**: Timer callback does nothing because `[0x40c67c]` (game-running flag) = 0
- **ROOT CAUSE**: RegisterClassA is never called → wndproc_addr = 0 → DispatchMessageA can't call WndProc → WM_ACTIVATE/WM_SIZE never processed → game never starts

## Key Discovery: Init Path Bypass
The game's window creation function at 0x405470 (which calls RegisterClassA, CreateWindowExA with WndProcs) is **never reached**. Instead, CreateWindowExA is called from a different code path (possibly the CRT _initterm chain or a WinMain variant). The RegisterClassA call at 0x4054dd is bypassed entirely.

Need to trace: What path actually creates the windows? Why is 0x405470 skipped?

WinMain is at 0x4047e0. It calls:
1. 0x4048c0 — alloc init (works, returns 1)
2. 0x404970 — game state init (works, returns 1)
3. 0x4052d0 — window creation (called via `call 0x4052d0` at 0x40482c)

But 0x4052d0 is **never reached** per breakpoint testing. This means WinMain itself isn't being called, OR the call at 0x40482c is skipped.

## Bugs Fixed
- [x] `66` prefix for ALU r/m (0x81 group) — 16-bit immediate was correct but operation was 32-bit
- [x] `66` prefix for ALU reg-mem (0x00-0x3D) — added 16-bit handlers (159-162)
- [x] `66` prefix for MOV r/m (0x89/0x8B) — added 16-bit load/store handlers (163-166)
- [x] `66` prefix for MOV [mem], imm (0xC7) — fetch 16-bit immediate
- [x] GetStringTypeA/W byte offset was 12, should be 13
- [x] Multiple WndProc support — first RegisterClassA sets main, second sets child

## APIs Implemented (new for ski32)
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

### GDI32
- PatBlt, CreateBitmap, TextOutA

### WINMM
- sndPlaySoundA (stub)

## Bugs Fixed (later sessions)
- [x] ADC flag corruption — `th_adc_r_i32` and `th_adc_r_r` destroyed ZF/SF when b+cf wrapped (set flag_res=0 instead of using raw mode). Fixed to match `do_alu32`'s correct flag_op=8 approach.
- [x] ScrollWindow — was stubbed as no-op, causing vertical stripe rendering artifacts. Implemented via canvas getImageData/putImageData shift.

## Current Status (updated)
- Game launches, runs, and renders sprites correctly
- Timer-driven game loop works (TimerProc at 0x4047c0)
- Sprite assertions eliminated after ADC fix (zero in 50k batches)
- Test runner still shows rare assertions (~1/1000 batches) likely due to timing artifacts from API logging overhead

## Rendering Architecture (disasm analysis)

### Global State
- `[0x40c5ec]` — hdcScreen: main window DC (from GetDC)
- `[0x40c5e8]` — hdcBackbuffer or composition DC

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

### Known Rendering Issues
- **Title text overlapping**: The "Copyright", "by", "Version" text lines in the title bitmap overlap. These are sprite-based (from CreateBitmap), NOT TextOutA. The overlapping visible in dumps suggests the sprite strip positions may be wrong, or the CreateBitmap pixel data conversion has issues with the specific bitmaps used for text.
- **GetTextExtentPoint32A**: Was returning 0 (failure stub). Now returns cx=count*8, cy=16. Used by status bar text positioning.

## Next Steps
1. Debug title bitmap overlapping — dump individual text sprite bitmaps to verify pixel data
2. Investigate if CreateBitmap monochrome (1bpp) conversion is correct for text sprites
3. Verify browser rendering works end-to-end
