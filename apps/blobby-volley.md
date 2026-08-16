# Blobby Volley 1.7.4

Beach-volleyball arcade game, 2001, Delphi/VCL front end over DirectDraw.
**Status: playable.** Boots to the animated menu, and clicking SPIEL STARTEN
starts a live single-player match — court, net, both blobbies, ball physics and
scoring all run. No emulator changes were needed to get here.

## Binary Info

- **File:** `test/binaries/candidates/blobby-volley/volley.exe` (361,472 bytes, 2001-06-07)
- **Image base:** 0x400000, sizeOfImage 0x5d000
- **Sections:** CODE (0x4b5c0), DATA, BSS, .idata, .tls, .rdata, .reloc, .rsrc
  — Borland section naming, i.e. Delphi
- **Provenance:** `.candidate-source.json` — archive.org `volley.zip`, sha1
  `8d22d891…`
- **Assets beside the exe:** `graph.pak` (619KB, all backdrops and sprites),
  `sound.pak` (20KB), `text.pak` (2.6KB)

## Imports

Static: kernel32, user32, gdi32, advapi32, oleaut32, ole32, comctl32, version,
winmm. **No ddraw/dplay in the import table** — both are `LoadLibraryA`'d at
runtime:

| DLL | Loaded from | Used for |
|---|---|---|
| `DPlayX.dll` | 0x440598 | DirectPlay, network match only |
| `DDraw.dll` | 0x441b48 | the entire game display |

## Startup shape (this is the part worth knowing)

It is a stock VCL app, so the window layout is not what a hand-written Win32
game would produce:

| hwnd | class | Notes |
|---|---|---|
| 0x10001 | `TApplication` | created **first**, 0x0 at (320,240) — becomes `$main_hwnd` |
| 0x10002 | `TForm1` | the real UI window, 800x600 at (0,0), owned by TApplication |
| 0x10003 | `TThreadWindow` | VCL's cross-thread `Synchronize` sink |

The game runs on a worker thread (T1) while the main thread sits in a VCL idle
loop — `PeekMessageA` / `WaitMessage` / `GetCursorPos` / `WindowFromPoint`,
thousands of iterations. Two consequences:

1. **It never calls `GetMessageA`.** All injected input has to survive
   `$handle_PeekMessageA`'s hardware-input path in
   `src/09a5-handlers-window.wat`.
2. **Keyboard focus is not automatic.** With nothing focused, `check_input_hwnd`
   falls back to `$main_hwnd`, which is the 0x0 `TApplication` window, so keys
   go nowhere. A click on the form sets focus to 0x10002 first. (Any Delphi app
   will show this shape; it is worth remembering before blaming an app's input
   handling.)

The 87 `LoadStringA` calls at startup — "Gleitkommaüberlauf", "Zugriffsverletzung
bei Adresse %p" and friends — are Delphi's standard exception-message resources
being cached. They are not errors.

## Driving it from the harness

The menu is mouse-driven (the manual says "Clicking this menu option starts a
new game"), and **a click alone does nothing**: the game tracks the pointer from
`WM_MOUSEMOVE` and hit-tests menu entries against its own cursor, ignoring the
click's lParam. Move first, then click:

```
--input=500:mousemove:400:222,520:mousemove:401:223,560:mousedown:401:223,600:mouseup:401:223
```

The second mousemove matters — the game only redraws its cursor on a delta.
It boots in German; the entries in the 640x480 frame sit at x≈300-510, 36px
apart. y=222 and y=366 are verified by clicking them; the rest follow the same
spacing.

| y | Entry | After ENGLISH PLEASE |
|---|---|---|
| 222 | SPIEL STARTEN | START GAME |
| 258 | NETZWERKSPIEL | NETWORK MATCH |
| 294 | STATISTIK | STATISTICS |
| 330 | EINSTELLUNGEN | SETTINGS |
| 366 | ENGLISH PLEASE | DEUTSCH |
| 402 | ENDE | QUIT |

Clicking y=366 does swap the whole menu to English, which is a cheap way to
confirm both the click path and `text.pak` (all three `.pak` files are opened
at startup).

Timing at `--batch-size=200000`: menu art is up by batch ~480, the match starts
within ~100 batches of the click. `test/test-blobby-volley.js` reaches a live
match in 700 batches, about 16s wall on an idle box.

Frame colors, for pixel asserts: sand 167,154,83 · daylight sky ~60,98,235 ·
player-1 blobby 192,0,0 · player-2 blobby 0,192,0 · menu logo outline 54,44,247.
The menu backdrop is a night beach (mean luminance ~26), the court is daylight
(~115) — that difference alone distinguishes the two screens.

## Regression coverage

`test/test-blobby-volley.js` (in `test/run-all.sh`, e2e tier), 9 checks: clean
exit, no unimplemented API, the VCL two-window startup, the decoded menu art and
logo, and — after the scripted click — daylight sky + sand shares and both
blobbies on court.

## Open

- **Network match (`NETZWERKSPIEL`) is untried.** It is the reason this app was
  picked as the async-I/O demo in `TODOS.md` item 3: it loads `DPlayX.dll` for
  DirectPlay over TCP/IP. Nothing in the DirectPlay path has been exercised
  yet, and it is the natural next step — it would pair with the virtual-LAN work
  in `src/09d-winsock.wat` and `lib/vlan-wire.js` (TODOS item 4), which already
  joins two emulator processes into one room.
- **Promotion out of `candidates/`.** `index.html` already launches it (option
  `blobby_volley`, with the three `.pak` files mounted) but the comment there
  keeps it "local and debug-only… until Blobby is ready for promotion". On the
  evidence above it is ready; the move needs an asset-layout decision, so it is
  left for whoever owns that.
- **Sound is unverified.** `sound.pak` is opened at startup but nothing checks
  that a sample ever reaches `waveOut*`.
