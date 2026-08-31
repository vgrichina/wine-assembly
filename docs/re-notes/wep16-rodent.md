# Rodent's Revenge (WEP2, 16-bit)

`test/binaries/wep16/WEP2/RODENT.EXE` — Microsoft Entertainment Pack 2, 1991,
Christopher Lee Fraley, written in Visual Basic 1 (NE, links VBRUN100 plus the
pack's FIELD100 custom control and WEPUTIL). App id `wep16_rodent`; it is on the
desktop (`DESKTOP_APPS`) as of 2026-08-25.

There is a second Rodent's Revenge in the tree — `Rodent2000` in
`test/binaries/wep32-community/`, a 2002 VB6 remake. Both editions are playable;
the original remains the desktop edition and the remake is separately
selectable as `rodent2000`. See [rodent2000.md](rodent2000.md) for the remake's
OLE picture startup fix and gameplay command.

## Reaching gameplay headlessly

The app deals a board at launch, but a *game* only starts from the menu:

```
node test/run.js --app=wep16_rodent --max-batches=11000 --no-close \
  --input='6000:click:203:71,7000:click:230:92,8500:png:/tmp/a.png,\
8600:keydown:38,8700:keyup:38,8900:keydown:38,9000:keyup:38,10500:png:/tmp/b.png'
```

`click:203:71` is the Game menu, `click:230:92` is New Game. Arrow keydowns then
push a column of blocks and the score climbs (5 → 12 over three keys, 1317 px
changed in a 232x264 box). Menu-bar hit points at 640x480: Game `203,71`,
Options `253,71`, Help `300,71`; Game popup items at y = 92 / 112 / 133 / 173.

A 16-bit app reports **0 API calls** and prints no host census when it is
healthy — that is not a sign of a dead run.

## Browser Worker startup (fixed 2026-08-30)

With the experimental **Threads** switch enabled, the NE executable was loaded
in slot 0's Worker but its NE DLLs were loaded into the idle main-thread WASM
instance. That split the selector/module state: RODENT's first far import into
VBRUN100 remained unresolved and trapped at `EIP=0x100010`.

The guest-worker protocol now runs `loadWin16Dlls` beside the instance that
loaded the NE task. Its `VBRUN100` selector, app-local modules, and far-import
fixups therefore share one arena. `test/test-worker-guest.js` keeps Threads on,
requires the Worker backend, and checks the rendered green Rodent board.

## Browser Worker keyboard focus (fixed 2026-08-30)

The renderer's Worker-owned WASM is only a browser-side shadow. Mouse clicks
updated its focus global, while slot 0 kept `$focus_hwnd == 0`; a following
arrow therefore reached the top-level form instead of the 276x276 VB picture
child that implements the board. The frame stayed alive and its timer kept
firing, which made this look like frozen rendering rather than wrong input.

Renderer focus changes now ride on the next slot-0 slice. The Worker performs
the normal `set_focus` notification and then mirrors USER's focus bookkeeping
before it dequeues a following key. Opening Game > New Game consequently leaves
live focus on `0x10005`, matching cooperative execution. The Worker browser
regression holds Right and requires the board to change; the 2026-08-30 run
changed 221 pixels with no trap. The reviewed frame has intact chrome, menu,
mouse counter, cyan border, olive floor, and green block field.

## Menu inventory and what each item does

Driven by click, item by item, on 2026-08-25. `menu-sweep.js` cannot do this
one: RODENT.EXE has no RT_MENU (`ne-dump.js --menus-json` returns `{}`) because
VB builds the menu at runtime from the form.

| Menu | Item | Verdict |
|---|---|---|
| Game | New Game (F2) | works — deals mouse, cats, blocks |
| Game | Pause (F3) | works — "Paused. Press F3 To Continue." |
| Game | High Scores… | **partial** — the Hall of Fame dialog paints (trophies, OK, Clear Scores) and VBRUN then raises `Control array element '0' does not exist` over it |
| Game | Exit | **broken** — VBRUN raises `Sub or Function not defined`; the app stays up |
| Options | Level… | **partial** — "Enter Starting Level: (1-50)" with Ok/Cancel paints, but the input box is not there: typing a digit and pressing Ok leaves the title at `[1]` |
| Options | Snail / Slow / Medium / Fast / Blazing | work — the radio check follows the selection (verified Slow → Blazing) |
| Help | Index (F1) | works — RODENT.HLP renders with live hyperlinks |
| Help | How to Play | works — own topic |
| Help | Commands | works — own topic |
| Help | Using Help | works — Help Topics dialog, Contents/Index tabs, 12 topics |
| Help | About Rodent's Revenge… | works — full WEP splash, author, VB credit |

Both "broken" verdicts are VBRUN100 runtime errors raised by the guest, not
emulator traps, so they name a missing piece of the VB1 runtime rather than a
GDI or USER gap. `Control array element '0' does not exist` and `Sub or Function
not defined` are the two to chase; the Level… input box is likely the same
control-array shortfall one form over.

## Status panel regression (fixed 2026-08-25, dec5373c)

The gray strip above the board — mouse count, stopwatch, score — turned into a
white band at some point after 2026-08-22. Bisected to `8fdf2f5f`, which fixed a
latent `i32.and`-with-a-boolean in BeginPaint's class-brush fill (the fill had
never actually run) and in the same move let it fire for a top-level window on
the creation-time erase seed. A VB form registers its class with
`COLOR_WINDOW+1` and paints its real BackColor itself, so that second erase is
**white**, over content the app had already drawn: 7645 px against the reviewed
v86 capture.

`dec5373c` gates that seed on `WS_CHILD`. That left the 32x32 stopwatch child
erased white the same way, one level down — 605 px — because children genuinely
do need the seed: IdleWild's IWINFO pane is white in Win98 for exactly that
reason and `test-win16-wep1-gameplay` asserts it.

The fix is ordering, not the seed. `$win16_rearm_visible_child_erases`
(`src/09e-win16-api.wat`) re-arms the deferred NC sequence for every visible
guest-wndproc child when a hidden parent is shown, and the erase bit was being
cashed in lazily at that child's *first BeginPaint* — after VBRUN had already
stamped the stopwatch into the picture control. USER erases when a window is
shown, before the app draws. Erasing right there at re-arm time and clearing
bit 1 restores that order: the capture is now pixel-identical (0 of 307200) to
the reviewed 2026-08-22 wine-assembly reference, and IdleWild still gets its
white background because its erase merely happens first instead of last.

The reviewed native reference is
`test/output/win16-v86-comparison/wep16_rodent/native.png` (`native.json` has
the v86 provenance); the 2026-08-22 wine-assembly capture beside it is a good
before-image for this area. Native runs at 4-bit VGA, so the board reads tan and
teal there against our olive and green — that difference is the palette, not a
bug.
