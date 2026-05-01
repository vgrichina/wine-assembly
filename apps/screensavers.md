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

**2026-04-27 cont.7 — Walked one more level up; entire mesh-render subtree is cold; .x file IS being mmap'd by d3dxof.dll.**

Used `--count` (16-addr hit counter) on the next-level callers of dead fns 0x647bd538 / 0x647becb6:

| Caller fn (preferred VA) | Hit count over 200k batches |
|---|---|
| 0x647a1227 (calls bd538 from 0x647a1346) | 0 |
| 0x647ad0cd (calls bd538 from 0x647ad177) | 0 |
| 0x647bff37 (calls bd538 from 0x647bff58) | 0 |
| 0x647bf26a (calls becb6 from 0x647bf27a) | 0 |
| 0x647bd538 / 0x647becb6 / 0x647bdf8a | 0 / 0 / 0 (re-confirmed) |

So the **entire mesh-render subtree is dead**, two levels deep. Three of the four next-level fns have *no static xrefs* (no callers from `.text`); they're vtable methods. fn `0x647bff37` is in vtable at `0x647e0efc` (slot 7 of the table starting at 0x647e0ee0). Likely `IDirect3DRMVisual` / `IDirect3DRMFrame::Render*` / similar.

**File loading path identified.** Pivoted to ask: is the `.x` mesh data even reaching d3rm? Traced file IO with `--trace-fs --trace-api=CreateFileMappingA,MapViewOfFile,UnmapViewOfFile,CloseHandle`:

```
CreateFileA("C:\ro_pick.x", access=GENERIC_READ, OPEN_EXISTING) → h=0x70000004
GetFileSize(h=0x70000004)
CreateFileMappingA(h=0x70000004, PAGE_READONLY) → mapping h=0xfb000001
MapViewOfFile(0xfb000001, FILE_MAP_READ) → 0x7500a004
... (no ReadFile on the .x handle — pure mmap path)
UnmapViewOfFile(0x7500a004)
CloseHandle(0x70000004)
```

So d3rm uses **CreateFileMappingA + MapViewOfFile** (not ReadFile) to slurp .x files. The pattern repeats per frame for ro_pick.x and ro_git.x — **each call lasts hundreds of API calls between map and unmap**, so the parser IS doing real work on the data.

**d3dxof.dll IS loaded** (this hadn't been confirmed before): `LoadLibraryA("d3dxof.dll") → 0x74fe8000`, then `GetProcAddress("DirectXFileCreate")`. So the X-file parser is wired up. The repeated calls into 0x74ff0... range that show up in `--trace-api` are d3dxof internals.

**Verified mmap correctness:** `lib/filesystem.js:700-725` `fs_map_view_of_file` correctly `guest_alloc`s, then `mem.set(data.subarray(offset, offset+mapSize), wasmAddr)` — copies the real VFS bytes into guest memory. ro_pick.x is 7005 bytes, valid `xof 0302txt 0032` header, present in VFS. So the parser sees real X-file content.

**Conclusion of this turn:** the bug is **inside the X-file → MeshBuilder → Frame::AddVisual chain** that runs after MapViewOfFile. The .x file is mapped, d3dxof parses it (we run real DLL code), the result should land in a d3rm IDirect3DRMMeshBuilder, and the mesh should be attached to a frame. Somewhere in that chain it silently fails — leaving the scene with zero visible visuals, so the per-frame render walker sees an empty visual list and never reaches the geometry emitter.

**Next probe:** intercept the d3rm side that consumes the parsed X data. Either:
1. Trace `IDirect3DRMMeshBuilder::Load` (find its vtable slot in d3rm and `--trace-at=` the entry).
2. Trace `IDirect3DRMFrame::AddVisual` (same approach).
3. Pick the SCR's loader fn at `0x7442020b` (already known from prior call-stack trace) and step through it to see which vtable indirect calls succeed and which return E_FAIL. Best done with `--break=0x7442020b --break-once` then single-step / dump the COM dispatch each call.

A successful run should show multiple `[FS] MapViewOfFile` calls **followed by** non-zero hits at fn 0x647bdf8a within a few hundred batches of each unmap. Currently zero hits ever, despite ~40+ map/unmap cycles.

**2026-04-28 cont.8 — SCR's X-file walker fn identified and confirmed running cleanly; mesh upload to d3rm not yet localized.**

Earlier note "0x7442020b is the SCR's loader" was wrong — that EIP is the **SEH unwind tail** of the loader. Real loader entry: **fn `0x74420140`** (found via `find_fn` → -203 bytes from 0x7442020b). It's a C++ method with full SEH frame setup (`push 0xFFFFFFFF; push 0x744ad0b8; fs:[0]=...`).

What it does, per static disasm:
1. Calls `0x7440c0c0` to get a buffer/string
2. Calls `0x74401780` via vtable
3. Calls `0x74420360` (sets up an out-param pair)
4. Tests `edi` (the X-file data ptr); if non-zero, calls **`0x74420aa0`**
5. fn `0x74420aa0` = `QueryInterface(IID_IDirectXFileData, &out)` — IID at `0x744b66f0` decoded as `{C3DFBD60-3988-11D0-9EC2-0000C0291AC3}` = **IID_IDirectXFileData** (a d3dxof IID)
6. After QI: calls `0x744207a0`, then vtable slot 0 of result, then `0x74429bb0`

**Confirmed via `--count` over 20k batches:**

| EIP | Hits | Meaning |
|---|---|---|
| 0x74420140 (entry) | 270 | SCR loader called 270x — once per X-file data node |
| 0x74420aa0 (entry) | 540 | QI called 540x (3 callers, 270 from this site + 270 from two other call sites) |
| 0x744201cd (after QI ret) | 270 | QI returns — control returns to caller |
| 0x744201d9 (throw on QI fail) | 0 | **QI never fails** |
| 0x744201de (post-throw merge) | 270 | Reached cleanly |
| 0x74420317 (cleanup tail) | 270 | Clean exit |
| 0x744207a0 / 0x744192a0 | 540 | Downstream fns hit (multi-caller) |

So the SCR runs the X-file walker **270 times cleanly with zero exceptions**. Every QI for IDirectXFileData succeeds. The walker traverses tree nodes, presumably builds `IDirect3DRMMeshBuilder` from each Mesh node, and attaches it to the scene. Yet `0x647bdf8a` (geometry emit) never fires — so the MeshBuilder either parses 0 vertices OR is never attached to a frame in the rendered subtree.

**Counter caveat learned this turn:** `--count` only fires on **block-entry EIPs**, not mid-block instructions. So 0 hits at `0x744201eb` (mid-block, between 0x744201de and the next branch) doesn't mean the code wasn't executed. Always pick block-boundary addresses for `--count` queries.

**SCR's d3rm imports (from `pe-imports.js --dll=d3drm.dll`):**

Only 9 imports, all utility helpers:
- `Direct3DRMCreate` (the only "create" entry point)
- `D3DRMCreateColorRGB` / `D3DRMCreateColorRGBA`
- `D3DRMVectorRotate` / `D3DRMVectorSubtract` / `D3DRMVectorNormalize`
- `D3DRMColorGetRed` / `D3DRMColorGetGreen` / `D3DRMColorGetBlue`

So the SCR gets `IDirect3DRM*` from `Direct3DRMCreate` and walks vtables from there for everything else (CreateMeshBuilder, CreateFrame, AddVisual, MeshBuilder::Load, etc.). All COM-vtable indirect calls — invisible to our tracer without IID/slot mapping.

**Direct3DRMCreate** (d3rm preferred VA `0x6478f112`) is a tiny shim that calls `0x6478f11f`, which `mem_alloc(0x428)` for the IDirect3DRM struct, then sets up vtable + state. The vtable for IDirect3DRM should be in d3rm's .rdata — would need to find it (look for the assignment to `[ebx+0]` in fn `0x6478f11f`'s success path) and then enumerate slots to identify CreateMeshBuilder / Load.

**Next probe (most direct):**
- Single-step or `--break-once` at fn `0x74420140`, step into the **vtable indirect calls** to see what fn entries they land on inside d3rm — those entries identify which IDirect3DRM/MeshBuilder/Frame methods the SCR uses. Once we know the d3rm-side VA for `MeshBuilder::Load` and `Frame::AddVisual`, set `--count` on them: zero hits = AddVisual never called (scene wired wrong); high hits + zero geometry-emit = MeshBuilder::Load succeeds but emits empty mesh (X-file parse bug or vertex extraction bug).
- Alternative quicker check: count any hits at `0x6478f11f` (Direct3DRMCreate impl) — confirms IDirect3DRM is created at all. Then dump the vtable that gets installed at `[ebx+0]`.

**2026-04-28 cont.9 — Direct3DRMCreate / CreateFrame / CreateMeshBuilder all fire; geometry-emit subtree is fully dead 2 levels up.**

ROCKROLL.SCR `/s` loads d3rm.dll at runtime base **`0x7459b000`** (preferred `0x64780000`, delta `+0x0FE1B000`). With that base, `--count` over 15k batches:

| Fn | Preferred VA | Reloc VA | Hits |
|---|---|---|---|
| `Direct3DRMCreate` impl | `0x6478f11f` | `0x745aa11f` | 5 |
| `IDirect3DRM::CreateFrame` (vt slot 4) | `0x6478fa90` | `0x745aaa90` | 40 |
| `IDirect3DRM::CreateMeshBuilder` (vt slot 6) | `0x6478fcf4` | `0x745aacf4` | 6 |
| SCR loader fn (X-file walker) | `0x74420140` | static | 16 |

So the SCR creates 5 IDirect3DRMs, 40 frames, 6 MeshBuilders, and runs its X-file walker 16x — nominally enough to populate a scene.

**IDirect3DRM root vtable @ `0x647e01f8`** (installed by `0x6478f11f` at `[obj+0x8]`, slot semantics from MSDN ordering):
- slot 0–2: IUnknown
- slot 4: CreateFrame → `0x6478fa90`
- slot 6: CreateMeshBuilder → `0x6478fcf4`
- slots 5/7/.../31 enumerated cleanly (CreateMesh/Face/Animation/...)

The struct also installs additional vtables at `[obj+0x14]=0x647e0288` and `[obj+0x20]=0x647e0318` (likely IDirect3DRM2 / IDirect3DRM3 aggregations) — multi-interface object as expected.

**Geometry-emit dead-tree (more callers walked):** `0x647bdf8a` has 2 static callers `0x647bd912` (in fn `0x647bd538`) and `0x647bf29b` (in fn `0x647bf26a`). fn `0x647bd538` has 3 grandparent xrefs `0x647a1227`, `0x647ad0cd`, `0x647bff37`. **`--count` over 15k batches: ALL FIVE FNs zero hits** (`0x745d8538`, `0x745da26a`, `0x745bc227`, `0x745c80cd`, `0x745daf37`).

So the entire emit-subtree — 2 levels up from the leaf — is statically reachable but dynamically dead. The SCR's per-frame work is funneled into a *different* d3rm code path (the `0x647c26a0` Execute-wrapper chain we already see firing 5863×/run) that produces only state-batcher buffers (`vc=0, il=32` STATE+EXIT, no TRIANGLE/PROCESSVERTICES). The "real" geometry path that would call `0x647bdf8a` is reachable only through code that the SCR's vtable indirects never trigger.

**`0x647bf26a` has zero static xrefs** — pure vtable target. Its enclosing fn must live in some d3rm interface vtable; finding which interface/slot would identify what the SCR is *not* invoking that it needs to. Candidate interfaces: IDirect3DRMMeshBuilder, IDirect3DRMMesh, IDirect3DRMFrame, IDirect3DRMVisual (likely Load / SetGeometry / Render / GetVertices).

**Next probe:**
1. Search d3rm `.data`/`.rdata` for any 4-byte word equal to `0x647bf26a` — its vtable home, then dump the surrounding 50 slots and infer the interface from MSDN method ordering.
2. Same for `0x647bd538` — confirms whether its only callers are the 3 internal fns we walked or whether one is also a vtable target.
3. If `0x647bf26a` is `MeshBuilder::Render` or `Mesh::Render`, then the SCR is creating MeshBuilders but never calling Render on them via d3rm's auto-traverse — confirming the "scene tree empty / not attached" hypothesis from cont.8.

**Update on (1)/(2):** byte-search for `0x647bf26a` and `0x647bd538` as 4-byte LE words anywhere in d3rm.dll → **0 hits each**. Neither is a vtable target. Combined with `xrefs.js` showing zero call-target xrefs to `0x647bf26a`, that fn is most likely dead code in the binary itself (unreferenced — possibly an inline helper the optimizer kept around). So the only live entry into the emit-subtree is via fn `0x647bd538` and its 3 callers — all of which are dead at runtime. **The whole geometry-emit branch of d3rm is unreachable from the per-frame path the SCR drives.**

This rotates the next-step priority: stop chasing the dead emit-subtree. Instead profile the *live* per-frame path's leaves to see what they DO emit. The 5863 Execute calls per run all come through `0x647c26a0`'s state-batcher (vc=0, il=32). Walk *into* that batcher to see what it iterates over — if its source list is empty, that's the upstream bug. Look for the loop body inside `0x647c26a0` (or its caller chain `0x64786365`/`0x64799202`/`0x64799087`) that should be visiting per-mesh state but is iterating zero items.

**2026-04-28 cont.10 — visual-list count is **0** across all 16 invocations of the per-frame state-batcher.**

Walking `0x647c26a0` upward landed on the real enclosing fn — preferred VA **`0x64798e51`** (reloc `0x745b3e51`), found by scanning for `55 8b ec` prologues between `0x64798c00` and `0x6479905f` in d3rm's `.text`. (`find_fn` mis-classifies because there's a code/data island just above; raw byte search beats it here.)

Fn `0x64798e51` runs the per-frame state setup. Around offset `+0x237` it has the suspect iteration loop:

```
64799082  push esi
64799083  call 0x647c21ec      ; ret addr 0x64799087 (Execute-wrapper from prior trace)
64799088  xor  ecx, ecx
6479908a  cmp  [esi+0xbc], ebx ; ebx=0 here
64799090  jle  0x647990be
loop:
  mov  eax, [esi+0xc4]         ; per-visual array
  mov  eax, [eax+ecx*4]        ; array[i]
  cmp  [eax+0x84], ebx         ; flag
  jz   set_to_1
  mov  [eax+0x88], ebx
  jmp  next
set_to_1:
  mov  dword [eax+0x88], 0x1
next:
  inc  ecx
  cmp  ecx, [esi+0xbc]
  jl   loop
```

So **`[esi+0xbc]` = visual count, `[esi+0xc4]` = visual array base**. Each item has flags at +0x84/+0x88 — looks like "dirty/visible" bits.

`--count` over 15k batches: fn fires **16×**. `--trace-at=0x745b3e51` gives one register snapshot per call:

| call # | esi | esi+0xbc value |
|---|---|---|
| #1 | 0x74a19420 | **0** |
| #2 | 0x74a194e0 | (esi increments by 0xc0 each call) |
| #3 | 0x74a195a0 | — |
| ... | ... | — |
| #15 | 0x74a19f00 | — |

`--trace-at-dump=0x74a194dc:4,0x74a1959c:4,0x74a1965c:4` (esi+0xbc for #1/#3/#5):

```
Hexdump 0x74a194dc (4 bytes):  00 00 00 00
Hexdump 0x74a1959c (4 bytes):  00 00 00 00
Hexdump 0x74a1965c (4 bytes):  00 00 00 00
```

**Visual count = 0 in every case.** This is the smoking gun: the per-frame state-batcher iterates a list of zero visuals, so emits zero per-visual state ops, and never descends into the geometry-emit path. Matches the consistent `vc=0, il=32` Execute-buffer signature (just 4 state ops + EXIT, no geometry).

The 16 `esi` values march by 0xc0 from `0x74a19420` to `0x74a19f00` — a contiguous array of 16 × 0xC0-byte device-state context records, plausibly one per render queue slot. None has a non-empty visual list.

**Implication:** the SCR creates `IDirect3DRMMeshBuilder`s and frames (constructor counts confirm: 6 / 40 over 15k batches), but the equivalent of `Frame::AddVisual` either (a) is never invoked, or (b) targets a different aggregation than the one the per-frame batcher reads. The visual-attach path is broken upstream.

**Next probe:**
1. Find writers to `[esi+0xbc]` and `[esi+0xc4]` in d3rm.dll: `node tools/find_field.js test/binaries/dlls/d3drm.dll 0xbc --reg=esi,edi --op=write,imm` (and 0xc4). The setter is what `AddVisual` calls under the hood. Once located, count its hits — if **zero**, the SCR never invokes the AddVisual path; if nonzero, the writes target a different esi than the one fn `0x64798e51` reads.
2. Walk up callers of fn `0x64798e51` (xrefs at `0x64798598`, `0x64799082`, `0x647a118c`) — that's the fn calling chain that actually reads from these contexts. The "input" caller would be where the SCR's per-frame entry point lands, telling us which interface method the SCR uses to feed visuals into d3rm.

**2026-04-28 cont.11 — gate chain traced to a vtable slot the SCR never calls.**

Walked the writer chain for `[esi+0xbc]` (visual count). `find_field` shows 6 `mov [esi+0xbc], …` writers; counted hits at the **enclosing fn entry** of each (since the writes themselves are mid-block and `--trace-at` only fires on block boundaries):

| writer | fn entry | reloc | hits/15k |
|---|---|---|---|
| 0x6479c884 | 0x6479c7f0 | 0x745b77f0 | 1 |
| 0x647acb86 | 0x647acace | 0x745c7ace | 0 |
| 0x647aed4d | 0x647aed3b | 0x745c9d3b | 3 |
| 0x647bd4f7 | 0x647bd4ba | 0x745d84ba | 0 |
| **0x647c0e4c** | **0x647c0ddc** | **0x745dbddc** | **37** |
| 0x647c13e8 | 0x647c1377 | 0x745dc377 | 1 |

Hot writer is fn `0x647c0ddc` (37 hits). Disasm at +0xa shows the gate immediately after entry:

```
647c0ddc  push ebp; mov ebp,esp; sub esp,0x44
647c0de2  push esi; mov esi,[ebp+8]
647c0de6  cmp byte [esi+0xb1], 0
647c0ded  jz   0x647c0e91          ; <-- skip the whole populate path
…
647c0e4c  mov [esi+0xbc], eax       ; write visual_count
647c0e91  pop esi; leave; ret
```

So `[esi+0xbc]` only updates when **byte `[esi+0xb1] != 0`**. Direct trace at the write addr `0x745dbe4c`: **0 hits**. The `jz` is taken every time → the gate byte is permanently 0.

**Tracing the gate writer.** `find_field` on `+0xb1` finds 9 references; only **one** real setter:

| addr | insn | role |
|---|---|---|
| `0x647c0859` | `mov [esi+0xb1], bl` | **resets** to 0 (bl=0 from xor at fn start) |
| `0x647967e1` | `mov [ecx+0xb1], al` | **conditional set** — `al` = 1 if FPU compare branch fires, else 0 |

Setter fn entry at `0x647966da` (preferred VA). Disasm of the relevant tail:

```
647967d4  fnstsw ax; sahf; jz short 0x647967dc
647967d7  push 0x1; pop eax; jmp short 0x647967de   ; al = 1
647967dc  xor eax, eax                              ; al = 0
647967de  mov ecx, [ebp+8]
647967e1  mov [ecx+0xb1], al
…
647967f3  ret 0x18                                  ; 6-arg stdcall
```

Fn signature `ret 0x18` = 6 args × 4 bytes. Looks like `Frame::AddVisual(this, visual)` plus padding — the FPU compare may be a unity-test on the visual's transform.

**Setter never fires at runtime.** Trace-at on `0x745b16da` (reloc of fn entry): **0 hits over 15k batches**. Trace-at on its sole call-site enclosing fn (`0x64788789`, reloc `0x745a3789`): also **0 hits**.

**Vtable fingerprint.** `xrefs.js` on fn `0x64788789` finds 3 .data references at `0x647df480`, `0x647df598`, `0x647df6e4`. `vtable_dump.js` confirms each is **slot 32** of three sibling vtables — the canonical d3drm Frame/Frame2/Frame3 versioning pattern. So fn `0x64788789` is `IDirect3DRMFrame::AddVisual` (slot 32 in the Frame vtable).

**Bottom line:** the SCR creates 40 frames + 6 mesh-builders, but **never calls `IDirect3DRMFrame::AddVisual`** on any of them. With nothing attached, the per-frame state-batcher's visual list (`[esi+0xbc]`) stays at 0, and the geometry-emit subtree never runs.

`api_table.json` has zero `IDirect3DRMFrame` entries — d3drm vtable methods are dispatched through the real DLL, not our COM thunk layer. So the SCR's vtable[32] indirect should land directly in `0x64788789` if it were invoked. The fact that it isn't means **the SCR's own logic never reaches the AddVisual call site**, not that we mis-route it.

**Next probe direction:**
1. Find SCR-side `call [reg+0x80]` (slot 32 = offset 0x80) instructions — those are the AddVisual call sites in the SCR binary. If no such instruction exists in `ROCKROLL.SCR`, the SCR uses a different attach mechanism (e.g., `IDirect3DRMMeshBuilder::AddFace` directly into a global mesh, or `IDirect3DRMViewport::SetCamera` style aggregation we haven't found yet).
2. Alternative hypothesis: the SCR may build geometry into a **single mesh-builder** that's attached via `IDirect3DRM::SetDefaultTextureColors`/some scene-root API rather than per-frame. Search for slot offsets used in `call dword [reg+0xNN]` patterns inside SCR's `.text` to enumerate which Frame/MeshBuilder methods it actually uses.
3. Faster: dump every COM vtable indirect call EIP from the SCR itself and tally — currently we have constructor counts but no full vtable-call census from the SCR's perspective.

**2026-04-28 cont.12 — assets confirm; gate fn signature ≠ AddVisual; promoted slot-call scanner.**

Promoted `/tmp/scan_slot.js` to `tools/find_vtable_calls.js` (commit `263b632`). Modes: `<slot>`, `--disp=0xNN`, `--slots` histogram, `--reg=` filter. Filled the call-indirect-by-displacement gap left by `find_field.js` / `xrefs.js`.

**Asset / file-IO sanity check.** All ROCKROLL assets are present in `test/binaries/screensavers/` (RO_PICK.X 7KB, RO_GIT.X 45KB, RO_TEX01.GIF, RO_BACK.GIF). The SCR opens them via `CreateFileA` then `GetFileSize → CreateFileMappingA → MapViewOfFile → … → UnmapViewOfFile`. Mesh `.X` files are read via memory-mapping, not `ReadFile` (so absence of `[FS] ReadFile` for `.X` is not a bug). `lib/filesystem.js:700` `fs_map_view_of_file` correctly copies `vfs.files[path].data` into a fresh `guest_alloc` region — verified with `--trace-host=fs_map_view_of_file`: each `.X` file produces a unique mapping at distinct guest addresses (e.g. ro_pick.x → 0x7500a004). `--dump-vfs` confirms both files registered with full byte counts. **File IO is not the bug.**

**Slot-32 census on the SCR.** `find_vtable_calls.js ROCKROLL.SCR 32` reports **40** `call dword [reg+0x80]` sites in `.text`. Distribution: ecx=24, edx=16. `--slots` histogram shows the most-active slots in SCR's compiled code:

| slot | disp | count |
|---|---|---|
| 1 | 0x04 | 157 |
| 2 | 0x08 | 555 |
| 3 | 0x0c | 57 |
| 4 | 0x10 | 66 |
| 5 | 0x14 | 76 |
| 6 | 0x18 | 41 |
| 22 | 0x58 | 38 |
| 23 | 0x5c | 66 |
| 26 | 0x68 | 53 |
| 32 | 0x80 | 40 |

Slots 1/2 dominate (Release/AddRef). Slots 3-6 are typical IUnknown-extended methods.

**Gate setter fn signature is NOT AddVisual.** Disassembly of fn `0x64788789` (sole caller of the gate setter) shows it takes **6 stack args + this** (`ret 0x18` after pushing this+6):

```
64788789  push ebp; mov ebp,esp; push esi
6478878d  push [0x647e7ad4]; call [0x64781198]   ; lock acquire
64788799  mov eax, [ebp+0xc]; …                  ; arg1: frameB ptr → ecx (deref +8 +0x10)
647887aa  mov eax, [ebp+0x8]; …                  ; arg0: frameA ptr → eax (same deref)
647887bb  push float [ebp+0x1c]; … +0x18; … +0x14; … +0x10  ; 4 floats
647887d7  push ecx; push eax
647887d9  call 0x647966da                        ; gate setter
…
647887e6  call [0x647811a4]                      ; lock release
647887f0  ret 0x18                               ; 6-arg cdecl/stdcall + this
```

So slot 32 is `Method(this, frameA*, frameB*, float, float, float, float)` — **two frame pointers + 4 floats**, not the canonical 1-arg `AddVisual(visual)` signature. With the FPU-compare-then-set-dirty-flag pattern in fn `0x647966da`, this is more consistent with a `Transform`/`SetMatrix`/`SetSceneBackground`-style mutator that compares old vs new value to set a "dirty" bit — likely `IDirect3DRMFrame::SetSceneFogParams` or one of the `Set*Transform*(this, refFrame, …, axis_x, axis_y, axis_z, theta)` style methods. **Not AddVisual.**

**Implication.** Earlier conclusion was wrong: `[esi+0xb1]` is not a "visual attached" gate but a "transform/state changed" dirty-flag, which gates whether the per-frame batcher repopulates the visual array `[esi+0xc4]` from a source list. Either:
- (a) the source list (somewhere upstream) is empty AND the dirty flag never fires, so the array stays null forever; or
- (b) the source list has visuals but the dirty flag never fires, so they're never copied into the per-context array the batcher reads.

Neither AddVisual call sites firing nor not firing is the relevant signal — we were chasing the wrong gate.

**Pivot.** The right next step is to find what *populates* the visuals' source list (likely a member of the d3rm scene root, before the per-context cache). Start from the writers to `[esi+0xc4]` and walk *upstream* — the call site that copies INTO that field is sourced from somewhere. Specifically:

1. Disasm fn `0x647c0ddc` (the populator) at `+0x37` (the `call 0x647c0e2e → 0x6479a6a2` prior to the writes). That call's output is the local `[ebp-0x44 .. -0x18]` block which then gets bulk-copied into `[esi+0xb8 .. +0xe0]`. So fn `0x6479a6a2` produces `(visual_count, visual_array_ptr, …)` — its inputs are `[esi+0x13c]` and a tmp buffer. So **`[esi+0x13c]` is the upstream visual-list source.** Find writers to `+0x13c`.
2. Once found, count their hits. If zero, that's where the chain breaks.

This is a more productive thread than slot-32 hunting.

**2026-04-28 cont.13 — pivot complete: `[esi+0x13c]` is a transform snapshot, NOT a visual list. Real AddVisual is slot 18.**

Walked the 7 lea-`[reg+0x13c]` sites with `find_fn`. The decisive one is inside the gate setter `0x647966da` itself at `+0xc0`:

```
64796796  lea esi, [eax+0xb4]
6479679c  lea edi, [eax+0x13c]
647967a2  rep movsd  ; ecx=17 → 68 bytes
```

So `[eax+0x13c]` is a 17-dword **snapshot of `[eax+0xb4]`** (the current transform block) — the "previous transform" needed to compute interpolation deltas. It is NOT a visual list. The populator `0x647c0ddc` reads this snapshot, calls `0x6479a6a2(local, &snapshot, local)` to derive interpolated values, then bulk-copies them into `[esi+0xb8..+0xe0]` — i.e. updates the *current* transform block from interpolation between `[esi+0xb4]` (current) and `[esi+0x13c]` (previous). That entire chain is the **animation interpolation subsystem** — irrelevant to whether visuals get rendered.

**Slot-numbering correction.** From the DX6/7 SDK `IDirect3DRMFrame` vtable, slot 18 = `AddVisual` (1-arg), slot 32 = `GetSceneFogParams` (a getter). I had the slot wrong by 14. The earlier "slot 32 = AddVisual" was a guess from comparing constructor counts — the disassembly disproved it.

**Real AddVisual census on ROCKROLL.SCR.**
```
$ node tools/find_vtable_calls.js test/binaries/screensavers/ROCKROLL.SCR 18
=== [.text]  24 hits  call dword [reg+0x48] ===
```
24 sites. Verified one at `0x74410c7a`:
```
74410c72  mov edx, [esp+0x1c]
74410c76  mov ecx, [eax]      ; vtable
74410c78  push edx            ; arg
74410c79  push eax            ; this
74410c7a  call [ecx+0x48]     ; AddVisual(this, visual)
```
1-arg + this — matches `AddVisual(IDirect3DRMVisual*)` exactly.

**Real next step.** Set `--break-api` (or a code break) at d3rm.dll's slot-18 thunk and count hits during ROCKROLL run. If zero hits, the SCR never attaches visuals to frames (asset-loading failure or scene-construction abort earlier). If non-zero, AddVisual fires but the render walk skips them — that's a different failure mode (frame visibility / camera attach / viewport binding).

**2026-04-28 cont.14 — AddVisual fires 7×; bug is downstream (render walk).**

Ran `--trace-at=0x745ad6d4` (AddVisual at relocated VA) over 40K batches with ROCKROLL.SCR /s. **7 hits. 1026 buffer flushes.** So scene init succeeds and 7 visuals get attached.

All 7 hits return to the same SCR caller `0x74410f1a`. Disasm of the call site:
```
74410f0b  mov eax, [esp+0x14]   ; this = frame
74410f0f  mov edx, [esp+0x18]   ; arg = visual ptr
74410f13  mov ecx, [eax]        ; vtable
74410f15  push edx              ; visual
74410f16  push eax              ; this
74410f17  call [ecx+0x18]       ; slot 6 of an internal vtable (NOT slot 18 of public Frame)
```

Vtable in use is `ecx=0x745fad58 → static 0x647dfd58`. `vtable_dump` confirms slot 6 there = `0x647926d4` (same fn, named "AddVisual" in our SDK mapping). But slot 0 of THIS vtable = `0x64791da1` (which is `AddLight` per the public Frame vtable mapping). So `0x647dfd58` is a d3rm-**internal** Frame helper vtable, not the public IDirect3DRMFrame vtable. The "AddVisual" method got reused at slot 6 of the internal vtable — same impl, different layout. Wine d3rm.dll likely has multiple sibling vtables for Frame/Frame2/Frame3/internal — slot numbers don't line up with the public DX SDK headers.

Per-hit data:
- Frame ptrs (this, varies): `0x74fe76c8 / 0x7500cc28 / 0x75034130 / 0x75447f30 / 0x757cc8b8 / 0x75b51b58 / 0x75ed6af0` — 7 independent heap allocations.
- Visual ptrs (edx): `0x7c3e6018 / 6058 / 6070 / 60a8 / 6108 / 6168 / 61c8` — tightly packed in a dedicated visual-arena range, 0x40-0x60 byte spacing.

So the scene tree IS being built correctly with 7 frame→visual attachments. The render walk just doesn't enumerate them into Execute opcodes. The 1026 flushes per run all carry only `STATETRANSFORM(count=3) + EXIT`.

**Real next step (now correctly framed).** The bug is in d3rm's per-frame visual enumeration — frames have visuals attached, but the renderer's traversal either (a) doesn't find the right frame chain (root scene frame ≠ traversed frame), or (b) walks frames but skips visuals due to a conditional that never opens (visibility flag, transform validity, viewport binding). With AddVisual now confirmed firing, the productive probe shifts to: instrument d3rm's per-frame `Tick` / render-walker (the fn that calls the buffer-flush at `0x647c3905`) and trace what it does with the 7 known frame ptrs — does it visit them at all? If it visits but emits nothing, what gate skips them?

**2026-04-28 cont.15 — emit-batcher located: fn 0x647c3744 takes opcode as 2nd arg.**

The flush at `0x647c3905` only emits `EXIT (0xb)` on its own. All other opcodes are queued by the **emit-batcher fn `0x647c3744`** which writes via `[esi+0x4c]` cursor, with current-opcode marker at `[esi+0x54]` and queued-flag at `[esi+0x44]`.

**Batcher signature:** `void Batch(buffer*, BYTE opcode)` — opcode passed as 2nd arg `[ebp+0xc]`. Logic:
- if `[esi+0x44]==0`: lazy-Lock the ExecBuffer, set up cursor at `[esi+0x4c]` with end at `[esi+0x50]`
- compare new opcode byte against `*[esi+0x54]` (current group's opcode):
  - same → coalesce, advance 8 bytes (next 8-byte record in same D3DINSTRUCTION group, count++)
  - different → start new group, advance 12 bytes (4 header + 8 first record)
- if cursor past end → flush, restart

**Hit counts during ROCKROLL.SCR /s, 40K batches:**
| Fn / VA | Hits | Meaning |
|---|---|---|
| `0x647c3744` (batcher entry) | 756 | called 2× per flush |
| `0x647c3796` (batcher post-init) | 504 | non-first-call branch (lock already held) |
| `0x647c3905` (flush) | 378 | flush calls |
| `0x647c3916` (flush non-empty branch) | 252 | 67% of flushes carry buffer content |
| any byte-immediate emit fn (`0x647af134`, `0x647be43d`, `0x647be4dc`, `0x6478e84c`) | 0 | dead — wrong code path entirely |

So instructions ARE being queued via the batcher (756 calls = ~2 ops per flush + EXIT). The byte-immediate emit fns I scanned for (`c6 [reg] OP`) are **not** the active code path — d3rm in this DLL build emits via the parametric batcher only.

**Decisive next probe.** Census which opcode values arg2 takes at `0x647c3744`. Either:
1. Patch a `--trace-at=0x647c3744` and dump `[esp+8]` (the arg) — gives the histogram of opcodes ever queued.
2. Find static callers of `0x647c3744` (they all `push imm8` immediately before the call) — read the literal opcodes from disasm.

If the only opcodes queued are `STATETRANSFORM(8)` and one other, PROCESSVERTICES(9) is statically never requested → the bug is upstream in the visual-walker that decides what to emit, not in the emit machinery.

**Project memory updated.**

**2026-04-28 cont.16 — full emit chain mapped; chokepoint = vtable@0x647e0b40 slot 6.**

Walking down from the batcher, mapped the entire d3rm emit pipeline by call-site opcode-push histogram:

```
                              CALLERS                          BATCHER             FLUSH
fn 0x647af646 (rasterizer-mesh-render, slot 6 of vtable@0x647e0b40)
  ├─ 0x647af6ff → calls 0x647af7a1 (geometry-emitter)
  └─ 0x647af741 → calls 0x647af7a1 (geometry-emitter)

fn 0x647af7a1 (geometry-emitter, 156-193 byte fn)
  ├─ 0x647af83d  push 6/op=3 (TRIANGLE)         ─┐
  ├─ 0x647af84f  push 1/op=9 (PROCESSVERTICES)  ─┼→ call 0x647c36e0 (emit-wrapper)
  └─ 0x647af862  push 1/op=9 (PROCESSVERTICES)  ─┘

fn 0x647c36e0 (emit-wrapper, opcode-discriminator)
  ├─ if op∈{7,8} && [buf.+3c.+5c4]≠0: → 0x647a0a29 (fast-path; NO ExecBuf write)
  └─ else: call 0x647c3744 (batcher)

fn 0x647c3744 (batcher)
  ├─ lazy-Lock ExecBuf, set cursor at [esi+0x4c], end at [esi+0x50]
  ├─ coalesce same-opcode group at [esi+0x54]
  └─ append 8 (coalesce) or 12 (new group) bytes; flush if past page end
```

**Opcode histogram across 49 callers of 0x647c36e0 (push imm8 nearest each call):**
| op | name | callsites |
|---|---|---|
| 1 | POINT | 3 |
| 2 | LINE | 1 |
| 3 | TRIANGLE | 1 (in 0x647af7a1) |
| 4 | MATRIXLOAD | 1 |
| 5 | MATRIXMULTIPLY | 2 |
| 6 | STATETRANSFORM | 4 |
| 7 | STATELIGHT | 7 |
| 8 | STATERENDER | 23 |
| 9 | PROCESSVERTICES | 2 (both in 0x647af7a1) |

**Runtime hit-count summary (ROCKROLL.SCR /s, 40K batches):**
| Site | Hits | Notes |
|---|---|---|
| 0x647c36e0 (emit-wrapper) | 3780 | total emits attempted |
| └─ STATELIGHT/STATERENDER fast path | 3024 | bypass ExecBuf |
| └─ batcher path (op∉{7,8}) | 756 | mostly STATETRANSFORM |
| 0x647c3744 (batcher) | 756 | confirms |
| 0x647c3905 (flush) | 378 | flush calls |
| 0x647c3905 +non-empty branch | 252 | 67% have content |
| 0x647af7a1 (geometry-emitter) entry | 0 | **DEAD** |
| 0x647af646 (vtable slot 6) entry | 0 | **DEAD** |

**Single chokepoint identified: vtable@0x647e0b40 slot 6 dispatch never fires.**

The struct at `0x647e0b20` has 50 data refs (mostly `push 0x647e0b20` as fn arg + `mov eax, [0x647e0b20]` then `call [eax+0x18]` = slot 6 of *another* primary vtable inside that struct's first field). The geometry vtable lives *inside* the struct at offset +0x20, so slot 6 dispatch is `call [structptr+0x38]` (0x20 + 6*4 = 0x38).

**Next-session probe:** find `call [reg+0x38]` sites in d3rm and instrument them. With `find_vtable_calls --disp=0x38`, the histogram showed 21 hits — manageable. Per-callsite census via `--count` of post-call landings will pinpoint which (if any) invoke this vtable's slot 6 — and what condition gates it. If ZERO of the 21 sites resolve to this struct at runtime, the gate is in whoever should be passing this struct to a dispatcher (likely scene-tree → render-context bind during Tick).

**2026-04-28 cont.17 — `call [reg+0x38]` site census: 3 of 21 fire, none dispatch slot 6 of vtable@0x647e0b40.**

ROCKROLL.SCR /s, 40K batches, --count post-call landings of all 21 candidate sites:

| site | hits | base reg |
|---|---|---|
| `0x6478e22c` | 5 | edx |
| `0x647988bf` | **126** | ecx |
| `0x647b2bac` | 10 | ecx |
| (other 18 sites) | 0 each | mixed |

Total 141 hits. None of them dispatch into our struct, since vtable@0x647e0b40 slot 6 (= fn `0x647af646`) had 0 hits. Either (a) these 3 active sites dispatch *different* vtables (whose slot at +0x38 is some other fn), or (b) the right struct's slot 6 dispatch uses a *different* displacement than +0x38.

**Hypothesis revision:** The vtable layout assumption was: struct@0x647e0b20 with inline vtable at offset +0x20, slot 6 = +0x18 within vtable = +0x38 from struct base. But the access patterns from earlier (`mov eax,[0x647e0b20]; call [eax+0x18]`) suggest the "primary" vtable is at offset 0 of the struct's first dword (`[struct+0]` = pointer to a primary vtable), not at +0x20. So slot 6 of the *primary* vtable would be `call [reg+0x18]` after `mov reg, [structptr]`.

The inline secondary vtable at struct+0x20 likely is reached via different code — could be a DDI (device-driver interface) callback installed in some other field, with a *different* dispatch displacement.

**Next-session probe (revised again):** Disasm fn `0x647af646` to see what its `(this, ...)` arg structure expects, then look at the bytes immediately surrounding the vtable (`0x647e0b30..0x647e0b60`) — the surrounding fields may identify what kind of struct this is (callback list / DDI table / texture pool / etc.). The access pattern `[esi+0x13c]` snapshot evidence (cont.13) suggests this struct is **per-Frame** (not per-Device), and the rasterizer slot 6 may be installed into a *different* per-Frame struct that's not the same singleton at 0x647e0b20.

Bottom line: the vtable@0x647e0b40 may not be the live rasterizer dispatch table at all — it may be the FALLBACK/null one used when no real device is attached. The 7 visuals attached via AddVisual go into Frame structs; rendering them requires a real Direct3D Device whose rasterizer vtable lives elsewhere (per-Device, populated at CreateDevice time).

**2026-04-28 cont.18 — vtable layout corrected; slot 8 (not 6); abstract-base dispatch returns NOT_IMPLEMENTED.**

Re-examined struct@`0x647e0b20` after seeing `mov eax,[0x647e0b20]; call [eax+0x18]` patterns. The struct's first dword is a **parent-class pointer** (`0x647e0fa0`), not the start of an inline vtable. The vtable starts at offset **+0x18**, not +0x20. Layout:

```
struct@0x647e0b20 ("mesh" subclass):
  +0x00  parent-class ptr → 0x647e0fa0
  +0x04  init fn
  +0x08  size1 (0x18c)
  +0x0c  size2 (0x48)
  +0x10  zero
  +0x14  zero
  +0x18  method[0]  0x647aed3b
  +0x1c  method[1]  0x647aee27
  ...
  +0x38  method[8]  0x647af646  ← what we were chasing as "slot 6"
  +0x40  method[10] 0x647afa2c
  +0x44  NULL terminator
```

So `call [reg+0x38]` is **method index 8** of whichever class struct `reg` points at. The 126-hit site `0x647988bf` (`mov ecx,[esi+0x18]; call [ecx+0x38]`) reads the class-ptr from instance `esi+0x18` and dispatches method 8.

**Parent class@`0x647e0fa0`** layout same shape; its method 8 = fn `0x647c35f9`:
```
647c35f9  push 0x88760316          ; D3DRMERR_NOTIMPL
647c35fe  call 0x64799d29          ; report-error
647c3603  ret
```

**Pure-virtual stub. Returns "not implemented" and bails.**

The mesh-render fn `0x647af646` (child method 8) had 0 hits, but the dispatch site fires 126x — meaning **every instance flowing through the 126-hit dispatch uses the parent (abstract) class, not the mesh subclass**. They all hit the NOTIMPL stub.

**Smoking gun:** the 7 visuals attached via AddVisual are NOT mesh instances. They're plain frames, lights, or some other subclass whose method 8 isn't overridden. The geometry-emitter path (`0x647af7a1`) is unreachable because there are no mesh-class visuals in the scene.

**Next-session probe:** at site `0x647988bf` snapshot `ecx` (class struct ptr) over multiple hits — `--trace-at-dump=0x647988bf:8` capturing the 4 bytes pointed-to-by-ecx — to identify *which* classes are actually rendering. If they're all `0x647e0fa0` (frame-as-visual base), then we need to find the mesh-instantiation path (CreateMesh / MeshBuilder) and see why the .X mesh files aren't being loaded into mesh instances. If a different class shows up, dump that struct and trace its class hierarchy.

**2026-04-28 cont.19 — .X mesh files DO load via d3dxof.dll + MapViewOfFile, but mesh-render still 0 hits.**

Traced the file-load path. The .X mesh files (`ro_pick.x`, `ro_git.x` for ROCKROLL) ARE present locally and ARE mapped successfully:

```
[LoadLibrary] d3dxof.dll loaded at 0x74fe8000, dllMain=0x74ff3040
[fs] CreateFile("C:\ro_pick.x") → 0x70000004
[API] GetFileSize(0x70000004, 0x00000000) → ret=0x74ff040a   ← in d3dxof.dll
[API] CreateFileMappingA(0x70000004, …)  → 0xfb000001        ← in d3dxof.dll
[API] MapViewOfFile(0xfb000001, FILE_MAP_READ, 0, 0, 0) → 0x7500a004   ← valid guest ptr
```

**d3dxof.dll** is the DirectX file format parser — it loads .X files via memory mapping (not ReadFile, which is why the cont.18 trace showed `CreateFile` without subsequent `ReadFile` for `.x` files). Our `fs_create_file_mapping` / `fs_map_view_of_file` host imports return valid guest pointers populated with the file's bytes (see `lib/filesystem.js:689-725`). So **the mesh data is in guest memory** — no asset-missing or read-failure issue.

But the mesh-render fn `0x647af646` (child class@`0x647e0b20` method 8) still has 0 hits, while the parent class@`0x647e0fa0` method 8 (NOTIMPL stub) gets 126 dispatches. Something between "mapped .X bytes" and "mesh visual in scene" is failing.

**Theories for cont.20:**

1. **d3dxof.dll COM dispatch failing** — the X-file parser is COM-based (`IDirectXFile`, `IDirectXFileEnumObject`, etc.). If our COM trampoline path mishandles d3dxof's vtables, parsing returns errors and d3rm gets no geometry.

2. **MeshBuilder::Load returning failure** — d3rm calls `IDirect3DRMMeshBuilder::Load(filename, ...)` to convert the .X file into a mesh. If this returns failure, the visual gets attached as a *frame*, not a mesh. The 7 AddVisual visuals would then all be frame-class instances → parent dispatch → NOTIMPL stub.

3. **Mesh class registered but never instantiated** — the d3rm class system requires per-class factories. If the "mesh" subclass ctor fails or isn't called, no instance exists with class@`0x647e0b20`.

**Next probes:**
- Search d3dxof.dll for `CreateEnumObject` / `Load` paths and instrument with `--count` to see what fires.
- Search d3rm for `IDirect3DRMMeshBuilder::Load` (look for "Couldn't load mesh from" string xref — already known to be in d3rm strings) — find the call site, set break, see if it's reached and what it returns.
- Trace COM dispatch via `0xC0DE0000|api_id` markers (memory says trace-api decodes these) — focus on d3dxof and MeshBuilder methods.

**2026-04-28 cont.20 — CreateMeshBuilder + Load fire 14×, all succeed; failure must be downstream of load.**

Located mesh-load orchestration in **ROCKROLL.SCR** itself (not d3rm). Two relevant fns:

1. **`0x7442578b`** (CreateMeshBuilder helper):
   ```
   mov ecx, [eax]; lea edx, [esp+0x30]; push edx; push eax
   call [ecx+0x18]      ; IDirect3DRM::CreateMeshBuilder, slot 6
   test eax, eax; jge short ok
   push "Couldn't create meshbuilder"; call err_print
   ```

2. **`0x7442b680`** (mesh loader, prints "Loading mesh from %s" then calls method 6 on a wrapper):
   ```
   push name_buf; push 0x744ca9e4 ("Inform: Loading mesh"); push 3
   call err_print
   mov edx, [ebp+0x104]   ; vtable of C++ wrapper class
   lea ebx, [ebp+0x104]   ; this
   mov ecx, ebx; push eax; call [edx+0x18]   ; method-6 (Load)
   ```

**Hit counts (40K batches):**
| addr | hits | meaning |
|---|---|---|
| `0x744257a7` (post-CreateMeshBuilder) | 14 | called 14× |
| `0x744257ab` (failure branch) | 0 | **all succeed** |
| `0x7442b799` (post-Load) | 14 | called 14× |

So `IDirect3DRM::CreateMeshBuilder` succeeds 14 times AND `IDirect3DRMMeshBuilder::Load(.x)` succeeds 14 times. Yet d3rm's child mesh class method 8 (`0x647af646`) still has 0 hits and parent NOTIMPL fires 126x.

**Missing step:** `IDirect3DRMMeshBuilder` is the *loader/builder*, not the *renderable*. To render, the SCR must either:
- Call `MeshBuilder::CreateMesh` → produces `IDirect3DRMMesh` (the actual renderable)
- Or attach the MeshBuilder *itself* via `AddVisual` (it implements IDirect3DRMVisual)

If AddVisual receives a MeshBuilder (which is a "Visual" but possibly maps to a different render class than 0x647e0b20), the dispatch could land on yet another class whose method 8 isn't the geometry-emitter. d3rm.dll has multiple mesh classes (`GenericMesh`, `ExtMesh`, `mesh`, `MeshModifier` per strings).

**Next-session probes:**
- Check what fn is at `0x74425600` (called right after Load — likely AddRef or "verify mesh has geometry"); count its hits.
- The actual visual added via AddVisual: dump the class-struct ptr `[obj+0x18]` at the AddVisual call site to identify which subclass — could be MeshBuilder's struct, not mesh's.
- d3rm `find_string` for class-name signatures (`AVGenericMesh`, `AVExtMesh`, `AVmesh`) → find class struct addrs → count which one's slot 8 dispatches at runtime.
- Verify SCR isn't using `IDirect3DRMMeshBuilder3::CreateMesh` — search SCR for method dispatches at slot offsets that match CreateMesh.

**2026-04-28 cont.21 — class-info struct hunt: cont.20 was tracing the wrong class.**

Re-derived d3rm class info table from name-string xrefs (`tools/find-refs.js`):

| classinfo VA | name VA | name | parent classinfo | size |
|---|---|---|---|---|
| 0x647e0b20 | 0x64784034 | "Texture" | 0x647e0fa0 (Visual) | 0x18c |
| 0x647e0b64 | 0x6478409c | "Wrap" | 0x647e0de0 | 0xb4 |
| 0x647e0de0 | 0x64784260 | "Object200b20001" (root) | 0 | 0x34 |
| 0x647e0ec8 | 0x647843bc | **"Mesh"** | 0x647e0fe8 (LitVisual) | 0x16c |
| 0x647e0fa0 | 0x647844b0 | "Visual" | 0x647e0de0 | 0x9c |
| 0x647e0fe8 | 0x647845d8 | "LitVisual" | 0x647e0fa0 | 0xa4 |

**Mesh inheritance chain:** `Object → Visual → LitVisual → Mesh`.

**Mesh vtable @ 0x647e0ed8 (slot N = +N*4):**
| slot | fn | note |
|---|---|---|
| 2 | 0x647bfc76 | |
| 3 | 0x647bfcab | |
| 4 | 0x647b99d3 | NOTIMPL stub |
| 5 | 0x647bfd81 | |
| 6 | 0x647b99d3 | NOTIMPL |
| 7 | 0x647b99d3 | NOTIMPL |
| 8 | 0x647b99d3 | **NOTIMPL — even on Mesh class itself** |
| 9 | 0x647bff37 | |
| 10 | 0x647bff6b | |
| 11 | 0x647b99d3 | NOTIMPL |
| 12 | 0x647c0697 | |

**0x647af646 (cont.20's "geometry emitter") is slot 10 of TEXTURE class @0x647e0b20, not Mesh.** All cont.20 hit-counts on that fn are irrelevant to the rendering bug — we were probing the wrong class entirely.

**Reframed bug:** the 126x NOTIMPL hits aren't a missing slot-8 on Mesh — slot 8 IS NOTIMPL natively in d3rm. The render-walk must dispatch to a *different* slot (probably slot 5=0x647bfd81 or 9/10 for geometry). 126 / 7 ≈ 18 — likely an aggregate of NOTIMPL calls across many classes, not a single missing method.

**Next-session probes:**
1. Count hits on each real Mesh method (0x647bfc76, 0x647bfcab, 0x647bfd81, 0x647bff37, 0x647bff6b, 0x647c0697) under runtime to see which fire during Frame::Render.
2. Find the actual render walker: search d3rm for a fn that loads classinfo+0x10+8*4 (slot 8) or similar — the dispatcher.
3. Locate IDirect3DRMMeshBuilder class info (separate from Mesh) — SCR may AddVisual the builder, not the finalized mesh; MeshBuilder may override slot 8.

**Mesh class info struct layout (from xref data dump):**
- +0x00 parent_classinfo = 0x647e0fe8 (LitVisual)
- +0x04 name_ptr = 0x647843bc ("Mesh")
- +0x08 size = 0x16c, +0x0c alignment = 0x4c
- +0x10..+0x18 zero (reserved)
- +0x18+ method override table — pointers, with 0x647b99d3 as the NOTIMPL fallback sentinel

**0x647c2a37 (Visual base slot 8) disasms as a real render-prep method** — touches `[obj+0x98]` flag, frustum-cull math on `[esi+0x110..0x11c]`, FPU compares against constants. Likely the inherited render method that Mesh would fall back to under classinfo-walk dispatch.

**No "MeshBuilder" classinfo exists** in d3rm — only "Builder" string at 0x647834c4 with zero refs. The COM interface IDirect3DRMMeshBuilder is implemented by the Mesh class itself; a Mesh instance is both built (Load) and rendered (AddVisual).

**Pivotal next-session probe:** stop static-vtable archaeology, switch to runtime. Set `--break=0x647b99d3` (NOTIMPL stub), inspect return addr → call site → ModRM displacement to learn *which slot index* the render walker actually invokes. The 126× NOTIMPL count must come from one call site; find it before more theorizing.

**2026-04-28 cont.22 — d3rm uses DDraw directly, NOT d3dim.dll. Render pipeline clarification.**

`tools/pe-imports.js d3rm.dll`: imports only `DirectDrawCreate` from DDRAW.dll, **no d3dim.dll import at all**. d3rm has its own software rasterizer built on top of DirectDraw surfaces.

This means the entire memory thread "[D3DIM matrix table]" (Tier 1 STATETRANSFORM landed for d3dim) is on a **different rendering path**. d3rm rendering goes: SCR → d3rm → DDraw. d3rm builds and walks its own scene graph, calls DDraw to plot pixels/lines/triangles directly. There is no IDirect3DDevice / Execute Buffer involvement for d3rm.

**0x647b99d3 is bare `ret` (not E_NOTIMPL)** — silent no-op. 99 vtable slots in d3rm point to it (per `xrefs.js`). Of 126x runtime hits, ~7 per frame × ~18 frames = matches AddVisual count × render walk frequency. Each frame, the visual-walk dispatches a method (probably "Render" or "ProcessVisual") that lands on the bare ret stub for Mesh-class visuals.

**Conclusion of static phase:** further progress requires runtime instrumentation. Static archaeology has identified:
- the right Mesh classinfo (0x647e0ec8)
- the inheritance chain (Object → Visual → LitVisual → Mesh)
- that 0x647b99d3 is `ret` (silent skip, not E_NOTIMPL crash)
- that d3rm bypasses d3dim entirely (rasterizes onto DDraw)

**Concrete next-session run:** `node test/run.js --exe=test/binaries/screensavers/ROCKROLL.SCR --break=0x647b99d3 --break-once --max-batches=200`. When bp hits, examine `dbg_prev_eip` to find the call site, decode the `call [reg+disp]`, learn the dispatch slot, then disasm that slot in Mesh classinfo to see which method got skipped. That's the actual missing renderable behavior.

**2026-04-28 cont.23 — MAJOR CORRECTION: d3rm DOES use d3dim. The rendering path is the SAME as d3dim apps.**

cont.22 was wrong. d3rm does not *statically* import d3dim.dll, but it dynamically obtains `IDirect3D2` via `IDirectDraw::QueryInterface` and creates `IDirect3DDevice2` from that. Long-run trace (20K batches) confirms ROCKROLL.SCR makes:
- 40 × `IDirect3DDevice_BeginScene` / `EndScene`
- 80 × `IDirect3DExecuteBuffer_Lock` / `Unlock` / `SetExecuteData` / `IDirect3DDevice_Execute`
- 800 × `IDirect3DDevice2_SetRenderState`
- 120 × `IDirect3DDevice_SetMatrix`
- Loads `d3dxof.dll` for .X file parsing

So **the d3rm rendering pipeline is: d3rm builds Execute Buffers and submits to `IDirect3DDevice2::Execute`** — exactly the d3dim path that the D3DIM Tier-1 work targeted. The `rasterizer-ignores-matrices` / `op=9 PROCESSVERTICES not handled` blocker from `project_d3dim_matrix_table` IS the same blocker for ROCKROLL.

The whole class-info / vtable / 0x647b99d3 NOTIMPL theory was a dead-end. 0x647b99d3 has 0 hits over a 2000-batch run (--count=d3drm+0x647b99d3). The render walk inside d3rm doesn't hit those slots — it goes through Execute Buffer dispatch in our d3dim handler.

**Real blocker:** our d3dim Execute Buffer handler in 09a-handlers.wat (or wherever IDirect3DDevice2_Execute lives) must process op 9 (PROCESSVERTICES) and op 6 (TRIANGLE) properly. With those, ROCKROLL would render.

**Next-session run:** `node test/run.js --exe=ROCKROLL.SCR --args=/s --trace-api=IDirect3DDevice_Execute,IDirect3DExecuteBuffer_SetExecuteData --max-batches=20000`. Inspect the Execute Buffer contents (lpData + dwInstructionLength) at each Execute call — confirm which opcodes are present and which our handler skips.

**2026-04-28 cont.24 — Execute Buffer DOES dispatch all opcodes; d3rm just NEVER emits geometry.**

`--trace-dx` over 20K-batch ROCKROLL.SCR run shows `[dx] Exec` histogram:
- **80× op=6 STATETRANSFORM, count=3 (size=8)**
- **0× op=3 TRIANGLE, 0× op=9 PROCESSVERTICES, 0× op=1 POINT, 0× op=2 LINE**

Each Execute Buffer is exactly 32 bytes: 4-byte op header + 3×8-byte STATETRANSFORM records + 4-byte EXIT. d3rm submits matrices only. Geometry opcodes never appear.

Checked our handler: `09aa-handlers-d3dim.wat:219 $handle_IDirect3DDevice_Execute` dispatches all opcodes (1,2,3,4,5,6,7,8,9,12,14,11=EXIT) into specific helper fns. PROCESSVERTICES calls `$d3dim_exec_process_vertices` (`09ab:1083`) which composites WVP + transforms via `$vertex_project`. TRIANGLE calls `$d3dim_exec_triangles` (`09ab:894`) which culls + draws. **The pipeline is implemented end-to-end.** It just never receives geometry.

Also no DrawPrimitive / DrawIndexedPrimitive API calls (0 hits). d3rm in this build path uses Execute Buffer exclusively — no fallback path being taken.

PNG output: pure black 640×480. All 13 Present calls show `firstNonZero=-1, nzBytes=0` — back surfaces are entirely zero.

**New blocker hypothesis:** d3rm decides "device cannot render this mesh" *before* building the geometry buffer. Likely culprits:
1. **GetCaps mis-reports** dpcTriCaps / dwTextureCaps — d3rm checks for required caps and bails. Our `$d3dim_fill_device_desc` (`09ab:1190`) sets dpcTriCaps.dwSize=56 but leaves the caps fields zero (line 1220).
2. **EnumTextureFormats no-op** — `$handle_IDirect3DDevice_EnumTextureFormats` (`09aa:368`) never invokes the callback. d3rm receives zero formats and refuses to texture-map → probably refuses to render.
3. **CreateMatrix/SetMatrix handle scheme** — already reviewed, looks OK.
4. **Materials/Lights** — 160 SetLightState + 4 GetMaterial. Could be that lighting setup fails.

**Next-session steps:**
1. Fill in real values for `dpcTriCaps.dwTextureCaps`, `dwShadeCaps`, `dwTextureFilterCaps`, etc. in `$d3dim_fill_device_desc` (zeros currently → no rendering capabilities advertised).
2. Wire EnumTextureFormats to enumerate at least RGB565 and RGBA8888. The "(no callback)" comment at `09aa:362` says "d3drm and d3dim-based apps tolerate zero enumerations" — this may be wrong for ROCKROLL specifically.
3. After (1)+(2), re-trace to see if geometry opcodes start appearing.

**2026-04-28 cont.25 — caps hypothesis FALSIFIED. Caps are filled.**

Reviewed `09a8-handlers-directx.wat:933 $fill_d3d_device_desc` — used when caller passes dwSize≥252 (DX5+ standard). Calls `$fill_primcaps` for both dpcLineCaps and dpcTriCaps with non-zero values:

- dwMiscCaps=0x3F, dwRasterCaps=0x07FF, dwZCmpCaps=0xFF
- dwShadeCaps=0x1FFFF, dwTextureCaps=0xFFFF, dwTextureFilterCaps=0xFF
- dwSrcBlendCaps=0x1FFF, dwDestBlendCaps=0x1FFF, dwAlphaCmpCaps=0xFF
- dwTextureBlendCaps=0xFFFF, dwTextureAddressCaps=0xFF

So GetCaps returns plenty. The cont.24 hypothesis was wrong — only the size<252 fallback at `09ab:1206` lacks primcaps fields, and DX5 d3rm is unlikely to use that path.

**Real next step:** trace inside d3rm's per-frame render fn to find where it decides "no geometry today." The 80 STATETRANSFORM-only buffers suggest d3rm IS reaching the render setup, IS computing matrices, and is then aborting before geometry walk. Two productive probes:

1. Set bp on `IDirect3DExecuteBuffer_Lock` (origVA hits before each Execute Buffer is filled). Walk back caller via EBP frame chain — find the d3rm render fn that builds buffers. Disasm forward from there to locate the conditional that gates geometry-emit.

2. Compare with a known-working d3rm path: the existing memory `[Organic Art engine]` says SCN-picker scene picks wrong file (OrgSuppList.txt missing). ROCKROLL doesn't use OrgSuppList. So that bug is independent. But d3rm's "list of meshes to render" might be empty at render time even if 14 were loaded — verify the AddVisual/Frame::AddChild step actually attaches the meshes.

**Useful handoff queries:**
- `node tools/find_string.js test/binaries/dlls/d3drm.dll "Visual"` — locate Visual string xrefs to find render-walker
- `--count=d3drm+0x647c2a37` — that's Visual::slot8 fn (frustum cull, identified in cont.21). If 0 hits, render walker never visits any Visual; if >0, it's reached but bails.
- `--trace-host=dx_trace --trace-dx-raw` — full hexdump of every Execute Buffer to confirm only STATETRANSFORM

**2026-04-28 cont.25b — runtime hit-counts confirm: render walker never visits any loaded Mesh.**

20K-batch ROCKROLL.SCR runs with `--count` on d3rm class-method override slots:

| addr | class:slot | hits |
|---|---|---|
| 0x647c2a37 | Visual:slot8 (frustum-cull/render-prep, real impl) | **0** |
| 0x647c28d0 | Visual:slot2 (AddRef?) | 109 |
| 0x647c28de | Visual:slot3 (Release?) | 101 |
| 0x647bfc76 | Mesh:slot0 override | **0** |
| 0x647bfcab | Mesh:slot1 override | **0** |
| 0x647bfd81 | Mesh:slot3 override | **0** |
| 0x647bff37 | Mesh:slot7 override | **0** |
| 0x647bff6b | Mesh:slot8 override | **0** |
| 0x647c0697 | Mesh:slot11 override | **0** |

So the 14 loaded mesh instances have refcount activity (~100 AddRef/Release on Visual base) but **none of their class-specific methods ever fire**. The render walker is not visiting them. Yet 80 STATETRANSFORM buffers DO fire, meaning d3rm's per-frame render setup IS running — just iterating an empty visual list.

**Verified the cause is d3rm-internal, not in our COM interception:** zero IDirect3DRM* references exist in our `src/` (`grep -rn "IDirect3DRM\|AddVisual" src/` → empty). d3rm runs natively against the loaded DLL. Our handlers only catch DDraw + d3dim methods that d3rm *uses* downstream.

**Sharper hypothesis:** the SCR calls IDirect3DRMFrame::AddVisual with the loaded MeshBuilder, but inside d3rm the AddVisual either (a) fails silently because of a missing capability or (b) attaches the visual to a non-rendering branch of the scene graph. Both lead to an empty visual list at render time.

**Concrete next probe (small, surgical):** find d3rm's `IDirect3DRMFrame::AddVisual` impl entry (slot 32 in IDirect3DRMFrame vtable, `tools/find_vtable_calls.js d3drm.dll --slot=32`), `--count=` it to verify it actually fires the 14 expected times. If <14, the SCR isn't even calling AddVisual — search for what it's doing instead. If =14, the visual is being attached but rejected internally — bp inside the impl to find the rejection.

**2026-04-28 cont.26 — ROCKROLL uses CUSTOM Visual classes via render callbacks. Not d3rm's built-in Mesh.**

ROCKROLL.SCR strings expose its C++ class hierarchy via MSVC RTTI:
- `.?AVGenericMesh@@`
- `.?AVExtMesh@@`
- `.?AVCDrawPrimVisual@@`

These are **SCR-side classes**, not d3rm classes. Plus error strings:
- `"Couldn't load mesh from %s (%s)"`
- `"Loading %s as mesh"`
- `"GetD3DRMDevice()->SetRenderMode(...)"` failed
- `"...->CreateViewport(...)"` failed

**Pattern:** ROCKROLL implements rendering through `IDirect3DRMUserVisual` + render callback, not through d3rm's own Mesh class. The SCR loads .X meshes (14× via MeshBuilder, succeeded), wraps them in custom CDrawPrimVisual / GenericMesh / ExtMesh objects deriving from IDirect3DRMVisual, registers a render callback, and inside the callback calls IDirect3DDevice2 methods to draw geometry.

This explains:
- 0 hits on d3rm Mesh class methods (cont.25b) — d3rm never iterates Mesh; SCR uses UserVisual.
- 0 DrawPrimitive API calls — render callback either isn't firing, or fires and submits via ExecuteBuffer with PROCESSVERTICES+TRIANGLE which is what cont.24 expected to see but didn't.
- 80 STATETRANSFORM-only Execute Buffers — d3rm sets matrices for the upcoming render walk but the per-Visual callback dispatch never produces geometry buffers.

**Our codebase has ZERO IDirect3DRM interception** (`grep -rn "RM" src/api_table.json` finds no RM methods). d3rm runs natively, and the UserVisual callback path is opaque to API tracing.

**Sharper next-step:** the UserVisual render callback is a guest fn pointer registered with d3rm. d3rm calls it during scene render. To verify the callback is being invoked, set `--break=` on the SCR's render callback fn. To find the SCR's callback, look for fns that:
1. Are referenced as a fn pointer in .data (no direct callers in code)
2. Take 5 args: `(this, lpData, dwIID, lpDevice, lpViewport)` — typical UserVisual callback signature

`tools/find-refs.js test/binaries/screensavers/ROCKROLL.SCR <suspected_va>` to find pointer refs. Or scan for fns whose prologue matches the callback ABI and have zero direct call xrefs.

Alternatively, add IDirect3DRMUserVisual to api_table.json + intercept SetCallback to log the registered callback's VA — surgical, gives us the callback's address directly.

**2026-04-28 cont.27 — UserVisual hypothesis FALSIFIED. ROCKROLL uses Frame::AddVisual with MeshBuilder. Earlier "0x647b99d4 = triangle emitter" was ALSO wrong — it's a Release/cleanup fn.**

20K-batch ROCKROLL.SCR `--count` matrix:

| addr | role | hits |
|---|---|---|
| `0x64790e2c` | IDirect3DRM::CreateUserVisual | **0** |
| `0x6478fa90` | IDirect3DRM::CreateFrame | 92 |
| `0x6478fcf4` | IDirect3DRM::CreateMeshBuilder | 8 |
| `0x647926d4` | Frame::AddVisual (vtable slot 18) | **4** |
| `0x64791da1` | Frame::AddLight (vtable slot 12) | 206 |
| `0x647924ab` | Frame::AddChild (vtable slot 17) | 0 |
| `0x6478bc6f` | Frame::Load (vtable slot 35) | 0 |
| `0x6478bf80` | Frame::SetName (vtable slot 32) | 0 |
| `0x647bb74e` | visual-list iterator (per-frame render) | 40 |
| `0x6479ff51` | per-mesh transform/preprocess | 40 |
| `0x647b99d4` | (cont.7th: "triangle emit") — actually Release-style cleanup, not emit | 790 |
| `0x647c2a37` | Visual:slot8 (frustum cull, real-impl override) | **0** |

**Re-disasm of `0x647b99d4` (the supposed triangle emitter from cont.7th probe):**
```asm
647b99d4  mov eax, [esp+0x4]
647b99d8  xor edx, edx
647b99da  cmp eax, edx
647b99dc  jz 0x647b9a00
647b99de  cmp word [eax+0xa], dx          ; type==0?
647b99e2  jnz 0x647b9a00
647b99e4  mov ecx, [eax+0xc]              ; refcount
647b99e7  test refcount; if >0 dec and store
647b99ef  if refcount==0 && [eax+0x10]==0:
647b99f9    push eax
647b99fa    call 0x647b9a01                ; finalize/free
647b99ff  ret
```
This is a Release/finalize helper — **not** an Execute Buffer triangle emitter. The 7th probe's note "kind==7||kind==8 → 0x647a0a29 = TRIANGLE/PROCESSVERTICES" needs re-verifying. The whole "find geometry emitter" chain was anchored on a misidentification.

**What's verified now:**
- Frame::AddVisual fires 4× per run. Scene graph IS being populated.
- The render walker enters per frame (`0x647bb74e` 40×, `0x6479ff51` 40×). Avg 10 frames × 4 visuals = 40 — consistent.
- Visual class real-impl slot 8 (`0x647c2a37` frustum-cull/render-prep) fires **0×**. So the per-Visual render method is NOT being invoked during scene walk, even though the iterator visits them.
- No Execute Buffer ever contains TRIANGLE/PROCESSVERTICES (cont.24 still stands).

**Sharper hypothesis (replaces cont.26 UserVisual story):** the visual-list iterator at `0x647bb74e` walks a list of 4 attached visuals each frame, but the inner conditional that gates per-Visual render-method invocation is unmet for all 4. Either `[edi+0xa4]==2` (subtype==2 == "skip") OR `[edi+0xac]==0` (no associated d3dim mesh-data) — both branches `jz 0x647bb78d` (skip emit). cont.27 still doesn't know which.

**Concrete next probe — settle the predicate:**
1. `--break=0x745d6768 --break-once` (= `0x647bb768 + 0xfe1b000`, the `cmp word [edi+0xa4], 0x2` site).
2. At the prompt, `r` to read EDI, then `d EDI+0xa4 16` and `d EDI+0xac 16` to inspect both fields. If subtype==2 → trace upstream what writes `[obj+0xa4]=2` (likely a MeshBuilder::Init path that's wrong). If `[obj+0xac]==0` → trace upstream what should write the d3dim mesh pointer (likely a MeshBuilder→d3dim mesh conversion that we never implement).
3. Re-find the actual triangle-emit fn by static search: pattern `c7 .. .. 03 08 ?? ??` (mov dword [reg+disp], 0x????0803 — D3DINSTRUCTION header for TRIANGLE op=3 size=8). Cross-check with PROCESSVERTICES (op=9, size=24): `c7 .. .. 09 18 ?? ??`.

The work to add IDirect3DRMUserVisual handlers is dead — UserVisual is unused. Cancel that path. The real chase is finding why all 4 attached MeshBuilder visuals get gated out of per-Visual render dispatch.

**2026-04-28 cont.28 — KEY ARCHITECTURAL FINDING: d3rm software-rasterizes; geometry NEVER goes through d3dim Execute Buffers.**

`0x647bb74e` (cont.7th's "visual-list iterator") is also misidentified — re-disasm shows it ENDS with `[esi+0x840]=0; [esi+0x844]=0; free [esi+0x840]` (clears + frees the list after iteration) and calls `0x647b99d4` (refcount-dec) per element. This is a **deferred-RELEASE drain** of pending visual references at end-of-frame, not a render walker.

Found the actual per-frame render driver at `0x64798521` (called via 4-byte stub `0x647988f5` which is the BeginScene-traceable caller frame). Its inner calls per frame:

| addr | role | hits/20K |
|---|---|---|
| `0x647c2792` | predicate (abort frame if nonzero) | 84 |
| `0x647c1d30` | matrix helper (compose WVP) | 82 |
| `0x647c21ec` | **STATETRANSFORM emitter** — produces the 80 Execute Buffers | 80 |
| `0x647a0434` | begin-scene shim ([edi+0x5b8] vtable[19]) | 80 |
| `0x647b9663` | vertex preprocess (called per-Visual with `[arg+0xa0]`) | 78 |
| `0x647b9574` | **`rep stosd` clear of `[ctx+0x44]` size `[ctx+0x3c]*[ctx+0x40]`** | 46 |
| `0x647b9632` | **OR-combine of two `[ctx+0x44]` buffers, same size** | 44 |

`0x647b9574` and `0x647b9632` are dead-giveaways: per-frame memset+OR over a `width*height*4` byte buffer at `[ctx+0x44]`. **d3rm has its own SOFTWARE RASTERIZER and writes pixels directly into a memory framebuffer, not into d3dim Execute Buffer triangle ops.**

This finally explains everything:
- Why Execute Buffers contain only STATETRANSFORM matrices: d3rm uses d3dim ONLY to push transform matrices to the (hardware-accel) device, but doesn't use d3dim for geometry submission.
- Why no TRIANGLE/PROCESSVERTICES op ever appears: d3rm rasterizes triangles itself in software.
- Why our PNG is all zero: software-rasterized framebuffer probably gets correctly written but never blitted to the DDraw surface — OR — the rasterizer's per-scanline output never reaches the surface Lock.

cont.21's note "d3rm has its own software rasterizer on top of DirectDraw" was RIGHT, then retracted in cont.23. Now confirmed correct.

**Concrete next probes:**
1. Find d3rm's IDirectDrawSurface::Lock/Unlock callsites — this is where d3rm grabs the back-buffer to write rasterized pixels into. Trace `--trace-api=IDirectDrawSurface_Lock --trace-stack=IDirectDrawSurface_Lock:8`. The d3rm caller is the surface-blit step; understand what it copies.
2. Verify `[ctx+0x44]` framebuffer addr — `--trace-at=d3drm+0x647b9574` (`rep stosd` clear) prints regs; EDX or ECX at entry holds ctx and `[ctx+0x44]` should be a guest pointer (probably 0x7500_xxxx range from heap_alloc). Dump it after the clear loop runs to see whether pixels get written.
3. Walk forward from `0x647b9663` (vertex preprocess) inside the render driver — after 0x64798889 the driver does coordinate clipping then must reach a triangle-rasterize loop. Find where pixel writes land in `[ctx+0x44]`.
4. The geometry pipeline is: project verts → clip → rasterize scanlines into `[ctx+0x44]`. Then somewhere d3rm Locks the back buffer surface and memcpys. If the framebuffer at `[ctx+0x44]` IS the DDraw surface bits (Lock'd once, kept), our DDraw Lock impl might give a different ptr each frame → writes go to a stale alloc.

**Pivots:**
- D3DIM Execute Buffer geometry handlers are NOT a blocker for d3rm screensavers — Tier-1 work helps static-d3dim apps (ARCHITEC, etc.) but not ROCKROLL.
- ARCHITEC may also be d3rm-driven; verify with the same `0x647b9574` clear-fn count.
- Real fix area: DDraw surface Lock/Unlock semantics + the d3rm software-rasterizer's framebuffer→surface copy step.

**2026-04-28 cont.29 — cont.28 SOFTWARE-RASTERIZER HYPOTHESIS DISPROVEN. New picture: d3rm's geometry-emit code paths are dead at runtime.**

Probes ran:
1. `--trace-api=IDirectDrawSurface_Lock --trace-stack=IDirectDrawSurface_Lock:10` over 20K batches (40 frames). Only **3 surface Locks total, all during init** — none per-frame. Dest surfaces 0x7c3e6018/0x7c3e6058/0x7c3e6070, caller=0x7440f3f5 (looks like ddraw.dll internals). So d3rm does NOT lock the back buffer per frame, contradicting cont.28's "software framebuffer copied via Lock" theory.
2. `--trace-dx-raw` over 20K batches dumped every Execute Buffer. ALL 80 ExecuteBuffer cycles contain literally `op=6(STATETRANSFORM) bSize=8 wCount=3 payload=24 [01,02 / 02,03 / 03,01]` followed by `op=11(EXIT)`. Three records: World→matrix2, View→matrix3, Projection→matrix1. Zero TRIANGLE, zero PROCESSVERTICES, zero POINT, zero LINE, zero anything.
3. Per-frame D3D op histogram (40 frames): 40 BeginScene+EndScene+Flip, 40 Viewport_Clear, 80 ExecuteBuffer cycles (=2/frame), 120 SetMatrix (=3/frame), 800 SetRenderState (=20/frame), 160 SetLightState (=4/frame). **No DrawPrimitive ever.** (Confirmed by 0 hits on host_dx_trace kind=10 path.)
4. Caller-census on the generic op-emit helper `0x647c36e0` (49 static callsites): only 6 sites fire — 3 in fn `0x64798dcd` pushing op=8 STATERENDER for state-IDs 7/14/23 (ZENABLE/FOGENABLE/...?), and 6 in fn `0x647c21ec` pushing op=6 STATETRANSFORM (3 records × 2 callsites that share one buffer). All other 43 callsites — including the geometry-emit candidates in `0x6479fxxx`/`0x647axxxx`/`0x647afxxxx` — are **dead code at runtime**.

**Architecture map of d3rm's submit pipeline:**
- `0x647c3744` is the streaming buffer-writer: appends an 8-byte record under a shared op header, locks the ExecuteBuffer on first call (via vtable[0x10]=Lock, hence the Lock count we already see), grows wCount, flushes via `0x647c3905` on overflow.
- `0x647c3905` is the explicit submit/flush: writes EXIT(11) byte, calls vtable[0x14]=Unlock, vtable[0x18]=SetExecuteData, then vtable[0x20]=Execute.
- `0x647c21ec` is the per-frame "push transform matrices" entry point — runs twice per frame, each time emitting 3 STATETRANSFORM records and triggering one flush.

**The smoking gun is now:** d3rm's render loop never reaches the geometry-emitter functions in 0x6479fxxx/0x647axxxx. The frame ends after BeginScene → matrix push → EndScene → Flip with the back-buffer untouched. Either (a) every per-frame visual-iteration short-circuits at a predicate (similar to cont.27's `[edi+0xa4]==2; jz skip` hypothesis) before reaching geometry emit, or (b) there's a higher-level "device can render?" gate based on a caps flag we set wrong. Caps look fine on inspection (DP2|DPTLV|EXECSYS, all primcaps populated 0x07FF rasterCaps etc.), so (a) is more likely.

**Concrete next probes:**
1. `--break-once=d3drm+0x647c21ec` to catch the per-frame matrix-push entry. From there, walk caller via bp_first_caller — what's the per-frame render loop entry?
2. Once render-loop entry known, --count fan-out across every basic block from there to find the predicate that skips geometry emission.
3. Also worth: `--trace-at=d3drm+0x6479f7b1,d3drm+0x647af7d0` (geometry-emit candidates) — 0 hits confirms they're never reached at runtime, even if SOME visual existed.

**Reverts cont.28 fully.** d3rm uses d3dim for matrix transforms only, but the geometry path is completely cold — not a software-rasterizer-into-surface pattern. The PNG is black because zero pixels are written anywhere — not d3dim, not software framebuffer, not GDI.

**2026-04-28 cont.30 — geometry-emit chain located + confirmed dead. Bug = vtable@0x647e0b40 slot dispatch on non-Mesh visual.**

Static analysis pinpointed the *only* fn in d3drm.dll that emits non-state D3DOP records:

- **`0x647af238`** — writes a multi-record EB block: `SETSTATUS(op=0x0e bSize=0x18) + PROCESSVERTICES(op=9 bSize=0x10 wCount=1) + TRIANGLE(op=3 bSize=8 — DX2 layout, 3×WORD verts) + EXIT(op=0x0b)`. Found via `find_bytes c6400118` (PROCESSVERTICES size byte) — 1 hit only. No other fn in d3rm writes opcode 3 or 9.

Call graph upward:

```
0x647af238 (geometry emit; 4-arg cdecl)
   <- 0x647af210 (3-arg trampoline: push edx; push ecx; call 0x647af238; ret)
       <- 0x647af134  (vtable slot 4 of vt@0x647e0b40, at +0x10)
       <- 0x647af646  (vtable slot 6 of vt@0x647e0b40, at +0x18)
       <- 0x647afa2c  (vtable slot 8 of vt@0x647e0b40, at +0x20)
```

**Critical: each of `0x647af134/0x647af646/0x647afa2c` has ZERO direct code xrefs and exactly ONE pointer ref each — all in vtable @ 0x647e0b40 (slots 4/6/8 = `+0x10`, `+0x18`, `+0x20`).** They are dispatched ONLY through that one vtable.

Runtime hit-counts (ROCKROLL.SCR /s, 20000 batches ≈ 80 frames):

| addr | fn | hits |
|---|---|---|
| 0x647c21ec | matrix-push entry | **80** |
| 0x647c36e0 | state-emit wrapper | **1200** |
| 0x647c3744 | inner non-7/8 op-emit | **240** (= 80×3 STATETRANSFORM) |
| 0x647c3905 | EB flush | **120** |
| 0x647af7a1 | state-render batch (9 STATERENDER) | **0** (dead) |
| 0x647af238 | geometry emit | **0** |
| 0x647af210 | trampoline | **0** |
| 0x647af134 | vt slot 4 | **0** |
| 0x647af646 | vt slot 6 | **0** |
| 0x647afa2c | vt slot 8 | **0** |

So the entire geometry chain is cold AND the equivalent state-render-batch fn `0x647af7a1` (which would emit 9 STATERENDER values per Mesh) is also cold — d3rm dispatches state ops only via the matrix-push path `0x647c21ec`, never via the per-Mesh setup `0x647af7a1`.

**Conclusion (matches cont.17/18 with sharper resolution):** The bug is that the per-frame render walker invokes its `call [reg+disp]` Visual-render dispatch on each attached Visual, but the dispatch never lands on `0x647af646` (or its siblings `0x647af134`/`0x647afa2c`). For ROCKROLL's MeshBuilder visual, `[vtable+0x18]` resolves to a different fn — most likely an abstract base-class no-op in our DX/d3rm scaffolding, or an inheritance-broken slot that should chain to the Mesh implementation but doesn't.

**Concrete next-session probe (cont.31):** find every static `call [reg+0x18]` and `call [reg+0x10]` site in d3drm whose `reg` came from a vtable load chain consistent with vt@0x647e0b40 (`tools/find_vtable_calls.js --slot=6 --slot=4 --slot=8`). For each candidate site, run a `--count` round; the alive caller is the one currently invoking a no-op slot. Then break inside that caller, dump the actual fn pointer at `[reg+0x18]` — that target VA tells us which class's `Render` is being invoked instead of Mesh's. The fix is almost certainly populating vtable slot 6 of the MeshBuilder/UserVisual vtable to chain to `0x647af646`, OR fixing wherever d3rm-level QueryInterface returns the parent-class iface when it should return the Mesh-derived iface.

**2026-04-28 cont.31 — frame-Render entry located + early-exit predicate confirmed.**

Live matrix-push caller is `0x64798521` (one of three; other two are dead). 16 frame Renders over 12000 batches.

Disasm (`0x64798521`):
- `0x64798547  call 0x64799d8d` — pre-check; if non-zero → exit `0x647988c9`.
- `0x64798568  mov esi, [eax+0x34]` — frame's first child Visual; `0x6479856b cmp esi, ebx; jz 0x647988ec` exits if no children.
- `0x64798577  call 0x647c2792 / jnz 0x647988ec` — second early-exit predicate.
- `0x6479858f  call 0x647c1d30` then `0x64798598 call 0x647c21ec` (matrix push) — both unconditional.
- After matrix push, per-Visual loop:
  - `0x647985fb call 0x647b9663` (Visual processor — bbox/clip/transform fn from cont.27)
  - `0x64798603 test eax,eax / jz 0x64798613` — if processor returned 0 (skip), enter "alt path" at 0x64798613; else go to geometry-emit at 0x6479864f.
  - `0x64798613` path then checks `cmp [ecx+0xa4], [ecx+0xa0]` and jumps to 0x6479865c — also a skip.
  - `0x6479864f` is the geometry-emit landing (where `0x647af238`-emit chain would fire).

Hit counts (12000 batches, 16 frames):

| addr | role | hits |
|---|---|---|
| 0x64798521 | Render entry | 16 |
| 0x647988ec | early-exit | 16 |
| 0x64798611 | jmp into geometry-emit path | **0** |
| 0x64798613 | post-`jz` "alt" path | 15 |
| 0x6479864f | geometry-emit landing | 0 |
| 0x6479865c | "alt" inner-skip | 15 |
| 0x64798669 | failure fork | 1 |

**Confirmed:** every frame either early-exits at `0x647988ec` (16/16) or, in the visual loop, takes the skip branch at `0x64798603 jz` (15/16, with 1 failure). Geometry-emit (0x647af238) is never reached because `0x647b9663` returns 0 OR the early-exit fires first.

The fact that frame-Render entries == early-exits (both 16) means every iteration takes the early-exit at `0x647988ec` — but the loop hit counts at 0x64798613/0x6479865c also = 15 each, which only adds up if 0x647988ec is reached **after** going through the visual loop. That fits: the loop iterates through children, and after the last child the `jmp/jcc` chain falls through to 0x647988ec as the natural fn epilogue.

So real picture per frame: matrix push runs, visual loop iterates ~15 times across children, `0x647b9663` returns 0 every time (skip path), zero geometry emitted, fn exits.

**Next-session task (cont.32):** disasm `0x647b9663`. It's the Visual processor that decides "render this Visual or skip". Find what predicate makes it return 0 — likely `[visual+OFFSET]` flag tied to mesh data being absent/uninitialized. Suspects: bbox not set, transformed-vertex cache empty, Mesh data pointer NULL. Once the failing predicate is found, trace upward to the missing initialization step (likely a SetData/Load call we no-op'd in d3rm COM thunks).

**2026-04-28 cont.32 — frame Render's geometry dispatch traced. Per-Visual render IS being invoked, but lands on a non-emitting target.**

Disasm of frame-Render (`0x64798521`) corrected from cont.31. The "alt path" at `0x64798613`/`0x6479865c` is not a skip — it falls through into a long body ending at `0x647988a4` where the per-Visual dispatch happens:

```
0x647988a4  test [ebp+0xc], 0x3     ; gate on caller's flags arg
0x647988a8  jz   0x647988d0          ; skip dispatch if flags & 3 == 0
0x647988aa  push [ebp+0xc]; push [ebp-0xc]; push [ebp-0x8]; push [ebp-0x14]; push [ebp-0x4]; push edi; push eax; push esi
0x647988bd  call [ecx+0x38]          ; ecx = [esi+0x18] = visual's vtable; slot 14 (offset 0x38)
0x647988c2  add esp, 0x20
0x647988c5  test eax, eax
0x647988c7  jz   0x647988d0          ; success → cleanup
0x647988c9  mov eax, [0x647e7afc]    ; error → load global error code
```

Hit counts (12000 batches, 16 frames):

| addr | role | hits |
|---|---|---|
| 0x647988a4 | gate test | 16 |
| 0x647988aa | gate prep (taken) | 16 |
| 0x647988d0 | post-dispatch cleanup (success) | 16 |
| 0x647988c9 | error path | 0 |

The gate IS taken every frame and the dispatch lands successfully. But 0x647af238 chain stays cold ⇒ `[ecx+0x38]` resolves to a fn that is NOT the geometry emitter. The actual target is whatever `[visual_vtable+0x38]` points to at runtime — likely a base-class no-op or a different visual subclass that doesn't emit geometry, OR a Mesh-render fn whose own emit-path is conditional on something else.

**Cont.33 plan:** runtime dump `[ecx+0x38]` at the call site. Two ways:
1. `--break=d3drm+0x647988aa` (fires before push prep) then in the debug prompt: `m32 ${esi}+0x18` to get vtable, then `m32 vtable+0x38` to get target VA.
2. Or `--trace-at=d3drm+0x647988aa --trace-at-dump=ESI+0x18:4` to log the vtable ptr each frame, then a second pass dumps its `+0x38` slot.

Once the target VA is known: if it's a stub/no-op in d3rm itself, that's the broken-inheritance bug — the Visual instance's vtable was constructed with a base-class slot where the Mesh subclass should have overridden it. Trace where the Visual vtable is built (likely `IDirect3DRMMeshBuilder_CreateMesh` / `IDirect3DRMFrame_AddVisual` or similar) and see which COM method we no-op'd.

**2026-04-29 cont.33 — runtime vtable dump attempt: probe addressing problem.**

Goal: dump `[esi+0x18]+0x38` at `0x647988bd` (`call [ecx+0x38]`) to identify the actual fn the per-Visual dispatch lands on.

Attempts:
- `--trace-at=d3drm+0x647988aa` — 0 trace lines emitted across 4000 batches even though `--count` shows the BB fires. Likely cause: `0x647988aa` is **inside** the BB that begins at `0x647988a4`; trace-at only fires on BB heads (per `feedback_trace_at_limits`).
- `--trace-at=d3drm+0x647988a4` and `--trace-at=0x745b38a4` (runtime VA) — both produced no `[trace-at]`-prefixed lines either. The numbered `[N] EIP=...` lines in the log are ordinary verbose-tail output, not trace-at hits.

Diagnosis pending: check whether trace-at output formatting changed (or whether my mapping was wrong). Try `--trace-at-dump=d3drm+0x647988a4:0` (zero len) to confirm the addr is recognized as a BB head, or read `test/run.js` lines for the trace-at handler to see its actual output prefix.

**Cont.34 plan (concrete and low-risk):**
1. Verify trace-at works at all in this session: pick a known-firing BB (e.g. `d3drm+0x647c21ec` matrix-push entry, which fires every frame) and confirm it produces output. If yes, the issue at `0x647988a4` is mapping; if no, trace-at infra is broken.
2. Once trace-at firing is confirmed at a known-good addr, hop forward: `--trace-at=d3drm+0x647988a4` should also fire (same kind of BB head). Capture esi from that hit.
3. Compute vtable VA = `*(u32*)(esi+0x18)`. Use `tools/dump_va.js` after the run captures it (the dump-va tool reads static PE only — for a runtime vtable allocated on the heap, instead use `--trace-at-dump=ESI+0x18:64` if supported, otherwise add a `--dump=GUEST_ADDR:LEN` post-run dump using the captured esi+0x18 value).
4. The vtable's slot 14 (offset 0x38) is the dispatch target. If it's a fn at d3rm-base + something < 0x647af200, it's a base-class no-op; if it's outside .text (heap thunk address), our COM thunking is broken; if it's a real d3rm fn but not the geometry chain, then walk that fn to see what it does instead.

Stopping here without a code change. cont.34 is purely instrumentation-side: get the vtable target VA. No source edits in this session.

**2026-04-29 cont.34 — runtime vtable target captured. The "visual" is a Viewport, dispatches via `[viewport+0x1bc]+0x30`.**

Trace-at sanity-check passed at matrix-push (0x647c21ec → 28 hits). Failure at 0x647988a4 in cont.33 was because `--trace-at` only takes ONE addr (first only) and 0x647988aa was inside a non-head BB; need to choose a real BB head.

Captured visual struct via `--trace-at=d3drm+0x647987ae --trace-at-dump=0x750a9a68:0x60` (15 hits). Key fields:

```
struct @ 0x750a9a68 (esi):
  +0x00  vtable_a    = 0x7500c138   (heap, mutable per-instance)
  +0x18  vtable_b    = 0x745fb8f8   ← runtime addr; =d3rm+0x647e08f8 in image
  +0x1bc (not in 96-byte dump, but read in target fn)
```

**Vtable @ d3rm+0x647e08f8 (image VA):** dump shows it's the Viewport/Camera class vtable. Slot 14 (`+0x38`) = **`0x6479fcd6`**.

Disasm of `0x6479fcd6` (the per-frame render target):
```
push ebp; mov ebp,esp; push esi
mov esi, [eax+0x1bc]        ; eax=this; [this+0x1bc] = inner device ctx
mov eax, [ebp+0x24]
and eax, 0x3                ; gate on flags & 3
cmp eax, 0x3
... dispatch by flags ...
call [eax+0x30]             ; eax = [esi]; slot 12 of device-ctx vtable
xor eax, eax                ; always returns 0 (success)
ret
```

**New mental model:** The "visual" attached to the root Frame is actually a **Viewport** object, NOT a Mesh. Viewport::Render forwards rendering to a device-context object stored at `[this+0x1bc]`, calling slot 12 of THAT object's vtable. The geometry-emit chain at `0x647af238` (vtable @0x647e0b40 slots 4/6/8) is for a different class (likely Mesh subclass) — it would only fire if the device-ctx walker enumerates scene meshes and dispatches into them.

So the cold geometry-emit chain isn't the bug — it's the *consequence*. The real questions:
1. Is `[esi+0x1bc]` populated correctly (non-NULL device ctx)? If NULL, the inner `mov eax, [esi]` crashes.
2. What is `[device_ctx+0]+0x30`? Dump that vtable target — that's the actual scene walker.
3. Does the scene walker iterate meshes and dispatch into their vtables (slots 4/6/8 of @0x647e0b40)?

**Cont.35 plan:**
1. trace-at `d3drm+0x6479fcd6` (target entry — should be a BB head). Dump 4 bytes from `viewport+0x1bc` to get device ctx ptr. esi is captured by trace-at regs.
2. Then dump 4 bytes from `device_ctx+0` to get its vtable, then dump `vtable+0x30` to get the scene walker fn.
3. Walk the scene-walker fn statically. Look for indirect calls that enumerate visuals — `call [reg+0x18]` style on Mesh-like objects. Find why those aren't reaching `0x647af238`.

This shifts the bug location from "Visual vtable misconstructed" (cont.31/32 hypothesis) to "device-context render walker truncated or scene-list empty". A scene with zero attached meshes would render only background, matching the PNG's all-black output.

**Likely root cause now:** `IDirect3DRMFrame::AddVisual` (or `IDirect3DRMMeshBuilder::CreateMesh` → AddVisual chain) is no-op or partial in our COM thunks, so the scene's mesh list is empty. The render walker iterates 0 meshes and exits silently. Verify by tracing AddVisual in our COM table.

**2026-04-29 cont.35 — device-context wrapper located. The dispatch lands on a synthetic D3DRM COM vtable slot 12.**

trace-at on `d3drm+0x6479fcd6` (Viewport::Render dispatch target) captured eax=this=0x750aada0 (Viewport `this`) over 15 hits.

Dump of Viewport struct @0x750aada0:
- +0x00: 0x74e0f968   (parent class metadata — d3rm-image addr)
- +0x04: 0x7500c138   (per-instance vtable in heap)
- +0x14: refcount/index 0x15
- +0x18: 0x745fbf68   (= d3rm+0x647e0bf8, ANOTHER class meta)
- +0x1bc: **0x7c3e6090** ← device-context COM wrapper

Dump of wrapper @0x7c3e6090 (in COM_WRAPPERS region 0x07FF0000+):
```
+0x00: 0x7451267c    ← synthetic vtable A
+0x04: 0x00000012    ← DX_OBJECTS slot id 18
+0x08: 0x745126f4    ← synthetic vtable B
+0x0c: 0x00000013    ← slot id 19
+0x10: 0x745129fc    ← synthetic vtable C
+0x14: 0x00000014    ← slot id 20
```

This is our standard COM-multi-iface layout: 3 (vtable, slot_id) pairs sharing one underlying object. The three vtables likely correspond to IDirect3DRMDevice, IDirect3DRMDevice2, and an aggregated iface (Unknown or DirectDrawSurface). Slot ids 18-20 are sequential DX_OBJECTS table entries.

The dispatch reads `[wrapper]` = `0x7451267c` (vtable A), then `call [vtable+0x30]` = slot 12. Vtable A is in the synthetic COM thunk region (0x745126xx), generated by our DX/D3DRM scaffolding.

**Bug isolated to:** synthetic vtable A's slot 12 (offset 0x30) for the d3rm Device interface. It returns success but does no geometry work.

**Cont.36 plan:**
1. Identify which iface vtable A corresponds to. Inspect `lib/host-imports.js` or wherever DX_OBJECTS vtables are constructed — find the table that produces thunks at 0x745126xx and read slot 12's handler name.
2. The d3rm interfaces and their slot 12 candidates:
   - IDirect3DRMDevice slot 12 = `Render` (after IUnknown 3 + IDirect3DRMObject 5 + AddRef/Release inheritance...). Need to count exact methods.
   - More likely: this is `IDirect3DRMViewportRender` or similar device-render slot.
3. Once the API name is known, implement it: it must walk the scene's Frame tree, enumerate Visuals, and dispatch each Visual's vtable at the right offset to invoke the geometry-emit chain `0x647af238` (which we proved is the only TRIANGLE-emitting fn in d3rm).
4. Alternative: since d3rm internally walks the scene and builds D3DIM ExecuteBuffers, the cleanest fix may be to invoke d3rm's *own* internal scene walker. That walker is in the same DLL — we just need to call into it from our stub. Find the d3rm-internal "Device::Render" implementation by xref'ing the wrapper construction: where is `0x7c3e6090` initialized, and what was the original d3rm fn that should have been wired to slot 12?

**Critical insight:** Our scaffolding *thinks* it's emulating d3rm by intercepting all its COM calls and forwarding to ddraw. But d3rm has its OWN sw-rasterizer and scene walker in `d3drm.dll`. Instead of stubbing, we should let the **real d3rm code** run for Device::Render, only intercepting the eventual ddraw/d3dim calls it makes downstream. The stub is the bug — d3rm has the implementation we need.

**2026-04-29 cont.36 — corrected cont.35; localized geometry-emit gap to a single d3rm fn.**

cont.35 was wrong about a "synthetic vtable stub". The vtables at runtime 0x745126xx ARE our standard COM thunks (heap-allocated by `$init_com_vtable`), and slot 12 of vtable A = api_id 1198 = `IDirect3DViewport3_Clear`. The dispatcher fn at d3rm+0x6479fcd6 is just a per-frame Clear wrapper — Clear is dispatched correctly via our handlers; not the bug site.

Real findings via `--trace-dx`:

- 80 ExecIn calls, 100% from caller `d3rm+0x647c3971` (single site), 80 Exec instructions, 100% `op=6 STATETRANSFORM`.
- Zero PROCESSVERTICES, zero TRIANGLE, zero MATRIXLOAD/MULT, zero STATERENDER.
- This matches the long-standing observation in `project_organic_art_engine.md` and `project_d3dim_matrix_table.md`: matrices flow, geometry never emits.

`d3rm+0x647c3905` is a small ExecuteBuffer-finalize fn:
```
arg this = esi (command-builder struct)
  [esi+0x44] = "has commands" flag — early-bail if 0
  [esi+0x4c] = write pointer
  [esi+0x48] = buffer base
  [esi+0x8]  = IDirect3DExecuteBuffer
  [esi+0x00] = IDirect3DDevice
flow:
  emit 0x0b (D3DOP_EXIT) to *[esi+0x4c], advance +4
  call execBuf->Unlock      (slot 5 = vtbl+0x14)
  build D3DEXECUTEDATA on stack, dwSize=0x30, instr length = curOff - base
  call execBuf->SetExecuteData (slot 6 = vtbl+0x18); bail on nonzero
  call device->Execute(execBuf, viewport, D3DEXECUTE_CLIPPED) (slot 8 = vtbl+0x20)
```

So the builder accumulates ops via OTHER d3rm fns BEFORE this finalize site, then this fn appends EXIT and submits. Since only STATETRANSFORM ever lands in the buffer, the upstream emit of geometry/process-vertices never runs.

**cont.37 plan:** find the d3rm fn that writes op=9 (PROCESSVERTICES) or op=3 (TRIANGLE) into the buffer. Two approaches:
1. `node tools/find_bytes.js test/binaries/dlls/d3drm.dll <hex>` for a `mov byte [reg], 9` or `mov byte [reg], 3` pattern — find every static "emit op N" site, then which call into the builder.
2. Watch the buffer with `--watch-byte=<bufferBase>` after MATRIXLOAD/STATETRANSFORM emits and see what fn would have written PROCESSVERTICES next but didn't — i.e. break at the visual-enumeration loop and see what it does NOT call.

Most likely approach: use approach 1 to enumerate the static emit sites, then `--count` each call site to see which ones execute at runtime (a hot one that should run but doesn't = the gap). The visual enumerator probably gates on `[mesh+offset] != 0` — and our COM constructor for IDirect3DRMMesh / IDirect3DRMMeshBuilder isn't populating that field.

**2026-04-29 cont.37 — geometry-emit subsystem proven entirely cold; localized to which finalize path runs.**

`tools/caller_census.js` on `d3rm+0x647c3905` (ExecuteBuffer-finalize):

| caller | hits | what it emits |
|---|---|---|
| 0x64798d17 | 16 | calls `0x64798db1` (emit-STATETRANSFORM helper) then finalize |
| 0x647c269b | 32 | optional `0x647c36e0` then finalize — no geometry helper |
| 10 other sites | 0 | (would emit lights, viewports, geometry, etc.) |

48 total = 16 + 32. Both live callers are matrix/state-only paths.

`--count` on the geometry-emit subsystem (cache lookup wrapper `0x647af210`, build fn `0x647af238`, parent visit fn `0x647af134`, helper `0x647af02b`, PROCESSVERTICES inline-emit `0x647af491`):
**all five = 0 hits**. The entire mesh→exec-buffer pipeline is never entered.

So the bug isn't in the emit code itself or in the Render dispatch — the app's render call never reaches the visual-enumeration code path. It dispatches into a different (matrix-only) sub-pipeline of d3rm.

**cont.38 plan — narrow what's missing in the app's call sequence:**
1. Trace EVERY COM api call from ROCKROLL with `--trace-host` or `--trace-api` filtered to `IDirect3DRM*` and `IDirect3D*`. The expected sequence per frame is roughly: `IDirect3DRMViewport::Clear` → `IDirect3DRMViewport::Render(rootFrame)` → (internal: walk frames, call `IDirect3DRMVisual::Render` per mesh) → `IDirect3DDevice::Execute`. If `Viewport::Render` is missing, the app uses a different render entrypoint (perhaps `IDirect3DRMDevice2::Update` — which I suspect we stub).
2. The two live finalize callers (0x64798d17, 0x647c269b) sit inside fns that update camera/viewport matrices. The 16 hits suggests Viewport::Configure/SetCamera, the 32 hits suggests Frame::Render or Frame::Move (per-frame transforms). What's missing is the actual mesh-render call.
3. Likely culprit on our side: `IDirect3DRMFrame::AddVisual` — if our handler doesn't actually link the visual into the frame's visual list, the per-frame walker finds nothing and skips geometry. Verify by inspecting the AddVisual handler in `src/09a8-handlers-directx.wat`.

**2026-04-29 cont.38 — caps-hardening fix (no behavior change); ExecuteBuffer content fully dissected.**

**Fix applied:** `src/09ab-handlers-d3dim-core.wat` `$d3dim_fill_device_desc` — for the partial-fill path (172 ≤ dwSize < 252) now calls `$fill_primcaps` for both `dpcLineCaps` (+44) and `dpcTriCaps` (+100) instead of writing only their dwSize. Both 56-byte ranges fit even in dwSize=172. This was a real latent bug (zero TriCaps would gate triangle emission for callers passing the smaller layout), but it does **not** unblock ROCKROLL — meaning ROCKROLL goes through the full-size path (dwSize ≥ 252) where caps were already populated.

**Asset trace** (`--trace-fs`): file IO is healthy. ROCKROLL successfully opens `ro_pick.x`, `ro_git.x`, `ro_tex01.gif`, `ro_back.gif` via CreateFile; CreateFileMapping succeeds. The .X-file mesh data IS being read into d3dxof.dll. We have zero IDirectXFile* handlers, but d3dxof.dll runs its own COM internally without needing us to provide them.

**ExecuteBuffer content** (`--trace-dx-raw`): every buffer is identical, 28 bytes:
```
op=6(STATETRANSFORM) bSize=8 wCount=3 payload=24 |
  01 00 00 00 02 00 00 00   ; D3DTRANSFORMSTATE_WORLD       = matrix handle 2
  02 00 00 00 03 00 00 00   ; D3DTRANSFORMSTATE_VIEW        = matrix handle 3
  03 00 00 00 01 00 00 00   ; D3DTRANSFORMSTATE_PROJECTION  = matrix handle 1
op=11(EXIT)
```
2 buffers/frame × 16 frames = 32 cycles. Render states / lights flow as direct API calls (320× SetRenderState, 64× SetLightState per run) — not through the buffer.

**Per-frame d3rm sequence is short by exactly one step**: BeginScene → Clear → 3×SetMatrix → ~20×SetRenderState → 4×SetLightState → 2× [Lock → write transforms → Unlock → SetExecuteData → Execute] → EndScene. The expected step between Unlock and Execute — appending PROCESSVERTICES + TRIANGLE for the visual's mesh — never runs. Whatever gates that emit decides "no geometry" before the writer fns 0x647af238 / 0x647af491 are entered.

**cont.39 plan:**
1. Find d3rm's per-visual render fn. The two live finalize call sites have parent fns:
   - parent of `0x64798d17` ends at `0x64798d43` (small fn, no geom-emit calls visible — likely Viewport-level)
   - parent of `0x647c269b` ends at `0x647c26a5` (also small, no geom-emit calls)
2. The "real" per-mesh render fn is one of the 10 cold callers. Disasm each cold caller's parent and look for the one that disasm-references mesh struct fields (vertex pointer, face count) — that's the visual submit fn.
3. Once located, run with `--break=` on its entry. If it never fires, the upstream walker is the gap (most likely: real d3rm scene-graph walker is gated on `IDirect3DDevice` flag we set wrong, or on a IDirect3DRMVisual vtable slot that real d3rm reads from a struct we never wrote into). If it does fire but bails early, instrument to find the early-bail check.
4. Alternative: focus on `IDirect3DDevice2_GetCaps` arg dump first to verify dwSize path. Add a one-shot console.log in `$d3dim_fill_device_desc` reporting the dwSize value to know which fill path runs. Cheap, removes one variable.

**2026-04-29 cont.39 — pivot: ROCKROLL doesn't use d3rm at all.**

API histogram across 88K calls of a 40K-batch run shows **zero IDirect3DRM* invocations**. d3drm.dll is loaded (import-bound) but never called into. Cont.36-38's investigation of d3rm finalize call sites and Visual::Render vtable was mis-directed — those code paths are statically dead in this app.

**Actual rendering API:** DX3 IM via IDirect3DDevice (v1) + IDirect3DDevice2 (v2 for SetRenderState/SetLightState). Histogram per 127 frames:
- 127× BeginScene / EndScene / Flip
- 5× CreateExecuteBuffer (handles 0x7c3e60b0, 0x7c3e6120, 0x7c3e6190, 0x7c3e6200, 0x7c3e6270)
- 254× ExecuteBuffer Lock / Unlock / SetExecuteData / Execute distributed across all 5 (32, 48, 58, 58, 58)
- 381× SetMatrix, 15× CreateMatrix
- 2540× SetRenderState (direct, not buffered)
- 508× SetLightState (direct)
- 259× SetViewport, 127× Clear
- 0× DrawPrimitive (DX5+ method, not used)

**Buffer content is the same on every Execute — STATETRANSFORM (W/V/P matrix handles 1/2/3) + EXIT, 28 bytes**, regardless of which of the 5 buffers fired. So **none of the 5 execute buffers ever receive TRIANGLE or PROCESSVERTICES ops**. In DX3 IM the *only* way to render geometry is via these ops (no DrawPrimitive yet) — so by design this app is pushing zero triangles per frame and 127 cleared/flipped frames is exactly the observed black output.

**Texture path is also empty:** 0× CreateTexture, 0× Load on IDirect3DTexture2, only 7× IDirect3DTexture2_QueryInterface and 7× Release. No texture binding flows through SetRenderState (TEXTUREHANDLE) either — verified by checking buffer content (no STATERENDER ops at all). So either textures fail to allocate (CreateSurface for DDSCAPS_TEXTURE bails, surface QI to texture fails silently) and the app's "ready to render" gate stays false, OR the geometry path is conditional on some other init step we're failing.

**cont.40 plan — find what gates the geometry-emit:**
1. Instrument SetExecuteData with full LPD3DEXECUTEDATA dump (dwInstructionOffset, dwInstructionLength, dwInstructionCount, ops vertex range). Look for any call where dwInstructionLength ≠ 28. If all five buffers genuinely declare length=28, the app is gating geometry emit upstream of all SetExecuteData callers.
2. Diff init-time CreateSurface descriptors — find the one(s) requesting DDSCAPS_TEXTURE. If our CreateSurface handler returns failure for texture caps, that's the gate.
3. Add a `--trace-host=com_dx_*` wide net to see every COM method our handlers fire (and every QI miss returning E_NOINTERFACE) — a single missed QI for IDirect3DTexture2 from a DDraw surface would silently disable texture-bound geometry rendering.
4. Cheapest first probe: grep CreateSurface descriptor flag bits over the 23 CreateSurface calls; correlate with the ones that have surface→texture QI follow-ups vs. those that don't. If the texture-caps surface is created but never QI'd to texture interface, the QI handler returned failure.

**2026-04-29 cont.40 — RETRACT cont.39 pivot. d3rm IS the renderer.**

Cont.39 concluded "0× IDirect3DRM* calls" — but `--trace-api` only logs the COM methods *we stub*. d3drm.dll is loaded as a real DLL (origBase=0x64780000, runtime base=0x7459b000, delta=0xFE1B000), so its internal calls are invisible to the API tracer. The 88K-call histogram is the d3rm→d3dim downward traffic only.

Confirmed via `--trace-dx`: every `IDirect3DDevice_Execute` ExecIn shows `caller=0x745de971 caller2=0x745dd6a0` — both inside d3rm.dll. Translated to d3rm origVA: caller=0x647C3971, caller2=0x647C2685. So d3rm internally calls Execute on the device with a buffer it built itself. Cont.36–38's investigation of d3rm Visual::Render and the geometry-emit subsystem was correctly targeted.

**Restated cont.36–38 finding, now reinforced:** d3rm runs through 127 frames. For every frame, d3rm builds an Execute buffer containing only `STATETRANSFORM (W/V/P, 28 bytes)` + `EXIT (4 bytes, total 32)`. It never writes TRIANGLE or PROCESSVERTICES ops into the buffer.

Where d3rm gates geometry emit:
- It DOES emit STATETRANSFORM, so the W/V/P matrix table is being managed (CreateMatrix×15, SetMatrix×381 outbound to d3dim).
- It does NOT emit PROCESSVERTICES (no vertices submitted, hence no TRIANGLE follow-up).
- The geometry-emit subsystem in d3rm at d3rm+0x647c3905 (cont.36-37 cold-path) is therefore NOT being reached on any of the 127 frames.

**cont.41 plan — find the gate inside d3rm's frame loop:**
1. Set `--break=d3rm+0x647c3971` (one frame's Execute callsite). Walk back EBP to identify the per-frame render loop in d3rm. The loop's body must contain: matrix setup → conditional geometry-emit → SetExecuteData → Execute. The conditional is the gate.
2. Use `--count=d3rm+0x647c3905,d3rm+ALT1,d3rm+ALT2,...` to confirm the geometry-emit fn is statically dead (0 hits) while the matrix-emit fn fires 254× per run. We already have evidence cont.37 ⇒ this matches.
3. Find the geometry-emit fn's static call sites with `tools/find-refs.js d3rm.dll d3rm+0x647c3905 --code-only`. Each call site sits inside a conditional. Print the conditional bytes and identify the test (likely a flag in IDirect3DRMVisual or the frame's mesh-list head being NULL).
4. Cross-reference: the COM fn we DO see called is IDirect3DRMFrame3_AddVisual / IDirect3DRMMeshBuilder3_*. If those weren't called, the frame's visual list is empty ⇒ no geometry to emit. Verify by adding IDirect3DRMFrame3_AddVisual to the trace stub set (we may already trace it, just need to inspect).
5. If AddVisual IS being called: scene loaded, geometry exists, but the gate is on something else (visibility flag, LOD selection, transform validity).
6. If AddVisual is NOT being called: app's scene-load path failed silently. Look at IDirect3DRMMeshBuilder3_Load / LoadFromFile — does it return success but produce an empty mesh?

**2026-04-29 cont.41 — multi-app sweep: the bug is systemic, not ROCKROLL-specific.**

Ran the same `--trace-dx-raw --max-batches=8000` probe across other d3rm screensavers in the Plus!98 set:

| Screensaver | Reaches Execute? | Buffer content |
|---|---|---|
| ROCKROLL.SCR | yes | STATETRANSFORM (W=mh2, V=mh3, P=mh1) + EXIT, 32B |
| GEOMETRY.SCR | yes | **identical** 32B payload |
| JAZZ.SCR | yes | **identical** 32B payload |
| SCIFI.SCR | no — stuck in CreateDevice/GetCaps retry loop |
| FALLINGL.SCR | no — same retry loop |
| OASAVER.SCR | no — same retry loop |
| CITYSCAP.SCR | no d3rm activity (cartoon/2D screensaver — uses DDraw only) |
| CATHY.SCR | no d3rm activity (cartoon/2D) |

**Three independent d3rm scenes (ROCKROLL/GEOMETRY/JAZZ) all submit byte-identical Execute buffers.** The payload `01 00 00 00 02 00 00 00 02 00 00 00 03 00 00 00 03 00 00 00 01 00 00 00` decodes as 3× D3DSTATE pairs: `(D3DTRANSFORMSTATE_WORLD, mh=2)`, `(VIEW, mh=3)`, `(PROJECTION, mh=1)`. That's d3rm's per-frame matrix-binding init, fired BEFORE per-mesh geometry emit. So all three apps complete d3rm's init phase but bail out before the geometry-emit phase begins.

Three different scenes producing three identical 32-byte buffers means the divergence point is **inside d3rm itself**, not the app — d3rm has the Frame::Render path and is choking on something we provide upstream. Hypotheses, ranked:
- (a) **Visual list is empty.** d3rm's IDirect3DRMFrame3::AddVisual was never wired (silent failure in MeshBuilder3::Load → returned NULL mesh → AddVisual rejected the NULL). All three apps would hit this if our MeshBuilder/Texture path is broken.
- (b) **Picking/visibility cull rejects everything.** d3rm computes view-frustum culling using the bound viewport rect; if our SetViewport handler stores wrong `dvScaleX/dvScaleY/dwClip*` values, the frustum is degenerate and every visual culls.
- (c) **Texture-load failure short-circuits the mesh's "ready" state.** Cont.39 noted 0× CreateTexture/Load — meshes that need a texture but can't bind one might be marked "dirty" and skipped from the emit pass.

**The fact that the SAME 32-byte buffer appears across 3 scenes that should differ wildly (rock instruments, jazz notes, abstract geometry) is the smoking gun: hypothesis (a) is most likely** — the meshes never even get registered as visuals in their respective frames, so d3rm has nothing to walk in the per-frame visual list.

**SCIFI/FALLINGL/OASAVER stuck in CreateDevice retry loop** is a separate bug: our IDirect3D2::EnumDevices or IDirect3DDevice2::GetCaps is reporting caps that d3rm rejects; it then retries with different requested caps, reaching the same answer, and never proceeds. That's a smaller, more localized fix (compare what wine-d3rm probes vs. what our GetCaps fills).

**cont.42 plan — verify hypothesis (a):**
1. Add a one-line hit-counter on d3rm's IDirect3DRMMeshBuilder3::Load (origVA TBD via `tools/find_string.js d3drm.dll "MeshBuilder"` + vtable walk). If it fires N times for N expected meshes but returns failure, our Load implementation is broken. If it fires 0 times, the app is using a different load path (LoadFromResource / LoadMesh-on-Frame / X-file parser).
2. Add a hit-counter on d3rm's IDirect3DRMFrame3::AddVisual. Hit count = 0 confirms no visuals registered.
3. Find the d3rm internal flag that gates "did this mesh produce vertices" and trace_at it.
4. As a workaround for (a), if d3rm's mesh-load path requires DirectX surfaces that we're failing to provide, identify the failing primitive (texture create? IDirect3DRMMeshBuilder3::SetTexture?) and fix the host stub.

**2026-04-29 cont.42 — Gemini consult: the gate at `[eax+0x5c4]` is the smoking gun.**

Sent disasm of d3rm flush-fn (0x647c3905) and append-state-op fn (0x647c36e0) to Gemini for a second opinion. Key insights:

1. **STATETRANSFORM (op=6) bypasses the gate.** In 0x647c36e0, opcode 6 fails both `cmp edx,8` and `cmp edx,7`, so it jumps to `0x647c3726` (a separate batcher shim). Matrices are always emitted regardless of device caps. That's why we see the 32-byte matrix-only buffer succeed.

2. **STATELIGHT (7) and STATERENDER (8) hit the `[eax+0x5c4]` gate.** If the gate is non-zero, d3rm thinks the device supports a "fast path" (DrawPrimitive-like) and routes RenderStates to a different emitter (`0x647a0a29`), which **bypasses the Execute Buffer entirely**. Mesh-renderer (vtable@0x647e0b40 slot 6) sees the "fast-path" bit and either fails silently or uses an emitter that never fires for our stubbed device.

3. **`[esi+0x1d4]` = CDirect3DRMContext** (emission scratchpad), with `[ctx+0x3c]` = IDirect3DDevice ptr, `[+0x44]` = writes-pending counter, `[+0x4c]` = write head into the locked Execute buffer.

4. **The `[eax+0x5c4]` field is inside d3dim's IDirect3DDevice struct** (the implementation-private extension). Our COM wrapper is only 8 bytes wide, so reads at +0x5c4 land in **adjacent slot memory** in our COM_WRAPPERS table — probably hitting the next slot's vtable/refcount and returning a non-zero value. That trips the fast-path branch and silently disables geometry emission.

**Concrete fix Gemini suggests:**
- Thicken the device wrapper to ≥ 1.5KB (alloc per-device backing in `dx_create_com_obj` or `IDirect3D2_CreateDevice`).
- Explicitly zero `[device+0x5c4]` to force d3rm onto the legacy Execute Buffer path for ALL opcodes.

**cont.43 plan — verify before fixing:**
1. `--trace-at=d3drm+0x647c36f8 --trace-at-dump=...` at the `cmp dword [eax+0x5c4], 0x0` instruction. Dump 32 bytes around `[eax+0x5c4]` to see what value d3rm actually reads. If it's non-zero (and not consistently 0xCAFE-pattern from our COM wrapper init), Gemini's hypothesis is confirmed.
2. If confirmed: identify the device wrapper allocator and bump the size; zero the +0x5c4 region. Alternatively, route d3rm reads at this offset through a special path that always returns 0.
3. Re-run ROCKROLL/GEOMETRY/JAZZ. If geometry now appears in the Execute buffer (TRIANGLE/PROCESSVERTICES ops), the fix is correct. If only one of the three benefits, there's a second gate.
4. If the gate IS zero in our trace but geometry still doesn't appear, the bug is elsewhere (likely the visual walker that calls into the mesh-render slot 6).

**2026-04-29 cont.43 — Gemini's diagnosis half-right; verified with hit counts.**

Hit-counted the gate paths in 0x647c36e0 (state-append fn) over a 12K-batch ROCKROLL run:

| Block | Meaning | Hits |
|---|---|---|
| 0x647c36e0 | fn entry | 480 |
| 0x647c36f5 | state ∈ {7,8} reached gate | 384 |
| 0x647c3701 | fast-path (gate non-zero, post-jz-not-taken) | 384 |
| 0x647c3726 | fallback (state ∉ {7,8} OR gate=0) | 96 |
| 0x647c3744 | fallback's inner | 96 |
| 0x647c3905 | flush | 48 |

`0x647c3701 == 0x647c36f5` ⇒ the `jz [eax+0x5c4]==0 → bail` is **never taken** ⇒ gate IS non-zero. Confirms Gemini's structural diagnosis: d3rm takes the fast path for all 384 STATELIGHT/STATERENDER appends, bypassing the Execute Buffer.

But Gemini's specific FIX ("zero +0x5c4 in the COM wrapper") is misaimed — `eax = [ctx+0x3c]` is NOT our 8-byte COM device wrapper. It points into d3rm's own internal `CDirect3DRMDevice` struct (heap-allocated by d3rm during init, filled by d3rm). The +0x5c4 byte is set BY d3rm itself — we can't directly write to it without intercepting d3rm's internal state.

That's also confirmed by post-run dump: `mem[0x7c3e8038 + 0x5c4] = 0x00...` (our device wrapper's +0x5c4 IS zero, but d3rm reads from a different pointer).

**The render-state fast path already works in our emulator.** Our API histogram shows 2540× SetRenderState + 508× SetLightState + 381× SetMatrix — these are the d3rm fast-path emissions hitting our DX_OBJECTS handlers correctly. So fast-path for state IS functional.

**What's broken is the geometry-emit fast path.** d3rm's per-mesh emitter would normally call `IDirect3DDevice2::DrawPrimitive` (or similar) directly when the same gate is set. Our API histogram shows **0× DrawPrimitive** in 88K calls. So a parallel gate (or precondition) for geometry is failing — different from the state gate.

**Refined hypothesis:** d3rm's geometry-emit path requires:
- (i) at least one mesh registered as a visual on the active frame (AddVisual succeeded),
- (ii) the mesh has non-empty geometry (X-file load produced vertices/faces),
- (iii) one of: a valid texture handle binding OR a "no-texture" fallback enabled,
- (iv) the device's "ready for geometry" sub-flag (likely a different offset in the same internal struct as +0x5c4) is set.

**cont.44 plan:**
1. Find the d3rm fn that calls `IDirect3DDevice2::DrawPrimitive` (vtable slot for DrawPrimitive on IDirect3DDevice2 vtable). Use `tools/find_vtable_calls.js` on d3drm.dll for the known DrawPrimitive vtable slot.
2. Hit-count its callers. Determine if the fn itself is reached (just fails to fire DrawPrimitive) or if it's never entered.
3. If never entered: walk backward to find the gate. Likely a `[ctx+OFFSET] != 0` test where OFFSET corresponds to "visual list head" or "mesh-builder count".
4. If entered but DrawPrimitive call doesn't fire: the gate inside it is a per-mesh "ready" flag — check what mesh-builder field gates it.

**2026-04-29 cont.44 — geometry-emit fns ALL never entered; X-file parse succeeds.**

Hit-counted all 16 `call [reg+0x74]` (slot 29 = IDirect3DDevice2::DrawPrimitive) sites in d3rm.dll. **Every one = 0 hits.** Then hit-counted the 8 distinct enclosing fns:
- 0x647a4beb, 0x647a955a, 0x647afed6, 0x647b8cec, 0x647c5fe8, 0x647c6b77, 0x647c72f4, 0x647cbf34 — all **0 hits**.

So d3rm's per-visual "render fn" family is statically dead. The bug is upstream — d3rm's per-frame visual walker never iterates a non-empty list, so it never dispatches to any render fn. Once that's fixed, ANY of the 16 DrawPrimitive sites might fire.

**Eliminated as causes:**
- File I/O: trace-fs+trace-api confirms ROCKROLL.SCN parses correctly, ro_pick.x and ro_git.x are mapped via CreateFileMappingA→MapViewOfFile (we don't see ReadFile because d3rm uses memory-mapped I/O), and the mapped content begins with `xof 0302txt 0032` — valid X-file magic. So the mesh data is reaching d3rm's parser as raw bytes.
- ro_tex01.gif loads via plain ReadFile in 0x1000-byte chunks. Texture path looks healthy.

**Open question:** the X-file content is reaching d3rm as bytes, but is d3rm's parser successfully producing a mesh-builder with vertices? If parser silently fails (e.g. on a template GUID it doesn't recognize, or our heap allocator fragmenting its parse-time buffer), the mesh-builder would have 0 vertices and AddVisual would either reject NULL meshes or accept-but-skip-empty.

**cont.45 plan — pinpoint where d3rm bails between "X-file mapped" and "render fn entered":**
1. Find d3rm's "Direct3DRMCreate" entry (origVA via export table) and its CreateMeshBuilder3 dispatch. Hit-count both.
2. Find d3rm's per-frame walker fn — it must be reached 127× (matches BeginScene count), and inside it, the visual-list iteration head pointer test gates everything. Locate the test, read the list-head pointer at runtime — if NULL, AddVisual was never called (or returned failure).
3. Walk ROCKROLL.EXE imports of d3rm: only `Direct3DRMCreate` is imported. So app calls IDirect3DRM3 vtable methods. Locate the IDirect3DRM3 vtable in d3rm.rdata (look for the QI/AddRef/Release/CreateMeshBuilder3 sequence) and hit-count CreateMeshBuilder3 + Load + AddVisual entries.
4. As parallel signal: instrument the X-file parser's "vertex emit" inner loop. If parser runs but emits 0 vertices, the mesh-data dispatch is wrong (template GUID mismatch, header-only file, etc.).

**Cumulative state** (cont.36 → cont.44):
- ROCKROLL/GEOMETRY/JAZZ all reach 127 frames/second (BeginScene/EndScene/Flip cycle works).
- d3rm renders 32-byte STATETRANSFORM-only buffers per frame, identical across all 3 apps.
- Render-state fast path fires correctly (2540× SetRenderState observed). 
- Geometry fast path completely silent (0× DrawPrimitive, 0 enters of any of d3rm's 8 mesh-render fns).
- Asset I/O for meshes (X-files) and textures (GIFs) succeeds at the file/mapping level.
- The bug sits between "asset bytes available to d3rm parser" and "visual added to frame's render list" — within d3rm's internal mesh-builder/AddVisual path. Need to instrument d3rm-internal entry points (no longer findable via API trace since d3rm is real not stubbed).

**2026-04-29 cont.45 — app uses IDirect3DRM v1, not v3; Load is never called on either interface.**

`Direct3DRMCreate` (origVA `0x6478f112` → inner `0x6478f11f`) allocates a 0x428-byte multi-interface object and writes three vtable ptrs:
- `[obj+0x08] = 0x647e01f8` — IDirect3DRM (v1, 35 slots)
- `[obj+0x14] = 0x647e0288` — IDirect3DRM2 (35 slots)
- `[obj+0x20] = 0x647e0318` — IDirect3DRM3 (36 slots)

Returns `obj+0x8` (v1 ptr). All three vtables share `slot 0=QueryInterface=0x6478f24e`, `slot 1=AddRef=0x6478f213`, `slot 2=Release=0x6478f326`.

Hit counts over 12K-batch ROCKROLL run (`--count d3drm+...`):

| Slot | v1 fn | v3 fn | v1 hits | v3 hits |
|---|---|---|---|---|
| 0 QI | 0x6478f24e | (same) | 6 | — |
| 4 CreateFrame | 0x6478fa90 | 0x6478fb83 | **40** | 0 |
| 6 CreateMeshBuilder | 0x6478fcf4 | 0x6478fdc1 | **6** | 0 |
| 13 CreateMaterial | 0x6479025c | — | **2** | — |
| 21/33 Load | 0x6479100e | 0x647917c3 | **0** | 0 |
| 22/34 Tick | 0x647914b5 | 0x647914b5 (shared) | 0 | 0 |
| 14 CreateDevice | 0x64790340 | — | 0 | — |

ROCKROLL.EXE imports only `Direct3DRMCreate` and uses **IDirect3DRM v1** for everything — no v2/v3 calls observed (every IDirect3DRM3 slot we tested = 0 hits). 40 frames + 6 mesh builders + 2 materials, but **0 Load calls on the IDirect3DRM interface itself**.

**Where the X-file actually loads:** `IDirect3DRMMeshBuilder::Load` is a method on the *returned* MeshBuilder, not on IDirect3DRM. The MeshBuilder is allocated by `0x647a7247` (a generic class-registry constructor) using class descriptor `0x647e0a10`. The descriptor's first dword `0x647e0fe8` is NOT a vtable (slot 1 points into .data, slot 2 = 0xa4). So the MeshBuilder's vtable isn't directly retrievable via the descriptor — it's installed by the constructor based on class GUID lookup.

**Eliminated:** the cont.36–37 "geometry-emit" vtable (`0x647e0b40`, slot 6 `Render = 0x647af646`) is statically dead under ROCKROLL — every slot (0x647af134/0x647af5f2/0x647af646/0x647afa2c/0x647aeede) = 0 hits. So either:
- (i) registered visuals use a DIFFERENT mesh-render vtable (mesh-builder vs. mesh — d3rm has both), and the dead vtable is for a different visual class we never instantiate; or
- (ii) the visual-list head pointer on the active frame is NULL, so the per-frame walker exits before any vtable dispatch.

The fact that CreateFrame fires 40× while no Load fires in the IDirect3DRM root means the app is building a frame hierarchy first, then expecting to populate meshes via `IDirect3DRMMeshBuilder::Load` calls (the MeshBuilder vtable's own Load slot, not the root). If those Load calls succeed, frames get visuals via `IDirect3DRMFrame::AddVisual` (a frame-vtable method).

**cont.46 plan — locate IDirect3DRMMeshBuilder vtable and hit-count Load:**
1. Identify the MeshBuilder vtable. Approach A: set `--watch-byte` on `[esi]` after a CreateMeshBuilder return; the value written is the vtable ptr. Concretely, break at `0x6478fd2d (mov [esi], eax)` once and dump `*eax` to read the vtable ptr. Approach B: scan d3rm's .data for vtable patterns where `slot 0 / slot 1 / slot 2` look like QI/AddRef/Release for the MeshBuilder class (different fns from RM's 0x6478f24e). Filter by "vtable's slot count matches IDirect3DRMMeshBuilder3 size (~50)". Approach C: find d3rm string "Mesh.X" or X-file template GUIDs and trace which fn parses them.
2. Once vtable located, hit-count its Load slot (typically slot 14 for IDirect3DRMMeshBuilder3; differs for v1/v2). If 0 hits — app uses a different load path (e.g., enumerates X-file via IDirectXFile directly). If non-zero — Load fires but produces empty mesh: instrument the vertex-emit inner loop.
3. Parallel: locate IDirect3DRMFrame vtable (returned by CreateFrame slot 4 = 0x6478fa90). Hit-count its `AddVisual` slot. If 0 — geometry never gets attached to frames, confirming hypothesis (a) from cont.41.
4. Cheaper alt: add a one-shot `--break=d3drm+0x6478fd2d` at MeshBuilder ctor return point, dump the returned object's `*[obj]` to console, exit. Three lines of evidence: MB vtable address, allowing direct vtable_dump.

**2026-04-29 cont.46 — Gemini consult + runtime probe: MeshBuilder::Load returns 0x88760314 for every call.**

Gemini provided the IDirect3DRMMeshBuilder vtable layout (50 slots: QI/AddRef/Release at 0..2, IDirect3DRMObject base at 3..10, Load at slot 11, AddVertex/AddFace/AddFaces at 23..25). Located the runtime vtable via `--trace-at=d3drm+0x6478fd44 --trace-at-dump=<eax>:32` after CreateMeshBuilder returns:

- **MeshBuilder vtable @ 0x647df9b8** (49 slots, QI=0x64791da1)
- **Frame vtable @ 0x647df388** (50 slots, shares slots 0..10 — same Object base)

Hit counts on MeshBuilder vtable:
- slot 11 Load = **6 hits** (one per CreateMeshBuilder)
- slot 23 AddVertex / 24 AddFace / 25 AddFaces = **0 hits** each
- slot 1 AddRef = 77, slot 2 Release = 234, slot 6 SetAppData = 3

Hit counts on Frame vtable:
- slot 11 AddChild / slot 18 AddVisual = **0 hits each**
- slot 12 AddLight = 3 hits
- slot 19 GetChildren / slot 23 GetParent = 16 each

**Smoking gun: Load EVERY call returns 0x88760314.** Trace-at at the post-call epilog `0x6478a1c4` (right before `mov eax,esi; ret 0x18` in `$IDirect3DRMMeshBuilder::Load`) shows EAX=ESI=0x88760314 for all 6 calls. So the X-file load fails inside the parser, and the app — seeing the failure — never calls AddVisual/AddChild to attach the empty mesh-builder to a frame. That's why the visual list stays empty and d3rm emits only matrix transforms.

`0x88760314` is a D3DRMERR_* HRESULT (D3DRM error space `0x88760000 | code`). Common candidates: D3DRMERR_BADFILE/D3DRMERR_FILEBADRESOURCE/D3DRMERR_NOTFOUND. The .X files ARE successfully mmapped (confirmed cont.44), so the failure is downstream — likely in d3xof.dll's IDirectXFile parsing, or in d3rm's CoCreateInstance(CLSID_CDirectXFile) which our COM/CoCreate dispatch may stub-fail.

Frame method hit profile is consistent with the diagnosis: 16× GetChildren/GetParent (app walks the frame tree it built) but 0× AddChild/AddVisual (no leaves attached). The 40 frames are isolated nodes; the 6 mesh-builders are empty objects nobody references.

**cont.47 plan — find what 0x88760314 means and where in Load it's raised:**
1. `tools/find_string.js d3drm.dll` for "BADFILE"/"FILEBAD"/"NOTFOUND" to confirm the error code mapping. Or grep d3rm .text for `b8 14 03 76 88` (mov eax, 0x88760314) to find every site that raises it.
2. Walk `0x64792acc` (Load delegate, called from slot 11) to find the early-bail. Hit-count internal sub-fns to localize where 0x88760314 first appears.
3. If failure is in CoCreateInstance(IDirectXFile): inspect our CoCreateInstance handler to see if CLSID_CDirectXFile maps to d3xof.dll. The DLL is already loaded (cont.44 saw it via DLL imports), but its class factory must be wired in our COM dispatch.
4. If failure is in d3xof.dll's parsing: instrument IDirectXFile::CreateEnumObject / IDirectXFileEnumObject::GetNextDataObject and see which template GUID rejects.
5. As parallel fast-fail check: load `ro_pick.x` directly with the DirectX SDK XOF tool / a known-good X-file parser to confirm the file isn't malformed (host-side sanity).

**2026-04-29 cont.47 — root cause: `IDirectXFile::RegisterTemplates` returns `DXFILEERR_BADVALUE`.**

Walked the Load delegation chain through d3rm:
- `MeshBuilder::Load` (slot 11, fn 0x6478a18f) → `0x64792acc` → `0x647ce0c5` → `0x647cdf1d` → `0x647d0868` (the X-file driver).

Inside `0x647d0868`:
1. First call: `LoadLibraryA("d3dxof.dll")` → handle 0x74fe8000 ✓; `GetProcAddress(handle, "DirectXFileCreate")` → 0x74fedfa8 ✓ (verified via trace-at on `0x647d0ab9`).
2. `DirectXFileCreate(&[0x647e74f4])` (call to cached fn ptr at `0x647d0ae5`) → returns **0** (S_OK) ✓; IDirectXFile object stored at `[0x647e74f4]`.
3. `IDirectXFile::RegisterTemplates(buffer=0x647e1250, size=0xcce)` (vtable slot 5 at `[ecx+0x14]`) → returns **0x88760362 = DXFILEERR_BADVALUE**. ← **first failure point.**
4. `jl` taken → fn resets `[0x647e74f4]=0` and returns `0x88760314`.
5. Calls 2-6 reach the same RegisterTemplates path (since `[0x647e74f4]` was reset to 0 each time after RegisterTemplates failure)... actually verified: `IDirectXFileEnumObject::GetNextDataObject` (vtable slot 3 at `[ecx+0xc]`) also returns 0x88760362 → same root cause. Without registered templates, the enum can't recognize any data block.

**Templates buffer is structurally valid:** dump of `0x647e1250` starts with the X-file header magic `xof 0302bin 0064`, followed by a `Header` template definition. So the bytes ARE the canonical D3DRM template set; the rejection is inside d3dxof.dll's binary template parser.

**This is now an emulation bug in d3dxof.dll's parsing path** (real DLL, runs under our x86 emulator). Possible causes ranked:
- (a) d3dxof.dll uses an unimplemented/buggy x86 instruction (uncommon but possible — the parser is tight code with shifts/masks).
- (b) d3dxof.dll's heap allocations (HeapAlloc/HeapCreate) returning wrong values. We already implement these.
- (c) String/byte read at the boundary of d3rm's data section (templates buffer at `0x647e1250` is in d3rm.dll's `.data`, mapped at runtime base `0x745fc...`). If d3xof reads past the first byte but lands on a non-mapped address, parser bails.
- (d) Some compiler intrinsic (e.g. _stricmp) has wrong behavior on our emulator — d3xof would compare keyword tokens like "template" or "Header".

**cont.48 plan:**
1. Find d3dxof.dll's `IDirectXFile::RegisterTemplates` impl. Walk its export `DirectXFileCreate` to locate the IDirectXFile vtable, dump slot 5. Then disasm to find the bail returning 0x88760362.
2. Hit-count every `mov eax, 0x88760362` site in d3xof.dll (`tools/find_bytes.js d3dxof.dll b862037688`) — should narrow to one or two parser bail sites.
3. At the bail, dump regs + the parser cursor (likely an EBP/EBX-based pointer into the template buffer). The byte at the cursor reveals which token confused the parser.
4. Compare expected token byte vs actual — if matches a known X-file marker (e.g. `0x10` = TOKEN_TEMPLATE, `0x05` = TOKEN_GUID, `0x06` = TOKEN_OPEN_BRACE), the parser's state machine took a wrong branch — bug is in d3xof's prior-token logic or our emulator's miscompiled instruction. If doesn't match, the cursor is wrong (off-by-one, alignment, etc).
5. Sanity check: copy the same 0xcce-byte buffer out and feed it to a known-good x86 d3xof.dll under Wine + a real RegisterTemplates harness. If real Wine ALSO fails, the buffer is malformed (unlikely but possible). If real Wine succeeds, our emulator is corrupting the buffer in transit — verify g2w mapping at `0x647e1250` returns identical bytes to the .data dump.

**2026-04-29 cont.48 — bail localized: d3xof binary parser returns EAX=1 → BADVALUE.**

Reorientation. cont.47 was right about the d3xof object but wrong about which method was called. Re-disasm of d3rm at `0x647d07db`:
- `push edx; push eax; mov ecx, [eax]; call [ecx+0xc]` → 1 arg + thisptr, slot 3 (offset 0xc). With ret 8, this is `IDirectXFileEnumObject::GetNextDataObject(LPDIRECTXFILEDATA*)`, not RegisterTemplates.

Mapped d3xof runtime VAs (base 0x74fe8000, delta 0x18ae8000) and used `--count` to verify each function actually executes:

| Fn | OrigVA | RuntimeVA | Hits |
|---|---|---|---|
| DirectXFileCreate | 0x5c505fa8 | 0x74fedfa8 | 1 |
| IDirectXFile::RegisterTemplates (slot 5) | 0x5c50620e | 0x74fee20e | 1 |
| IDirectXFile::CreateEnumObject (slot 3) | 0x5c50604e | 0x74fee04e | 3 |
| IDirectXFileEnumObject::GetNextDataObject (slot 3) | 0x5c50638e | 0x74fee38e | 3 |
| Template walker (`call 0x5c5085a1`) | 0x5c5085a1 | 0x74ff05a1 | 4 |
| Parser entry stub (`call 0x5c50733a`) | 0x5c50733a | 0x74fef33a | 4 |
| Parser body (0x5c507361) | 0x5c507361 | 0x74fef361 | 4 |
| Lexer (`0x5c506e2d`) | 0x5c506e2d | 0x74feee2d | 387 |

So 1× RegisterTemplates + 3× GetNextDataObject all fire, the parser body actually runs (387 lexer calls), but the **walker exits via state=2** every single time:

| Walker exit path | OrigVA | RuntimeVA | Hits |
|---|---|---|---|
| state=2 (BADVALUE) | 0x5c5085da | 0x74ff05da | **4** |
| state=1 (success) | 0x5c5085d1 | 0x74ff05d1 | 0 |
| state=0 (eof) | 0x5c5085c6 | 0x74ff05c6 | 0 |
| list-read fall-through | 0x5c5085ee | 0x74ff05ee | 0 |
| buffer-overflow | 0x5c50772e | 0x74fef72e | 0 |

`--trace-at=0x74ff05b8` (post-`call 0x5c50733a` landing) confirms **EAX=1 every call** at the walker's `test eax, eax; jnz state=2`. So the parser doesn't return an X-file error code — it just returns 1.

That means either:
- (i) Parser's success exit is `xor eax, eax; ret`, but our emulator's path through it is taking a *different* exit that returns 1 (e.g. a sentinel "no more tokens" path normally meant for inner state machines).
- (ii) Parser's body has a self-test that returns 1 if some global state mismatch is detected — and our emulator is corrupting that global.

Notable parser globals (set in parser entry block 0x5c507361):
- `[0x5c51cc18]` → token-stream cursor, init = `0x5c51a8e0`.
- `[0x5c51cc20]` → templates table base, init = `0x5c51acc8`.
- `[0x5c51a8d8]` → last-token (init `-1`).
- `[0x5c51cc1c]`, `[0x5c51a6c0]` → init 0 (depth/flag).

These are **statics in d3xof's .data**. The parser is heavily stateful and shares the same statics across all 4 calls. After 1× RegisterTemplates the statics are mutated; subsequent CreateEnumObject reuses them.

**cont.49 plan:**
1. Disasm full body of `0x5c507361` past 0x5c507450 to find every `ret` and the eax value preceding it. Tools cap is ~60-80 instructions per call — chain disasm calls or enlarge `count` arg further. (The fn is large; `0x5c5085a1 - 0x5c507361 = 0x123c` bytes ≈ 1k+ insts.)
2. Once every ret-with-eax is enumerated, set `--trace-at` on the ret addresses to find which one fires.
3. Likely candidate: a "templates table exhausted" exit returns 1 because our walker entered with parser state already done. State `[0x5c51cc18]` may already be at end after RegisterTemplates' first parse, so re-entries hit the "nothing more to do" branch which returns 1 (legitimately error from caller's POV).
4. If that's it, the bug is that **RegisterTemplates and GetNextDataObject share the same parser statics** → only first call works. This is correct per spec; our problem may be that d3rm's internal use expects a *fresh* parser per file. Investigate whether GetNextDataObject creates a new parser context that we're not honoring (different `ecx` thisptr → different state pointer).
5. Quick check: `0x5c5085a1` takes `ecx=esi`, where esi is the iterator obj (different per call). The parser fn 0x5c507361 uses GLOBALS not [esi+...] — that's the bug per d3xof's design. So the iterator's [esi+0x4] state field must encode the result, but our walker takes path that sets state=2 because parser returned 1 (intended-as-sentinel). Need to re-read the walker logic with this lens.

**2026-04-29 cont.49 — parser exit instrumented; eax=1 reached via the `push 0x1; pop eax` epilogue.**

Walked all 25+ rets in the d3xof parser fn region (0x5c507361..0x5c5085a0). The parser body's exit epilogue at `0x5c507739..0x5c507743` decodes as:

```
5c50772a  33 c0           xor eax, eax              ; success
5c50772c  eb 0e           jmp 0x5c50773c            ; → pop edi/esi/ebp/ebx; ret
5c50772e  68 bc 16 50 5c  push 0x5c5016bc           ; error path A
5c507733  e8 ff fb ff ff  call 0x5c507337           ; emit error
5c507738  59              pop ecx
5c507739  6a 01           push 0x1                  ; ← runtime hits 4×
5c50773b  58              pop eax                   ; eax = 1
5c50773c  5f              pop edi
... ret
```

Branches reaching the eax=1 path (static analysis):
- `0x5c507404 jnb 0x5c50772e` — buffer cursor overflow.
- `0x5c507639 jnb 0x5c50772e` — same overflow check.
- `0x5c5076e0 jnb 0x5c50772e` — yet another overflow check.
- `0x5c5076c5 jbe 0x5c507739` — state-stack underflow (esi <= base 0x5c51a8e0).
- `0x5c50771b je 0x5c507739` — last-token sentinel (eax=[0x5c51a8d8]==0).

Runtime counts (delta=0x18ae8000):
- `0x74fef739` (push 0x1; pop eax): **4 hits** ✓
- `0x74fef72e`, `0x74fef716`, `0x74fef719`, `0x74fef67e`, `0x74fef687`: 0 hits.

All five static predecessors show 0 hits, yet the epilogue fires 4 times. The `0x74fef739` address isn't strictly a jump target either (mid-block), but the WAT block-cache evidently picks up its instructions. So either:
- (a) My disasm of branches is incomplete (some path I haven't found bypasses the show jcc's), or
- (b) Counts only fire reliably on canonical basic-block entries our decoder picks (call-return landings, branch targets, fn entries) and these mid-epilogue probes are dropping in/out depending on cache layout.

Given the pattern (push 0x1; pop eax IS measured 4×, but no predecessor count fires), (b) is more likely — the d3xof parser body is hot, our block cache has it as one giant block crossing all the "exit" cmp/jcc sequences, and only the jcc *targets* register as cache entries.

**cont.50 plan:**
1. Use `--trace-at` on the actual parser-body entry `0x74fef361` and dump key globals on each call:
   - `[0x5c51a8d8]` (last-token, runtime VA `0x74fff8d8` after delta)
   - `[0x5c51cc18]` (cursor)
   - `[0x5c51cc20]` (template table base)
   - `[0x5c51a6c0]` (depth counter)
2. Compare globals **between** the 4 calls (1× RegisterTemplates, 3× GetNextDataObject). If RegisterTemplates already left the cursor at end-of-buffer, GetNextDataObject re-enters with a stale state and immediately exits.
3. Also dump the templates buffer 0x647e1250 (in d3rm .data) to confirm bytes match the .dll's static template buffer.
4. **Most-likely root cause:** RegisterTemplates is *supposed* to update an internal "templates registered" list, then return success. Each subsequent CreateEnumObject is supposed to set up a fresh per-iterator parsing context (cursor pointing at the .x file's byte stream — *not* the templates buffer). If our flow somehow re-uses the templates-buffer cursor for the .x file enumeration, the parser sees end-of-buffer immediately. Investigate `0x5c508297` (called from CreateEnumObject) — does it set `[0x5c51cc18]` to the .x file content or to the templates buffer?
5. Bisect: run with --break-api=`HeapAlloc` or --trace-host wrapping d3xof's internal alloc fn `0x5c50671c` to verify per-iterator state is allocated and not aliasing the global parser cursor.

**2026-04-30 cont.50 — cursor-not-reset hypothesis FALSIFIED; parser is YACC; failure is "syntax error" + YYABORT.**

Disassembled the parser entry. The first 0x35 bytes do *exactly* the cursor reset that cont.49 hypothesized was missing:

```
5c507361  sub  esp, 0x10
5c507364  or   eax, -1
5c50736c  mov  [0x5c51a8d8], eax        ; yychar = -1
5c507377  mov  [0x5c51cc1c], 0          ; yynerrs = 0
5c50737d  mov  [0x5c51a6c0], 0          ; yyerrstatus = 0
5c507383  mov  dword [0x5c51cc18], 0x5c51a8e0   ; yyssp = yyssa (state stack base)
5c50738d  mov  [0x5c51cc20], 0x5c51acc8         ; yyvsp = yyvsa (value stack base)
5c507395  mov  [0x5c51a8e0], bp                 ; *yyssa = 0 (initial state)
```

So all four globals from cont.49's plan are *unconditionally* reinitialized on entry. The four parse calls each start from a clean state — staleness is not the bug.

**The parser is YACC-generated** — proven by two error strings emitted via `0x5c507337` (yyerror):
- `0x5c5016bc` = `"yacc stack overflow"`
- `0x5c5016d0` = `"syntax error"`

The four "tables" referenced in the body are classic Bison artifacts:
- `0x5c515308` = yystos (state→default-action), `0x5c515460` = yytable, `0x5c5159d8` = yycheck, `0x5c5156b8` = yydefact
- The reduce dispatcher at `0x5c5074ca jmp [0x5c507d5b+eax*4]` is the per-rule action switch.

**cont.51 — runtime counts on both error landings:**

```
0x74fef361 (parser entry)            = 4   ✓
0x74fef72e ("yacc stack overflow")   = 0
0x74fef66c (post syntax-error call)  = 4   ← every call
0x74fef739 (push 0x1; pop eax)       = 4   ✓
0x74fef72a (xor eax,eax success)     = 0
```

So **every parse hits "syntax error" exactly once**, then bails via the YYABORT path. Concretely:
1. Parser starts; lexer returns tokens normally for a while (cont.48: 387 lexer hits across 4 parses ≈ 97 each).
2. At some point lexer returns a token that doesn't fit the current state — yyerror("syntax error") fires (`0x5c507662`).
3. yyerrstatus is set to 3 (recovery mode).
4. Parser shifts error tokens until lexer returns 0 (EOF).
5. At `0x5c507681 cmp [yyerrstatus], 3 / jge 0x5c507719`, we enter the YYABORT branch: `cmp eax,0 / jz 0x5c507739` — eax==0 (EOF in error state) → push 1 / pop eax / ret.

**This invalidates the entire "shared cursor" theory** from cont.46–49. RegisterTemplates and GetNextDataObject each get a fresh parser; both fail. The bug is *one token deep into each parse*: the lexer is yielding a token sequence that's locally invalid LALR.

**cont.52 plan — instrument the lexer's first-divergence token:**

Lexer is at `0x5c506e2d`; on entry it dispatches on `[eax+8]` (mode):
- mode=0 → text-mode lexer at `0x5c506e95`
- mode=1 → binary-mode lexer at `0x5c5071bf`
- mode≥2 → return 0xFF (the parser would treat that as "unknown" → instant syntax error).

Templates magic is `xof 0303bin 0032` (binary mode); .x files are `xof 0302bin 0064` / `xof 0302txt 0064`. So mode comes from header parsing in the iterator init (`0x5c508297` and friends). If our flow leaves `[parser_ctx+8]` at the wrong value (e.g., 0 = text) while the buffer is binary-formatted, the text lexer chokes on byte 0 and emits garbage.

Probes for cont.52:
1. `--count` on `0x5c506e6f` (mode==1 dispatch), `0x5c506e75` (mode call binary lexer), `0x5c506e7d` (mode≥2 → return 0xFF), `0x5c506e95` entry (text lexer). Expectation if mode is correct: text-lexer hit count ≈ 0, binary-lexer hits = 387, mode-mismatch path = 0.
2. If 0xFF return path fires, the iterator init left mode=2+. Walk back to where `[parser_ctx+8]` is set in `0x5c508297`/`0x5c5082xx`.
3. Trace the first 5 lexer return EAX values via `--trace-at` on the post-call landing inside the parser at `0x5c5073bd` (immediately after `call 0x5c506e2d`). The very first non-0xFF token tells us if the lexer is sane on byte 0 of the buffer. A stream like `[1, 1, 1, 0]` is a normal "header / template / template / EOF" sequence; `[0xff, 0xff, ...]` or `[0]` immediately is mode-misconfigured.

**cont.52 result — both lexer modes are firing; mode dispatch is correct.**

```
0x74feee2d (lexer entry)         = 387  ✓ matches cont.48
0x74feee6f (mode==1 path)        = 291  binary
0x74feee7d (mode≥2 → 0xFF)       = 0    no mode-mismatch
0x74feee95 (text-lexer body)     = 92   text
0x74fef1bf (binary-lexer body)   = 291  binary
```

`387 − 291 − 92 = 4` accounted for by the prologue early-returns (`yyssp` pushback + EOF flag). So:
- 1× RegisterTemplates parse → 291 binary-lexer calls (templates buffer is `xof 0303bin 0032`).
- 3× GetNextDataObject parses → 92 text-lexer calls (`RO_PICK.X` / `RO_GIT.X` are `xof 0302txt 0032`).

Both modes are dispatched correctly *and* both still result in `"syntax error" + YYABORT`. So **the bug is not in mode selection**. Two independent lexers producing parse-incompatible tokens for one parser is implausible coincidence — the failure must be common to both lexers. Hypotheses to test in cont.53:

1. **Parser table corruption / mis-read.** The reduce dispatcher `jmp [0x5c507d5b+eax*4]` and the lookup tables `0x5c515308`/`0x5c515460`/`0x5c5159d8`/`0x5c5156b8` are static `.rdata`/`.text`. If our PE loader miscomputed RVA→VA for d3dxof's reloc-free `.text` tables, every parser action would be off-by-N. Probe: dump 16 bytes of each table at runtime via `--trace-at-dump` and diff vs the static PE. If they differ → PE-load bug.
2. **Both lexers share a bad post-token normalizer at `0x5c506e82` (`cmp eax, 0x37; jnz / mov [0x5c51cc30],1; xor eax,eax`).** Token 0x37 is special-cased to "set EOF flag and return 0". If our emulator's flag handling miscompiles this `cmp/jnz`, the lexer would *return EOF on every token* — but then the parser would only get 1 token before EOF and the cont.51 token counts wouldn't reach 387. So this branch is NOT the bug — falsified by cont.52 numbers themselves.
3. **`yychar` / `yystate` width mismatch.** The parser reads tokens via `[ebx*2]` indexing into yytable (cont.46 disasm: `movsx ecx, word [0x5c515460+ebx*2]`). If our 16-bit `movsx` sign-extension is buggy, large negative actions would mis-decode as huge positives, hitting "syntax error" path. Probe: hand-emulate one parse state transition by reading the tables and checking against expected Bison action.
4. **Stack-pointer drift between yacc actions.** The parser uses `[esp+0x14]` / `[esp+0x18]` / `[esp+0x1c]` as locals (cont.47-ish disasm). If a reduce action calls into `0x5c507337` (yyerror) and the call's stdcall arg-pop is wrong, ESP is corrupted on return → next lexer call returns to wrong site → garbage token stream.

cont.53 starts with hypothesis #1: dump the four parser tables at runtime and compare to a static disasm dump.

**2026-04-30 cont.53 — tables and templates buffer are pristine; hypothesis #1 falsified.**

Tooling fix (commit incidentally produced by this session): `--trace-at-dump=` and `--count=` now accept `module+0xVA` syntax, and module bases registered by lazy `LoadLibraryA` (e.g. `d3dxof.dll`) trigger a deferred re-resolve + WASM `set_bp` re-arm. Previously, module-relative specs were resolved once at startup before lazy DLL loads, leaving probes silently dangling. Edits in `test/run.js`: `traceAtDumps` keeps the original `spec` string, `deferredResolveAddrs()` re-resolves both trace-at-dump and breakpoint set, and the `LoadLibrary` yield handler re-runs deferred resolve and re-sets `set_bp`.

Probe: `--trace-at=0x74fef361 --trace-at-dump=0x74ffd308:48,0x74ffd460:48,0x74ffd9d8:48,0x74ffd6b8:48,0x74fefd5b:48` (raw runtime VAs, d3dxof base 0x74fe8000, delta 0x18ae8000). 16 hits across the 20k-batch run (the screensaver retries Load repeatedly, well beyond cont.48's 4-hit observation).

Per-hit hexdump compared with `tools/dump_va.js test/binaries/dlls/d3dxof.dll`:

| Table | Static @ origVA | Runtime @ runtimeVA | Match |
|---|---|---|---|
| `yystos` 0x5c515308 | `00 00 3d 00 00 00 29 00 2a 00 ...` | identical | ✓ |
| `yytable` 0x5c515460 | `36 01 00 00 0e 00 00 00 00 00 ...` | identical | ✓ |
| `yycheck` 0x5c5159d8 | `02 00 3d 00 01 00 01 00 ...` | identical | ✓ |
| `yydefact` 0x5c5156b8 | `16 00 50 00 01 00 4c 00 ...` | identical | ✓ |
| `yyaction-jump` 0x5c507d5b (32-bit fnptrs) | `d1 74 50 5c, 44 77 50 5c, 1a 7c 50 5c, ...` (`0x5c5074d1`, `0x5c507744`, `0x5c507c1a`...) | `d1 f4 fe 74, 44 f7 fe 74, 1a fc fe 74, ...` (`0x74fef4d1`, `0x74fef744`, `0x74fefc1a`...) | ✓ relocated by +0x18ae8000 |

All five tables byte-identical between hits 1, 2, ... (across both binary RegisterTemplates and text GetNextDataObject parse calls). **Tables are not corrupted, not misrelocated.**

Also dumped the templates buffer that d3rm passes to RegisterTemplates: static `d3drm.dll!0x647e1250` (`78 6f 66 20 30 33 30 32 62 69 6e 20 30 30 36 34 1f 00 01 00 06 00 00 00 48 65 61 64 65 72 0a 00 05 00 43 ab 82 3d da 62 cf 11 ab 39 00 20 af 71 e4 33 28 00 ...`) vs runtime `0x745fc250` — byte-identical for 64+ bytes. So the input bytes are intact end-to-end.

**Smoking gun must therefore be in parser/lexer logic execution, not data.** Remaining hypotheses (from cont.52, narrowed):
- (#3) `movsx word` sign-extension miscompile in the action/check tables. The parser's primary table read is `movsx ecx, word [0x5c515460+ebx*2]` (and similar for yycheck which has signed sentinels like 0x47, 0x47 ≥ 0 ok, but yydefact entries can be negative). If our emulator's `movsx r32, m16` implementation is broken on a specific edge (e.g. high-bit set), a single mis-extended action becomes a wild jump.
- (#4) ESP drift between yacc reduce actions. The reduce dispatcher `jmp [0x5c507d5b + eax*4]` lands on action handlers that may push/pop different counts; if stdcall arg-pop is wrong somewhere in those branches, esp drifts and the next yacc loop iteration corrupts.
- New (#5): the lexer's lookup table for keyword tokens (e.g., "template", "Header") may use an `_strcmpi`/local string-compare that we emulate incorrectly, causing every keyword to resolve to the wrong token even though the byte-stream is legal.

**cont.54 plan — instrument the actual token stream returned by the lexer:**
1. Trace EAX immediately after each lexer call. The parser body has `call 0x5c506e2d / mov [0x5c51a8d8], eax` patterns. Find the post-call landing for the *first* parse and `--trace-at` it with a small dump of `[0x5c51a8d8]` (yychar) on each hit. The first 5-10 tokens reveal whether the binary lexer is yielding the canonical X-file binary stream tokens or something divergent.
2. Compare against the canonical first-tokens of `xof 0303bin` template stream:
   - `template` keyword → token id (read from yytname symbol table; or look at d3xof's lexer string table).
   - `Header` identifier → id 0x29 typically (first non-keyword in our yystos dump shows 0x29 at offset +6, which is yacc state 6 = identifier-leaf).
   - GUID `<43AB823D-...>` → id 0x3d (= 61, matches yystos[0]=0x3d offset +2).
3. If lexer returns wrong token ids → bug is in lexer (#5). Disasm `0x5c506e2d` and trace its keyword-match path.
4. If lexer returns correct tokens → bug is in parser action — instrument the reduce dispatcher `0x74fef4ca jmp [0x74fefd5b + eax*4]` and trace EAX (rule#) and ESP each iteration. ESP drift will show as monotonic walk; correct path keeps ESP at fn-entry sp − 0x10 (parser allocates 0x10 locals).
5. Quick parallel: check our `movsx r32, m16` decoder/handler in WAT (`07-decoder.wat` for decode; `05-alu.wat` for execution). The `0F BF` opcode prefix path. A unit test could feed `[0x80 0x00]` (= -32768) through `movsx ecx, word ptr [...]` and verify ECX = 0xFFFF8000.

Tactical preference: probe (1) first — costs one trace-at + small dump; outcome bins the entire investigation.

**2026-04-30 cont.53b — DX SDK sample survey: `viewer.exe` is the minimal d3xof repro.**

Smoke-tested every exe in `test/binaries/dx-sdk/bin/` (`--max-batches=8000`, no extra args). Categorising by behaviour:

| Bucket | Samples |
|---|---|
| **d3drm Load failure (same root cause as RockRoll)** | `viewer.exe` → `MessageBox("Failed to load camera.x")` after 674 API calls + 11 batches. `bellhop.exe` stalls at 185 API calls (T1 yield=1 — likely d3rm load yield, needs follow-up). |
| Runs cleanly to batch cap | `boids`, `flip2d`, `flip3dtl`, `palette`, `wormhole`, `ddex3` (DDraw-only or D3D Immediate, no .x files). |
| Stuck in PeekMessage / Flip loop (likely DDraw vs render-loop quirks, NOT the d3xof bug) | `donut`, `donuts`, `stretch`, `tunnel`, `twist`, `globe`, `ddex1`, `ddex2`, `ddex4`, `ddex5`. |

`viewer.exe` is now the canonical d3xof repro: a self-contained DX5 SDK sample that imports `Direct3DRMCreate`, calls `IDirect3DRMMeshBuilder::Load("camera.x")`, and pops a MessageBox on failure. No screensaver scene-picker / no scene-file VFS games / no Plus!98 wrapper. cont.54+ should switch to `viewer.exe` for instrumentation — same parser bug, ~1/30 the noise. Sample command: `node test/run.js --exe=test/binaries/dx-sdk/bin/viewer.exe --max-batches=8000 --trace-at=...`.

Globe/donut/stretch failures are likely a separate bucket (DDraw flip / page-lock / vsync emulation), not relevant to the d3xof investigation. They're a useful future target but should be tracked in a separate doc.

**2026-04-30 cont.53c — viewer.exe verified as cont.54 instrumentation target.**

Tooling fix #2: lazy `LoadLibrary` was registering `moduleBases[key]` with `origBase: undefined` (the `result` from `lib/dll-loader.js#loadDll` returns only `{loadAddr, dllMain}`, not `origBase`). `resolveAddr` then computed `va - undefined + loadAddr` = NaN, hitting the silent `parseInt(s, 16) >>> 0 = 0` fallback. Fix: read PE OptionalHeader.ImageBase (offset PE+52) from `dllBytesArr` in the LoadLibrary handler before populating `moduleBases`. Now `module+0xVA` works for any DLL whether statically linked, EXE-imported, or dynamically `LoadLibraryA`'d.

Verified on viewer.exe (d3dxof base 0x9b7000, delta 0x4b7000):
```
node test/run.js --exe=test/binaries/dx-sdk/bin/viewer.exe --max-batches=8000 \
  --trace-at=d3dxof+0x5c507361 \
  --trace-at-dump=d3dxof+0x5c515308:48,d3dxof+0x5c5159d8:48,d3dxof+0x5c507d5b:48
```

Outputs:
- `[TRACE-AT #1] EIP=0x009be361` (single hit, vs. RockRoll's 16 retries) — RegisterTemplates fires once, fails, viewer pops MessageBox.
- yystos at 0x009cc308 = `00 00 3d 00 00 00 29 00 ...` ✓ static-identical
- yycheck at 0x009cc9d8 = `02 00 3d 00 01 00 ...` ✓ static-identical
- yyaction-jump at 0x009bed5b: pointers correctly relocated by +0x4b7000 (e.g. `0x5c5074d1 → 0x009be4d1`).

So same cont.53 finding holds across two completely different load addresses (delta 0x18ae8000 in RockRoll vs delta 0x4b7000 in viewer). **Confirms tables/templates buffer aren't position-dependent corruption.** The bug is in parser logic, deterministic regardless of load base.

cont.54 will use `viewer.exe`. Single parse, 1 RegisterTemplates call, no D3DRMCreate scene-walker noise — strict superset: any failure-mode found here also explains RockRoll/Geometry/Jazz/etc.

**2026-04-30 cont.54 — lexer is correct; parser hits YYABORT via state-stack underflow without ever calling yyerror.**

Tooling: extended deferred-resolve to also re-arm `set_count` after lazy LoadLibrary (previously `module+0xVA` count probes silently logged 0 because count addrs were sent to WASM at batch=0 with NaN→0). Now `--count=d3dxof+0xVA` works.

**Lexer-mode labels in cont.48/52 were swapped.** d3xof's header parser at `0x5c508145..0x5c508189` shows: `txt ` → mode=1 (edi), `bin ` → mode=0 (ebx). And the lexer dispatch at `0x5c506e60`: `mov ecx, [eax+8]; jz call 0x5c506e95; cmp ecx, 1; jnz call 0x5c5071bf`. So **`0x5c506e95` is the BINARY-lexer** (mode=0), **`0x5c5071bf` is TEXT-lexer** (mode=1) — opposite of what cont.48 documented. All prior counts and language about "291 binary-lexer / 92 text-lexer" should have their labels flipped.

**Viewer parse profile** (1× RegisterTemplates on the binary-format templates buffer `xof 0302bin 0064`):

| Probe | Hits | Meaning |
|---|---|---|
| Lexer entry `0x5c506e2d` | 93 | total lexer calls |
| Binary-lexer body `0x5c506e95` | 92 | all main tokens via correct mode |
| Text-lexer body `0x5c5071bf` | 0 | mode dispatch correct |
| Mode≥2 path `0x5c506e7d` | 0 | no mode mismatch |
| Parser entry `0x5c507361` | 1 | one parse call |
| YYABORT epilogue `0x5c507739` | 1 | parser returns 1 |
| `yyerror("syntax error")` call `0x5c507667` | 0 | **never called** |
| `mov [cc34], 1` setter callers (12 sites) | 0 each | parser actions never set the lexer pushback flag |

`--trace-at` on the parser's post-lexer-call landing `0x5c5073bd` captured 93 token returns; the first 30 are textbook canonical X-file binary token IDs:

```
#1 EAX=0x1f (TOKEN_TEMPLATE)         #2 EAX=0x01 (TOKEN_NAME, ECX=6 → "Header")
#3 EAX=0x0a (TOKEN_OBRACE {)         #4 EAX=0x05 (TOKEN_GUID — 16 bytes follow)
#5 EAX=0x28 (TOKEN_WORD)             #6 EAX=0x01 (NAME, ECX=5 → "major")
#7 EAX=0x14 (TOKEN_SEMICOLON ;)      #8 EAX=0x28 (WORD)
...                                  #92 EAX=0x14 (SEMI)
#93 EAX=0xff (lexer "stop" sentinel)
```

The byte stream walked correctly through the templates buffer (EDX cursor monotonically advanced from 0x47d262 to 0x47d47d across hits #1..#92). **The lexer is fine.**

**YYABORT predecessor.** `--break=d3dxof+0x5c507739 --break-once` reports `dbg_prev_eip=0x009be6bf` = `d3dxof+0x5c5076bf`:

```
5c5076bf  cmp esi, 0x5c51a8e0   ; esi = yyssp; 0x5c51a8e0 = yyssa base
5c5076c5  jbe 0x5c507739        ; if yyssp ≤ base → YYABORT (state stack empty)
```

At the abort: `EBX=0x28 ESI=0x009d18e0 (= runtime base of yyssa, exactly empty) EDI=0x18e (yystos size 398)`. So parser drained the state stack down to base while in the error-recovery loop at `0x5c50769e`. Recovery loop fired **6 iterations** (count of `0x5c50769e`), with state-stack-empty fallthrough hit **7 times** (0x5c5076bf).

**The puzzle:** recovery loop ran but `yyerror` was never called. Normal Bison flow is `[error detected] → call yyerror → set yyerrstatus=3 → enter recovery loop → pop until shift-on-error available → if empty, YYABORT`. Here `yyerror=0` hits. Either:
- (a) An action handler explicitly invoked `YYERROR` macro (jumps to recovery without yyerror) — common in Bison %destructor / mid-rule actions.
- (b) A reduce action returned an error code that the parser body translates into "go to recovery loop" via a non-yyerror path.
- (c) Count probe at 0x5c507667 is unreliable (it's mid-block; cont.49 already noted counts only fire on canonical block entries) and yyerror actually DID fire. To verify, `--break=d3dxof+0x5c507667 --break-once` would be definitive.

Token #92's normal NAME→SEMI sequence (decoded as `<TYPE> <name>;` field declaration) suggests the parser was mid-way through a template body. The state value `EBX=0x28` at YYABORT entry matches state values seen mid-stream during normal parsing. So abort happened in a "field-list closed, expecting `}` or another field" boundary — likely after a reduce action triggered YYERROR.

**cont.55 plan:**
1. **Verify yyerror reachability** with `--break=d3dxof+0x5c507667 --break-once`. If it does fire, count probes simply lied (mid-block); if it doesn't, hypothesis (a) or (b) is right.
2. **Find the YYERROR-jumping reduce action.** Bison `YYERROR` typically expands to `goto yyerrlab1`. Search d3xof.text for branches into the recovery loop entry block (0x5c50768d..0x5c50769e). Each such branch is a candidate action site; hit-count them.
3. **Once the triggering action is found**, disasm it to see what condition tripped (likely a string-table lookup, a heap-alloc, or a sub-parser call returning failure).
4. **Cross-check via the templates buffer offset**. EDX at #92 = 0x47d47d (cursor right after "minor" field's SEMI). Decode the next bytes (0x47d47d onwards) to know what the parser was about to consume; the failing reduce action operates on the LAST token (SEMI at #92) and the prior names — likely `Header` template's last field reduces a "field declaration" into a "field list", and that reduce action validates the field type-name against an internal type-id table. If the type lookup fails (e.g. "BYTE" not in d3xof's static type-id map), action triggers YYERROR.

Tactical: probe (1) costs nothing and bins the rest of the investigation. Run it first.

**2026-04-30 cont.54b — yyerror probe + recovery-loop ingress: counts unreliable, bp shows execution touches post-yyerror landing.**

Probe results:

| Probe | Method | Result |
|---|---|---|
| `--break=d3dxof+0x5c507667 --break-once` (yyerror call site) | bp | **never fires** — but bp lands on instruction boundary, may have mid-block-cache issue. |
| `--break=d3dxof+0x5c50765b --break-once` (syntax-error block start: `cmp eax, [yyerrstatus]`) | bp | **never fires** |
| `--break=d3dxof+0x5c50768d --break-once` (post-yyerror, `mov esi, [yyssp]`) | bp | **fires** — `dbg_prev_eip=0x009be66c` = `d3dxof+0x5c50766c` (right after yyerror call). |
| `--trace-at=d3dxof+0x5c50769e` (recovery loop body) | trace | 6 hits with EBX=0x28, ESI walking down 0x009d18ea→0x009d18e0 (5 stack levels → empty). |

**Contradiction.** Recovery-loop and post-yyerror landing are reached, but `0x5c50765b`/`0x5c507667` (the only static path to `0x5c50766c`) never break. Either:
- The execution path reaches 0x5c50768d via some other route I haven't mapped (no static xrefs found by `tools/find-refs.js` to 0x5c50766c, 0x5c50767e, 0x5c50765b — but find-refs.js searches absolute literals + Jcc rel32; if a path uses computed jump or fall-through from a block whose entry I haven't probed, refs would miss it).
- OR the WASM block-cache has fused 0x5c50765b..0x5c50768d into one block, the bp at 0x5c50765b never fires because the bp check happens at block-entry only, and the block actually starts somewhere else (e.g. 0x5c507650 where `mov eax, [yyerrstatus]` looks like a multi-pred join). Need to probe 0x5c507650 (the literal byte sequence preceding 0x5c50765b in our disasm — but that disasm garbage-decoded since 0x5c507650 is actually data/padding from the previous fn).

**Status snapshot (cont.50→cont.54b):**
- d3xof RegisterTemplates parses the binary templates buffer (`xof 0302bin 0064`) using the correct binary-lexer (mode=0). 92 valid X-file binary tokens flow through the lexer.
- Tables (yystos/yytable/yycheck/yydefact/yyaction-jump) and templates buffer are **byte-identical** to static PE; correctly relocated regardless of load base (verified at deltas 0x18ae8000 and 0x4b7000).
- Parser exits via YYABORT at 0x5c507739 (state-stack underflow at 0x5c5076c5) after recovery loop pops the state stack 6 times to empty.
- yyerror call at 0x5c507667 unconfirmed (bp didn't fire, but post-call landing is reached) — may be count/bp probe limitation on mid-block instructions.

**Confirmed tooling fixes shipped:**
- `--trace-at-dump=` now accepts `module+0xVA` (was: addr-only).
- `--count=` and `--break=` now re-resolve module bases when DLLs are lazily LoadLibrary'd. Previously, `module+0xVA` specs registered before the lazy-load silently logged 0.
- LoadLibrary path now reads PE ImageBase from DLL bytes to populate `moduleBases[name].origBase` (was undefined → resolveAddr returned NaN).
- After deferred resolve, `set_bp(traceAtAddr)` and `set_count(i, ...)` are re-armed inside the LoadLibrary handler so probes light up immediately on the first execution after the DLL is mapped.

**cont.55 plan (revised):** the count/bp instability around mid-block addresses is now the dominant source of confusion. Rather than chasing yyerror reachability further:
1. Add a `--trace-eip-range=LO-HI` flag that logs every EIP in the range during one batch — gives a deterministic list of executed instructions in the parser-error region without bp-cache caveats.
2. Walk the executed-EIP set against the disasm to deterministically map the path `<some action> → recovery loop → YYABORT`.
3. With the path known, identify the YYERROR-jumping action and inspect what it tested.

Alt: run viewer under a debugger that fully supports per-instruction stepping (extend `--trace-host` or write a Mini-step helper). For now, the cleanest path is the EIP-range trace.

**2026-04-30 cont.55 — `--trace-eip-range` shipped; closes the yyerror-reachability puzzle.**

New flag `--trace-eip-range=LO-HI` (`module+0xVA-module+0xVA` works) logs every block-entry EIP inside the range. Module-relative ranges arm only after deferred resolve so pre-LoadLibrary batches don't fire on a 0/0 match-all range. Verification on viewer.exe parser-error region (`d3dxof+0x5c507650-d3dxof+0x5c507760`):

| d3dxof VA | Hits | Decoded |
|---|---:|---|
| 0x5c50765a | 1 | error block start: `cmp [yyerrstatus], 0` |
| 0x5c507660 | (jnz)|  → 0x5c50767e if already in error mode |
| 0x5c507662 | 1 | `push "syntax error"` |
| 0x5c507667 | (mid-block) | `call yyerror` |
| 0x5c50766c | 1 | post-yyerror: `inc yynerrs` |
| 0x5c50768d | 1 | `mov esi, [yyssp]` (yyerrlab1 init) |
| 0x5c50769e | 6 | `movsx eax, word [esi]` — state-stack pop loop body |
| 0x5c5076ad/b1/b5 | 7/7/3 | yytable[state+YYERROR] checks |
| 0x5c5076bf | 7 | `cmp esi, yyssa; jbe → YYABORT` |
| 0x5c5076c7 | 6 | pop one state (`dec esi; dec esi; sub edx, 0x10`) |
| 0x5c507705 | 151 | (NOT error-path — `jmp` target from 0x5c507655 = generic reduce-resume; fires per shift/reduce) |
| 0x5c507739 | 1 | YYABORT epilogue ✓ |

**Resolved the cont.54b contradiction.** `0x5c50765a` and `0x5c50766c` *do* fire — exactly once each. The hypothesis that yyerror is never called was wrong; it was bp/count probe limitations on mid-block addresses (block-cache fusion), exactly as cont.54b suspected. So flow is **standard Bison**:

```
parse-error detected → yyerror("syntax error") → yyerrstatus=3 → recovery loop pops 6 states → state stack hits yyssa → YYABORT
```

Hypothesis (a) (action invokes YYERROR macro skipping yyerror) and (b) are dropped. The remaining puzzle is **why the parser detected a syntax error in the first place** — i.e. which (state, lookahead) pair has no shift/reduce action in `yytable`.

**cont.56 plan:**
1. Identify the parser entry point that detects "no action available" → goto syntax-error block. From the disasm, the only static jmp/jcc into 0x5c50765a's *block* (the error label) is from another place in yyparse. Run `tools/xrefs.js d3dxof.dll 0x5c50765a` (got 0 — so it's reached by a jmp/jcc whose target is *some address in this block, not necessarily 0x5c50765a*; look for branches to 0x5c507655 (the preceding `jmp 0x5c507705`) — that's the static jmp that flows into 0x5c50765a as fallthrough? No — 0x5c507655 is `jmp 0x5c507705`, unconditional, so 0x5c50765a is dead unless reached by another jmp). Need `tools/xrefs.js` for 0x5c50765a..0x5c50765c range — caller is presumably the action-table-lookup default-case in yyparse.
2. Once the entry to the error block is found, instrument the (state, token) pair right before — that pair is what's missing from yytable. Cross with x-file grammar to decide: missing token, missing rule, or pre-error grammar mistake (e.g. a TYPE token mis-classified by lexer).

**cont.55b — failing (state, token) captured: state=0x28, token=0xff.**

`tools/find-refs.js d3dxof.dll 0x5c50765a` finds 4 conditional jumps to yyerrlab, all from the action-table dispatch at 0x5c50745a..0x5c507486:

```
5c507455  mov edi, 0x18e               ; YYLAST
5c50745a  movsx ecx, word [yypact+ebx*2]   ; ecx = yypact[state]
5c507462  cmp ecx, ebp                 ; vs YYPACT_NINF (=0)
5c507464  jz  yyerrlab                 ; (1) state has no action
5c50746a  add ecx, eax                 ; ecx += token
5c50746c  js  yyerrlab                 ; (2) signed-neg out-of-bounds
5c507472  cmp ecx, edi
5c507474  jg  yyerrlab                 ; (3) past YYLAST
5c50747a  movsx esi, word [yycheck+ecx*2]
5c507484  cmp esi, eax
5c507486  jnz yyerrlab                 ; (4) yycheck mismatch
5c50748c  movsx ecx, word [yytable+ecx*2]   ; valid action
```

`--trace-at=d3dxof+0x5c50745a` (7 hits before error path takes over):

| Hit | EBX (state) | EAX (token) |
|---:|---|---|
| 1–6 | 0x28 | 0x0b |
| **7** | **0x28** | **0xff** |

State 0x28 = 40 (mid-template, inside field-list). After hit #7, EIP leaves d3dxof; the next trace returns to viewer.exe at 0x04200358 — that's MessageBoxA / parser-failed return path. So the failing dispatch is **(state=0x28, token=0xff)**.

Token id 0xff is YYUNDEFTOK-shaped. Hypothesis: d3xof's binary lexer returns 0xff for an X-file binary token-tag it doesn't recognise. Six valid tokens of type 0x0b shifted in (likely INTEGER_LIST values inside Header template body), then a binary tag arrives that the binary lexer (mode=0) fails to map and emits 0xff.

**cont.56 plan:**
1. Read d3xof's binary lexer (mode=0, entry at 0x5c506e95) and find where it emits token 0xff. The X-file binary tokens are 16-bit tags 0x0001..0x000a: NAME, STRING, INTEGER, GUID, INTEGER_LIST, FLOAT_LIST, OBRACE, CBRACE, OPAREN, CPAREN. Anything outside that range or any TOKEN_RESERVED_ID (0x0010-0x001b for keywords like `template`, `array`) that the binary lexer doesn't handle → 0xff fallback.
2. Capture the actual byte sequence in the templates buffer at the point of error (cont.54 noted EDX=cursor at 0x47d47d). Decode the next 1-2 16-bit tags to know which tag value the binary lexer choked on. That tag value is either (a) a legal binary tag that d3xof's lexer mishandles, (b) garbage from a misalignment caused by an earlier mis-decode, or (c) end-of-buffer sentinel that should be EOF/0 but lexer returns 0xff.

**cont.56 — root cause: token 0xff is a *synthetic EOF*, not a lexer-of-bytestream emit.**

The hypothesis above (cont.55b) was wrong. The 0xff doesn't come from the binary lexer at 0x5c506e95 returning an unrecognized tag — that lexer is fine. The actual `yylex` called by `yyparse` is a *one-line wrapper* at 0x5c506e2d:

```
5c506e2d  push edi
5c506e2e  xor edi, edi
5c506e30  cmp [0x5c51cc34], edi      ; check global "force-EOF" flag
5c506e36  jz  0x5c506e45              ; flag clear → call real lexer (0x5c506e95)
5c506e38  mov [0x5c51cc34], edi      ; clear flag
5c506e3e  mov eax, 0xff              ; ← synthetic EOF token
5c506e43  pop edi
5c506e44  ret
```

When global flag `[0x5c51cc34]` is non-zero, yylex bypasses the underlying lexer and returns 0xff. So 0xff is the grammar's `YYEOF` (end-of-stream), and it's *triggered by a parser semantic action*, not by the byte-tag stream.

12 callsites set this flag (call 0x5c507356 = `mov [0x5c51cc34], 1; ret`). `--count` over all 12 (max 16 fits) shows exactly **one** fires before failure: `d3dxof+0x5c507bf4` (count=1). Surrounding code:

```
5c507bdc  push ebp                     ; arg3 = NULL (ebp=0 in yyparse)
5c507bdd  push [edx-0x10]              ; arg2 = yyvsp[-1] (a name?)
5c507be0  push [edx-0x20]              ; arg1 = yyvsp[-2] (a type/scope?)
5c507be3  call 0x5c50a1d6              ; lookup(arg1, arg2, NULL)
5c507be8  add esp, 0xc
5c507beb  cmp eax, ebp                 ; eax vs 0
5c507bed  mov [0x5c51cc08], eax        ; stash result globally
5c507bf2  jnz 0x5c507bf9               ; eax != 0 → skip
5c507bf4  call 0x5c507356              ; ★ FAILED LOOKUP → set force-EOF
```

So the real failure: a Bison reduce-action does a name/template lookup via `0x5c50a1d6(name1, name2, NULL)`; it returns 0; the action signals "abort parse via synthetic EOF". The next yylex returns 0xff; state 0x28 has no action for token 0xff → yyerror → YYABORT → "Failed to load camera.x".

**cont.57 plan:**
1. Disassemble `0x5c50a1d6` to identify what kind of lookup it does (template-name registry? GUID resolution? typename hash?).
2. Capture the args (arg1, arg2) at the failing call. They're `[edx-0x10]` and `[edx-0x20]` where edx is the Bison value-stack pointer. Decode them — if they're string pointers, dump the strings; if structs, dump fields.
3. The lookup target is presumably a name that should resolve in a clean d3dxof. Three candidates for why it doesn't:
   - **Template not registered**: d3dxof bootstraps with built-in templates (Header, Frame, Mesh, MeshNormals, etc). If our DLL load skipped a registration step, lookup of e.g. "Header" misses. Check whether d3dxof's DllMain or first-call init runs all the `RegisterTemplates` calls.
   - **Earlier corruption**: name string was written wrong by a prior lexer step (e.g. STRING/NAME tag handler ran on bad bytes due to misalignment).
   - **Memory aliasing**: `0x5c51cc08`/`0x5c51cc20` (registry/value-stack pointers) collide in our emu's memory model.
4. The state-0x28 + 6×token-0x0b stream from cont.55b still tells us what *was* parsed up to the failure: a Header-template-shaped field list. Cross-checking, this is exactly the X-file initial Header object preamble: 6 INTEGER fields. The reduce-action firing right after is "look up template by name / declare instance" — and *that's* where the name-resolve fails.

**cont.57 — confirmed: template registry is uninitialized at runtime.**

Disassembled `0x5c50a1d6` (the lookup at the failing reduce-action). It's a two-tier lookup:

```
0x5c50a1d6:  push [ebp+0x8]                    ; name
             call 0x5c50800b                   ; tier-1: built-in PRIMITIVE TYPES
             test esi,esi; jz tier2
             ; tier-1 hit → wrap with primitive metadata, return
tier2:       lea eax, [ebp-0x4]; push eax
             push [ebp+0x8]                    ; name
             call 0x5c50a0f0                   ; tier-2: REGISTERED TEMPLATES
             test eax,eax; jz fail
             ; tier-2 hit → wrap with template metadata, return
fail:        xor eax, eax; ret                 ; ← caller sets force-EOF
```

**Tier-1** (`0x5c50800b`) scans a 13-entry static table at `0x5c5016f8..0x5c501794` of built-in *primitive type* names: WORD, DWORD, FLOAT, DOUBLE, CHAR, UCHAR, BYTE-alias, SWORD, SDWORD, STRING, CSTRING, UNICODE, ULONGLONG. These are the X-file scalar types — not the templates.

**Tier-2** (`0x5c50a0f0`) scans the runtime-allocated *template registry* at `[0x5c51cc3c]`. Each entry has a 16-byte GUID at +8 and a name pointer at +4.

`[0x5c51cc3c]` is initialized empty (count=0, capacity=100, items_ptr=NULL) by `0x5c50a090`. New entries are added via `0x5c507ebd` (vector::push_back) wrapped by `0x5c50a0df`. There are zero internal callers of `0x5c50a0df` — it must be reached via an exported entry point (likely `IDirectXFile::RegisterTemplates`).

**Runtime check at the failing call:** `--break=d3dxof+0x5c507bf4 --break-once`, then dump `0x009d3c3c:16` (= `d3dxof+0x5c51cc3c` at runtime base 0x009b8000):

```
0x009d3c3c  00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
```

The registry pointer itself is **NULL** — `0x5c50a090` was never called. Combined with tier-1 missing because the looked-up name isn't a primitive (it's a template name like "Header" or "Camera"), the reduce-action returns 0 every time → EOF flag → 0xff → yyerror.

**cont.58 plan — root cause is a missing `RegisterTemplates` step.**

The standard D3DRM template buffer (`D3DRM_XTEMPLATES`, ~3290 bytes binary blob) ships embedded in d3drm.dll. Apps using D3DRM call `Direct3DRMCreate` which internally creates an IDirectXFile, calls `IDirectXFile::RegisterTemplates(D3DRM_XTEMPLATES, ...)` to populate the registry, then `CreateEnumObject(camera.x)`.

For viewer.exe:
1. Verify viewer.exe (or d3drm) calls `IDirectXFile::RegisterTemplates`. Trace its imports and look for the call. d3dxof.dll exports: `DirectXFileCreate` (the only entry that creates IDirectXFile). `IDirectXFile` vtable exposes `RegisterTemplates` at slot 3.
2. If the call IS made, find which path in our emu drops it. Possible: (a) `DirectXFileCreate` returns wrong vtable, (b) the vtable's `RegisterTemplates` slot is null/stub, (c) the call runs but `RegisterTemplates` internal goes through a path our emu mishandles (e.g. it may itself parse the template buffer using the same parser, hitting the same EOF flag bug).
3. If the call is NOT made, the X-file we feed has to define its own templates inline. camera.x typically does NOT — it just references built-ins. So the call should be there.
4. Quickest probe: `--trace-api=DirectXFileCreate` plus `--trace-host=` for the COM dispatch on its returned vtable. Or `--break=d3dxof+0x5c50a090` to see if registry-init ever fires.

**cont.58 — confirmed root cause: d3dxof DllMain never ran in our emu.**

The registry init function `0x5c50a090` is called from exactly one site: `d3dxof+0x5c504b9e`, inside the DLL's `DllMain` (entry `0x5c504b7b`). The DllMain flow:

```
0x5c504b80  call ???               ; first-time init guard
0x5c504b85  jnz tail (no init)
0x5c504b87  call 0x5c504bba        ; setup
0x5c504b8c  call 0x5c50aedb        ; ?
0x5c504b91  test eax, eax
0x5c504b93  jnz init_registry      ; ★ branch to registry-init
0x5c504b95  call 0x5c504c3b        ; failure path
0x5c504b9a  xor eax, eax; jmp tail
0x5c504b9e  call 0x5c50a090        ; ★ ALLOCATE REGISTRY
0x5c504ba3  jmp tail
```

`--count` over every node in this flow returns **0 hits across the board** — the entire DllMain never executed. Yet other d3dxof code clearly runs (the parser, `0x5c50a0df` RegisterTemplate-add fires 6 times, `0x5c507ebd` push_back fires 24 times). So d3dxof was *loaded* but its `DllMain(DLL_PROCESS_ATTACH)` was *not invoked*, leaving:

- `[0x5c51cc3c]` (template registry pointer): NULL
- `[0x5c51cc34]` (parser force-EOF flag): zero (lucky — non-zero would force failure even earlier)
- All other DllMain side-effects: skipped

When d3drm later calls `IDirectXFile::RegisterTemplates`, the d3dxof impl chain reaches `0x5c50a0df`, which does `mov ecx, [0x5c51cc3c]` (= 0) and passes NULL as `this` to `vector::push_back` (`0x5c507ebd`). push_back then writes through `[NULL+offset]` — in our flat WASM memory this maps to an arbitrary low-VA region (≈ guest VA 0..0x40), corrupting whatever lives there but not crashing. So 6 templates' worth of "registration" lands in nothing.

**Loading path observation:** viewer.exe imports only d3drm.dll (no static d3dxof). d3drm dynamically loads d3dxof via `LoadLibraryA("d3dxof")` at `d3drm+0x647d0a90` (helper `0x647d0a8b`), then `GetProcAddress(hMod, "DirectXFileCreate")`. Our `LoadLibraryA` host import in `lib/host-imports.js` is supposed to invoke the DLL's `DllMain` after loading; for d3dxof specifically that step is dropping. The `IDirect3DRMMeshBuilder::Load` path that *would* call RegisterTemplates+CreateEnumObject (entry `0x647ce300` / `0x647d16cd`) is not even hit — instead d3drm appears to use a leaner direct path that skips RegisterTemplates entirely (also a problem, but downstream of the DllMain miss).

**cont.59 plan — make d3dxof's DllMain run:**

1. Find d3dxof's DllMain VA via PE header (`AddressOfEntryPoint`) and confirm it equals `0x5c504b7b - 0x5c500000 = 0x4b7b` RVA.
2. Inspect `lib/dll-loader.js` — the relocation/import/DllMain-call sequence. Verify whether (a) DllMain is being invoked but trapping early, (b) the call is being skipped for d3dxof specifically (e.g. version filter, unrecognized init API), (c) the call is being scheduled but never reached because of an async/yield path that drops it.
3. Add a one-shot `--count=d3dxof+0x5c504b7b` to whatever step in our DLL loader is supposed to invoke DllMain — see if EIP ever even tries to enter this VA.
4. If DllMain entry is being called but returns early, the conditional at `0x5c504b85` (`jnz tail`) is the most likely cause — that test depends on a host import (`call 0xa471bf85` is bogus disasm; the real target is whatever the IAT thunk at `0x5c504b80+1` resolves to). A failed Win32 API early in DllMain (e.g. `InitializeCriticalSection`, `TlsAlloc`) would gate the rest off.

Once DllMain runs, `0x5c50a090` will allocate the registry, RegisterTemplates will populate it correctly, and the parser at `d3dxof+0x5c507bf4` will resolve "Header"/"Camera"/etc instead of force-EOF'ing.

**cont.59 — fixed: dynamic LoadLibraryA was skipping DllMain.**

Root cause was `test/run.js` line 2300 — the `callDllMain` invocation in the LoadLibraryA yield handler was commented out with the note "Plugin DLLs don't need complex init". d3dxof emphatically *does* need it: registry init lives in DllMain. Fix is a one-line uncomment; no API surface changes.

Verification on viewer.exe (post-fix):

```
[LoadLibrary] d3dxof.dll loaded at 0x9b7000, dllMain=0x9c2040
Calling DllMain at 0x9c2040...
DllMain returned, EAX=0x1
```

`--count` over the previously-zero registry-init flow:
- `d3dxof+0x5c504b7b` (DllMain entry): **1**
- `d3dxof+0x5c50a090` (registry allocator): **1**
- `d3dxof+0x5c50a0df` (RegisterTemplate-add helper): **35** (was 6 — D3DRM_XTEMPLATES populates the registry now)
- `d3dxof+0x5c507ebd` (vector::push_back): **129** (was 24)

The original parser-dispatch failure region (`d3dxof+0x5c507650-d3dxof+0x5c507760`) no longer fires at all — the state-0x28 + token-0xff dispatch trap is gone. camera.x is opened (CreateFileA #340), memory-mapped, parsed, and *cleanly released* (UnmapViewOfFile #3193) before viewer reaches its error path. We went from 674 API calls / 11 batches to ~3206 / parser-success-then-downstream-fail.

**cont.60 — new failure: "Failed to load camera.x.\n(null)\n" downstream of parser.**

After cont.59, viewer.exe still pops the Load failure dialog, but the failure is now after a successful X-file parse:

```
[API #3193] UnmapViewOfFile(0x00ddc344)
[API #3194] CloseHandle(0xfb000001)
[API #3195] CloseHandle(0x70000002)
... (heap teardown) ...
[API #3204] wvsprintfA(buf, fmt, args)
[API #3205] lstrcatA(dst="Failed to load camera.x.\n(null)", src="\n")
[API #3206] MessageBoxA(...)
```

The `(null)` substitution means viewer's error-formatting path got a NULL string for the HRESULT description (likely `D3DRMErrorToString(hr)` for an unrecognized HRESULT). So `IDirect3DRMMeshBuilder::Load` returns a non-zero HRESULT that viewer doesn't have a string for — meaning *either* the Load itself failed at a later stage (after parse completed), *or* the parse succeeded but produced no usable mesh data.

`dbg_prev_eip=0x00401049` is viewer.exe's lstrcatA call site; the failing HRESULT is at `[esp+0x3fffe74 - 0x3fffd44] = [esp+0x130]` of the failure frame. To find the real root cause, the next step is:

1. Trace `IDirect3DRMMeshBuilder::Load` return value — set a break-once on the call site (caller is in viewer.exe near `0x40102d-0x401049`) and capture EAX at return.
2. If HR is non-zero, walk back into d3drm to find which sub-step set it. Likely candidates: `IDirectXFileEnumObject::GetNextDataObject` (returns DXFILE_E_NOMOREOBJECTS if registry mismatched, or a parser-side error code if a Frame/Mesh template field is misnamed), or the d3drm-internal "build mesh from data object" reduce action.
3. Verify `0x009d3c3c` (registry pointer) is **non-NULL** at the point the Load is invoked — confirms RegisterTemplates actually wired the registry into the singleton DLL state, not just into a transient allocation.
