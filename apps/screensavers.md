# Plus! 98 Screensavers — Progress

**Binaries:** `test/binaries/screensavers/` (19 screensavers from Plus! 98)
**Command-line:** `/s` = run screensaver, `/c` = config dialog, `/p <hwnd>` = preview
**Status:** Config dialogs work for all. 4/7 GDI savers render with sprites. 5 MFC42 savers reach the message loop. 7 D3D/DDraw savers run their game loop but produce only HUD/fade chrome — main mesh-render path is never entered (see Task 3).

## Categories

### Pure GDI
| Screensaver | /s Visuals | Notes |
|-------------|-----------|-------|
| PEANUTS / CATHY / DOONBURY | Renders | Sprite compositing fixed |
| FOXTROT | White silhouettes | See Task 1 |
| GA_SAVER | Renders | Garfield/Odie on pogo sticks |
| CITYSCAP | Blank | Spins in GetMessageA, render fn never runs (Task 2) |
| PHODISC | Desktop teal only | Asset-load path missing (Task 2) |

### MFC42-based
| Screensaver | /s Visuals | Notes |
|-------------|-----------|-------|
| WIN98 | Renders | DDraw QI AddRef fix |
| CORBIS / FASHION / HORROR / WOTRAVEL | Black | Need DirectAnimation (DAView/DAStatics). Deferred — large COM surface. |

### Organic Art (statically-linked DX framework, all 7 are the same 1,005,056-byte PE — `md5 fef9ed080d8cbb34df636f9c71b406cd`)
ARCHITEC / FALLINGL / GEOMETRY / JAZZ / OASAVER / ROCKROLL / SCIFI: Config OK; `/s` reaches the per-frame loop, but only emits a HUD quad + fade overlay via direct D3D2::DrawPrimitive. d3rm submits a single state-only Execute buffer per frame and never reaches its mesh-emission path. See Task 3.

## Open Tasks

### 1. FOXTROT white silhouettes (LOW)

Inconclusive after 2026-04-20 investigation: the 75×80 character sub-sprites in the 225×80 sheet have only white/gray/maroon palette entries in the source art. Either real Win98 used dynamic palette mapping we don't emulate, or the rendering is faithful and the original note misdiagnosed. Need a reference screenshot before further work.

### 2. CITYSCAP / PHODISC blank screens (MEDIUM)

- **PHODISC:** DIB blit no longer wipes canvas (sparse-hash sync fix shipped) — now shows desktop teal but no photos. Asset-load path not traced yet.
- **CITYSCAP:** Spins in GetMessageA without ever calling SetTimer/InvalidateRect. Render fn never runs. Probably missing a startup message or a registry value that gates rendering.

### 3. Organic Art savers — d3rm scene-root handler list is empty (HIGH, BLOCKED on runtime probe)

Active investigation. d3drm.dll is loaded as a guest PE (image base `0x64780000`, runtime base `0x7459b000`, delta `0xfe1b000`); its real x86 code runs on our emulator. `$handle_Direct3DRMCreate` is dead code in this configuration.

**Architectural facts (settled, don't re-litigate):**

- The 7 D3D savers are byte-identical; only the .SCN config differs.
- Scene-picker is NOT broken: `--trace-fs` confirms ROCKROLL loads its own assets (`ro_pick.x`, `ro_git.x`, `ro_tex01.gif`, `ro_back.GIF`). Earlier "lands on CA_CHROM" claims were stale. ROCKROLL.SCN has no `Active=` key at all yet still loads — `Active=` only gates the random CA_* pool. Stop chasing OrgSuppList.txt / scene-picker.
- Per-frame Execute buffers contain ONLY a 28-byte `STATETRANSFORM(count=3)` + 4-byte `EXIT` — never `PROCESSVERTICES` / `TRIANGLE` / `POINT` / `LINE`. All 205 Executes (across 40k batches) originate from d3rm-internal state-flush at `0x647c26a0` (file VA), not from a mesh-emit path.
- The only `DrawPrimitive` calls in the run come from the SCR EXE (`0x744217e7` HUD quad, `0x74420f28` full-screen fade overlay) — not from d3rm.
- App spends 95%+ of batches in a guest-internal MFC virtual method at `0x7440f38d` running a bump allocator (arena `0x744deed0`, bump ptr `[0x744deb9c]`, 4096-entry parallel arrays at `[0x744daa60]`/`[0x744d6a60]`). Almost certainly procedural mesh construction from SCN `Form/Branches/Ribs` params. The `call [ecx+0x64]` at `0x7440f3f2` is a guest-internal vtable dispatch, NOT host `IDirectDrawSurface2::Lock` (no host Lock fires in `--trace-api`).

**d3rm Tick path (mapped 2026-04-26):**
```
IDirect3DRM3::Tick (slot 34) → 0x647bc46a
  → enum frames + Move callbacks
  → enum devices → for each viewport:
      → 0x64798e51 (per-vp render)
        → 0x64798903 SCENE WALKER     [177 hits / 86 Flips]
            → visual-loop entry        [177]
              → non-Frame emit branch  [177]  visual ESI=0x75281d38
                → emit fn 0x647bc390   [177]  descriptor=0x647e0e78
                  → up-call [parent+0x38] = 0x647c52f9 → returns 0
                → fallback 0x745d73e6  [177]  no draw
```

**Class chain proven intact** (via `vtable_dump`): `0x647e0e78 → 0x647e0fe8 → 0x647e0fa0 → 0x647e0de0`. Slot 14 of parent = `0x647c52f9` (the polymorphic dispatcher).

**Dispatcher semantics inverted from HRESULT:**
```
0x647c52f9: call inner → neg eax; sbb eax, eax; and eax, [hr_cache]; ret
   = inner_returned_nonzero ? hr_cache : 0
```
Caller `0x647bc3db test eax,eax; jz fallback` treats 0 as "no handler found." `0x647e7afc` is the HRESULT accumulator (cleared on entry to many fns; OR'd with errors), NOT a sentinel.

**Inner walker `0x647c534f`** iterates `[arg3+0xbc]` entries (count) at base `[arg3+0xc4]`, stride **4 bytes** (pointer-array). Calls predicate `0x647ad71e(*entry, 0, ctx)` per entry; if nonzero, AddRef+invoke and writes a 0x50-byte result row into `[ebx+0xa0]`. Returns 0 if no entry matched.

**List ownership (corrected 2026-04-26):** `[+0xbc]/[+0xc4]` on the inner walker's `edi` belong to the **viewport**, NOT scene-root. Earlier doc claim was based on wrong arg-mapping. Full chain re-verified:

- scene_walker `0x64798903` entry: `mov ebx, [ebp+0x8]` → ebx = arg0 = **viewport** (not scene-root). The local rename `mov [ebp+0x8], eax` (scene-root) at `0x64798924` only overwrites the stack slot, not the register; ebx stays = viewport for the rest of the function.
- Dispatcher call site `0x64798ac9: push ebx; push edi; push esi; call [eax+0x38]` passes (visual=esi, scene-root=edi, **viewport=ebx**) to outer dispatcher `0x647c52f9`.
- Outer dispatcher trampolines (visual, scene-root, viewport) → (visual, scene-root, `[viewport+0x34]`=scene-root, viewport) into `0x647c531c`.
- `0x647c531c` then calls inner walker `0x647c534f` with (visual=arg0, scene-root=arg1, **viewport=arg2**).
- Inner walker `0x647c534f`: `mov edi, [ebp+0x10]` → edi = arg2 = viewport. Reads `[viewport+0xbc]` (count=3) and `[viewport+0xc4]` (base = 0x74e0ef50, populated array of 3 entries).

So the inner walker IS iterating the viewport's populated list — 3 iterations per dispatcher call.

**The bug surface (current state):** across all of d3rm.dll, `find_field --op=write` shows **no instruction stores a nonzero value into `[reg+0xc4]`** — only zero-inits and one clone (copy-ctor at `0x647a3069` in fn `0x647a2f6d`):

| Writer VA | Fn entry | What it writes |
|---|---|---|
| `0x647a3069` | `0x647a2f6d` | clone: copies `[src+0xc4]` → `[dst+0xc4]` |
| `0x647a5cde` | `0x647a5c8d` | `0` (init) |
| `0x647aed61` | `0x647aed3b` | `0` (init) |
| `0x647c13f4` | `0x647c1377` | `0` (viewport zero-init) |

Field offset `+0xbc` is overloaded across object classes (count in some structs, doubly-linked-list `next` in others — e.g. `0x647acb4d` inside `0x647acace`), so pure offset-grep is noisy.

**Runtime probe (2026-04-26, ROCKROLL.SCR, runtime delta `0xfe1b000`):**

Object identification (corrected from earlier static analysis):
- `0x7500d6a0` = **viewport** (vtable `0x74e0fa58`; +0x3c/+0x40 = 640/480 = screen dims; +0x34 = scene-root back-pointer)
- `0x7500c368` = **scene-root frame** (vtable `0x74e0fc60`)

**Found the populator the static scan missed: `0x647c1c2b`.** Confirms field semantics: `+0xbc=count`, `+0xc0=capacity`, `+0xc4=array base`. `find_field --op=write` missed it because writes go through realloc helper + indexed store:

```
0x647c1ca1: mov eax,[esi+0xc0]       ; capacity
0x647c1cad: cmp [esi+0xbc],eax        ; if count==capacity:
0x647c1cb5:   add eax,3               ;   capacity += 3
0x647c1cb8:   mov [ecx],eax
0x647c1cbd:   push eax / shl eax,2 first
0x647c1cbe:   lea eax,[esi+0xc4]      ;   &array
0x647c1cc5:   call 0x6479c5f0         ;   realloc(&array, new_size_bytes)
0x647c1cdb: mov ecx,[esi+0xc4]        ; base
0x647c1ce1: mov [ecx+eax*4],edi       ; array[count] = entry
0x647c1ce4: inc [esi+0xbc]            ; count++
```

**Populator runtime behavior (trace-at on fn entry `0x745dcc2b`):** fires 6+ times per per-vp-render invocation (1 from `0x6479902f`, then recursive walks via `0x647c1d08` over `[ebx+0xa8]` sibling chain). Destination ESI = `0x7500d6a0` (viewport, NOT scene-root). At dispatcher hit, viewport `+0xbc=3, +0xc0=3, +0xc4=0x74e0ef50` (3 populated entries). Scene-root frame `0x7500c368` has `+0xbc=0xc0=0xc4=0` — it's a **separate, legitimately empty per-frame list**. (Initial `--break=0x745b402f --break-once` hit zero times because that VA is mid-block; trace-at on the populator's entry block instead.)

**So the prior "list is empty" diagnosis was wrong twice over:** (a) the viewport's list IS populated, and (b) the inner walker DOES read viewport's list (not scene-root's). The 3 entries are being iterated per dispatcher call.

**New question:** does predicate `0x647ad71e(entry, _, scene-root)` match any of viewport's 3 entries? Predicate (statically read):

```
0x647ad71e: cmp [entry+0x88], 0
0x647ad72c: jnz match
0x647ad72e: xor eax,eax; ret           ; NO MATCH if [entry+0x88]==0
match: copy [entry+0x38].xform fields ([+0x11c..+0x134]) into [entry+0x6c..+0x80]
       return [entry+0x34] != 0
```

So match requires both `[entry+0x88]=1` AND `[entry+0x34]!=0`.

**Where `[entry+0x88]` gets set:** scene_walker's own pre-loop at `0x64798955` walks viewport's 3 entries and sets `[entry+0x88]=1` ONLY for entries whose `[entry+0x84]==scene-root` (`edi`):

```
0x6479895f: mov eax, [ebx+0xc4]      ; ebx=viewport
0x64798965: mov eax, [eax+ecx*4]      ; entry = viewport.array[i]
0x64798968: cmp [eax+0x84], edi       ; edi = scene-root
0x6479896e: jnz skip
0x64798970: mov dword [eax+0x88], 1
```

**The actual draw consumer is `0x647c5150`**, called from trampoline `0x647c531c` AFTER the inner walker. It walks `visual.[0x9c]/[0xa0]` result rows (populated by inner walker on match) and invokes `[entry.vtable+0x10]` per row — that is the polymorphic "render this entry into the viewport" call. So if the inner walker matched 0 entries, `[+0x9c]=0` and no draws happen.

**hr_cache `0x647e7afc` is BSS zero-init**, with 440 `and ...,0x0` clears and exactly **one** nonzero writer at `0x64799d32` inside an HRESULT-set helper (`0x64799d29`): `mov [hr_cache], edi` then if (edi<0) call registered error callbacks. So hr_cache is the "last HRESULT" global; in success paths it stays 0. The outer dispatcher's `and eax, hr_cache` epilogue therefore returns 0 even on match — but the caller's `test eax,eax; jz fallback` only matters for the fallback-emit path; the actual draw work happens inside `0x647c5150` BEFORE the dispatcher returns. So this is not a bug — the work is unconditional once the inner walker populates result rows.

**Runtime confirmation (2026-04-26 follow-up, ROCKROLL.SCR delta `0xfe1b000`, break at `0x745b3903` = scene_walker entry):**

Viewport at `0x7500d6a0`:
- `[+0x34]` = `0x7500c368` (scene-root back-pointer)
- `[+0xbc]` = 3 (count) ✓
- `[+0xc0]` = 3 (capacity)
- `[+0xc4]` = `0x74e0ef50` (array base — heap-allocated)

Three entries (heap allocations, not d3rm static):
- entry[0] @ `0x74e100f8`: `[+0x18]` vtable=`0x745fbaa0`, `[+0x34]`=3, `[+0x84]=0`, `[+0x88]=0`
- entry[1] @ `0x74e0fee0`: similar layout, `[+0x84]=0`, `[+0x88]=0`
- entry[2] @ `0x74e0fda8`: similar layout, `[+0x84]=0`, `[+0x88]=0`

scene_walker is invoked with `arg2 (edi) = 0x7513d510` (different from `[viewport+0x34]=0x7500c368` — there are two scene-roots in play; arg2 is the "current" scene-root for this Tick). `[edi+0x2f0]=3` (bit 0 set → pre-loop gate passes).

**Diagnosis confirmed:** `[entry+0x84]=0` for all 3 entries. Pre-loop's `cmp [eax+0x84], edi` always fails (edi is nonzero in either case), so `[entry+0x88]=1` never gets set, predicate `0x647ad71e` returns 0, dispatcher returns 0, `0x647c5150` walks 0 result rows, no draws emitted.

**Why is `[entry+0x84]=0`?** Static analysis found 8 writers across 8 fns:

| Writer VA | Fn entry |
|---|---|
| `0x6478d9c5` | `0x6478d9bd` |
| `0x6479c835` | `0x6479c7f0` |
| `0x6479d1d1` | `0x6479d18d` |
| `0x647add4d` | `0x647adcef` |
| `0x647b022d` | `0x647b0190` |
| `0x647b047f` | `0x647b043e` |
| `0x647b1fb0` | `0x647b1e53` |
| `0x647b240e` | `0x647b2309` |

**Runtime confirmation (2026-04-26 follow-up): all 8 writer instructions fired 0 times** across a 200k-batch run on the most-likely candidate (`0x745a89c5`) and 50k-batch runs on the other 7 (`0x745b7835 / 0x745b81d1 / 0x745c8d4d / 0x745cb22d / 0x745cb47f / 0x745ccfb0 / 0x745cd40e`). `[entry+0x84]` is therefore never written — the bind path is entirely dead.

**Best candidate among the 8 (still 0 hits): `0x647adcef`.** Disasm shows the structural match for "bind a visual to a parent frame":
- arg0 QI'd against vtable `0x647e0aa0` (the entry's class metadata — same `[+0x18]=0x647e0aa0` we see on the 3 viewport entries at runtime)
- arg1 QI'd against `0x647e0f18` (a different class, presumably "frame")
- if `[arg0+0x84]` already set, Release old value via `0x647ddb08`
- write `[arg0+0x84] = QI(arg1)`
- register via `0x64797f39(new_val, arg0)`; on failure undo
- ret 0x8 — stdcall(2 args)

Called only by trampoline `0x6478ba43` (lock + COM-wrapper unwrap `arg.[+0x8].[+0x10]` for both args + call inner + unlock + ret 0x8). That trampoline is slot **6** of the vtable starting at `0x647dfcc0` (full layout dumped — slot 0=`0x6478b8e1`, slots 0–7 in `0x6478b8e1..0x6478ba8f`, slots 8+ jump into a different range). This is the public COM method that's never being called.

**Next-session pivot:**
1. Identify which `IDirect3DRM*` interface vtable `0x647dfcc0` is, and which method slot 6 is. Check d3rm's `Direct3DRMCreate`/`QueryInterface` paths and the IID checks against `0x647e0aa0` / `0x647e0f18` (these are class-descriptor blobs containing the IID). Likely candidates: `IDirect3DRMFrame::AddVisual` or `IDirect3DRMVisual::AddDestination`.
2. Once identified, search the SCR EXE (or the d3rm Load() path that ingests `.SCN` files) for the call site that should invoke that slot. The SCR's `.SCN` parser presumably walks `Children=`/`Visuals=` keys and binds via this method.
3. **Confirmed dead at the public boundary too:** trampoline `0x745d5a43` (= `0x6478ba43 + 0xfe1b000`) fires 0 times in 50k batches. So the SCR/SCN-loader never even reaches the public COM method — the call is missing entirely, not failing inside guest code. Look upstream: which IDirect3DRMFrame/Visual API is the SCN loader supposed to use to attach the 3 entries it created? Possibilities: (a) the SCN parser uses a different API (e.g. `Load`-style block that binds internally without going through this vtable slot), and our impl of that API is incomplete; (b) the SCN parser does walk `Children=`, but its dispatch table maps the keyword to a stubbed handler. Grep d3rm.dll for refs to slot-6's surrounding vtable to find what data structure indexes into it.

**2026-04-26 follow-up (cont.):**
- ROCKROLL.SCR's only static d3rm import is `Direct3DRMCreate`; everything else is COM vtable indirect, i.e. all bind/load calls live entirely inside guest d3rm code. `--trace-api`/`--break-api` are blind here.
- **Class names confirmed via descriptor blobs:**
  - `0x647e0aa0` is class **"Light"** (name string at `0x64783f80 = "Light"`, object size 0x8c). 27 xrefs, all clustered in `0x647ad6c8..0x647add81` — this 0x694-byte block contains the Light class's vtable methods + ctor + dtor.
  - `0x647e0f18` is class **"Frame"** (name string at `0x64784420 = "Frame"`, object size 0x2fc). 119 xrefs spread across `0x6479*` — Frame is the common parent.
- **Bind semantics decoded:** writer fn `0x647adcef` takes (arg0=Light, arg1=Frame), QIs both, then writes `[Light+0x84] = Frame`. Semantically this is **`IDirect3DRMFrame::AddLight(IDirect3DRMLight*)`** — `[Light+0x84]` is the back-pointer from a Light to the Frame that owns it. Conventionally this is the "frame" field of a light, set when a frame adopts it.
- **Earlier "vtable 0x647dfcc0" claim was wrong.** Slot 0 of that table (`0x6478b8e1`) ends with `ret 0x4` and uses `fld/fstp` — that is *not* a QI signature (QI is 2-arg, ret 0x8). The address `0x647dfcc0` also appears nowhere as raw bytes in the file (grepped little-endian) and has no xrefs — it's not actually a public COM vtable. It's some internal dispatch / float-method table whose role is unclear.

**Architecture note (matters for diagnosis):** d3rm.dll is loaded as a guest DLL (1188 thunks). `Direct3DRMCreate` is our only registered API entry — *all* IDirect3DRM* COM method calls run guest→guest entirely inside d3rm.dll's own code. There is no missing host-side COM handler for AddLight; the bind logic ships intact in the guest DLL. So the failure mode is necessarily one of:
- **(A) Mis-execution:** our x86 emulator runs the bind path but a bug (e.g. bad ModRM decode, lazy-flag glitch) corrupts the write. **Ruled out:** the trampoline `0x745d5a43` and all 8 candidate writer instructions fire 0 times — the path is never *reached*, not mis-run.
- **(B) Missing upstream call:** the SCR / SCN-loader takes a different code path (e.g. `Load()` ingest, or programmatic construction without explicit AddLight) and our impl of *that* path is incomplete enough that the bind step is skipped. The scene_walker firing means scene-init *did* run far enough to register entries — but they were never bound to a frame.
- **(C) Wrong-scene-loaded:** ROCKROLL.SCR ran a fallback or internal default scene, not its real scene file. **CONFIRMED via `--trace-fs` (2026-04-26):** ROCKROLL probes `.\Backdrop`, `.\Informs`, `.\Textures`, `.\Scenes` (all INVALID — flat dir layout, no subdirs), tries `C:\OrgSuppList.txt` (FAIL — file isn't shipped in PLUS98.CAB; it's runtime-generated state from a separate Plus!98 user app), then falls back to `FindFirstFile(".\\*.scn") → "architec.scn"`. So ROCKROLL.SCR is actually rendering **ARCHITEC.SCN**, which is precisely the same scene & code path documented in `project_architec_texturemap.md` and `project_architec_vertex_zeros.md` — geometry never fires because scene_walker rejects entries with `[Light+0x84]=0`. **All Plus!98 Organic-Art SCRs share this root cause.** The bind-AddLight gap is one symptom of the upstream picker landing on architec.scn (which has Active=0 in its header — should be skipped, but our impl runs it anyway because there's no other Active=1 alternative being matched).

**Strings extracted from ROCKROLL.SCR (`.data` segment) confirming picker logic:**
- `0x744cfa8c` "OrgSuppList.txt"  ← suppress-list file path
- `0x744cfa9c` "SuppList"          ← used as registry/INI key suffix
- `0x744cfaac` "Initialising Suppressor..."  ← log/diag string
- `0x744d0588` "*.scn"             ← directory enum pattern
- `0x744d0598` "   Scene %s has changed - saving"
- `0x744d05b8` "   Testing Original"
The literal "ROCKROLL.SCN" does NOT appear — there's no hardcoded scene name; it's purely picker-driven from `*.scn` enum + Active-flag filter + suppress-list.

**Next concrete actions (re-prioritized):**
1. **Fix the picker before chasing AddLight.** Either (a) implement Active-flag parsing so architec.scn (Active=0) is skipped, (b) generate a synthetic `C:\OrgSuppList.txt` that suppresses every .SCN except ROCKROLL.SCN before launching the SCR, or (c) reorder `FindFirstFile(*.scn)` results so ROCKROLL.SCN sorts first. (a) is the right fix; (b)/(c) are diagnostic shortcuts to verify rockroll's geometry path independently.
2. After ROCKROLL.SCN actually loads, re-run the writer-fn break-once probe. If `0x745d5a43` *now* fires, the AddLight binding works for legitimate scenes and the original "all Plus!98 SCRs are unbound" diagnosis was just architec-specific. If it still doesn't fire, the bind gap is deeper than the scene file.

**ROCKROLL.SCR actual scene loaded — `--trace-fs` files opened:** `vopstain.gif`, `io-half.x`, `calogo.gif`, `spot_br.gif`, `octahedr.x`, `grad_k2.gif`, etc. — these are **CA_2001 assets** (2001 Space Odyssey-themed Computer Artworks scene), not RockRoll. Confirmed: the `architec.scn` from `FindFirstFile` is just a probe; the actual scene loaded is whatever DefaultScene says, which is `"CA_2001"` (set in `lib/storage.js:101`). ROCKROLL.SCR runs the wrong scene.

**Why every SCR runs CA_2001:** `lib/storage.js` registers a single `HKCU\Software\Computer Artworks\Organic Art\Plus\DefaultScene = "CA_2001"` for *all* Plus!98 SCRs. Each per-theme SCR (ARCHITEC, ROCKROLL, JAZZ, etc.) reads from this *same* registry path — there's no per-SCR override. The real Plus!98 installer sets DefaultScene per the user-selected theme (or writes the active theme to OrgSuppList.txt). Our default of `"CA_2001"` gives identical behavior across all theme SCRs.

**Embedded picker logic in SCR (strings):**
- `"   Loaded scene Name %s, Active %d. from ...\\%s"`
- `"FileName: %s, Name: %s, Active %d, Loaded %d"`
- `"   Set "%s" active"` / `"   Set "%s" inactive"`
- `"There were no active scenes in the play list - using 'current scene' anyway"`
The picker enumerates `*.scn`, parses `Active=` from each, builds a play-list of Active=1 scenes, then picks DefaultScene if it's in the list — else falls back to current/first.

**Active-flag survey (2026-04-26):** all .SCN files in test/binaries/screensavers/, grepped for `^Active=`:
- `ARCHITEC.SCN`: Active=0
- `JAZZ.SCN`: Active=0
- `CA_DIAGR.SCN`: Active=1   ← only one with Active=1
- `GEOMETRY.SCN`: Active=0
- `ROCKROLL.SCN`: **no Active= line at all**
- (others not surveyed)

Implication: a "skip if Active=0" picker would land on `CA_DIAGR.SCN` regardless of which SCR is launched — matching the existing `project_architec_texturemap.md` finding ("scene-picker skips architec.scn (Active=0), runs ca_diagr wanting built-in 'Granite' tex"). Our current run picks ARCHITEC because the Active filter is unimplemented. Even fixing Active wouldn't help ROCKROLL specifically — `ROCKROLL.SCN` has no Active= line so the picker's default behavior on missing-key determines whether it's eligible. The intended Plus!98 selection mechanism must be: SCR-name → OrgSuppList entry → eligibility, with Active= as a global on/off flag. Without OrgSuppList, no per-SCR scene mapping exists.

**PLS98THM.INF install layout (extracted from PLUS98.CAB):** each theme installs to `%THEMES_DIR%\<ThemeName>\` (e.g. `C:\Program Files\Plus!\Themes\RockRoll\`). The SCR itself lands in `C:\Windows\System\`. `HKLM\Software\...\KEY_OA\ResourceDir` holds a semicolon-list of all Theme dirs as a search path. **Per-theme install is flat — no `Backdrop\Informs\Textures\Scenes` subdirs.** The `.\Backdrop` etc. probes our trace shows are feature-detect fallbacks; the SCR copes when they're absent.

**Real Plus!98 selection mechanism (uncovered):** each theme's `*.SCN` file ships with `Active=0` *in the CAB* — themes are inactive by default. When the user picks RockRoll in Themes control panel, the installer either (a) edits `ROCKROLL.SCN` to `Active=1`, or (b) writes the theme name to a state file. Without that step, no theme scene is "active" for the picker. Only the `CA_*.SCN` core scenes ship with `Active=1` — these are what every Plus!98 SCR falls back to.

**Concrete next-session VFS work (2026-04-26 plan):**
1. Per-SCR DefaultScene override in `lib/storage.js`: keyed off the SCR's filename stem (e.g. `ROCKROLL.SCR` → `DefaultScene="RockRoll"`, `JAZZ.SCR` → `DefaultScene="Jazz"`, etc.). Or set this dynamically at SCR launch time in `test/run.js` based on `--exe=` basename.
2. Patch each theme's `*.SCN` in the VFS to set `Active=1` when its corresponding SCR is launched (RockRoll for ROCKROLL.SCR, etc.).
3. Verify: re-trace `--trace-fs` and confirm the SCR opens `RO_GIT.X`, `RO_TEX01.GIF`, `RO_BACK.GIF` etc. (RockRoll-specific assets) instead of CA_2001's Io/octahedron/calogo set.
4. **Only then** is the AddLight gap a meaningful follow-up — until the right scene loads, every diagnosis about "[Light+0x84]=0" applies to the wrong content.

**VFS-side fix landed (2026-04-26, after the plan above):** `test/run.js` now detects `*.SCR` exes with a sibling `*.SCN`, flips that SCN to `Active=1` and *every other* SCN in the VFS to `Active=0`, then sets `HKCU\...\Plus\DefaultScene` to the matching SCN's `Name=` field via the new `setRegValue` export from `lib/storage.js`. Confirmed via `--trace-fs`: `ROCKROLL.SCR /s` now opens `ro_back.gif`, `ro_pick.x`, `ro_git.x`, `ro_tex01.gif`; `ARCHITEC.SCR /s` opens `ar_textu.gif`, `ar_mesh.x`, `ar_wallp.gif`. The "deactivate everything else" half is essential — the picker's playlist rotates through *all* Active=1 scenes, so a single Active=1 flip on the target wasn't enough. Output PNG is still black because the d3drm engine's STATETRANSFORM-only Execute-buffer gap is unchanged; this turn was purely VFS-side.

**2026-04-26 follow-up — d3drm IS being used, just not via SCR import table.** `--trace-api` on ROCKROLL.SCR shows zero d3drm-named calls because the SCR talks to d3drm through COM vtables (no name traceable from imports). Distinct COM IDs that fire: pure DirectDraw + D3DIM (`IDirect3DDevice_CreateExecuteBuffer/Execute/BeginScene/EndScene`, `CreateMatrix/SetMatrix`, viewports, materials, render/light state). d3drm emits these *internally* — confirmed by `--trace-dx-raw`: every Execute buffer the device receives is identical and minimal:

```
[dx-raw] @+0 op=6(STATETRANSFORM) bSize=8 wCount=3 payload=24 |
        01 00 00 00 02 00 00 00   (WORLD = matrix 2)
        02 00 00 00 03 00 00 00   (VIEW = matrix 3)
        03 00 00 00 01 00 00 00   (PROJECTION = matrix 1)
[dx-raw] @+28 op=11(EXIT)
```

Caller is `0x745de971` (d3drm @ 0x7459b000 → original VA `0x647c3971`), which is the tail of the buffer-flush function `0x647c3905` — it sets the EXIT byte, calls `vtable[5] Unlock`, `vtable[6] SetExecuteData`, then `vtable[8] Execute`. The flush *runs* every frame. The dirty-flag at `[esi+0x44]` is being set by something — but only the STATETRANSFORM emitter is feeding the buffer. **No PROCESSVERTICES, no TRIANGLE, no LINE, no POINT ever queued.**

So the d3drm side IS reaching its rasterization plumbing, the matrices flow through, but the geometry-emission code path that would queue ops 1/2/3/9 into the same buffer (then trigger the flush) never fires. That's the real gap — somewhere in d3drm's mesh-traversal-during-render, the call that would translate Frame's visuals into Execute opcodes is being short-circuited. Memory `project_d3dim_matrix_table.md` was wrong about "d3drm dropping geometry before Execute" — d3drm IS calling Execute, just empty-of-geometry.

**Concrete next probes:**
1. Find d3drm's per-frame-render walker: it must read mesh data and emit op=9 PROCESSVERTICES and op=3 TRIANGLE into the same buffer the flush uses. Search d3drm.dll for byte-immediate writes of `0x09` and `0x03` into a `[reg+N]` to find the geometry emitters, then xref their callers up to the scene-traversal entry.
2. Check whether `IDirect3DRMFrame::AddVisual` is ever called by the SCR (would set up the mesh→frame attachment that the renderer walks). Set break on the relocated AddVisual thunk (vtable slot 18 in standard order; need to find by walking Frame vtable like we did for AddLight at slot 10).
3. If AddVisual *is* called but rendering still empty, the bug is in d3drm's traversal seeing an empty visual list — likely a list-pointer never updated (storage emu or alignment bug).

**2026-04-26 second probe — Frame public vtable identified, but SCR doesn't call AddLight or AddVisual.** Walked the IDirect3DRMFrame vtable at orig VA `0x647dfcb0`:
- slot 10 @ `0x6478ba43` → AddLight (calls helper `0x647adcef` with frame_inner+light_inner)
- slot 11 @ `0x6478ba8f` → likely AddVisual (helper `0x647add81`, similar Add* family signature)
- slot 12-22 @ `0x64791d**` block — likely AddChild/AddTransform/AddTranslation/AddScale/AddRotation/AddMoveCallback/Get*

Ran ROCKROLL.SCR with `--break=0x745a6a43,0x745a6a8f --break-once` (relocated AddLight + slot 11) for 15000 batches. **Neither breakpoint ever fires.** Yet buffer flush fires 778 times during that run. So the SCR does NOT call Frame::AddLight or Frame::AddVisual directly through this vtable.

That means one of:
- d3drm's `D3DRMLoadFromFile` / `Load` family auto-creates frames+visuals from the .X file internally, never going through public AddVisual. The SCR likely calls `IDirect3DRMFrame::Load` (some slot >22 in the vtable) or `IDirect3DRM::Load` to slurp `ro_pick.x` and `ro_git.x` in one shot.
- OR the d3drm wrapper version d3drm uses an alternate "internal" vtable for its own bookkeeping that *doesn't* hit the public-vtable thunks we're watching, and the public vtable is only for the SCR's direct calls.

**Concrete next probes:**
1. Find d3drm exports `Direct3DRMCreate`, `D3DRMLoadFromFile` etc.; `node tools/pe-imports.js test/binaries/screensavers/ROCKROLL.SCR --dll=d3drm.dll` to list which d3drm imports the SCR actually pulls in.
2. Check vtable slots 23+ (the `0x6478bb*` range) — these include Load, AddChild variants. Set breaks across slots 11-30 in batch to find which Frame methods *do* fire.
3. Once we know which Frame methods fire, walk into them to see whether they're populating the visuals list — and if not, why our impl drops the relevant input (likely a file-IO read returns wrong size, or a callback never invokes).

**2026-04-26 third probe — slot mapping was wrong; corrected via Wine d3drmobj.h.** The earlier "neither bp fires" test was hitting the wrong slots. Per the IDirect3DRMFrame public vtable (IUnknown 0-2, IDirect3DRMObject 3-10, then Frame methods):
- slot 10 = `GetClassName` (NOT AddLight)
- slot 11 = `AddChild`
- slot 12 = `AddLight` → orig `0x64791da1` (relocated `0x745ACDA1` in last run)
- slot 18 = `AddVisual` → orig `0x647926d4` (relocated `0x745AD6D4`)
- slot 35 = `Load` → orig `0x6478bc6f` (relocated `0x745A6C6F`), `ret 0xc` (3 args: filename, options, callback?)

Helpers `0x647adcef` and `0x647add81` that I previously saw at slots 10/11 are for GetClassName/AddChild internals, not AddLight/AddVisual.

**SCR d3drm import surface (only 9 fns):** Direct3DRMCreate, D3DRMVectorRotate/Subtract/Normalize, D3DRMCreateColorRGBA/RGB, D3DRMColorGetRed/Green/Blue. **No QueryInterface, no Load helper.** All scene construction happens through COM vtables of objects returned by `Direct3DRMCreate`.

Ran 15K batches with `--break=0x745ACDA1,0x745AD6D4,0x745A6C6F --break-once` — none fired in that window. Need either longer run, or break on `Direct3DRMCreate` first to see when scene init starts, then break on the IDirect3DRM root vtable's CreateMeshBuilder / CreateFrame / Load slots (different vtable from Frame's).

**Next probes:**
1. Find IDirect3DRM root object vtable — break on `Direct3DRMCreate` exit, dereference returned ptr, dump its vtable. Map slots via `IDirect3DRM` declaration in d3drmobj.h (CreateMeshBuilder, CreateFrame, CreateLight, Load).
2. Break on each IDirect3DRM creation method to see which path the SCR uses to build the scene.
3. Trace through whichever Load/Create path fires to find where mesh data is dropped.

**2026-04-26 fourth probe — IDirect3DRM v1 vtable mapped from Direct3DRMCreate.** `Direct3DRMCreate` (orig VA `0x6478f112`, RVA `0xf112`) allocates a 0x428-byte object and writes 3 vtables at offsets +0x8/+0x14/+0x20 (v1/v2/v3 of IDirect3DRM). Returns `obj+0x8` (v1 interface ptr) to the caller. Per Wine d3drm.h, IDirect3DRM v1 layout slot→method (orig VAs at base 0x647e01f8):

| slot | method | impl VA |
|------|--------|---------|
| 3 | CreateObject | 0x6478f81b |
| **4** | **CreateFrame** | **0x6478fa90** |
| 5 | CreateMesh | 0x6478fc12 |
| **6** | **CreateMeshBuilder** | **0x6478fcf4** |
| 7 | CreateFace | 0x6478fe2b |
| 8 | CreateAnimation | 0x6478feff |
| 9 | CreateAnimationSet | 0x6478ffd3 |
| 10 | CreateTexture | 0x647900a7 |
| **11** | **CreateLight** | **0x647901ea** |
| 12 | CreateLightRGB | 0x64790ba6 |
| 13 | CreateMaterial | 0x6479025c |
| **14** | **CreateDevice** | **0x64790340** |
| 20 | CreateViewport | 0x64790ed6 |
| 23 | LoadTexture | 0x647910ee |
| **33** | **Load** | **0x64791751** |
| 34 | Tick | 0x647914b5 |

Direct3DRMCreate is exported (RVA 0xf112, hint=20) — set break on it before any of the vtable methods to confirm the SCR actually reaches it. Tested 30K batches with breaks on CreateFrame/CreateMeshBuilder/CreateLight/Load at relocated `0x745A****` — no break appears to fire and EIP is still spinning in the SCR's own .text (`0x74497***`), which suggests the SCR is stuck in an early init loop (not yet at scene construction) OR d3drm loaded at a different base than we calculated. Need to:
1. First break on `Direct3DRMCreate` itself (orig `0x6478f112`) — confirm whether the SCR reaches it at all in 30K batches.
2. If yes, capture the actual relocated d3drm base from `dbg_prev_eip` at break and recompute the v1 vtable method VAs.
3. If no, the SCR's `winmain` likely hangs in our env on something earlier — verify with `--trace-api` what it's actually doing in those 30K batches.

**2026-04-26 fifth probe — Direct3DRMCreate fires; v1 vtable methods don't; SCR drives D3DIM ExecuteBuffer.** Verified d3drm relocates to base `0x7459B000` (delta 0xFE1B000), and `Direct3DRMCreate` at relocated `0x745AA112` does fire — confirmed by --break-once. But 60K batches with breaks on slot 4/6/11/33 (CreateFrame/CreateMeshBuilder/CreateLight/Load) at `0x745AAA90/CF4/B1EA/AC751` produce **zero hits**.

`--trace-api` reveals why: the SCR's COM surface is **D3DIM (immediate mode)**, not D3DRM:
- `IDirectDrawSurface_*` (CreateSurface, Lock, Flip, Blt) — DDraw
- `IDirect3DTexture2_*` (QueryInterface, Release)
- `IDirect3DExecuteBuffer_Lock / Unlock / SetExecuteData` — **fired repeatedly**

So the SCR does call Direct3DRMCreate (just to bring up d3drm's machinery), then talks directly to D3DIM ExecuteBuffers. The d3drm vtable methods (CreateFrame, etc.) likely run during `Direct3DRMCreate` itself or during a later Load that happens via internal helper functions — but the SCR's main loop submits geometry via D3DIM execute buffers, not via the d3drm public vtable.

This matches `project_organic_art_engine` exactly: d3drm internally drives d3dim, our d3dim emulation receives the STATETRANSFORM ops but never any TRIANGLE/PROCESSVERTICES ops — so the screen stays empty. The chase target is therefore inside **d3drm's mesh-walker → d3dim ExecuteBuffer fill path**, not the SCR-facing vtable surface.

**Pivot for next session:**
1. Walk what d3drm does between Direct3DRMCreate and the first ExecuteBuffer.Lock — likely an internal Render loop calling visual.Draw → d3dim. Set break on the relocated ExecuteBuffer.Lock thunk and walk EBP backward to find the d3drm internal caller.
2. From the d3drm caller, find where it picks up vertex data — that's the function that's seeing an empty visuals list (per the existing organic-art notes).
3. Then trace upward: who was supposed to populate that visuals list? Either Frame::AddVisual was never called (file load path broken) or it was called and our impl drops the input.

**2026-04-26 sixth probe — stack walk via --trace-stack doesn't apply to COM tracer.** Tried `--trace-api=IDirect3DExecuteBuffer_Lock --trace-stack=IDirect3DExecuteBuffer_Lock:8` over 80K batches — 0 events captured. The `--trace-api=NAME` filter applies only to the regular api tracer, not the COM tracer (`[COM api_id=N => Name]`), so passing a COM method name to that filter silently suppresses everything.

Two viable instrumentation paths for the next session:
- **WAT-side, no JS edits:** add a one-line `(call $log_caller (i32.load (global.get $esp)))` near the top of the IDirect3DExecuteBuffer Lock handler in `09a-handlers.wat`. The d3drm-internal return address pinpoints the d3drm caller for `tools/find_fn.js` → entry, then disasm to see what builds the buffer.
- **JS-side via `--trace-host`:** find which host import the Lock handler eventually calls and add `--trace-host=<name>` — that already prints raw args. But the d3drm caller VA isn't in the args; would still need a wat-side `console.log(eip_at_call_site)`.

Both paths converge to the same finding: who called Lock, did SetExecuteData get a populated buffer, and where does the geometry get dropped (matching org-art's STATETRANSFORM-only observation).

**2026-04-26 seventh probe — landed: tracing infra fixed AND first d3drm Lock-callers mapped.**

`test/run.js` now resolves COM ordinal names before tracing decisions: `--trace-api=IDirect3DExecuteBuffer_Lock,...` and `--trace-stack=IDirect3DExecuteBuffer_Lock:N` work (commit 8bfc0e2). On ROCKROLL, the captured chains for the FIRST Lock burst (3 Lock/Unlock/SetExecuteData triplets) are:

```
[API #16443] IDirect3DExecuteBuffer_Lock(this=0x7c3e60a0, ...) [ret=0x745de773]
  frames=[0x745de73d <- 0x745dd2fb <- 0x745b359d <- 0x745b3900]
[API #20277] IDirect3DExecuteBuffer_Lock(...) [ret=0x745de773]
  frames=[0x745de73d <- 0x745dd2fb <- 0x745b4087 <- 0x745b4202 <- 0x745a1365 <- 0x7442020b]
```

Reloc delta = `0x7459b000 - 0x64780000 = 0xfe1b000`. Translating runtime VAs back to preferred-base d3drm addresses and decoding (with `find_fn.js` + `disasm_fn.js`):

| runtime ret | preferred | function | role |
|---|---|---|---|
| `0x745de773` | `0x647c3773` | fn `0x647c3744` | **Lock-wrapping helper.** Pushes a 0x14-byte D3DEXECUTEBUFFERDESC on stack, calls `[ecx+0x10]` (Lock vtable slot 4) on `[esi+0x8]`, on success caches lpData at `[esi+0x44]`/`[esi+0x48]`/`[esi+0x4c]` (`[esi+0x44]` = "is locked" flag). Retries on `0x88760215` (`D3DERR_EXECUTE_LOCKED_FAILED`)? — actually the `cmp eax, 0x8876021c` is jump-back-if-equal which loops. |
| `0x745de73d` | `0x647c373d` | fn `0x647c3726` | Tiny shim: pushes 3 args (this, ?, ?) and calls `0x647c3744`. Used only as fall-through from `0x647c36e0`. |
| `0x745dd2fb` | `0x647c22fb` | fn `0x647c21ec` | **State-token batcher.** Builds two stack structs from `[esi+0x3c..0x14C]` and `[esi+0x58..0x94]` (camera/viewport/projection matrices), calls `[ecx+0x14]` and `[ecx+0x40]` on the buffer, then issues 3 calls to `0x647c36e0(this, kind, 6, src)` with kind ∈ {1,2,3} and src ∈ `[esi+0x1d4]` / `[esi+0x1d0]` / `[esi+0x1c8]` — three D3DOP_STATETRANSFORM ops setting WORLD/VIEW/PROJ matrices. **This is the matrix-only path; never emits triangles.** |
| `0x6479859d` | `0x6479859d` | fn `0x64798521` | **Per-frame render driver.** Resolves scene-root frame from viewport `[esi+0x34]`, calls predicate `0x647c2792`, then matrix helper `0x647c1d30`, then `0x647c21ec` (matrices). Continues with comparisons of `[eax+0x124]/[edi+0x2c8]` etc. and a call to `0x647b9663` — geometry emission likely lives further inside this function (after the matrix block). Frame chain confirms this is what's running on the live render loop. |
| `0x745b3900` / `0x745b4087` / `0x745b4202` / `0x745a1365` | (see find_fn) | upper frames | Render-loop entry path; reachable via `0x7442020b` (the SCR's WinMain → message loop in ROCKROLL.SCR). |

`0x647c36e0` (the state-writer) takes `(this, kind, type, data)` and gates on `kind`:
- `kind == 7 || kind == 8` → calls `0x647a0a29` (different path — possibly **D3DOP_TRIANGLE / D3DOP_PROCESSVERTICES**!)
- otherwise → falls through to `0x647c3726` → Lock+memcpy (the only path we observe firing)

**Concrete next-session hypothesis to verify:**
- `0x647a0a29` is the geometry-emit path. If we never see Lock chains rooted there, the problem is in d3drm's renderer never reaching kind=7/8 calls — i.e. visuals aren't being walked.
- Inside `0x64798521`, after the call to `0x647c21ec` returns, follow the post-matrix code; look for `push N; push 7` or `push N; push 8` argument patterns being passed to `0x647c36e0` (or directly to `0x647a0a29`). That tells us whether the call exists in the binary at all.
- Equivalently: `node tools/xrefs.js test/binaries/dlls/d3drm.dll 0x647a0a29 --code` to find every caller, then break on each at runtime to see which fires and which is dead. If none fires, the dead code is a missing call from the parent (the visual-iteration loop).

So the real next step is no longer "find the Lock caller" — it's **find who calls `0x647a0a29` (the kind=7/8 path) and discover why that path is dead under our emulation while kind=1/2/3 fires fine.**

**2026-04-26 eighth probe — `0x647b9663` IS being called: it's a per-mesh transform/preprocess, not the triangle emitter.**

`--break=0x745d4663 --break-once` (relocated `0x647b9663`) hit at batch 8683 — the function fires. `bp_first_caller=0x745bafeb` → preferred `0x6479ffeb`, inside fn `0x6479ff51`.

Caller `0x6479ff51` shape (lines `0x6479fff2..0x647a002b`):
```
lea ecx, [eax+0xa4]   ; arg3 = &[eax+0xa4]
push ecx
lea ecx, [eax+0xa8]   ; arg2 = &[eax+0xa8]  (out_count?)
push ecx
push [eax+0xa0]       ; arg1 = [eax+0xa0]   (vertex/data buffer)
call 0x647b9663       ; transform/preprocess
add esp, 0x10
test eax, eax
jnz error
push [ebp+0x8]
call 0x647bb74e       ; ← actual emit pass: walks [esi+0x840..0x844] (list of meshes)
call 0x647a0461       ; another emit
mov esi, [eax+0xb8]   ; walk linked-list of child frames/visuals
```

`0x647bb74e` iterates a frame's child-mesh list (count at `[esi+0x844]`, ptr at `[esi+0x840]`). For each non-2 element calls `[ecx+0x28]` then `0x647b99d4(child)`. **That's the chase target**: `0x647b99d4` likely emits actual D3DOP_TRIANGLE / D3DOP_PROCESSVERTICES into the execute buffer.

`0x647b9663` itself: walks vertex-like data with stride 0x10 (per-record), shifts indices by 5 (×32 = D3DTLVERTEX size) — looks like it's writing transformed vertex indices, not triangles. Probably a vertex-list builder rather than triangle emitter.

**Concrete path for next session:**
1. Set `--break=0x745d49d4` (= `0x647b99d4 + 0xfe1b000`) — does the actual triangle emit fire?
2. If yes: walk inside `0x647b99d4`, watch which D3DOP_* values get written. Cross-reference with our d3dim Execute() decoder to see which op codes go in.
3. If no: walk the path that decides whether to call it — predicate check at `0x647bb768` (`cmp word [edi+0xa4], 0x2`). If `[edi+0xa4]` is always 2 in our run, we're skipping the emit. That field looks like a "visual subtype" — 2 might mean "skip". Trace to find what sets it.
4. Verify `0x647bb74e`'s outer loop (`cmp [esi+0x844], ebx`) — if `[esi+0x844]` is 0, the mesh list is empty and we never even consider emitting. That would suggest `Frame::AddVisual` never populated this list — matching the stated organic-art finding.

Reloc helpers for next session:
- d3drm preferred=0x64780000, runtime=0x7459b000, delta=`0xfe1b000`.
- runtime VA = preferred + 0xfe1b000.

Frame chain to reproduce: `--trace-api=IDirect3DExecuteBuffer_Lock --trace-stack=IDirect3DExecuteBuffer_Lock:8 --max-batches=20000`.

**2026-04-27 confirmed: render loop hits `0x647bb74e` but the triangle-emit path at `0x647b99d4` is skipped by the visual-subtype predicate.**

Three runtime breakpoints (80K batches each):

| breakpoint | preferred | hits | first caller |
|---|---|---|---|
| `0x745d4663` | `0x647b9663` (vertex/data preprocess) | many | `0x6479ffeb` (render loop) |
| `0x745d674e` | `0x647bb74e` (visual-list iterator) | many | `0x745bb016` (`0x647a0016`, post-`b9663`) |
| `0x745d49d4` | `0x647b99d4` (**triangle emit**) | only at startup batch 68 | `0x647cc689` (init/static, NOT render loop) |

So the render path enters `0x647bb74e` per frame but its inner branch at `0x647bb778..0x647bb787` never fires. The relevant code:

```asm
647bb768  cmp word [edi+0xa4], 0x2
647bb770  mov eax, [edi+0xac]
647bb776  jz short 0x647bb78d   ; subtype==2  → SKIP emit
647bb778  test eax, eax
647bb77a  jz short 0x647bb78d   ; [edi+0xac]==0 → SKIP emit
647bb77c  mov ecx, [eax]
647bb77e  push eax
647bb77f  call [ecx+0x28]       ; some Lock/prep on ass'd object at [edi+0xac]
647bb782  test eax, eax
647bb784  jl short 0x647bb78d
647bb786  push edi
647bb787  call 0x647b99d4       ; ← TRIANGLE EMIT (never reached at render time)
```

So one of these is true for every visual in the list: `(word [edi+0xa4]) == 2`, or `[edi+0xac] == 0`. Both look like "this visual is incomplete / not a renderable mesh".

**Concrete next session:** runtime-inspect `[edi+0xa4]` and `[edi+0xac]` for each visual when `0x647bb74e`'s loop iterates. Use `--break=0x745d6768 --trace-at=0x745d6768 --trace-at-dump=0x745d6768:0` (tracing won't capture EDI directly but `--trace-at` logs regs). Concretely: add `--break=0x745d6768` then read `[edi+0xa4]` and `[edi+0xac]` at the prompt with `d` (dump) using EDI.

If `[edi+0xa4]==2` always: the visuals were created as the wrong subtype. Find what writes `[obj+0xa4]=2` and trace upstream — likely a Frame::AddVisual variant that registers a "deferred" or "skip me" subtype.

If `[edi+0xac]==0` always: the visual has no associated d3dim mesh-data pointer — i.e. d3drm built the visual record but never attached the prepared geometry. Find what writes `[obj+0xac]` (or fails to). Likely candidates: MeshBuilder::CreateMesh path or material/texture binding.

Tooling shortcut: `node tools/find_field.js test/binaries/dlls/d3drm.dll 0xac --reg=edi,esi --op=write` — find every store to `[obj+0xac]`. Same for offset 0xa4. Cross-reference with what's CALLED during init vs not — that narrows the suspect.

**2026-04-27 retrace — prior chain misidentified.**

Two key reidentifications based on actual runtime dumps:

1. **`0x647b99d4` is `Release()` (refcount-decrement), NOT triangle emit.**
   ```
   647b99d4  mov eax, [esp+0x4]      ; this
   647b99d8  xor edx, edx
   647b99da  cmp eax, edx            ; if this==0 ret
   ...
   647b99e4  mov ecx, [eax+0xc]      ; refcount
   647b99eb  dec ecx
   647b99ec  mov [eax+0xc], ecx
   647b99ef  cmp [eax+0xc], edx
   647b99f2  jnz ret
   647b99f4  cmp [eax+0x10], edx
   647b99f7  jnz ret
   647b99fa  call 0x647b9a01         ; → destructor
   647b9a00  ret
   ```
   69 xrefs across the DLL — far too many for a render-only function. Calling chains threaded through this look like normal COM teardown, not draw events.

2. **`0x647bb74e` is a property-list destructor, NOT a per-frame visual iterator.** Runtime dump of ESI=0x750a9a68 at the function entry showed not a Frame but a dictionary of property strings ("green", "red", "blue", "alpha", "filename", "Material", "TextureFilename", color refs, etc.). The fn's tail at `0x647bb796..0x647bb7c2` frees `[esi+0x840]`, zeroes `[esi+0x844]/[esi+0x848]` — classic teardown. The "visual subtype skip" reading was wrong.

**Real per-mesh render fn: `0x64798521`** (caller of `0x647c21ec` → Lock chain `0x745de73d <- 0x745dd2fb <- 0x745b359d <- 0x745b3900` from `--trace-stack=Lock`).

Critical structure (post-Lock body):
```
64798521  push ebp; mov ebp,esp; sub esp,0x3c
64798547  call 0x64799d8d           ; setup
64798557  mov eax,[ebp+0x8]
6479855d  call 0x647c11f7           ; get device
6479858f  call 0x647c1d30
64798598  call 0x647c21ec           ; ← Lock execute buffer
647985a9  cmp [eax+0x124], ecx      ; ┐
647985b0  jnz 0x64798669            ; │  state-cache check —
647985bc  cmp edx, [edi+0x2cc]      ; │  if any cached field
647985c2  jnz 0x64798669            ; │  differs from current,
647985ce  cmp edx, [edi+0x2d0]      ; │  go to "reprocess" path
647985d4  jnz 0x64798669            ; │  at 0x64798669
647985e0  cmp edx, [esi+0x34]       ; │
647985e3  jnz 0x64798669            ; ┘
647985f5  push [eax+0xa0]           ; cache-HIT: data buf
647985fb  call 0x647b9663           ; preprocess → out vert_count at [ebp-0x18]
64798603  test eax, eax
64798605  jz 0x64798613
64798607  cmp dword [ebp-0x18], 0   ; ← VERTEX-COUNT CHECK
6479860b  jle 0x647988c9            ; ← ZERO VERTS → BAIL OUT
64798611  jmp 0x6479864f            ; non-zero → render
```

Runtime: `--break=0x745b3607` (= 0x64798607) over 20K batches **NEVER fires** — confirms cache-hit path is not taken. We always go through `jnz 0x64798669` (cache-miss / reprocess path), which calls `0x6479f65f` followed by its own emit chain.

**True next step: trace the cache-miss path at `0x64798669`.** That's where every per-mesh render lands in our run. It calls `0x6479f65f(esi, [eax+0x1c4], ecx, 0, edx, 0, 0, ebx)`; if it returns nonzero, exit at `0x647988c9`. If 0, continues to a setup block at `0x647986d3+` that primes `[ebp-0x2c..0x20]` and `[eax+0x124/0x128/0x184]` cache fields.

Concrete probes:
1. `--break=0x745b3669 --break-once` (runtime VA of `0x64798669`) — confirm we land here.
2. `--break=0x745baa90` (runtime of `0x6479f65f`'s ret site test, i.e. `0x6479868e+0xfe1b000`) — log eax to see if `0x6479f65f` is failing for us (returning nonzero → `0x647988c9` exit).
3. Disasm `0x6479f65f` end-to-end — that's the actual heavy "geometry preprocess" workhorse for this scene; it likely contains the equivalent vertex-count gate that the cache-hit branch has at `0x64798607`.
4. Inspect what's in `0x647988c9..0x647988ec` (the bail/exit block) — does it set `[viewport.error]` or just unwind? That tells us whether the Unlock+SetExecuteData we still see in the trace are real-render or a no-op-flush of an empty buffer.

Reloc reminder: runtime VA = preferred + 0xfe1b000.

**2026-04-27 SMOKING GUN: per-render execute buffer is `vc=0, il=32 bytes`.**

Instrumented `$handle_IDirect3DExecuteBuffer_SetExecuteData` to emit `host_log_i32(marker), log(vc), log(il)`. Run output:
```
[i32] 0xd3d70001   ← marker
[i32] 0x00000000   ← dwVertexCount
[i32] 0x00000020   ← dwInstructionLength (32 bytes)
```
Repeating every frame for thousands of frames.

32 bytes ≈ 4 × 8-byte D3DSTATE records = state ops only (matrix/render state + D3DOP_EXIT). **No D3DOP_TRIANGLE, no D3DOP_PROCESSVERTICES emitted.** This matches the long-standing organic-art finding ("STATETRANSFORM only").

So `0x6479f65f` (the heavy preprocess in the cache-miss path) succeeds but populates the execute buffer with state transforms only — geometry never gets appended.

**Cache-miss-path probe sequence verified at runtime:**
| break | preferred | hits | notes |
|---|---|---|---|
| `0x745b3521` | `0x64798521` (per-mesh render entry) | YES | per-frame |
| `0x745b3669` | `0x64798669` (cache-miss branch) | YES | always taken (cache-hit at `0x745b3607` NEVER fires) |
| `0x745b38c9` | `0x647988c9` (fail-exit) | NO | `0x6479f65f` succeeds |

**Concrete next step:** `0x64798757 call 0x647b95a5(&[ebp-0x3c], [eax+0xa0])` is the prime suspect for geometry emission — it's called between cache update and the bounds-update loop. Set `--break=0x745d45a5 --break-once` to confirm it fires; if so, walk inside to find where it would write `D3DOP_TRIANGLE` (1) or `D3DOP_PROCESSVERTICES` (9) opcodes to the buffer. If the byte-write loop never reaches those branches, find what predicate skips them — likely tied to vertex-source-data being null on the mesh object `[ebp+0x8]`.

Tooling for next session:
- `node tools/disasm_fn.js test/binaries/dlls/d3drm.dll 0x647b95a5 200`  — inspect the candidate emitter.
- `node tools/xrefs.js test/binaries/dlls/d3drm.dll 0x647b95a5 --code` — see all callers; if it's used elsewhere as a non-emitter we can disambiguate.
- Re-instrument the SetExecuteData handler (one-line `host_log_i32`) to read from the actual execute buffer's instruction stream and dump opcodes — hand-decode the 32 bytes to confirm exactly which D3DOP_* values appear.

**2026-04-27 NEXT LAYER: 0x647b95a5 is NOT the geometry emitter — it's a rect surface fill (`rep stosd/stosb` of color into `[edi+0x44]+stride*y`). The real geometry-emit call sits later at 0x647988bf, gated on `[ebp+0xc] & 3`.**

Confirmed via disasm of `0x647b95a5` — it scales 4 packed-fixed16 rect coords, computes `width-=stride`, then `imul eax, [edi+0x3c]; add eax, [edi+0x44]` and `rep stosd; rep stosb` to fill a rect with `[ebp+0x10]` as the byte color. That's a **clear-target** primitive, not vertex output.

The actual geometry-emit happens further down in `0x64798521`'s cache-miss path:
```
0x647988a4  test [ebp+0xc], 0x3        ; flags & 3
0x647988a8  jz   0x647988d0            ; skip render if 0
0x647988aa..bc  build 8 args
0x647988bf  call [ecx+0x38]            ; ecx = [esi+0x18] (cached-source-data vtable+0x38)
```

**2026-04-27 update — flags ARE 7, gate IS open. Earlier "break never hits" finding was a tooling artifact (bp at non-block-boundary doesn't fire).**

Used `--trace-at=0x745b38a4 --trace-at-dump=0x77fffb64:4` (the test instr is a known block boundary — branch target from the earlier `jle 0x647988a4`). At every hit:
```
[TRACE-AT] EIP=0x745b38a4 ... EBP=0x77fffb58 ...
Hexdump 0x77fffb64 (4 bytes): 07 00 00 00     ← [ebp+0xc] = 0x7
```
So `flags & 3 == 3` → the geometry-emit vtable call AT `0x647988bf` (`call [ecx+0x38]`) **does fire every frame**. The bug is not gating — it's that the slot-14 geometry-emit fn produces an empty execute buffer.

**Two parallel render trampolines confirmed:**
| vtable | slot 12 fn | flags pushed |
|---|---|---|
| `0x647df240` | `0x647862f4` (CS-wrap → `0x647988f5` shim) | **literal `push 0x7`** ← fires per frame |
| `0x647df2e0` | `0x64786943` (CS-wrap → direct `0x64798521`) | passthrough of caller's arg2 |

`0x647df240` is the active path (verified: `--trace-at=0x745a12f4` fires per frame); `0x647df2e0` (`--trace-at=0x745a1943`) NEVER fires for this app. Slots 0-11 are identical — only the "render" method (slot 12) differs. Both interfaces are RM-object derived; almost certainly **IDirect3DRMVisual** (slot 12 = `Render`) vs some other RM-object type sharing slots 0-11.

**Runtime probe — followed the vtable chain one level deeper:**
| What | Address | How |
|---|---|---|
| Cached source data ESI | `0x750a9a68` (rt) | `--trace-at-dump=0x77fffb48:4` (= `[ebp-0x10]`) |
| Source vtable `[esi+0x18]` | `0x745fb8f8` (rt) → `0x647e08f8` (pref) | `--trace-at-dump=0x750a9a80:4` |
| Slot 14 (geometry-emit) `vtbl[+0x38]` | `0x745bacd6` (rt) → **`0x6479fcd6` (pref)** | `--trace-at-dump=0x745fb930:4` |

**Disasm of `0x6479fcd6` — yet another dispatch layer (NOT the leaf emitter):**
```c
fn(arg1=esi_caller, arg2=this, arg3, arg4=rect4, arg5=rect4cnt, arg6=rect2, arg7=rect2cnt, arg8=flags)
{
  esi = arg2->[0x1bc];               // sub-object on the visual
  switch (arg8 & 3) {
    case 3:                          // ← flags=7 → 7&3=3 → this branch
      if (arg6 != 0) { eax=esi->[0]; eax->[0x30](esi, rect2, rect2cnt, 1); }
      eax = esi->[0];
      eax->[0x30](esi, rect4, rect4cnt, 2);
      break;
    case 1:                          // emit single pass
      eax = esi->[0]; eax->[0x30](esi, rect4, rect4cnt, 1);
      break;
    case 2:
      if (arg6) { eax=esi->[0]; eax->[0x30](esi, rect2, rect2cnt, 2); }
      break;
  }
}
```
So the real geometry-emit fn is **slot 12** (`+0x30`) of `[arg2->[0x1bc]]->[0]` — yet another vtable indirection through a sub-object.

**Runtime walk continued — the leaf is NOT a geometry emitter, it is `IDirect3DViewport3::Clear`:**

| Step | Address | Source |
|---|---|---|
| arg2 to `0x6479fcd6` (visual) = EAX at trace | `0x750aada0` | `--trace-at=0x745b38a4` reg snapshot |
| sub-object at `[visual+0x1bc]` | `0x7c3e6090` | `--trace-at-dump=0x750aaf5c:4` |
| sub-object's vtable `[sub+0]` | `0x7451267c` | `--trace-at-dump=0x7c3e6090:4` |
| vtable slot 12 (`+0x30`) | `0x78200ed0` | `--trace-at-dump=0x745126ac:4` |
| Bytes at the leaf | `10 00 ca ca ae 04 00 00` | `--trace-at-dump=0x78200ed0:32` |

`10 00 ca ca` is our **COM-thunk marker**; the next dword is the API id. **API 0x4ae = `IDirect3DViewport3::Clear`** (per `src/api_table.json`). Adjacent slots are 0x4af, 0x4b0, 0x4b1 (sequential thunk IDs), confirming this is a packed COM vtable for IDirect3DViewport3.

**So the entire path we have been tracing is the clear path, not the render path.**
- `0x6479fcd6` with `flags=7` (`& 3 == 3`) calls `Clear(rect2, n2, 1)` then `Clear(rect4, n4, 2)` — likely color-buffer clear (mode 1) followed by z-buffer clear (mode 2). That matches the d3d Clear API's `dwFlags` bits.
- The disasm of `0x64798521` (the slot-12 trampoline target on the source `0x647e08f8` vtable) confirms the function body is purely viewport rect clamping + clip-rect computation, ending in the gated `call [ecx+0x38]` to Clear. **No triangle/vertex code anywhere in this fn.**

**Reframed root cause: we have not yet found the real Render call.** The "RM Visual::Render" identification was wrong — this is `RMViewport::Clear` (or an internal rect-clip helper that funnels into Clear). RM `Render`/`ForceUpdate` lives on a different code path that we haven't traced.

**Concrete next step:**
1. Find d3rm's actual public `IDirect3DRMViewport::Render` vtable slot. Per the SCR's COM trace earlier (look for `RM*::Render` and `RMViewport::Render` in `--trace-com`), grep for `Render` in `src/api_table.json` to enumerate every Render variant's API id (RMViewport, RMViewport2, RMFrame::DoSomething, etc.) and which interfaces the SCR actually calls per frame.
2. Once the right RM Render entrypoint is identified, set `--trace-com` to dump it and follow its call chain into d3rm internals — it should eventually call `IDirect3DDevice::BeginScene` / `Execute` / `EndScene` (NOT just Clear).
3. Possible alt hypothesis: SCR might be calling `RMViewport::Clear` per frame but **never** `RMViewport::Render`. Verify by tracing all RM-COM dispatch IDs the SCR invokes per frame; if Render is missing, the bug is upstream (scene tree empty? frame loop broken? animation tick missing?).

**Update — `--trace-com` shows d3rm IS executing per frame:** The actual per-frame COM call sequence is:
```
IDirect3DExecuteBuffer_Lock                ← d3rm acquires the buffer
IDirect3DDevice2_SetRenderState × 7        ← state setup (rasterizer, alpha, etc.)
IDirect3DExecuteBuffer_Unlock              ← d3rm releases the buffer
IDirect3DExecuteBuffer_SetExecuteData      ← fills D3DEXECUTEDATA (vc=0, il=32)
IDirect3DDevice_Execute                    ← runs the buffer
IDirect3DViewport3_Clear                   ← (the Clear we were chasing)
```
Repeated for each RM frame/visual.

So d3rm DOES walk Render+Execute. But its **buffer-emit code (which runs as plain memory writes between Lock and Unlock — no API calls)** produces only D3DOP_STATETRANSFORM headers, never D3DOP_TRIANGLE / D3DOP_PROCESSVERTICES. That's why `vc=0, il=32`. Only ~15-20 API calls happen between Lock and Unlock; the geometry-emit logic is purely in-memory in d3rm internals.

**Refined root cause hypothesis:** the geometry-emit loop in d3rm walks the visual's mesh face/vertex list, but at runtime that list appears empty (zero faces). Possible upstream causes:
- Mesh data was loaded as a placeholder / count of 0 — SCN/X-file load may have failed silently.
- A `IDirect3DRMMesh::AddFace` / similar call returned an error and the SCR didn't notice.
- An animation tick (`IDirect3DRMFrame::SetPosition`/`AddRotation`) is failing and the visual ends up culled.

**New concrete next step:** Set `--break-api=IDirect3DExecuteBuffer_Lock` to pause inside Lock; then `--trace-at=` on the Lock call's return EIP and dump bytes at the lpData buffer just before the matching Unlock — confirm the buffer is genuinely empty/zero. Then walk back: scan d3rm's symbol space for fns that compose D3DOP_* constants (0x05=PROCESSVERTICES, 0x09=TRIANGLE) — `node tools/find_string.js test/binaries/dlls/d3drm.dll` won't help (these are immediates, not strings); instead grep d3rm.dll bytes for `c6 04 06 05` / `c6 04 06 09` (mov byte ptr [esi+eax], 0x05/0x09) to find the buffer-write call sites.

**Byte-pattern search for D3DOP_TRIANGLE emit — INCONCLUSIVE:**

Scanned d3rm.dll for likely byte-write patterns of D3DOP_TRIANGLE=0x09 / D3DOP_PROCESSVERTICES=0x05:
- `c6 06 09` (mov byte [esi],9): 0 hits
- `c6 07 09` (mov byte [edi],9): 0 hits
- `c6 00 09` (mov byte [eax],9): 1 hit at VA 0x647af491
- `c6 04 06 09` (mov byte [esi+eax],9): 0 hits
- 16-bit `09 08` (op=9, size=8 = sizeof(D3DTRIANGLE)) anywhere in .text: 1 hit (incidental, not an instruction emit)
- `c7 ?? 09 ..` (mov [reg], imm32 starting with 0x09): produced one cluster at 0x647be721 that writes `dword [ebx]=9` then `[ebx+4]=eax`, advance 8 — *not* the D3DINSTRUCTION format (op|size|count packed). Looks like a d3rm-internal scratch DAG/IR, not the public D3DEXECUTEBUFFER format.

Conclusion: d3rm almost certainly emits D3DINSTRUCTIONs through a **parameterized helper** that takes (buf_ptr, op, size, count) — opcode is a parameter, not a byte-literal. Direct byte-pattern search will not find it.

**Better paths to find the emitter:**
1. Trace the lpData pointer returned by Lock. Set `--trace-api=IDirect3DExecuteBuffer_Lock` with `--trace-stack=Lock:8` to get d3rm's caller; disasm there to see what local stores the unpacked `lpData`. Then use `tools/find_field.js test/binaries/dlls/d3drm.dll <local_offset>` (or a watch on the lpData address) to find every store through it.
2. Set `--watch-byte=<lpData_VA>` on the buffer immediately after Lock; the first write tells us exactly which fn writes the first instruction.
3. Lift the buffer dump just before SetExecuteData to confirm whether the 32-byte content is actually 4× D3DOP_STATETRANSFORM headers or some other shape. If it's only headers with the count=0, then a single conditional gate is suppressing the body — that's the bug site.

**Iteration — found the parameterized emitter and its caller graph:**

`--trace-stack=Lock:8` resolved the per-frame Lock callers to two distinct fn entries:
- Site A (alternates with Site B): caller fn `0x6479f781` — emits only ops 7, 8, 0x1b, 0x29, 0x1d (STATELIGHT, STATERENDER, render-state value codes). No triangle/vertex emit.
- Site B: caller fn `0x6479df51`/related.

Both reach the same emit helper: `0x647c36e0(ctx, op, lo, hi)` →`0x647c3744(ctx, op, ptr_to_8byte_payload)`. The latter writes a 4-byte D3DINSTRUCTION header `(op, size=8, count++)` then copies 8 bytes payload. **Size=8 is hardcoded** — meaning this helper handles ONLY 8-byte-payload ops (TRIANGLE, STATE*, MATRIXLOAD, POINT). PROCESSVERTICES (24B) and LINE (4B) need different paths, presumably with a similar parameterized helper that we haven't located yet.

**Caller-opcode tally** (49 call sites of `0x647c36e0`, opcode tallied from preceding `push imm8`):
| op | count | meaning |
|---|---|---|
| 8 | 23 | D3DOP_STATERENDER |
| 1 | 10 | D3DOP_POINT or counter |
| 0 | 8 | (size or value) |
| 7 | 8 | D3DOP_STATELIGHT |
| 4 | 5 | D3DOP_MATRIXMULTIPLY |
| 0x21 | 5 | render-state code |
| ... | ... | various |
| **9** | **1** | **D3DOP_TRIANGLE** ← only one site |
| **5** | **2** | **D3DOP_PROCESSVERTICES (DX6)** |
| 3 | 2 | D3DOP_TRIANGLE (DX2/3) or size |

**Triangle emit lives in fn `0x647af646`** (which wraps the only op=9 push at 0x647af84f). Xref shows `0x647af646` is bound only via vtable at `0x647e0b58` — a class vtable whose name string is `"Texture"`. Equivalent slot in the `"Device"` class vtable (`0x647e08f8`+0x38) is the Clear-dispatcher we have been chasing.

**Tested both candidate geometry-emit fns at runtime — NEITHER fires for ROCKROLL:**
- `--trace-at=0x745CA646` (= preferred 0x647af646, "Texture" slot-14): zero hits
- `--trace-at=0x745DAF6B` (= preferred 0x647bff6b, "Mesh" slot-14 from vtable 0x647e0ec8): zero hits

**(2026-04-27 verification)** Re-tested with the correct relocation delta (`0x7459b000 − 0x64780000 = 0xFE1B000`). Earlier session used a wrong delta — reported addresses `0x745cb646` / `0x745dff6b` were never code in the loaded image, so those "zero hits" were vacuous. Confirmed Device-class slot-14 (Clear, `0x745BACD6`) fires repeatedly while Texture/Mesh slot-14 (`0x745CA646` / `0x745DAF6B`) genuinely never fire. The "bug is upstream" conclusion stands.

**Reference relocated addresses (delta = +0xFE1B000):**

| Source VA | Loaded VA | Purpose |
|---|---|---|
| 0x64798E51 | 0x745B3E51 | per-vp render entry |
| 0x647C2792 | 0x745DD792 | Gate B (per-vp setup, populates [vp+0xa0/0xa4]) |
| 0x647AD71E | 0x745C871E | Gate A (mesh-data populated predicate) |
| 0x647AF646 | 0x745CA646 | "Texture" class slot-14 (only op=9 site) |
| 0x647BFF6B | 0x745DAF6B | "Mesh" class slot-14 |
| 0x6479FCD6 | 0x745BACD6 | "Device" class slot-14 (Clear — fires) |
| 0x647C534F | 0x745E034F | inner walker |

So ROCKROLL's scene-walker invokes only `"Device"`-class slot-14 (Clear), never `"Mesh"` or `"Texture"`. The bug is **upstream of vtable dispatch**: the scene-graph iteration either contains no Mesh/Texture-class visuals, or the iteration filters them out.

**Refined root-cause direction:** check the scene-tree population path. RM scenes are built via `IDirect3DRMFrame::AddVisual` (slot 41 of the Frame interface) and `AddChild` (slot 18). At runtime, trace those COM IDs in the SCR's COM-call sequence — if `AddVisual` is never invoked or is invoked with a wrong-class ptr, that pinpoints the upstream bug. Also worth checking: `IDirect3DRMMeshBuilder::Load` (mesh data load) and `IDirect3DRMObject::CreateObject` to see if the SCR even creates meshes during init.

**Iteration — characterized the two gates from the next-session pivot:**

Gate A — `0x647ad71e` (relocated `0x745c871e`): trivial mesh-data populated predicate.
```
mov eax,[esp+4]            ; arg = some object (mesh or visual)
cmp [eax+0x88], 0
mov ecx,[eax+0x38]         ; ecx = arg's child (mesh data?)
jnz +alt
xor eax,eax; ret           ; early-out: returns 0
alt:
  copy [ecx+0x11c..+0x134] (24B) → [arg+0x6c..+0x80]    ; bbox/transform copy
  cmp [arg+0x34], 0
  setnz cl; mov eax,ecx; ret    ; returns ([arg+0x34] != 0)
```
So Gate A returns 0 when `[arg+0x88]==0` — meaning the object has no mesh data attached. Returns 1 when both `[arg+0x88]` and `[arg+0x34]` are populated.

Gate B — `0x647c2792` (per-vp setup, called as the per-frame gate at `0x64798e9a`): NOT a pure predicate, it actively populates `[vp+0xa0]` and `[vp+0xa4]` from a hash table:
```
esi=vp; ecx=[esi+0x34]=scene; ebx=[esi+0x98]; edi=[esi+0x9c]
ecx += 0xac                         ; ecx = &scene[0xac]  (counter)
[esi+0xa0] = [edi + ([ecx] mod ebx)*4]      ; hash-bucket lookup
[esi+0xa4] = [edi + ((([ecx]+ebx-1) mod ebx))*4]
mov edi,[ebx_local+0x540]; call [edi.vtbl + 0x30]    ; vtable slot 12 on a COM obj
```
So the dispatcher's "result row" pointers `[vp+0xa0]/[vp+0xa4]` are seeded by Gate B from `[vp+0x9c]` (a hash bucket array of size `[vp+0x98]`, indexed by a per-frame counter at `[scene+0xac]`). **The hash bucket array `[vp+0x9c]` IS the consumer chain we need.** If those buckets contain row entries pointing at meshes, geometry emit follows; if they're zero/empty, we get the observed "Clear-only" walk.

**Concrete next probe:** at runtime, after init has settled (e.g. batch 800), dump the contents of `[vp+0x9c]` for ROCKROLL's main viewport. Steps:
1. Locate `vp` ptr — viewport is the obj passed to `0x647c2792` (recurses into the scene-root walk). Easiest: `--break=0x745d2792 --break-once`, dump `[esp+4]` (= vp) and step into to read `ebx=[vp+0x98]` (bucket count) and `edi=[vp+0x9c]` (bucket array base).
2. Hexdump that bucket array: if every dword is 0, the scene populator never ran. If non-zero entries point at mesh-class instances, then Gate A's `[arg+0x88]==0` early-out is filtering them out (which means mesh-data attachment is failing).
3. Fork: if buckets are empty, the bug is at scene-population time (CreateMeshBuilder/Load/AddVisual init path). If buckets are populated but Gate A bounces them, check whether `[arg+0x88]` (likely a mesh-data ptr) was ever written — that's the real failure point.

**Iteration (2026-04-27): static analysis identified the populator + runtime confirmed it never fires.**

`find_field --op=write --reg=esi,edi,ebx 0x9c` on d3drm.dll returns 3 sites that write `[reg+0x9c]`:

| Site | Enclosing fn | Role |
|---|---|---|
| 0x647c13c2 | 0x647c1377 (viewport ctor) | Zeros `[esi+0x9c]=0` along with `+0x98/+0xa0/+0xa4/+0xa8/...` (initial NULL state) |
| 0x647aef29 | 0x647aeede (vp clone) | Copies `[edi+0x9c]` → `[esi+0x9c]` (and many surrounding fields) — clone path |
| 0x6479e6b5 | 0x6479e550 (populator wrapper) | `[esi+0x9c] = [ebp-4]` only on success — the lone allocator/populator |

The populator wrapper at `0x6479e550` (loaded VA `0x745B9550`) calls inner `0x6479e6cc(vp, arg, &out_ptr)` which allocates the bucket array; on success writes `[vp+0x9c]=out_ptr` and `[arg2]=out_ptr`. Caller chain: `0x6479e259 → 0x6479e3c1 (call 0x6479e550)`.

**Runtime test:** `--trace-at=0x745B9550` over 15000 batches → **0 hits.**

**Conclusion:** `[vp+0x9c]` stays NULL for ROCKROLL's entire run. The bucket array is never allocated — scene-population path is short-circuiting before it ever reaches the populator. This pins the bug to the scene-creation path that should invoke `0x6479e259`'s caller chain.

**Next-session pivot:**
1. Walk the call chain back from `0x6479e259` — its sole external xref is `0x6479ee76`. Find its enclosing fn and continue back until we hit either (a) a public d3rm COM method (entry pattern `mov ecx,[esp+4]; mov eax,[ecx]; jmp [eax+N]` style or a vtable slot), or (b) a code path gated on something the SCR doesn't satisfy.
2. Once identified, set `--trace-at=` on each level to see which is the topmost fn that DOES fire vs the topmost that DOESN'T — the gap is the missing wiring.
3. The likely culprit class: `IDirect3DRMViewport::Render` or its inner `BuildVisualList`. Check `[obj+0x540]` slot 12 callee from Gate B for hints about what kind of object owns `[+0x540]`.

**Iteration (2026-04-27, part 2): walked the chain up — found the gating fn, identified the failing dirty/has-work check.**

Call chain (each level confirmed by xrefs):

```
0x6479e6cc (allocator, writes [vp+0x9c])
  ← 0x6479e550 (wrapper, success path)            16 callers
  ← 0x6479e259 (multi-arg caller, calls 0x6479e550 at 0x6479e3c1)
  ← 0x6479ee1c (loop fn — walks 3 parallel arrays at [ebp+0x10/14/18], calls 0x6479e259 per item)
  ← 0x6479f1ee (only 1 xref to ee1c)
  ← 0x6479ff51 (entry: push ebp; sub esp,0x20)    2 callers: 0x647857ef, 0x647bc516
```

Fn `0x6479ff51` body (relevant skeleton):
```
push 0x647e08f8 / push [ebp+8] / lea/push &local
call 0x64799d8d           — QI/lock probe (returns nonzero on FAIL)
test eax,eax
jnz 0x647a021e            — FAIL path (skip body)
push [ebp+8]
call 0x6479fe13           — DIRTY/has-work check (returns 1 if work needed)
test eax,eax
jz  0x6479ffeb            — SKIP body if no work
... (body that eventually calls 0x6479f1ee → ... → populator)
```

**Runtime probes (single --trace-at per run, block-entry only):**

| Probe | Loaded VA | Hits |
|---|---|---|
| 0x6479ff51 entry (wrapper) | 0x745BAF51 | **16** |
| 0x6479ff76 (after QI-success) | 0x745BAF76 | **16** |
| 0x6479ff7e (after dirty-check call) | 0x745BAF7E | **16** |
| 0x6479ff85 (work-path entry) | 0x745BAF85 | **0** |
| 0x6479ffeb (skip-body target) | 0x745BAFEB | **16** |
| 0x6479f1ee | 0x745BA1EE | 0 |
| 0x6479ee1c | 0x745B9E1C | 0 |
| 0x6479e259 | 0x745B9259 | 0 |
| 0x6479e550 (populator) | 0x745B9550 | 0 |

**Conclusion:** Wrapper `0x6479ff51` IS reached 16 times. QI succeeds every time. **All 16 calls take the skip-body path** because `0x6479fe13` (dirty/has-work check) returns 0 every time. The populator chain is therefore never invoked.

`0x6479fe13` returns 1 only if **both** conditions hold:
1. List at `[esi+0x5cc]` non-empty OR list at `[esi+0x698]` non-empty (probe via `0x6479fe64` — likely "is list head non-NULL")
2. AND `[esi+0x90] & 3 == 3` (both bits 0 and 1 set)

`esi` here is the object passed to ff51 — based on push-pattern at the call site (`push 0x647e08f8` / `push [ebp+8]` / `lea+push`), this is presumably a viewport or root frame.

**Next-session pivot:**
1. At runtime, when 0x6479ff51 fires, dump the wrapper's `[ebp+8]` (= `esi` inside fe13) and read `+0x90`, `+0x5cc`, `+0x698`. That tells us which of the two gates is failing.
2. Trace the writers to those fields to find the missing wiring:
   - `find_field --op=write 0x90 --reg=esi,edi,ebx` for the flags field
   - `find_field --op=write 0x5cc` and `--op=write 0x698` for the list heads
3. The 0x647e08f8 token pushed before the QI call is likely a class/IID identifier — dump it to confirm what kind of object ff51 expects.

**Original (now superseded) "find AddLight in d3drm" plan:**
1. **Find the real public-COM vtable for IDirect3DRMFrame** — its `AddLight` slot (slot 12 in DirectX 5 header order) must call into `0x647adcef` somehow (possibly via more glue we haven't disasm'd). Walk class-Frame's ctor at `0x647e0f18+...` to find what vtable address it writes into `[obj+0x0]`. That gives the public Frame vtable; slot 12 is AddLight.
2. **Inside d3rm, search for direct calls to `0x647adcef`** (not just vtable refs): `node tools/xrefs.js test/binaries/dlls/d3drm.dll 0x647adcef --code` — its callers are the COM-method implementations that should fire when the SCR calls AddLight. If a chain of these exists, set `--break=` on each in turn to find the layer where the call is missing.

Per-vp render `0x64798e51` flow (cleaned up):
- entry: `mov esi, [ebp+0x8]` → esi = viewport
- `mov edi, [esi+0x34]` → edi = scene-root frame
- gate `0x64798e9a: call 0x647c2792(esi)` — predicate; runtime returns 0 → continue (verified)
- `0x64798eca: and dword [esi+0xbc], 0` — zero viewport count for new frame
- `0x64798f35: call 0x647c1d30` — initial setup
- `0x64798fb6: mov eax,[ebx]; ... call [eax+0x40]` — vtable call (slot 0x40 of `[edi+0x5b8]`'s class)
- `0x6479901d: call 0x6479b235` — pre-populator hook
- `0x64799027: call 0x647c11f7` — produces source list
- `0x6479902f: call 0x647c1c2b` — populator (dest=viewport, src=eax of prev call) — **fires**

So the populator builds the viewport's draw list. Then per-vp render presumably issues the dispatcher walks afterwards. The dispatcher gets EBX=scene-root because scene-root IS the natural "walk root" for the scene_walker (`0x64798903`), but the dispatcher's inner walker `0x647c534f` looks at `[arg+0xbc]/[arg+0xc4]` of THIS arg (scene-root) — which is empty. The viewport's populated list is read from a different code path we haven't traced yet.

**Next-session pivot:**
1. Probe predicate `0x647ad71e` (relocated `0x745c871e`) on each of the 3 viewport entries — what does it test, what does it return? `--break=0x745c871e --break-once` then dump `[esp+4]` (entry), `[esp+0xc]` (scene-root), step to ret, dump eax.
2. Read `hr_cache` at `0x647e7afc` (relocated `0x7500_2afc` — verify) at dispatcher entry/exit. If 0, the success path is masked by the `and eax, hr_cache` epilogue.
3. If predicate succeeds and hr_cache is nonzero, follow the result row at `[ebx+0xa0] + i*0x50`. The 0x50-byte rows are the dispatcher's output — they must be consumed by a downstream geometry-emit pass that writes PROCESSVERTICES/TRIANGLE. `find_field` for `+0xa0 --op=read` should narrow that consumer down.

### 4. MFC screensavers — full DirectAnimation (DEFERRED)

CORBIS investigation (2026-04-20): the COM dependency isn't IPicture/OleLoadPicture but **DirectAnimation** (DAView + DAStatics from `danim.dll`). `CLSIDFromProgID(L"DirectAnimation.DAView"/L"DAStatics")` stubbed to `REGDB_E_CLASSNOTREG`; app then crashes on a null vtable from an unpopulated DAView pointer. Bringing up even minimal DirectAnimation is larger than the existing DDraw work. FASHION/HORROR/WOTRAVEL share the framework.

`CLSIDFromProgID` returns `REGDB_E_CLASSNOTREG`. `IDirectDrawFactory` (CLSID `0x4FD2A832`, ddrawex.dll) is short-circuited in `CoCreateInstance`; its 5 vtable methods (api_ids 1136–1140) delegate to existing DDraw wrappers. WIN98.SCR works via this path.

## Tooling — recently added (keep using)

- `tools/dump_va.js <pe> 0xVA[,...] [len]` — peek static PE/DLL bytes; explicitly tags BSS so a zeroed sentinel doesn't masquerade as initialized data.
- `tools/vtable_dump.js <pe> 0xVTBL_VA [n]` — enumerate N vtable slots with first-instruction disasm of each target.
- `--trace-dx-raw` (lib/host-imports.js case 8) — hex-dumps the full Execute-buffer instruction stream, not just the walker's parse. Reusable for any future d3rm/d3dim investigation.
- `--trace-at-dump=ADDR:LEN[,...]` — per-hit memory snapshot; pair with `--trace-at-watch` for diff-vs-previous.
- `[dx] ExecIn` formatter (lib/host-imports.js:4397) annotates each Execute with `caller=<retAddr>` so the originating wrapper is identifiable in one glance.

## Completed (for reference; details in git log)

- **InSendMessage / EnumWindows + ESP cleanup** — fixed ESP drift across stdcall handlers; unblocked 7 DDraw savers' MFC init.
- **DirectDraw QI AddRef** — QI must AddRef even when returning the same wrapper, otherwise Release frees the DX_OBJECTS slot. Unblocked WIN98.SCR rendering.
- **Sprite SRCAND/SRCPAINT compositing** — black silhouettes → correct colors (PEANUTS/CATHY/DOONBURY).
- **MFC42 CBT hook stack fix** — CACA0002 missing saved_ret/saved_hwnd pushes; unblocked CORBIS/FASHION/HORROR/WIN98/WOTRAVEL message loop.
- **THREAD_BASE moved out of thunk zone** — was 0x01D52000, now 0x01E52000.
- **D3D init crashes** (sessions 2026-04-18 a..j): "No valid modes" CA::DXException — root-caused to GetSurfaceDesc reporting SYSTEMMEMORY caps for Z-buffers. Plus IDirect3D2 QI returning D3D3 vtable, IDirect3D2::CreateDevice returning DEV3 vtable, GetPalette error triggering DXException, COM-wrapper vtable mutation replaced with aux-wrapper pool. All shipped.
- **TLS via fs:[0x2c]** — MFC string helpers read TLS array via direct FS-segment access, never call TlsGetValue. Eagerly allocate `$tls_slots` and set `fs_base+0x2c` in `$enter_entry_point`.
- **fs_search_path arg-order bug** — `writeStr(bufGA, full, bufLen, isWide)` consumed `bufLen` as `isWide`, so SearchPath results were UTF-16-encoded. Fixed.
- **IDirectDrawSurface2 GetDDInterface / PageLock / PageUnlock** — `esp += 8` instead of `esp += 12` caused -4 ESP drift; downstream `pop edi` read wrong slot, manifested as a phantom EDI corruption across an unrelated callee.
- **QI for Texture2 / DDSurface must upgrade vtable** — DX3-compat "return same wrapper for any QI" broke Texture2→DDSurface roundtrips. Now uses aux-wrapper pool keyed by IID.
- **SEH walker fix** — `frame_ebp = seh_rec + 0x10` (was `+0xC`) for the 5-dword MSVC `__SEH_prolog4` layout; also reset `$steps=0` on unwind so `$th_call` doesn't clobber the unwind target. Apps with top-level MFC `__except` handlers now exit cleanly.
- **dibSection sparse-hash sync** — `_syncDibSection` no longer wipes the canvas on every BitBlt source resolution. Unblocked PHODISC's desktop-color render.
- **GetClipBox / Timer ID 0 / SetStretchBltMode / GetBkColor / GetTextColor / GdiFlush / PlaySoundA stub** — implemented.

**2026-04-27 iteration — public Viewport::Render is dead at the SCR boundary; "caller B" recap was a false lead.**

Today's session pinned down two things that the prior chain had wrong:

1. **`0x647bc46a` is NOT a viewport-render path.** Its sole xref is `0x647914ca` inside fn `0x647914b5`, which sits at slot 32 of all three IDirect3DRMFrame vtables (`0x647e0200/0290/0320`) and is a critsec-wrapped 1-float setter (scene-fog-class). So the prior session's "caller B at `0x647bc516` is the viewport-render path to populator" was wrong — `0x647bc516` is inside the body of the fog setter, not on the render hot path. That branch fires only for fog manipulation, which ROCKROLL never does.

2. **Public IDirect3DRMViewport vtable located: `0x647dfde0` (38 slots).** Confirmed via `tools/vtable_dump.js`:
   - Slots 0–10 = IUnknown(3) + IDirect3DRMObject(8) shared base — same prefix as every other RM vtable in `.data` (`0x64791da1, 0x64791df6, 0x64791e3d, 0x64791e84, 0x64791f73, 0x647924ab, 0x647926d4, 0x64792720, 0x64792766, 0x647927aa, 0x647928bd`).
   - Slot 13 = **IDirect3DRMViewport::Render = `0x6478be6d`**. Body confirms: `push esi; push [global_lock]; call [crit_lock]; mov eax,[esp+8]=arg1=Frame; if (eax) ecx=[eax+8]; ... call 0x647aebc1; push eax; push esi; call 0x64793e93; ...; pop esi; ret 0x8` — single-frame-arg, locked, dispatches to internal renderer at `0x64793e93`.

3. **Runtime probe — `0x6478be6d` (relocated `0x745d6e6d`) NEVER fires** in an 8000-batch ROCKROLL run. Confirms an architectural fact already implicit in the trace inventory: the SCR never calls the public IDirect3DRMViewport::Render. The whole "RM scene tree → RM Render → emits Execute buffer" mental model doesn't apply here. **ROCKROLL is pure D3DIM:** `--trace-api` over a full run shows **zero** `IDirect3DRM*` API names — only `IDirect3D{,2,3}_*`, `IDirect3DDevice{,2,3}_*`, `IDirect3DExecuteBuffer_*`, `IDirect3DViewport3_*`, `IDirect3DMaterial3_*`, `IDirect3DTexture2_*`. The only d3rm import the SCR pulls is `Direct3DRMCreate` (plus a few math helpers).

   So d3rm.dll is loaded, `Direct3DRMCreate` is called once, but nothing on the render side ever traverses through public RM interfaces. The visible per-frame work (the Lock/Unlock/Execute/Clear cycle) goes directly through D3DIM. d3rm's internal scene-walker (the `0x647c534f` family we've been tracing) is reachable, but only via the Frame fog setter — which the SCR never invokes — so it's effectively dead code in this run.

4. **Vtable map of d3drm `.data`** (file/VA delta `dataFile=0x5e400`, dataVA=0x647df000): scanning for runs of valid-text-pointers yields 37 vtable runs. Notable identifications:
   - `0x647e0200 / 0x647e0290 / 0x647e0320` — IDirect3DRMFrame v1/v2/v3 (≈33/45/39 slots). Confirmed.
   - `0x647dfde0` — IDirect3DRMViewport (38 slots, slot 13=Render=`0x6478be6d`). **NEW.**
   - `0x647dff98` (24 slots) + `0x647dfff8` (14 slots) — paired interfaces sharing 11-slot RMObject base; sizes don't match Viewport.
   - `0x647dfb50` (~70 slots before next prefix) — IDirect3DRMMeshBuilder3 candidate (extends RMVisual+RMObject; ~50 derived methods).
   - Long merged runs at `0x647dfde0..` and `0x647dfb50..` contain multiple back-to-back vtables; the 11-slot RMObject prefix demarcates each new vtable boundary.

**Reframed picture (consolidated with prior findings):** The *only* per-frame execute buffer that reaches our D3DIM is the d3rm-internal state batcher producing `vc=0, il=32` (4× state ops + EXIT). The SCR doesn't drive RM at all post-Direct3DRMCreate. So the geometry must be coming from one of:
   (a) The SCR builds D3DIM execute buffers itself (with TRIANGLE/PROCESSVERTICES) and our Lock/Unlock pair fails to retain its writes — but `--trace-stack=Lock:8` shows every Lock caller resolves to a d3rm-internal fn (`0x647c3744` / `0x647c3726`), never to SCR code (`0x744xxxxx`). So **the SCR doesn't directly populate execute buffers either.**
   (b) The SCR's draw path is "build execute buffer via d3rm-internal helpers it discovered through QI on the device" — i.e., d3rm exposes execute-buffer-fill helpers that the SCR uses without going through the public RM Render API. This matches the prior `0x6479ff51` finding (16 hits per frame, all skipping body via the `0x6479fe13` dirty-check). The SCR's per-frame work invokes that wrapper, but the dirty bit is never set, so the populator never runs.
   (c) Old hardware-rendering shortcut: SCR fills geometry through `IDirect3DDevice::DrawPrimitive`-style calls. Our trace has zero `DrawPrimitive` (no `IDirect3DDevice2_DrawPrimitive` in the API set), so this path is also dead.

**Concrete consolidation for next session:**
- Drop the Viewport::Render hypothesis — it's dead at the SCR boundary.
- Re-focus on the existing `0x6479ff51`/`0x6479fe13` finding: at runtime, when ff51 fires, dump `[ebp+8]` (= esi inside fe13) and read `+0x90` (flags), `+0x5cc`, `+0x698` (list heads). Whichever gate is failing tells us which upstream init step is missing.
- Cross-check with the SCR's d3rm-internal entry: only one of ff51's two callers (`0x647857ef` or `0x647bc516`) is on the live path. `0x647bc516` is inside the fog setter (dead in ROCKROLL), so all 16 ff51 hits per frame must come from `0x647857ef`. Find what fn `0x647857ef` belongs to and walk up — that's the per-frame entry the SCR uses to drive d3rm internals.

**2026-04-27 cont. — `0x647857cf` identified: IDirect3DRMDevice slot 14 (versioned), reachable from SCR's paint loop.**

Walked the live caller of `0x6479ff51` (the dirty-check wrapper that fires 16×/frame but always skips body). The trampoline at `0x647857cf`:
```
push [global_lock]; call [crit_lock]
mov eax,[esp+8]            ; arg1 = this (COM wrapper)
test eax,eax; jz null
mov eax,[eax+8]            ; eax = inner
mov eax,[eax+0x10]          ; eax = inner.[+0x10]
push eax
call 0x6479ff51            ; ← the dirty-check chain
push [global_lock]; call [crit_unlock]
ret 0x4                     ; 1 arg + this
```
Single-arg public method, classic critsec-wrapped COM trampoline.

`tools/xrefs.js` shows three xrefs to `0x647857cf` — all from `.data`. Scanning d3rm `.data` for the canonical 11-slot IUnknown+RMObject prefix yields 33 vtable starts; scoring `0x647857cf`'s slot index across those:
- `0x647df068` slot 14
- `0x647df0f0` slot 14
- `0x647df190` slot 14

Three vtables, same slot, identical fn → **versioned IDirect3DRMDevice vtables (Device v1/v2/v3), slot 14**. Per DX5 header order (IUnknown[3]+RMObject[8]+Device-specific), slot 14 is `HandlePaint(HDC)` — the per-WM_PAINT render-trigger an app calls to drive the device. The 16 hits/frame match a typical paint-loop cadence (one HandlePaint per child viewport per frame).

So the SCR's per-frame entry into d3rm internals goes:
```
SCR WndProc/timer → IDirect3DRMDevice::HandlePaint(hdc)
                  → trampoline 0x647857cf
                  → 0x6479ff51 (dirty-check wrapper)
                  → 0x6479fe13 (dirty bits @ [obj+0x90], list heads at +0x5cc/+0x698)
                    → ALL 16 calls skip body — dirty bits never set
                  → exit without populating
```

The bug surface narrows further: **dirty bits at `[obj+0x90]`** never get set during scene init. That's what gates the entire populate→emit→draw chain.

**Refined next-session probe (keep narrow):**
1. `--break=0x745b3f51 --break-once` (= `0x6479ff51 + 0xfe1b000`), at hit dump `[esp+4]` = arg-to-ff51, then dump that obj's `+0x90` (flags), `+0x5cc` (list head 1), `+0x698` (list head 2). Confirm all three are zero.
2. `find_field --op=write 0x90 --reg=esi,edi` on d3drm.dll for writers that *set* (not zero) the dirty bits. The setter is what should fire when the SCR calls `IDirect3DRMFrame::AddVisual`/`AddChild`/`SetPosition` — find which of those it is, then trace whether the SCR ever invokes that path.
3. The COM trace already shows the SCR calls `IDirect3DDevice_BeginScene/EndScene/Execute/CreateExecuteBuffer/SetMatrix/CreateMatrix` plus `IDirect3DViewport3_*` — but **no `IDirect3DRM*` API at all**. So the dirty bit must be set *internally* by Direct3DRMCreate or by an internal helper the SCR triggers via Device QI. Check Direct3DRMCreate's own body to see whether it primes `[device+0x90]` with the right flags.

**2026-04-27 cont. — fe13 predicate decoded, gate is bit 1 of `[device+0x90]` (bit 0 is set, bit 1 is missing).**

Ran with `--trace-at=0x745baf51 --trace-at-dump=0x750a9a68:0x100` (relocated ff51, d3drm.dll loaded at 0x7459b000, delta 0x0fe1b000, obj from `[esp+4]` is 0x750a9a68 — stable across all 16 hits/frame, confirming there's a single device on the paint path).

Live device dump (first 0x100 bytes):
```
+0x00  vtable=0x7500c138, inner=0x75033350
+0x10  =2  +0x18=0x745fb8f8 (d3rm static)  +0x20=0x7500bf60  +0x2c=0x74e13390 (global)
+0x3c  =0x280 (640)   +0x40=0x1e0 (480)        ← viewport size
+0x80  =0x3fb33333 (1.4f)   +0x8c=0x3fc00000 (1.5f)
+0x90  =0x00000001                                ← FLAGS: only bit 0 set
+0x94  =1  +0x98=1  +0x9c=0x7500bf50              ← visual-list count=1, array of 1 ptr
```

So the obj IS populated (1 visual at `0x7500bf50`, 640×480 viewport, default 1.4/1.5 floats — looks like real device state).

Disassembled the predicate at `0x6479fe13`:
```
mov esi, [esp+8]                ; esi = device
lea eax, [esi+0x5cc]; call 0x6479fe64    ; list_active(&device.list1)?
test eax, eax; jnz fe3a
lea eax, [esi+0x698]; call 0x6479fe64    ; list_active(&device.list2)?
test eax, eax; jz fe53                    ; if BOTH lists inactive → return 0
fe3a: mov eax, [esi+0x90]
      test al, 0x1; jz fe4d              ; bit 0 must be set
      test al, 0x2; jz fe4d              ; bit 1 must be set      ← FAILS HERE (al=0x01)
      mov eax, 1
fe4f: test eax, eax; jnz fe57            ; → run full populate path
fe53: xor eax, eax; ret                  ; → return 0, ff51 caller skips work
```

And the list-active helper `0x6479fe64`:
```
mov eax, [esp+4]          ; arg = &device.list_struct
test [eax+0x04], 0x40    ; jz fail
test [eax+0x74], 0x10    ; jz fail
test [eax+0x78], 0x20    ; jz fail
return 1
```
Three independent ready-bits across a sub-struct. We didn't dump +0x5cc/+0x698 yet (next probe), so list-active state remains unknown — but it doesn't matter: **the bit-1 gate at +0x90 already fails**, fe13 returns 0 even if both lists are active.

**Hunt for the bit-1 setter** — `find_field [reg+0x90] --op=write` on d3rm.dll yields exactly 4 mov-writers; none ORs in bit 1, none stores imm 3:
- `0x64794596` — public setter `[ecx+0x90] = arg` (any value); enclosing fn `0x6479456e`. Single xref from trampoline `0x64785b8f`, which appears in **slot 36 of Device v2/v3 vtables (`0x647df180`/`0x647df220`)** — strongly looks like `IDirect3DRMDevice2::SetRenderMode(DWORD)`. **COM trace shows zero IDirect3DRM* calls from ROCKROLL.SCR** — slot 36 is never dispatched, so this path can't be where the value gets set at runtime.
- `0x6479c852` — device-init initializer, writes `[esi+0x90] = 0` (init clears).
- `0x6479d95c` / `0x6479d970` — list-unlink/relink in some teardown helper; neither sets bit 1.

So the writers `find_field` can see don't account for the live value `0x01` in our dump. Either:
  (a) bit 0 is set via a byte/OR op (`80 88 90 00 00 00 ..` or `83 88 90 00 00 00 ..`) that find_field's mov-only scan misses, or
  (b) writer 4 (which copies `[ebx]` into `[ecx+0x90]`) fires with a global-table value that holds 1.

**Refined next-session probe (this is the working theory):**
1. Relocated breakpoints on the public setter and on writer 4: `--break=0x745af56e,0x745b8970 --break-once` — confirm (or rule out) that writer 4 is what installs the live value 1.
2. If neither fires before the first ff51 hit, then bit 0 is set via a non-mov op. Run `objdump -d` / a custom byte-pattern grep on d3rm.dll for `83 88 90 00 00 00` (or-imm32) and `80 88 90 00 00 00` (or-imm8) to find OR-ers.
3. Once the bit-0 setter is found, look for what *should* set bit 1 in the same code path. The likely scenario: there's a path conditioned on a flag we never satisfy (e.g., palette/dither config, scene attached, viewport background set), and that path is where bit 1 = "scene ready" gets ORed in. Identifying it pins down exactly which init-time check our emulator is failing.
4. As a parallel probe, dump the larger device region `0x750a9a68:0x800` (covers +0x5cc and +0x698) just to verify list-active state isn't *also* failing — even though the bit-1 gate is sufficient on its own.

**2026-04-27 cont.2 — ff51 = IDirect3DDevice IM EndScene; gate object is a *sub*-object of the device, not the device itself.**

- xrefs(0x6479ff51) → 2 callers; the relevant one is thin trampoline `0x647857cf` (push critsec → call ff51 → pop critsec) which lives in slot 14 of Device v1/v2/v3 vtables `0x647df068/0x647df0f0/0x647df190` (slot offset 0x38 from each base, all three pointing at `0x647857cf`). **Slot 14 of IDirect3DDevice2 = EndScene.** So ff51 is the IM device's EndScene scene-renderer.
- The trampoline pre-call at `0x647857d0`: `push eax = [[device+8]+0x10]`. So the obj that lands in `[esp+4]` of ff51 is **not the device** — it's `device->internal_state[+8]->[+0x10]`. Our earlier "live device dump at 0x750a9a68" was actually the IM-device's *render-context* or *scene-state* sub-object. The `+0x90` bit-flag predicate is on this sub-object, not on the device.
- This means the bit-1 gate is whatever flag this sub-object sets to mean "scene populated and ready to render." Exec buffers, vertex buffers, and matrix-table state probably feed into it.
- The 4 mov-writers in `find_field` may all target the device proper (called with different bases) — we need to redo `find_field` filtered to writers reachable from the IM render path (Execute / SetMatrix / SetRenderTarget / BeginScene). The byte-pattern grep for OR-imm targeting +0x90 in the *whole* DLL returned 0 hits, so the bit-1 setter is definitely a `mov dword ptr [reg+0x90], <value-with-bit1>` — and `<value-with-bit1>` must come from a load in a code path that's not yet firing.
- Tried bp at relocated 0x745af56e / 0x745b8970 with `--max-batches=20000`: ROCKROLL.SCR didn't get past CRT init / heap loop in 100M instructions, never even reached `RegisterClass` → `CreateWindow` → first paint. Earlier sessions reaching ff51-16x/frame must have used different setup (longer run, different /s args, or windowed); current `/s` flow is stuck before any d3rm code executes (174 unique EIPs, none in the 0x745b0000+ range).

**Next-session probe (revised):**
1. Get the SCR past CRT init first — try `--args=""` (run-config dialog instead of /s) or `--args="/p HWND"` (preview), and crank `--max-batches=200000`. Confirm we reach a CreateWindow/ShowWindow before chasing the bit-1 problem.
2. Once paint loop runs, set `--break=0x745b8516 --break-once` (= relocated 0x647bc516, the *other* ff51 caller — the one with a real prologue at `0x647bc46a`). It's the in-d3rm internal caller (not the vtable trampoline), and it likely runs *during* scene setup. If it fires earlier than the trampoline path, walk back to find which init step was supposed to set bit 1.
3. Re-run `find_field 0x90 --op=write` but this time on **DLL-internal** structures. The "sub-object at device->[+8]->[+0x10]" could be a different class with its own +0x90 field that overlaps with what `find_field` is reporting. If the sub-object is allocated by a specific factory function, walk its constructor (`new` site → ctor) to see the full bit-init.
4. Long shot: the bit-1 might actually represent "a render target has been bound" — check if SCR ever calls `IDirect3DDevice::SetRenderTarget` or equivalent. COM trace would show this. If absent, the SCR might be expecting an implicit binding that our emulator doesn't perform on viewport attach.

**2026-04-27 cont.3 — public setter IS called from SCR with value=1 (28 hits).**

Reproduction recovered: `--args="/s" --max-batches=200000 --batch-size=2000` reaches d3rm code (472 unique d3rm EIPs, 303k API calls, full DDraw/D3DIM init flow — DirectDrawCreate → IDirect3D2_EnumDevices → SetCooperativeLevel → CreateWindowExA → GetMessage loop, etc.).

`--trace-at=0x745af56e` (relocated public setter at d3rm preferred 0x6479456e):
- **28 hits over the run.** Each hit shows `[esp+4]` = a sub-object ptr, `[esp+8]` = `0x00000001` always. Hit #1's sub-object = `0x750a9a68` — exactly the gate object we identified earlier.
- Return addr `[esp+0]` = `0x745a0bb8` = relocated `0x64785bb8`, which is **inside trampoline `0x64785b8f`**, immediately after its `call 0x6479456e`. So the call chain is: vtable indirect → trampoline → setter.
- The trampoline is at slot 36 (offset 0x90) of vtables `0x647df0f0` / `0x647df190`. Slot 0 of `0x647df0f0` = `0x64791da1` (looks like QI prologue; hexdump shows the standard QI/AddRef/Release triple at slots 0-2).
- One step up: trampoline ret addr in stack = `0x74419179` = inside SCR fn `0x74419044`. SCR call site `0x74419173`: `call [ebx+0x90]` (vtable indirect, slot 36). 2 args pushed: `push esi` (this), `push eax` (value). The `eax` came from `call 0x7448e8ac`, which is an **FPU fistp helper** — converts FPU TOS to int. So the SCR pushes a float via FPU then converts to int and passes it. The float was 1.0 → eax=1.

**Writer 4 (`0x6479d970`, mov [ecx+0x90], eax loaded from [ebx]) NEVER fires** — confirmed via `--trace-at=0x745b8970`, 0 hits over the same 200k-batch run. So the live `+0x90 = 0x01` value comes 100% from setter `0x6479456e`, called from SCR with FPU-rounded value 1.

**This rules out the "missing call to SetRenderMode(3)" theory.** The SCR explicitly pushes 1.0 here; the value isn't a constant we can tweak by triggering more init paths. So the bit-1 gate must come from **a different write path** (a *different* offset that overlaps under another base register's view — i.e., a different mov-writer with target offset other than 0x90 but landing on the same byte due to base mismatch), or **the predicate at fe13 is structured so bit 0 = "at least one write happened" and bit 1 = "render target is current"** — set by a code path that fires on `SetRenderTarget`/`SetCurrentViewport`-style calls.

**Next probes:**
1. Confirm: does ROCKROLL.SCR call `IDirect3DDevice2::SetRenderTarget` or `IDirect3DDevice::SetCurrentViewport`? Add `--trace-api=IDirect3DDevice2_SetRenderTarget,IDirect3DDevice_SetCurrentViewport,IDirect3DDevice2_SetCurrentViewport`. If yes, walk our handler — we may be returning early without setting the bit-1 backing state. If no, the fe13 path may simply not be the gate this app needs and ff51 is dead code (the *real* render path would be elsewhere — re-check that the 16x/frame ff51 hits are during *paint* not init by correlating with WM_PAINT).
2. Walk fn `0x74419044` (the SCR caller) — what COM interface is `ebx` here? `call [ebx]` (slot 0) earlier in the fn would be QueryInterface on `ebx`; alternatively grep `0x74419044`'s prologue for the LPVTBL constant or `CreateInstance` chain that produced `ebx`. That tells us the interface name and the official meaning of slot 36.
3. Static: dump vtable `0x647df0f0` slot-by-slot, identify it via slot-0 QI's IID lookup or slot-3+ method count to determine the COM interface family. That nails down what setter we're looking at and what bit-1 *should* mean.

**2026-04-27 cont.4 — vtable identified, COM trace shows no SetRenderTarget/SetCurrentViewport.**

Vtable `0x647df0f0` dump (`tools/vtable_dump.js test/binaries/dlls/d3drm.dll 0x647df0f0 50`): 39 slots, slot 38 last non-null, slot 39 NULL. Slot count + d3rm-internal context = **`IDirect3DRMFrame2`** (Frame has ~28 methods, Frame2 has ~38, Frame3 has ~46+). Slot 36 of Frame2 is one of the late-added Frame2 methods — tentatively `SetSceneFogMethod` / `SetMaterialMode` / similar single-int setter. Caller pushing 1.0 via FPU fistp aligns with a quality/mode enum.

Full unique D3D APIs called by ROCKROLL.SCR (`grep -oE "IDirect3D[A-Za-z0-9_]+" sorted -u`): 47 distinct. Includes `IDirect3DDevice_AddViewport`, `_BeginScene`, `_EndScene`, `_Execute`, `_CreateExecuteBuffer`, `IDirect3DViewport3_SetViewport`, `_SetBackground`, `_Clear`, `IDirect3DDevice2_SetRenderState`, `_SetLightState`, `IDirect3DDevice2_GetRenderTarget`, `IDirect3DDevice_SetMatrix`. **No `SetRenderTarget`, no `SetCurrentViewport`** (d3rm uses immediate-mode D3D1 `AddViewport` only — there is no `SetCurrentViewport` in D3D1; that arrived in D3D2; the D3D1 immediate model uses the most-recently-added viewport implicitly).

So bit-1 is **not** missing because of a SetRenderTarget gap — the SCR doesn't call it. The bit-1 must be set **inside d3rm itself** during BeginScene/Execute/EndScene flow (the retained → immediate translation layer). Since the SCR-level setter at slot 36 fires 28× with value=1 but bit-1 is still clear in the gate object, the setter must be writing to a *different* sub-object than the gate object, or the gate object's +0x90 represents a different field aggregated from multiple writers.

**Re-check needed:** is the `0x750a9a68` "gate object" we keep referring to actually the *same* sub-object whose +0x90 is being set by the 28 hits? The trace-at hit #1 shows `[esp+4] = 0x750a9a68` — yes, it IS. So the setter IS writing to the gate object's +0x90 with value 1, 28 times. Then **bit-1 of +0x90 SHOULD be set** after these calls. Either (a) the bit-1 we're checking is actually on a *byte* offset other than +0x90 (e.g. +0x91, +0x92), or (b) something else clears it between the setter calls and the fe13 predicate check.

**Next step:** add `--watch-byte=GATE+0x90` (with GATE=0x750a9a68) and `--watch-byte=GATE+0x91/0x92/0x93` to see what byte the predicate at fe13 actually reads, and watch for clears. The predicate disasm needs another look — bit-1 of which byte exactly?

**2026-04-27 cont.5 — KEY INSIGHT: slot 36 is `IDirect3DRMDevice::SetRenderMode(DWORD flags)`; fe13 checks for `BLENDED+SORTED` transparency mode.**

Re-traced public setter `0x6479456e` with full arg dump (`--trace-at=0x745af56e`). 14 hits, **each on a different sub-object** (not all on the gate object 0x750a9a68 — only hit #1 was). Every call passes `value=0x00000001`. So the gate object's +0x90 was written *once* by hit #1 with value 1; no other writer touched it.

Walked SCR fn `0x74419044` immediately preceding the slot-36 call (lines `0x74419156..0x74419173`):
```
push 0                          ; arg3
push 0x3f800000                 ; arg2 = 1.0f (default)
push 0x744c5ef4                 ; arg1 = "RenderMode"  ←
mov ebx, [esi]                  ; ebx = vtable
call 0x744094f0                 ; reads HKEY_CURRENT_USER for "RenderMode"
add esp, 0xc
call 0x7448e8ac                 ; FPU fistp → eax = int(value)
push eax                        ; value
push esi                        ; this
call [ebx+0x90]                 ; slot 36
```

`0x74409f20` confirms the registry call uses `HKEY_CURRENT_USER` (constant `0x80000001`); `0x744c5ef4` is the literal string `"RenderMode"`. Adjacent debug-fmt strings: `Getting config value "%s"`, `Couldn't parse vector key "%s"`, `GetD3DRMDevice()->S...`, `Found "%f" in HKEY_CURRENT_U...`. So slot 36 of vtable `0x647df0f0` (Frame2-shape, 39 slots, `+0x90` setter, IID=`0x647e08f8`) is **`IDirect3DRMDevice::SetRenderMode(DWORD)`** — vtable is actually `IDirect3DRMDevice` (or v2/v3), not `IDirect3DRMFrame2` (slot count overlaps; the IID match nails it down).

Per d3drmdef.h, `D3DRMRENDERMODE_BLENDEDTRANSPARENCY = 0x1` and `D3DRMRENDERMODE_SORTEDTRANSPARENCY = 0x2`. So:
- bit 0 set ⇒ blended transparency enabled
- bit 1 set ⇒ sorted transparency enabled
- bits 0 AND 1 ⇒ both transparency modes (mode value 3)

The fe13 predicate `test al, 0x1; test al, 0x2` is therefore **"are BOTH transparency modes active?"** — *not* "is rendering needed?". When false (default mode=1, only blended), fe13 returns 0 and the ff51 caller skips its branch. **This is the simple/common case, not a bug.**

**This invalidates the 6-day investigation thread.** ff51 is **not** the missing render path — it's a transparency-sort optimization that's correctly skipped when the registry's RenderMode=1. The actual blank-screen bug is somewhere else entirely. The 16 hits/frame on ff51 + skip-body just means "16 transparency checks per frame, none needed." Real rendering must flow through the Execute/TLVertex/BeginScene path that we already see in COM trace (BeginScene/Execute/EndScene fire). The bug is **in our handlers' execution of the Execute buffer**, not in a missing init bit.

**Drop fe13/ff51 thread.** Refocus on:
1. Are `IDirect3DDevice_Execute` calls actually rasterizing geometry, or are we ignoring opcodes? `--trace-host=...` or step into our `$handle_IDirect3DDevice_Execute` and confirm we're processing TRIANGLE / PROCESSVERTICES opcodes (not just STATETRANSFORM, per the existing D3DIM matrix-table memory).
2. Verify the canvas attached to the SCR's window receives any draw calls at all. If COM-level Execute fires but our handler does nothing, no pixels appear.
3. Existing memory `project_d3dim_matrix_table.md` says rasterizer still ignores matrices and op=9 PROCESSVERTICES is next. **That is the actual gating issue for ROCKROLL** — implement op=9 there, then op=2 TRIANGLE, then transparency-sort path can stay skipped without hurting visible output.

**2026-04-27 cont.6 — Execute buffer confirmed geometry-empty; PROCESSVERTICES emitter never reached.**

Ran ROCKROLL.SCR /s with `--trace-dx-raw --max-batches=200000`. Result: **5863 IDirect3DDevice_Execute calls, but the buffers contain ONLY:**
- op=6 (STATETRANSFORM): 2918 records
- op=11 (EXIT): 1459 records
- **Zero op=1/2/3/9 (POINT/LINE/TRIANGLE/PROCESSVERTICES). Zero geometry.**

So our op=9 / op=2 handlers in `09ab-handlers-d3dim-core.wat` (which DO exist — `$d3dim_exec_process_vertices` at line 1083, `$d3dim_exec_triangles` at line 894) never receive work. The bug is upstream: d3rm's scene walker never emits geometry into the buffer.

**Located the geometry-emit fn:** `0x647bdf8a` (preferred d3rm VA). Identified by byte-pattern scan for `c6 03 09` (`mov byte [ebx], 0x9` = write D3DOP_PROCESSVERTICES into Execute buffer). Only 2 sites in the entire d3rm.dll write byte 0x09 to memory (and only 3 sites write byte 0x03 = TRIANGLE). The interesting site at file 0x3da5a (VA 0x647be45a) lives inside fn `0x647bdf8a`, which:
- Takes 1 stack arg (pointer to a write cursor `ebx`)
- Loops over visuals, emitting op=7 STATELIGHT (light state), op=9 PROCESSVERTICES (16-byte D3DPROCESSVERTICES record), then op=12 BRANCHFORWARD into the buffer
- This is the per-mesh emitter

**Trace confirms fn `0x647bdf8a` is NEVER called** (`--trace-at=0x745d8f8a` returns 0 hits over 200k batches). So the geometry-emit code path is completely dead.

The fn has 2 callers:
- `0x647bd912` (inside fn `0x647bd538`)
- `0x647bf29b` (inside fn `0x647becb6`)

**Both upstream callers also never fire** (`--trace-at=0x745d8538` and `--trace-at=0x745d9cb6` both 0 hits). So the bug is even higher up the call chain.

**Yet d3rm's render flush plumbing IS running** — 5863 Execute calls per session, all dispatched by d3rm internal frame-loop (we already see the call stack: SCR(`0x7442020b`) → d3rm(`0x64786365` → `0x64799202` → `0x64799087` → Execute-wrapper `0x647c26a0`)). So d3rm is doing its outer per-frame loop but the inner mesh-traversal that should call `0x647bdf8a` never gets entered.

**Next probe:** instrument the d3rm flush stack to find WHERE the mesh-traversal short-circuits. Specifically:
1. Trace fn `0x64786365` (the d3rm-side entry that the SCR calls per frame): does it walk a visual list? Look for a `cmp` against zero (empty list) that bails early.
2. Find where `0x647bdf8a` *should* be called from (its 2 callers' enclosing fns): walk those fns and identify the loop/condition gating the call.
3. Most likely root cause: the SCR's scene has zero visuals attached, OR a visual's mesh count is zero. Check whether `IDirect3DRMFrame::AddVisual` succeeds in our emulator (vtable call chain — needs to be inspected via static disasm of fn 0x7442020b in SCR to see what it constructs).

**Note on COM trace coverage:** `api_table.json` has zero `IDirect3DRM*` entries. So our COM tracer doesn't show any RM-level calls, only D3DIM/DDraw. RM calls land in real d3rm.dll code that we execute via vtable indirect, but we have no name-level visibility. To trace specific RM methods, would need to add IID + slot mapping to api_table.json (or just `--trace-at=` the relevant d3rm vtable-method entry VAs).
