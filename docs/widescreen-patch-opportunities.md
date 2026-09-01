# Widescreen / high-res opportunities per app

Status 2026-08-31. This is a **backlog document**: no app settings, config seeds,
or byte pokes have been applied. The one emulator-side change that landed is the
mode-enumeration widening (see baseline below). Everything else here is a
verified recipe waiting for a decision to wire it up.

Every mechanism below was checked against **our** binaries (demo/shareware
builds), not taken from the web as-is — community patches are written against
retail and several claims did not transfer. Corrections are listed so the next
session does not re-trust the same sources.

## Emulator baseline (what a guest sees today)

- The guest desktop is already arbitrary-resolution: `get_screen_size` packs the
  live canvas, nothing rounds to 4:3.
- `IDirectDraw::EnumDisplayModes` (`src/09a8-handlers-directx.wat`) advertises
  10 resolution slots — 640x480, 800x600, 1024x768, 1152x864, 1280x1024, the
  host canvas (rounded down to a multiple of 8, clamped 640x480..1920x1080),
  320x200 (8bpp only, raw index 18 — Jazz2 cinematics), 1280x720, 1600x900,
  1920x1080 — at 8/16/32bpp where applicable, 28 modes total.
- `EnumDisplaySettingsA/W` (`src/09a3-handlers-audio.wat`) walk the same table
  densely (28 rows, FALSE past the end); `ENUM_CURRENT_SETTINGS` returns the
  canvas. Regression: `test/test-display-mode-enumeration.js`.
- `SetDisplayMode` accepts any WxH and never refuses.
- Exclusive presentation letterboxes, never stretches
  (`lib/renderer.js` `_computeExclusiveTransform`).

Open emulator issues that gate some recipes:

- **RCT crash above 800x600** — marker `0xCA002E20`, guest RETs at `0x407165`
  into string data with ESP inside the threaded-code region. Our bug; it is why
  the RCT `launchPrefs` poke was removed 2026-08-26 (`apps/rct.md:346-356`,
  `test/test-launch-prefs-resolution.js:66-80`). Gates every RCT recipe.
- `GetDeviceCaps(HORZRES/VERTRES)` ignores an active DirectDraw mode while
  `GetSystemMetrics(SM_CXSCREEN)` honors it (`src/09a4-handlers-gdi.wat:1601`
  vs `src/09a-handlers.wat:3475`) — a game mixing the two sees two screens.
- `ChangeDisplaySettingsA` returns success for a mode it never applies; an app
  that sets a mode and re-reads it through GDI sees the canvas.
- `launchPrefs` is plumbed in both hosts (`lib/app-profiles.js`,
  `host.js`, `lib/browser-shell.js:615`, `test/run.js:3624`) but
  `LAUNCH_PREFS = {}` — there is currently no live poke to copy from.
- **DLL pokes are an implementation gap**: `launchPrefs` patches the EXE after
  `load_pe`; poking a DLL (Diablo II's `d2gfx.dll`) needs the DLL's load base.

## Corrections: retail claims vs our binaries

| Web claim (retail) | Our demo/trial binary |
|---|---|
| TA registry `…\Total Annihilation` | `…\Total Annihilation Demo` (traced live) |
| TA `-screenwidth`/`-screenhight` args | absent — registry only |
| MW3 `…\MechWarrior 3\1.0` | `HKCU\SOFTWARE\MicroProse\MechWarrior 3 Demo\0.183` |
| JJ2 `VideoSize` REG_BINARY | subkey with DWORDs `Width`/`Height`/`BPP` |
| GTA2 keys under HKCU | `HKLM\SOFTWARE\DMA Design Ltd\GTA2\Screen` |
| AoE2 `Screen Width`/`Screen Height` regvals | not present in the trial (retail-AoC only) |
| AoE argv `NoStartup NormalMouse` | uppercase tokens; AoE1 trial has `NORMALMOUSE` but no `NOSTARTUP` |

## Per-game verdicts

NATIVE_CONFIG = engine takes a resolution from registry/ini/args and renders it.
PORTABLE_POKE = documented hex technique re-derived against our binary.
NOT_PORTABLE = community solution is an injected DLL / replacement engine /
build-gated patch that cannot apply to our build.

| Game | Native mechanism | Community patch | Verdict | Confidence |
|---|---|---|---|---|
| total_annihilation_demo | registry `DisplaymodeWidth`/`Height`, arbitrary WxH | v3.9.02 replacement exe (unneeded) | **NATIVE_CONFIG** | high (traced) |
| deus_ex_demo | `System/DeusEx.ini` `[WinDrv.WindowsClient]` viewport keys (lines 68-72; SoftDrv present) | — | **NATIVE_CONFIG** | high |
| quake2_demo | `sw_mode`/`gl_mode` index into fixed 10-entry table | — | **PORTABLE_POKE** (8 bytes) | high |
| rct | none; 3 hardcoded slots + `Game.cfg[0x17]` selector | ComputerLife22 slot swap; jeFF0Falltrades clamp patch | **PORTABLE_POKE**, gated on our crash | high |
| mw3 | registry `InGameVMode` DWORD (+`*_SW` renderer pin) | Teleguy HUD assets | **NATIVE_CONFIG** | high key / med values |
| gta2_demo | `window_width`/`full_width`/`start_mode` (strings confirmed, HKLM) | GTAMP (offsets unpublished) | **NATIVE_CONFIG** | high |
| halflife_uplink | `HKCU\Software\Valve\…\Settings` `ScreenWidth`/`Height`; `-w`/`-h` | WON res patch | **NATIVE_CONFIG** | med-high |
| diablo2_demo | `-w`, `-res640`/`-res800` | 5-site hex recipe (retail offsets) | **PORTABLE_POKE** — sites located in our build, but in `d2gfx.dll` | high |
| aoe1 / aoe2 | bare-number argv token (`EMPIRES2.EXE NOSTARTUP 1280`); AoE1 ≤1024, AoE2 ≤1280 | aoe2wide (MD5-gated, rebuilds `interfac.drs`) | NATIVE_CONFIG to stock modes | med (trial untested) |
| jazz2_demo | `VideoSize` subkey; fixed list, 640x480 max | JJ2+ = exe patch + guest `plus.dll` → 800x600 | NATIVE_CONFIG (capped) | high |
| mcm | in-game menu, 800x600 ceiling | — | NATIVE_CONFIG (narrow) | med |
| captain_claw_demo | typed cheats `MPINCVID`/`MPDECVID` → up to 1280x1024 | — | PORTABLE_POKE (keystrokes) | med |
| caesar3_demo | 3 fixed modes; binary `c3.inf`, no registry | c3resPatcher (SHA-gated to retail 1.0.1.0) | **NOT_PORTABLE** to demo; re-derivable | high |
| heroes2_demo / heroes3_demo | none (F4 windowed = scaling only) | HD Mod = per-version patched exe + hook DLLs; refuses this lineage | NONE_EXISTS / NOT_PORTABLE | high |
| diablo_demo / diablo_shareware | none | every "D1 HD" replaces the engine (Belzebub = SDL2/GL) | NONE_EXISTS | high |
| starcraft_shareware | none | Resolution Expander = injected DLL, 1.16.1-only | NOT_PORTABLE | high |
| worms2_demo | none | wkReSolution = WormKit injected DLL, offsets unpublished | NOT_PORTABLE | high |
| fallout_demo | none | Mash Hi-Res patch rejects `FALLDEMO.EXE` by name | NOT_PORTABLE | high |
| abedemo | none — always 640x480 | DDhack only upscales output | NOT_PORTABLE | high |

Fixed-surface 2D titles not listed (Baldur's Gate demos, Icewind Dale, Civ2,
Liquid War, Cave Story, …) get widescreen only as letterbox/crop on our side of
the boundary. Windowed GDI apps are trivially fine on any desktop size.

## Ranked recipes (when we decide to wire them)

1. **Total Annihilation — zero patching.** Traced end to end: queries
   `DisplaymodeWidth`/`Height` under
   `HKCU\Software\Cavedog Entertainment\Total Annihilation Demo`, gets
   not-found, writes back 640/480. Recipe: `startupRegistry` DWORDs. Menus stay
   640x480 by design — validate on a gameplay frame, not a shell `--png`.
2. **Deus Ex — two-line ini edit.** `WindowedViewportX/Y` in the
   `DeusEx.ini` we already mount (`lib/apps.js:716-728`); mount a modified copy
   via `vfsPath` exactly as Quake II's `config.cfg` is mounted. Cost: UE1
   software rasterizer at wide resolutions; watch vert- FOV.
3. **Quake II — fully specified 8-byte poke.** `vid_modes[]` in our exe at VA
   `0x0044d418` (raw `0x4b018`), 10 × 16 bytes `{char* desc, int w, int h,
   int mode}`. Mode 9's dimensions live at `0x0044d4ac` / `0x0044d4b0`; poke
   them and add `+set sw_mode 9` (or `gl_mode`) to args. ref_soft renders 8bpp
   indexed at any resolution.
4. **RCT — derived, but sequence matters.** All three published patterns occur
   exactly once in our unpacked `RCT.exe`:
   - mode-3 slot: `0x40137c` push 768, `0x401381` push 1024, `0x401395`
     mov [ebp-4],1024, `0x40139c` mov [ebp-0xc],768
   - width clamp: `0x401456` cmp 1280, `0x401463` mov 1280
   - height clamp: `0x40146a` cmp 1024, `0x401477` mov 1024
   Patching alone does not help: this is the same fullscreen path that crashes
   us (`0xCA002E20`). The promising experiment is the **windowed route** —
   `Game.cfg[0x17]=00` plus the clamp patch — which sidesteps `SetDisplayMode`
   and possibly the whole crash.
5. **MechWarrior 3 — one DWORD.** Seed `InGameVMode` under
   `HKCU\SOFTWARE\MicroProse\MechWarrior 3 Demo\0.183` and re-trace; our
   6000-batch run only observed the open→not-found, so read-back is
   unconfirmed. The `*_SW` values also pin the software renderer.

Cheapest experiments outside the top five: **AoE1/AoE2** are an `args` change
only (`EMPIRES2.EXE NOSTARTUP 1280`). **Diablo II** turned out easy to
re-derive: `d2gfx.dll` (Shareware v1.04) has two clean if/else selectors at
`0x100044ac` and `0x10004a4c`, four immediates each (width → `[ebp-8]`,
height → `eax` then global `0x1001c528`); there is no `d2client.dll` in this
build (client code is in the exe). Blocked on the `launchPrefs` DLL-base gap
above.

## Structural notes

- **We are the mode enumerator.** GTA2 (`start_mode`), Half-Life fullscreen and
  DirectDraw surface creation resolve resolution through *our*
  `EnumDisplayModes`. For index/list-driven games, widening the advertised
  table (done) beats poking the guest.
- **Caesar III is genuinely not poke-able.** Its three modes are ~9 independent
  inline `.text` constants per dimension and there is no mode table (`.data`
  has zero adjacent 640/480 or 800/600 dword pairs). That constant-folding is
  why the community wrote the Julius engine instead of a hex patch. By
  contrast HoMM2 and HoMM3 each have exactly one such pair (`0x004e91d8`,
  `0x005e937c`) — a lead worth an hour, though the community verdict for both
  is that only scaling exists, no playfield widening.

## Sources

id-Software/Quake-2 `win32/vid_dll.c` · SlashWork `d2widescreenhack.md` ·
SGD2FreeRes (mir-diablo-ii-tools) · jeFF0Falltrades/rct_patch ·
c3resPatcher (gitlab dr_afdch) · bvschaik/julius `settings.c` ·
withmorten/aoe2wide · MS KB Q175347 (AoE1) / Q242227 (AoE2) ·
PCGamingWiki + WSGF: Total Annihilation (WSGF via mirrors — 403 to fetchers) ·
DxWnd MW3 thread (sourceforge) · Jazz2Online JCF t-19223 · jj2.plus ·
StepS/wkReSolution · Resolution Expander (moddb) ·
beyondunrealwiki `deusex-ini` · GTAMP forum t=244 ·
Vault-Tec Labs Fallout 1 Hi-Res Patch · PCGamingWiki: Abe's Oddysee, Claw
