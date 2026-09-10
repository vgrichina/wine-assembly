# Bricks I (`bricks.exe`)

App id `bricks`. `test/binaries/wep32-community/Bricks/bricks.exe`, a Klotski
remake. `imageBase=0x400000`, loads at `0x400000` (delta 0, so the original VAs
below are runtime VAs). Imports `MSVCRT.dll`; loads `brk1.dll` at `0x660000`
through `LoadLibrary` for its resources.

One window class, one window, no child controls:

```
RegisterClassA(class="WinBrkWndClass", wndProc=0x00412bf0)
CreateWindowExA(class="WinBrkWndClass", style=WS_OVERLAPPEDWINDOW, 648x508)
```

Everything on screen — board, right-hand button strip, left icon column — is
painted by the app onto that one window and hit-tested by the app itself. If a
click "does nothing", it is the app declining it, not a missing child window.

## The wndproc: `0x00412bf0`

Frame is `sub esp,0x58` + `push ebx/ebp/esi/edi`, so after the prologue
`[esp+0x6c]=msg`, `[esp+0x70]=lParam`, `[esp+0x74]=wParam`; the handler keeps
`esi=msg`, `ebp=lParam`, **`edi = lParam & 0xffff` (client x)** and
**`ebx = lParam >> 16` (client y)**. Three switches:

| range | dispatcher | jump table / index bytes |
|---|---|---|
| `msg` in `0x0f..0x47` | `0x00412c34` | `0x004135ac` / `0x004135c4` |
| `msg == 0x100` (WM_KEYDOWN) | `0x00412ddc` | `0x00413600` / `0x00413624` |
| `msg > 0x100` | `0x00412ff0` | `0x00413638` / `0x0041364c` (`eax = msg-0x112`) |

From the third table, only three mouse messages are handled at all:

| msg | handler |
|---|---|
| `0x200` WM_MOUSEMOVE | `0x00413437` |
| `0x201` WM_LBUTTONDOWN | `0x00413010` |
| `0x202` WM_LBUTTONUP | `0x0041341c` |

There is **no** WM_LBUTTONDBLCLK or WM_RBUTTONDOWN arm (`eax > 0xF0` falls to
the default at `0x0041358e`). WM_LBUTTONUP is only
`[0x41580c] = 0; ClipCursor(NULL)`.

## The left icon column is a legend, not a row of buttons

`0x00413010` gates on three ready flags (`[0x415299]`, `[0x415679]`,
`[0x4156b9]`, all `2` once a board is up) and then dispatches on the game state
`[0x0041571c]` through `0x00413740`. The state-0 arm `0x00413060` does:

```
mov  al,[0x415718] / jnz 0x4132fa      ; busy -> ignore
mov  eax,[0x415010] & 0xff             ; board origin unit
... ebp = originX, ecx = originY
cmp  edi, ebp / jl 0x4132fa            ; click left of the board  -> ignore
cmp  ebx, ecx / jl 0x4132fa            ; click above the board    -> ignore
... /idiv esi -> (col,row), read cell byte at [0x415ec0]+row*w+col
```

So a WM_LBUTTONDOWN outside the board rectangle is discarded by design. The
S / N / V / E / J glyphs down the left column at screen x≈38 are **shortcut
legends**, not controls. Measured: a click there does deliver
WM_NCHITTEST + WM_LBUTTONDOWN/UP with correct client coords (`--trace-input`
plus `--count=0x413010` shows the arm entered), and the app returns without
touching anything. **This is correct behaviour, not an emulator gap.**

The real shortcuts live on the WM_KEYDOWN arm and are **Shift-modified**:

```
00412e84  push 0x10 / call [0x40119c]   ; GetKeyState(VK_SHIFT)
00412e8c  test ah, 0x80 / jz ...        ; Shift must be down
00412e95  lea eax,[esi-0x43]            ; VK 'C'..'V'
00412ea3  mov dl,[eax+0x413624] / jmp [0x413600+edx*4]
```

Index bytes `00 01 02 03 08 08 08 04 08 08 08 05 08 08 08 08 06 08 08 07`
(`08` = default) give:

| keys | handler |
|---|---|
| Shift+C | `0x00412edd` |
| Shift+D | `0x00412ecc` |
| Shift+E | `0x00412eee` |
| Shift+F | `0x00412eb0` |
| Shift+J | `0x00412f0b` |
| Shift+N | `0x00412f44` |
| **Shift+S** | **`0x00412f86` — `xor byte [0x415735],1`, the sound flag** |
| Shift+V | `0x00412f9e` |

Shift+U (`0x412e6e`, checked before the switch) is undo. The whole key path is
additionally gated on `[0x0041571c] == 0` (idle state).

Sound flag `0x00415735` starts at 0 (read from `.\bricks.ini` `[winbrk]` with
`GetPrivateProfileIntA`); `PlaySoundA("bricks%02i.wav", 0, 3)` at `0x0040b95d`
is guarded by it.

Verified command (both dumps and the icon repaint are asserted by
`test/test-bricks-drag.js`):

```
node test/run.js --app=bricks --no-close --max-batches=140 --batch-size=1000 \
  --input='50:mousedown:240:450,51:mouseup:240:450,90:dump-mem:0x415735:1,\
95:keydown:16,96:keydown:83,100:keyup:83,101:keyup:16,115:dump-mem:0x415735:1'
```

`0x00415735` goes `00 -> 01`, and the only pixels on the whole 640x480 screen
that change are the 17x17 speaker glyph at (29,178) — the crossed-out overlay
comes off.

## Dragging a brick: ClipCursor around the grab point

`0x00413152` starts a drag. It takes the window's screen origin
(`call [0x40115c]`, the POINT/RECT at `[esp+0x10]`), reads the half-extent
`a = [0x415736]`, and writes a **screen-coordinate** RECT at `0x00415ee0`:

```
[0x415ee0] left   = originX + clientX - a
[0x415ee4] top    = originY + clientY - a
[0x415ee8] right  = originX + clientX + a + 1
[0x415eec] bottom = originY + clientY + a + 1
```

then `ClipCursor(&that)` and `[0x41580c] = 1`. So the cursor is pinned to a
tiny box (measured `a = 5`, an 11x11 box) centred on the grab point. The piece
advances one cell only when a WM_MOUSEMOVE arrives **at the clipped edge**; the
app then calls `SetCursorPos` to re-centre and re-clips. WM_LBUTTONUP calls
`ClipCursor(NULL)`.

This is why the renderer must clamp injected/real mouse coords to the guest's
clip rect (`_applyCursorClip` in `lib/renderer-input.js`, fed by the
`clip_cursor_*` exports off `$clip_cursor_l/t/r/b` in `src/01-header.wat`).
Without the clamp the cursor sails past the edge and no move is ever seen.
Fixed in `7fa84e0c` (horizontal) and `21b53a03` (vertical); regression is
`test/test-bricks-drag.js`.

Working drag, screen coords, with the board already up:

```
95:mousedown:305:293,96:mousemove:282:293,97:mousemove:259:293,98:mouseup:259:293
```

The trace then shows `ClipCursor(0x00415ee0)` from `ret=0x004131ad`, the second
move delivered clamped to the box edge, `SetCursorPos` from `ret=0x0040c564`,
and the brick one cell to the left (~1800 changed pixels in the board rect).

## Geometry cheat sheet (640x480 screen, window at 20,20)

Client origin is (24,44), i.e. `client = screen - (24,44)`.

| thing | screen |
|---|---|
| "Press left button" start bar | 240,450 |
| speaker (S) glyph | 38,185 |
| N / V / E / J glyphs | 38,218 / 38,250 / 38,277 / 38,305 |
| board rect (pieces) | ~185,145 .. 330,335 |

The window is 648x508, so on a 640x480 screen the right-hand button strip is
clipped. Use `--screen=800x600` to see all of it.

## Local idle CPU verification (2026-09-10)

This is a non-realtime Klotski puzzle, not a breakout game. Headful Chrome,
1280x900 desktop, local source304: click start(240,450), hold220ms. The actual
board uses0.93% renderer CPU over15s, with main slices4 ->4 and yield7.
Then the drag route above, with220ms between moves, visibly moves the bottom
right block left:1838 changed board pixels and `MOVES: 1`. Subsequent15s
renderer CPU0.84%, main slices9 ->9, yield7, no page errors. Host loads18.15
and15.65 mean these are no-spin evidence, not precise quiet-machine timings.
Raw screenshots/JSON: `/private/tmp/wa-idle-bricks-board304` and
`/private/tmp/wa-idle-bricks-drag304`. No runtime change or deployment.

## Ruled-out input hypotheses

- *"Clicks on the icon column are being dropped by the renderer."* No: the
  messages arrive with correct client coords and the app's own handler enters
  and declines them (see above).
- *"The icons are child windows the emulator does not route to."* No: exactly
  one `CreateWindowExA` in the whole run.
- *"The drag needs GetCursorPos / GetAsyncKeyState polling."* No: the app reads
  the position from `lParam`; `GetCursorPos` is never called.
