# DirectAnimation support — design notes

Status: **design only, not implemented**. Captures what we learned while
investigating CORBIS/FASHION/HORROR/WOTRAVEL screensavers (Plus!98) so a
future session doesn't re-discover the surface.

## Guests that need it

| Binary | What it calls |
|---|---|
| `CORBIS.SCR`   | `DirectAnimation.DAView`, `DirectAnimation.DAStatics` |
| `FASHION.SCR`  | same (shared MFC framework) |
| `HORROR.SCR`   | same |
| `WOTRAVEL.SCR` | same |

All four use the same Plus!98 MFC screensaver framework. Fixing one fixes
four. They load media from a registry-configured directory
(`HKLM\SOFTWARE\Microsoft\Plus!98\ScreenSavers.<Name>\MediaDirectory`),
pipe it through a DirectAnimation DAG, and composite onto a DirectDraw
surface we already manage.

## Current failure mode

1. `CoCreateInstance(CLSID_DirectDrawFactory)` ✓ (short-circuited).
2. `IDirectDrawFactory::CreateDirectDraw` → `IDirectDraw::CreateSurface` ✓.
3. `CLSIDFromProgID(L"DirectAnimation.DAView")` → `REGDB_E_CLASSNOTREG`.
4. `CLSIDFromProgID(L"DirectAnimation.DAStatics")` → `REGDB_E_CLASSNOTREG`.
5. Guest reads `MediaDirectory` (not in registry) and an internal fallback.
6. EIP runs away to `0x0053f3ad` — almost certainly an indirect call through
   an uninitialised DAView vtable pointer that the guest assumed was
   populated.

## Three options, roughly ordered by cost

### A. Graceful degrade (cheapest, no animation)

Find the call site of the failed CoCreateInstance, confirm the runaway is a
missing null check, and make the saver sit on a black screen (or exit
cleanly) instead of corrupting EIP.

- **Cost:** hours. Single call-site fix or a better error return from
  `CoCreateInstance`/`CLSIDFromProgID`.
- **Win:** no crash, but still no animation. Matches current user-visible
  behaviour (black screen) — only difference is cleanliness.
- **When to pick:** always do this first regardless of whether we pursue B or C.

### B. Hand-rolled DirectAnimation shim (medium cost, partial coverage)

Implement just enough `IDAStatics`/`IDAView`/`IDAImage`/`IDABehavior` to
run these four savers and nothing else.

```
IDAStatics        ~40 methods — at minimum: ImportImage, ImportSound,
                   ModifiableBehavior, NumberB, StringB, Compose2,
                   DetectCollision
IDAView           ~15 methods — StartModel, Tick, Pause, SetRenderTimeout
IDAImage          ~20 methods — Transform, Crop, Tile, Opacity, Overlay
IDABehavior       ~30 methods — animate-able scalar/vector base class
IDANumber / IDAPoint2 / IDAPath2 / IDATransform2 …
```

All four savers are **OLE-Automation** guests, so they reach these methods
through `IDispatch::Invoke`, not through the vtable directly. The shim
therefore also needs:

- An `IDispatch` plumbing layer (`GetIDsOfNames` + `Invoke`) backed by a
  per-interface DISPID → `api_id` table.
- `VARIANT`/`SAFEARRAY` argument marshalling into our existing COM
  dispatcher.
- `BSTR` path I/O against our VFS.

Behaviors in DirectAnimation are **time-varying expression trees**, not
draw calls. You don't "draw" the DAG — you evaluate it each tick to yield
a frame. Most of the work is building a tiny evaluator for the behavior
subset these savers actually compose, plus a compositor that lands the
result on the IDirectDraw primary surface we already own.

- **Cost:** weeks. ~100+ COM methods plus an IDispatch layer plus a
  behavior evaluator plus a compositor.
- **Win:** four savers run. IDispatch plumbing is reusable for other
  OLE-Automation guests (VB apps, ActiveX content).
- **Risk:** the scope creeps the moment we look at a fifth DA guest.

### C. Load real `danim.dll` (high cost, high coverage)

Drop the redistributed DLL into `test/binaries/dlls/` and let the emu's PE
loader resolve it the way it already does for `mfc42u.dll` / `msvcrt.dll`.

**Redist status.** Shipped with IE 4/5 and the DX Media 6 SDK (1998). The
original EULA permitted redistribution with a shipping app. Microsoft
retired it around IE6 (2001); not in any current DX redist. Legally grey
for new distribution, fine for local / preservation use. Plus!98 users
have it on disk. Same posture as the `msvcrt.dll` / `mfc42u.dll` we
already ship under `test/binaries/dlls/`.

**What it costs us on the emulator side:**

```
danim.dll (~2.3 MB) imports from:
  ole32, oleaut32       heavy (IDispatch, SafeArray, VARIANT, apartments)
  ddraw, d3drm, d3dim   partial, already in use
  dsound, dmusic        not implemented
  urlmon, wininet       not implemented (streams media over HTTP)
  msvcrt                have
  kernel32/user32/gdi32 have, hits APIs we've never needed
```

Plus:

- Heavy **MSVC C++ EH** — we have SEH but C++ throw has been fragile
  historically (see D3DRM "No valid modes" for an example).
- **MMX/SSE** inner loops — not in the decoder today.
- **COM apartments** + free-threaded marshaler — stubs needed for
  single-threaded emu.
- Self-registration (`CoRegisterClassObject`) paths we don't have.

- **Cost:** weeks, with a long tail. Similar in shape to the mfc42u.dll
  integration, but mfc42u.dll only needed GDI/USER which we already had
  solid. danim.dll drags in DirectSound, urlmon, MMX, C++ EH corners.
- **Win:** correctness is free where the real DLL runs — behaviour
  evaluator, image decoders, compositor come from Microsoft. Scales to
  any DA guest, not just these four.
- **Risk:** unbounded tail of missing Win32/DX primitives that danim.dll
  happens to hit. Debugging moves from "read our code" to "reverse an
  unsymbolised MS binary". Historically the pattern that most often
  blows up the budget.

## Recommended path

1. **Do A now.** Harmless, cheap, stops the EIP runaway whatever we
   decide next.
2. **Defer B and C.** Neither is justified for four stock-photo savers.
   Higher-leverage screensaver work that's already close:
   - DDraw → canvas blit (unlocks WIN98.SCR animation — already 90% wired).
   - D3DRM geometry savers (ARCHITEC/FALLINGL/GEOMETRY/JAZZ/OASAVER/
     ROCKROLL/SCIFI) — see `apps/screensavers.md`.
3. **Revisit C if a non-saver DA guest appears** (IE-era ActiveX
   content, a VB app that wraps DA). The redist cost is the same but the
   coverage argument gets stronger.
4. **Avoid B as a standalone project.** If we ever need DA, load the
   real DLL — the evaluator/compositor math isn't the fun kind to
   re-derive.

## Assets

Plus!98 CAB (`PLUS98.CAB` on `/Volumes/PLUS98`, see memory
`reference_plus98_iso.md`) contains the media directories each saver
wants. If we ever do A-with-a-twist (fake DA that just slideshows the
JPGs/GIFs), the assets are already reachable — no VFS work needed.

## Pointers

- CLSID short-circuit and CoCreateInstance path:
  `src/09a7-handlers-dispatch.wat:551`
- `CLSIDFromProgID` stub: `src/09a7-handlers-dispatch.wat:834`
- DDraw factory / vtable: `src/09a8-handlers-directx.wat` (api_ids 1136–1140)
- Screensaver status matrix and prior investigations: `apps/screensavers.md`
