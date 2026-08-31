# Rodent's Revenge 2000 (VB6 remake)

`test/binaries/wep32-community/Rodent2000/Rodent2000.exe` — James Emmrich and
Alexander Popov, 2002. App id `rodent2000`; the app manifest mounts the five
shipped `Levels/0000*.rodent_level` files at `C:\levels\`.

## Reaching gameplay headlessly

The credits splash appears first. Open **Game > New Game** to deal the board:

```
node test/run.js --app=rodent2000 --max-batches=4300 --batch-size=2000 \
  --quiet-api --quiet-blocks --trace-fs \
  --input='2500:mousedown:155:38,2501:mouseup:155:38,\
2700:mousedown:165:58,2701:mouseup:165:58,\
4000:png:/tmp/rodent2000-game.png,4100:stop'
```

At 640x480, `155,38` opens Game and `165,58` selects New Game. A healthy frame
has the cyan border, olive floor, dense green block field, mouse, cats, and
score. `test/test-rodent2000-gameplay.js` checks those board colors and proves
all five numbered level files were read.

## Startup failure and fix (2026-08-30)

Before the fix, VB6 caught a failed embedded-picture decode and displayed
`Unexpected error`; no level files were opened. Tracing OLEAUT32 from
`OleLoadPictureEx` through its picture helper reached this call:

```
CreateIcon(instance, 32, 32, 0x00200001, 0x20, andBits, xorBits)
```

The apparent plane count is an ABI artifact. Win32 declares `cPlanes` and
`cBitsPixel` as `BYTE`. This Win9x OLEAUT32 build loads adjacent `BITMAP` WORD
fields with an overlapping dword read, but native USER32 consumes only the low
byte of each argument. The WAT handler had treated the entire 32-bit stack slot
as the plane count, tried to allocate a bitmap with 2,097,153 planes, returned
NULL, and OLEAUT32 translated that into `E_OUTOFMEMORY` (`0x8007000e`).

`$handle_CreateIcon` now masks both BYTE arguments before validating or creating
the color bitmap. `test/test-cursor-icon-indirect.js` passes deliberately dirty
high bits (`0x00200001` planes and `0x5a000020` depth) and requires a valid
32-bpp icon, matching the real OLEAUT32 call rather than a sanitized surrogate.

The initial black page is the remake's authored credits screen, not a failed
board render. Its blank visible caption was separate: VB6 sends `WM_SETTEXT`
through `DefWindowProcA` on the Thunder form, and the default procedure did not
yet implement that message. It now stores, paints, and mirrors the caption;
the gameplay test requires `Rodent's Revenge 2000` (or its active Level suffix)
on the visible form before accepting the dealt board.

## Browser Worker keyboard routing (fixed 2026-08-30)

When the Worker has no live child focus, keyboard messages now fall back to the
front visible top-level owned by that guest instead of hwnd 0. The browser
regression opens Game > New Game through the real menu, holds Right, and checks
the rendered board rather than accepting key logs alone. The verified run
changed 893 pixels and retained the complete `Rodent's Revenge 2000 - Level 1`
frame: caption/menu, lives and score strip, cyan border, olive floor, green
blocks, mouse and cats were all visually inspected.
