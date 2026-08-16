# TODOS

Snapshot of remaining work, written 2026-08-16 by picking up five Claude sessions
that ran the night of 2026-08-15 and stopped mid-flight. Each item names the
session that owns it, the files it touches, and what the *next* concrete step is.

Session transcripts live in
`~/.claude/projects/-Users-vg-Documents-projects-phone-wine-assembly/<id>.jsonl`.
Coordination history is `messageboard.txt` (append-only; entries 1180-1220 cover
this stretch).

Tree state at time of writing: HEAD `209aa00`, working tree clean, build green,
corpus sweep 106 PASS / 0 FAIL.

---

## 0. Blocking question: are the 24 e2e failures real?

**Priority: highest. Nobody owns this yet.**

`test/run-all.sh` in the shared tree at 23:58 gave **151 passed / 27 failed**:
unit 92/2, e2e 58/24, smoke 1/1. The two unit failures are known and owned
(`test-winhelp-wat-parser`, `test-gdi-public-api-status` 245-vs-244).

The 24 e2e failures are **not** from the prop-atom fix — sampled reasons are
glyph, frame, and dialog-lifecycle asserts:

| Test | Assert that fails |
|---|---|
| `test-regedit-deep` | `tree displays classic folder glyphs (0 yellow px)` |
| `test-mspaint-options` | `tool-options margin stayed button-face gray` |
| `test-spider-messagebox` | `No button has full raised frame` |
| `test-find-cancel` | `titlebar X cleared dlg global`, `open #2 got a fresh dlg hwnd` |
| `test-solitaire-resize` | width/height did not grow after corner drag |
| `test-cwordzap-render` | RLE4 splash white field / colored logo |

Most plausible sources, both of which landed **without an e2e run**:

- `eff03cb` "Delete the JavaScript text path" + `45e58ae` (fonts session; it said
  outright that the e2e tier was never run against either commit)
- the `WNDPROC_DIALOG 0xFFFE0002 -> 0xFFFF0004` move (board entry 22:30), which
  fits the `find-cancel` dialog-hwnd failures

**Next step:** run `bash test/run-all.sh e2e` at the commit *before* the font-path
deletion, in a worktree, and diff the FAIL name sets against the current run.

**Do not repeat the mistake that wasted the last attempt:** the abandoned worktree
at `~/.claude/jobs/b303255f/tmp/wt5` symlinked only `test/binaries`, so it had no
fonts and failed 83+ tests including every `test-wat-gdi-*`. Its numbers are
meaningless. Delete it. A baseline worktree needs the font assets too.

---

## 1. Win16 / NE loader — Phase 2 (session `ebc2c6b0`)

Phase 1 is committed (`0c23c78`): NE segments load and fixups link, 2452 checks
green across WINMINE / FREECELL / MSHEARTS / SOL / CARDS.DLL. **Nothing executes
yet.**

- Files: `src/08c-ne-loader.wat`, `test/test-ne-loader.js`, `src/01-header.wat`
  (globals + data at `0x11E70` Win16 module names, `0x07E08400` WIN16_SEG_TABLE),
  `src/08-pe-loader.wat` (NE branch in `load_pe`), `lib/compile-wat.js` WAT_FILES
- Tooling: `tools/ne-dump.js`, binaries in `test/binaries/win98-16bit/`
- Next: 16-bit instruction decode, then the Win16 API layer. The session had just
  started reading the prefix/ModRM machinery and posted a board notice that it was
  entering `src/07-decoder.wat` — **coordinate before editing the decoder.**
- Closes the 4 SKIPs in the corpus sweep, which are all 16-bit NE executables.

## 2. Fonts — e2e verification and the original measurement (session `ea1ba02f`)

- Files: `src/10b-gdi-font.wat`, `src/10c-truetype.wat`, `lib/host-imports.js`,
  `lib/font-substitutions.js`, `fonts/substitutions.json`,
  `tools/v86-reference/*`, `test/fixtures/font-metrics.json`,
  `test/test-wat-font-metrics-reference.js`
- Commits `eff03cb`, `45e58ae` have unit coverage and a byte-identical notepad
  render, but **no e2e run** — see item 0, which is largely this.
- Its own stated next step ("#1"): the original measurement question, now that the
  measurement infrastructure exists; item #3 on its list comes free with it.
- Still open and font-shaped: `test-winhelp-reference` fails on
  `WinHelp close glyph differs from Win98`.

## 3. Async I/O demo path (session `410075d6`)

Ended on a question to the user, never answered:

- **Telnet first** as a cheap async-I/O proof — `apps/telnet.md`. It creates a 0x0
  `WS_POPUP` window, never calls `ShowWindow`, and pumps messages forever; the XP
  console client also needs console rendering.
- **Blobby Volley** as the demo afterward.

## 4. Virtual LAN / TetriNET (session `b303255f`) — mostly landed

- `ecd3a6b` + `209aa00` now carry the round-trip gate and the prop-atom fix.
  Verified: corpus 106 PASS / 0 FAIL, `test-vlan-tetrinet` 6/6.
- Files: `src/09d-winsock.wat`, `src/09a5-handlers-window.wat`,
  `test/test-vlan-tetrinet.js`, `test/test-wat-winsock-hostname.js`
- Remaining: the browser wiring for the virtual LAN (`lib/vlan-wire.js` currently
  proves loopback + cross-process; the browser side is unbuilt).

## 5. WinHelp (session `351afaf4`) — clean, one open item

- `87a9546` verified: parser 606/7, `test-help` 5/5, `winhelp-dll-macro` 6/6.
- Files: `src/09c6-winhelp-core.wat`, `src/09c7-winhelp-hlp.wat`,
  `src/09c9-winhelp-ui.wat`, `tools/hlp-wat-check.js`
- Open: the close-glyph mismatch above (font work, not parser work).

---

## Cross-cutting, carried over from earlier sessions

- **Screensaver GDI-bridge regression** — `apps/screensavers.md` Task 0, fixed
  2026-08-15 via the RLE DIB path; re-read before trusting it, since
  `test-cwordzap-render`'s RLE4 asserts are failing again in the current e2e run.
- **d3rm `MeshBuilder::Load` / ProgressiveMesh** — `apps/screensavers.md` Task 3,
  `apps/d3drm.md`. Minimal repro is DX SDK `viewer.exe` loading `camera.x`;
  `Load` returns `D3DRMERR_NOTFOUND (0x88760311)`. Blocks the DX5 D3DIM Viewer
  WARN and the Organic Art screensavers' mesh render.
- **CITYSCAP blank screen** (Task 2, MEDIUM), **FOXTROT white silhouettes**
  (Task 1, LOW).
- **CD Player** renders frame and menu but not its transport controls — the only
  other unresolved emulator bug among the sweep WARNs.
- **External-asset WARNs** (not emulator bugs; each names its blocker in
  `test/test-all-exes.js`): Kodak Preview needs OIDIS400+OIADM400, HyperTerminal
  needs HYPERTRM.dll, Welcome98 needs `welcome.dat`, IP Config has no adapter,
  JigSawedME and Rodent2000 need the VB6 runtime, XP EOL is version-gated by
  design.

---

## Hazard worth knowing about

Something in this shared tree rewrites whole `src/` files that other agents have
dirty. A verified `$prop_key` fix was reverted from disk between a read and a
commit; `git commit <path>` then silently committed only the other file, and the
loss was visible only in the `1 file changed` stat. **Check the file count in
commit output — do not assume your hunks landed.**
