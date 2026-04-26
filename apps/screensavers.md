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

**Next concrete action:** the question is now "where, in the SCR's guest code, is the call to `IDirect3DRMFrame::AddLight` that should fire and isn't?" Two probe paths:
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
