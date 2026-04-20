# DirectX support — design sketch

Scope: just enough DirectX 3/5-era surface for the one real DirectX app in our test set (Plus! 98 `MARBLES.EXE` — *Lose Your Marbles*), with hooks for future apps. Reusable for any app that touches `DDRAW.dll`, `DSOUND.dll`, or `DINPUT.dll`.

This is **not** a plan to implement Direct3D, DirectMusic, DirectPlay, DirectShow, or any post-DX7 API. Those are large, tied to hardware features we don't have, and no binary in our test set needs them.

## What we actually need to run (by binary)

| Binary                          | DDRAW | DSOUND | DINPUT | Notes                                                    |
|---------------------------------|:-----:|:------:|:------:|----------------------------------------------------------|
| `plus98/MARBLES.EXE`            |  ✔   |   ✔   |   ✔   | Classic DX3-era layout; legacy creators; single-screen 2D. Runs past title screen (2026-04-15); palette may still be off. |
| `screensavers/*.SCR` (7 DX ones)|  ✔   |   —   |   —   | ARCHITEC, FALLINGL, GEOMETRY, JAZZ, OASAVER, ROCKROLL, SCIFI — all use DDraw primary-surface + D3DRM. Window created; needs D3DRM (see `d3drm.md`) to render. |
| `shareware/abe/ex/AbeDemo.exe`  |  ✔   |   ✔   |   —   | Abe's Oddysee demo. DX3/5-era 2D; sprite game. Not yet smoke-tested. |
| `shareware/aoe/aoe_ex/Empires.exe` |  ✔ |   ✔   |   —   | Age of Empires 1 demo. 2D isometric; DDraw primary only. |
| `shareware/aoe2/aoe2_ex/EMPIRES2.EXE` | ✔ |  ✔   |   —   | Age of Empires 2 demo. Larger/heavier than AoE1. |
| `shareware/mcm/mcm_ex/MCM.EXE`  |  ✔   |   ✔   |   —   | Motocross Madness. Needs **d3drm.dll** + D3D IM (see `direct3d-im.md`). |
| `shareware/mw3/.../mech3demo.exe` |  ✔ |   ✔   |   ✔   | MechWarrior 3 demo. Pure D3D IM (no d3drm). See `direct3d-im.md`. |
| `shareware/rct/English/RCT.exe` |  —   |   ✔   |   ✔   | RollerCoaster Tycoon. No DDraw (its own GDI blitter); needs DSOUND+DINPUT. |
| `wep32-community/TWorld`        |  —   |   —   |   —   | Uses `SDL.dll`, but this build of SDL is a **GDI+WinMM** backend (verified: `SDL.dll` imports are kernel32/gdi32/user32/winmm/msvcrt/advapi32 — no DX). TWorld is not actually a DirectX app in our build. |

So the entire initial implementation is driven by one EXE and three `Create*` entry points:

```
DDRAW.DirectDrawCreate(lpGUID, lplpDD, pUnkOuter) -> HRESULT
DSOUND.DirectSoundCreate  (ordinal 1, same signature)
DINPUT.DirectInputCreateA (hInstance, dwVersion, lplpDI, pUnkOuter) -> HRESULT
```

Once those succeed, everything else is **COM vtable dispatch** against the returned `IDirectDraw`, `IDirectSound`, `IDirectInput` objects (and the subsidiary `IDirectDrawSurface`, `IDirectSoundBuffer`, `IDirectInputDevice` objects they vend).

## The central problem: COM vtable dispatch

The three creator entry points are trivial — they exist purely to hand back an interface pointer. All the real work happens when the guest does:

```c
lpDD->lpVtbl->SetCooperativeLevel(lpDD, hwnd, DDSCL_NORMAL);
```

which compiles (roughly) to:
```asm
mov eax, [lpDD]            ; eax = lpVtbl
push DDSCL_NORMAL
push hwnd
push lpDD                  ; "this"
call [eax + 0x50]          ; vtbl slot = SetCooperativeLevel
```

For this to work we must control **where those function pointers land**. The guest will dereference them and CALL them, so they need to be addresses that the emulator can recognise and route back into WAT handlers.

We already have exactly this infrastructure for Win32 DLL imports: the PE loader fills the IAT with addresses in `THUNK_BASE`, and when EIP enters that zone `$win32_dispatch` looks up the corresponding api_id. The plan is to reuse it for COM methods.

### Fake objects and fake vtables live in guest heap

On `DirectDrawCreate`, the handler:

1. Allocates a guest-memory block for the `IDirectDraw` struct. Only field we care about is `[0] = lpVtbl`.
2. Either allocates or returns a **shared** vtable block (one per interface type — not per instance, since all `IDirectDraw` objects share the same vtable).
3. Writes the guest pointer into `*lplpDD` and returns `DD_OK` (0).

The vtable block is an array of **thunk addresses** — one per method. These addresses live in the existing `THUNK_BASE` zone, allocated during wine-assembly startup, one thunk per `(interface, method)` pair we care about. The thunks are populated by a new init routine (`$init_com_thunks`) that runs once, at module load, before any guest code executes.

### Dispatcher extension

`$win32_dispatch` already resolves `eip → api_id → handler`. For COM we extend the mapping:

```
thunk_addr -> com_api_id (e.g. 2048 + interface_id*32 + method_index)
com_api_id -> $handle_DDraw_SetCooperativeLevel (etc.)
```

The cleanest way is to give COM methods regular entries in `api_table.json` (e.g. `IDirectDraw_SetCooperativeLevel`) and reuse the existing dispatch table generator. They then appear in `09b2-dispatch-table.generated.wat` like any other API. The only new thing is `$init_com_thunks`, which walks a small static table `(interface_id, method_slot, api_id)` and populates the shared vtable blocks.

### Why not implement the vtable in JS?

Because then every DirectDraw call would trap to JS, which is ~100× slower than a WAT handler. The only reason we'd trap to JS is for the *backend* work (pushing pixels to canvas, scheduling audio), and those are already host imports. The dispatching itself stays in WAT.

## Memory map additions

```
0x0000AD80  256B  DX_OBJECTS        (same region as MCI_DEVICES; pick the next free block)
                                    32 entries × 8 bytes
                                     +0  u32  iface_id (0=free, 1=IDDraw, 2=IDDrawSurface, ...)
                                     +4  u32  backend_id (opaque host id — canvas layer, sound voice, etc.)

0x00xxxxxx  N·4B  DX_VTABLES        one shared vtable per interface, allocated in guest heap at init:
                                     IDirectDraw vtbl:        27 entries (IDirectDraw1 method count)
                                     IDirectDrawSurface vtbl: 34 entries
                                     IDirectDraw2 vtbl:       28 entries (superset of IDD1 + GetAvailableVidMem)
                                     IDirectSound vtbl:       11 entries
                                     IDirectSoundBuffer vtbl: 18 entries
                                     IDirectInput  vtbl:       9 entries
                                     IDirectInputDevice vtbl: 17 entries
```

Vtable blocks are guest-addressable (so the guest can dereference `lpDD->lpVtbl[slot]`) but filled with addresses pointing **into `THUNK_BASE`**. The guest's indirect CALL through the slot lands in the thunk zone, and `$win32_dispatch` takes over.

## Per-subsystem sketches

### DirectDraw → our existing renderer

`MARBLES.EXE` does the standard DX3 dance:

```
DirectDrawCreate → SetCooperativeLevel(NORMAL) → SetDisplayMode(w,h,bpp,0,0)
  → CreateSurface(PRIMARY) → CreateSurface(BACK, sysmem)
  → loop: Blt/BltFast from offscreen to back, Blt back to primary
```

Everything maps to our existing GDI/renderer primitives:

| DX call                             | Backend mapping                                                          |
|-------------------------------------|---------------------------------------------------------------------------|
| `SetCooperativeLevel`               | No-op (we're always "fullscreen" in a canvas).                           |
| `SetDisplayMode(w, h, bpp)`         | Resize the shared renderer canvas; store (w,h,bpp) for `GetDisplayMode`. |
| `CreateSurface(PRIMARY)`            | Allocate a DX_OBJECT whose backend_id = the renderer's front canvas.     |
| `CreateSurface(offscreen, wxh)`     | Allocate a guest-memory DIB (w·h·bytesPerPixel) + DX_OBJECT entry. Surface pointer points at our DX object; `Lock` returns the DIB bits pointer directly — zero-copy. |
| `Lock(pDDSD)`                       | Fill `DDSURFACEDESC.lpSurface` with the DIB pointer, pitch, ddpfPixelFormat. |
| `Unlock`                            | No-op (no GPU upload; canvas reads from guest memory on present).        |
| `Blt / BltFast(dst, src, ...)`      | memcpy rows between surface DIBs (respecting pitch). If dst is primary, also tell the renderer to repaint that rect. Color keys handled by a per-pixel compare in a tight WAT loop. |
| `Flip`                              | Swap primary/back DX_OBJECT backend_ids and schedule renderer repaint.    |
| `GetAttachedSurface(BACKBUFFER)`    | Return the DX_OBJECT allocated when the primary was created with a back-buffer count. |
| `SetColorKey`                       | Store the key in the DX_OBJECT; Blt reads it.                             |
| `GetSurfaceDesc`                    | Return stored (w,h,bpp,pitch).                                            |
| `Release`                           | Decrement refcount; on zero, free DX_OBJECT and any DIB.                  |
| `CreatePalette / SetPalette`        | Store palette in DX_OBJECT; 8bpp Blt walks it to produce RGBA.            |
| `IDirectDraw::EnumDisplayModes`     | Call the callback once with the mode MARBLES wants (usually 640×480×16). |
| `IDirectDraw::WaitForVerticalBlank` | No-op return DD_OK.                                                       |
| `IDirectDraw::RestoreDisplayMode`   | No-op.                                                                    |

Pixel formats: support 8bpp paletted, 16bpp RGB565, 32bpp ARGB8888. MARBLES is 16bpp; 8bpp is a future addition for older apps. No need for 4bpp, 24bpp, FourCC surfaces, YUV, or Z-buffers.

### DirectSound → reuse the waveOut backend

`DSOUND.DirectSoundCreate` (ordinal 1). `IDirectSound` methods we need:

| Method                  | Backend                                                                   |
|-------------------------|---------------------------------------------------------------------------|
| `SetCooperativeLevel`   | No-op.                                                                    |
| `CreateSoundBuffer`     | Allocate a DX_OBJECT for the IDirectSoundBuffer. If primary, it's a no-op mixing target. If secondary, allocate guest memory for the sample data; remember format (WAVEFORMATEX). |
| `GetCaps`               | Fill DSCAPS with "has software mixing, 8/16 bit, stereo".                 |

On IDirectSoundBuffer:

| Method                 | Backend                                                                     |
|------------------------|-----------------------------------------------------------------------------|
| `Lock(offset, bytes)`  | Hand back a pointer into the sound buffer's guest memory.                   |
| `Unlock`               | Mark dirty.                                                                 |
| `Play(flags)`          | If DSBPLAY_LOOPING, enqueue the buffer into the waveOut stream repeatedly. Otherwise submit once. The existing host audio backend is already a streaming mixer. |
| `Stop`                 | Dequeue the buffer.                                                         |
| `SetVolume / SetPan`   | Apply to the voice in the mixer (host side).                                |
| `SetFrequency`         | Adjust the sample rate the mixer walks at for this voice.                   |
| `GetStatus`            | Return DSBSTATUS_PLAYING if the voice is still active.                      |
| `GetCurrentPosition`   | Mixer reports read cursor; subtract buffer start.                           |
| `Release`              | Stop + free.                                                                |

The heavy lift is a small mixer: **N voices → sum → waveOut**. We already have waveOut handlers (see `09a3-handlers-audio.wat`) that submit PCM blocks to the host's AudioContext. Extending them to sum several buffers is ~100 lines of JS on the host side. No DSP: no pitch interpolation beyond nearest-neighbour, no reverb, no 3D, no DSBPAN curves beyond linear L/R gain.

### DirectInput → message-pump scrapers

`DINPUT.DirectInputCreateA`. Games use DirectInput one of two ways:

1. **Device enumeration + polling** (MARBLES-style). Calls `IDirectInput::CreateDevice(GUID_SysKeyboard / GUID_SysMouse)` then `GetDeviceState` in the game loop.
2. **Buffered events**. We don't need this path.

Backend: we already see every keyboard and mouse event through the WM_KEYDOWN/WM_MOUSEMOVE window-message path. `GetDeviceState`:

- For keyboard: fill a 256-byte array where `state[VK] = 0x80` if the key is held. We track the held-keys bitmap in WAT already (for GetKeyState).
- For mouse: fill a `DIMOUSESTATE` struct: relative dx, dy since last call, button states. Since the renderer gives us absolute coords in WM_MOUSEMOVE, we diff against the previous sample.

`SetCooperativeLevel`, `SetDataFormat`, `Acquire`, `Unacquire` are all no-ops that return DI_OK.

This is maybe 50 lines of WAT once the vtable plumbing exists.

## WAT file layout

New file `src/09a8-handlers-directx.wat` (after the misc dispatch file). Keeps DX concerns together and out of the already-crowded `09a-handlers.wat`. Contents:

```
$init_com_thunks                    ;; called once at module startup
$alloc_dx_object(iface_id) -> ptr   ;; helper
$free_dx_object(ptr)                ;; helper

;; Creators
$handle_DirectDrawCreate
$handle_DirectSoundCreate
$handle_DirectInputCreateA

;; IDirectDraw methods (27 of them, most are no-ops)
$handle_IDDraw_SetCooperativeLevel
$handle_IDDraw_SetDisplayMode
$handle_IDDraw_CreateSurface
$handle_IDDraw_EnumDisplayModes
$handle_IDDraw_WaitForVerticalBlank
$handle_IDDraw_RestoreDisplayMode
$handle_IDDraw_Release
...   ;; all others return DDERR_UNSUPPORTED (0x80004001)

;; IDirectDrawSurface methods (34)
$handle_IDDrawSurface_Lock
$handle_IDDrawSurface_Unlock
$handle_IDDrawSurface_Blt
$handle_IDDrawSurface_BltFast
$handle_IDDrawSurface_Flip
$handle_IDDrawSurface_GetAttachedSurface
$handle_IDDrawSurface_GetSurfaceDesc
$handle_IDDrawSurface_SetColorKey
$handle_IDDrawSurface_Release
...

;; IDirectSound + IDirectSoundBuffer
...

;; IDirectInput + IDirectInputDevice
...
```

Non-trivial handlers are Blt/BltFast (pixel copies with optional color key and pitch mismatch), Lock (zero-copy pointer return), and the three creators. Everything else is a dozen lines or less.

## Host import surface additions

`lib/host-imports.js`:

```
host_dx_set_display_mode(w, h, bpp) -> 0
  Resize the renderer canvas. Stash bpp so host_dx_present knows how to decode.

host_dx_present(front_ptr, w, h, pitch, bpp, palette_ptr) -> 0
  Decode the guest-memory DIB at front_ptr into the renderer canvas's
  primary layer. Reuses lib/dib.js for 8bpp palettes and 16bpp RGB565
  (adds a 16bpp codepath — currently dib.js only handles 1/4/8/24/32).

host_dx_sound_create_voice(format_ptr, data_ptr, nbytes) -> voice_id
host_dx_sound_voice_play(voice_id, loop: 0|1) -> 0
host_dx_sound_voice_stop(voice_id) -> 0
host_dx_sound_voice_set_volume(voice_id, linear_gain_fixed16) -> 0
host_dx_sound_voice_get_position(voice_id) -> bytes_played_u32
host_dx_sound_voice_release(voice_id) -> 0
```

No separate input host imports — DirectInput state is scraped from the existing WAT input state.

## Step-by-step implementation order

1. **Plumbing.** COM vtable allocator + thunk init + dispatcher extension. Wire it with a *single* method (`IDDraw::Release`) that just returns S_OK, plus the three creators returning fake objects. MARBLES should now get past `DirectDrawCreate` and into its display-mode setup before crashing on the first unsupported method. ~250 lines, all verifiable in isolation via `--trace-api`.
2. **Null-backend DirectDraw.** All IDirectDraw / IDirectDrawSurface methods return DD_OK and zero out output structs. `Lock` returns a freshly allocated DIB, `Unlock` is a no-op. Blt does nothing. The game now runs its main loop against an invisible backbuffer — verifies state machine, message pump, and release-order are correct.
3. **Real 16bpp surfaces + Blt.** Implement `CreateSurface`, `Lock`/`Unlock` with real DIB backing, `BltFast` rect copies, `Flip` routing to the renderer. Add 16bpp RGB565 support to `lib/dib.js`. MARBLES should now actually draw its board.
4. **DirectSound.** Minimum to not crash: creators + Release. Then small mixer + voice playback so MARBLES's click sounds come through.
5. **DirectInput.** Keyboard + mouse `GetDeviceState`. MARBLES becomes playable.
6. **Polish.** SetColorKey, palette surfaces, `EnumDisplayModes` variants, DDERR_* error codes. Only the ones MARBLES actually exercises.

## Non-goals

- **Direct3D / D3DRM.** Completely separate API. No app in our test set uses it.
- **Hardware acceleration / overlays.** Not a thing in a browser canvas.
- **Exclusive-mode fullscreen.** We ignore `DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN` and keep running in the shared canvas. Games that care will crash on `SetDisplayMode` failure — MARBLES doesn't care.
- **Gamma / palette animation.** If a future app needs it, palette changes will trigger a reblit; fine for MARBLES since it's 16bpp.
- **DirectSound 3D, EAX, environmental reverb, DirectMusic.**
- **DirectInput joysticks / force-feedback / buffered events.**
- **Multiple monitors, `EnumDisplayModes` returning anything beyond the native mode.**
- **DirectX 7+ APIs.** `DirectDrawCreateEx`, `IDirectDraw7`, `IDirectSound8` etc. stay unimplemented until a binary needs them; the vtable scheme extends trivially when they do.

## Why not just stub the COM vtables with return-0?

Because it won't get us past the first `Lock` — MARBLES dereferences `DDSURFACEDESC.lpSurface` and blts into it. A stub that returns `DD_OK` without writing a valid surface pointer will crash the guest. COM is the kind of API where half-working is not working. Either we implement enough of a surface that its bits can be written and re-presented, or the app is broken. Step 2 above (null backend) is the minimum viable implementation *because* that's where the guest's own code starts accessing the object contents.

## Implementation status (2026-04-20)

| Feature | Status |
|---------|--------|
| COM vtable infra | Done — init_com_vtable + extend_com_vtable + 64-slot DX_OBJECTS pool |
| IDirectDraw (27 methods) | Done — all methods have handlers |
| IDirectDraw2 (extends DD1) | Done — vtable extension with GetAvailableVidMem |
| IDirectDrawSurface (34 methods) | Done — Lock/Unlock/Blt/BltFast/Flip/GetAttachedSurface/SetPalette/SetClipper/etc. |
| IDirectDrawPalette (7 methods) | Done — GetEntries/SetEntries with 256-color support |
| IDirectDrawClipper (9 methods) | Done — stub-functional (SetHWnd/SetClipList no-ops) |
| IDirectSound (10 methods) | Done — CreateSoundBuffer works, no audio output |
| IDirectSoundBuffer (18 methods) | Done — Lock/Unlock/Play/Stop stubs |
| IDirectInput (9 methods) | Done — CreateDevice for keyboard/mouse |
| IDirectInputDevice (17 methods) | Done — GetDeviceState returns current input |
| IDirect3D/IDirect3D3 | Phase 0 stubs only (E_FAIL/D3D_OK) |
| EnumDisplayModes | Done — multi-mode enumeration (640×480×8/16, 800×600×8/16) with CACA0008 continuation |
| 8bpp palette rendering | Done — SetPaletteEntries → dx_present → RGBA expansion → SetDIBitsToDevice |
| Default 8bpp palette | Done (2026-04-20, f0d3835) — SetDisplayMode(≤8bpp) installs 6×6×6 cube + grayscale when app skips CreatePalette. Unblocks ddex1. |
| 16bpp RGB565 rendering | Done — pitch/format support in CreateSurface/Lock |
| Color-key transparency | Done — BltFast checks color-key during copy |

### Per-game status

| Game | Status | Blocker |
|------|--------|---------|
| **MARBLES** (Plus! 98) | **Rendering game screen** — 173K API calls, sprites visible | Needs mouse input to start gameplay |
| **AoE** (Age of Empires) | DD init succeeds, creates surfaces/palette/clipper | `MapViewOfFile` for DRS data files; VFS path resolution |
| **RCT** (RollerCoaster Tycoon) | Dialog renders, EndDialog works | Data files (CSG1.DAT etc.) not found via VFS |
| **Abe's Oddworld demo** | PE load crash | 32MB sizeOfImage overflows WASM memory layout |
| **AoE2** | Not tested | Likely same issues as AoE1 |
| **Screensavers (7)** | Blocked | Need D3DRM (see `d3drm.md`) |
| **MCM / MW3** | Blocked | Need D3D Immediate Mode (see `direct3d-im.md`) |

### DX5 SDK samples (harness, 2026-04-20)

Pixel-diversity gate added to `test-all-exes.js` (commit c484b24) exposed which DX5 samples truly render vs. init-but-blank. PNGs land in `scratch/harness-pngs/`.

| Sample | Status | Notes |
|--------|--------|-------|
| ddex1 | **PASS** (12 colors) | Default 8bpp palette fix (f0d3835) — app skips CreatePalette |
| ddex2 / ddex3 / ddex5 | blank | Similar DDraw path to ddex1 but palette fix doesn't cover them |
| flip2d | **PASS** (65+ colors) | Needed user32 stubs (GetMenuItemCount, EnableScrollBar, {Set,Get}MenuItemInfoA — 8de8043) |
| palette / stretch | **PASS** (65+ colors) | |
| flip3dtl | **PASS** (22 colors) | Needed XLAT (0xD7) decoder support — CRT float-classification hung on it (commit 0dfa24f) |
| Boids | **PASS** (32+ colors) | |
| Donuts | **PASS** (window created) | |
| tunnel / twist | blank | Run to completion but hit D3D error path ("D3D Example Message" MessageBox + ExitProcess) — real upstream D3DIM issue |
| Globe / Bellhop / Viewer / Wormhole | blank | D3DIM Phase-0 stubs (see `direct3d-im.md`) |
| Donut | blank | DDraw; 20k-API render loop runs but output doesn't composite — similar to ddex2/3/5 |
| FoxBear | blank | DDraw sprite demo; same composition issue |

### Recent changes (2026-04-20)

- **f0d3835** — Default 8bpp palette at SetDisplayMode when app skips CreatePalette (ddex1 fix)
- **8de8043** — user32 stubs: GetMenuItemCount, EnableScrollBar, {Set,Get}MenuItemInfoA (flip2d/viewer unblocked)
- **0dfa24f** — XLAT decoder opcode — flip3dtl hung on CRT FPU-class helper before wndproc ever registered
- **c484b24 / 1ab922d** — `test-all-exes.js` pixel-diversity gate (two-signal: ≤8 colors AND >95% one-color = blank). Demoted 10 false-PASS apps; PNGs saved for visual review.

## Open questions

- **Refcount correctness.** Games that call `AddRef`/`Release` asymmetrically will leak DX_OBJECTs. We have 64 slots; expanded from 32 after MARBLES exhausted the original pool.
- **MapViewOfFile.** AoE and potentially other games use memory-mapped files for data. Need to implement CreateFileMappingA + MapViewOfFile → allocate guest memory, read file into it, return pointer.
- **Large PE images.** Abe's demo has a 32MB PE image (`_winzip_` section = self-extracting archive). Current memory layout (GUEST_BASE=0x12000, stack at 0xE12000) can't fit it. Needs dynamic memory layout or larger WASM memory.
- **Thunk pressure.** Each method gets its own THUNK_BASE slot. ~150 methods across all interfaces × ~8 bytes per thunk ≈ 1.2 KB. The thunk zone is 256 KB, so fine.
