# FoxBear — DX5 DDraw sprite sample

`test/binaries/dx-sdk/foxbear/foxbear.exe` (+ `foxbear.art`, 1.6 MB sprite atlas).

DirectDraw sample from the DX5 SDK: animated fox-and-bear sprite demo using color-keyed BltFast against a primary+back buffer pair.

## History

- **2026-04-21 early** — stuck at 93 API calls: EIP=0 right after `SetDisplayMode`. Two back-to-back fixes:
  - `4962118` — `QueryInterface(IID_IDirectDraw2)` was mutating the primary wrapper's vtable in-place. FoxBear QIs for DDRAW2 then continues calling v1-signature methods on the original pointer; the mutated vtable made `SetDisplayMode` pop 28 bytes (v2) when only 20 were pushed (v1). ESP 8 bytes too high → ret-to-0. Fixed by allocating a separate DDRAW2 wrapper via `dx_get_wrapper_for_vtbl`.
  - `229a5bb` — `fs_create_file_mapping` didn't normalize `hFile >>> 0`, so the handle came in signed and missed the Map. FoxBear's art-file load bailed with "Could not load art file".
- **2026-04-21 mid** — reached the render-loop init, crashed at `0x00408e67` on unimplemented **`bsearch`**.
- **2026-04-21 late** — `bsearch` implemented via a CACA000C continuation thunk (WAT drives the binary search one probe at a time, invoking the guest comparator via the usual push-args/push-thunk/jump pattern; continuation pops the 2 pushed args, inspects `eax`, narrows `[low, high)` and re-probes or returns). First render shows the bear sprite blitted in the top-left corner (`test/output/foxbear.png`). 3114 API calls before the message pump idles without input.

## Next blocker — WinMain bails before entering the message loop

After bsearch was fixed, foxbear runs 3285 API calls and renders two sprite poses (bear + fox peeking) into the top-left ~160×100 region of the 640×480 window, then calls `exit(0)` from `mainCRTStartup` (ret=0x00409c2e). `handle_exit` now sets `yield_flag` so the emulator halts cleanly instead of looping.

The anomaly: **the message pump at `0x00402680` is never entered** — zero `PeekMessageA` / `GetMessageA` calls in the trace, yet the render function (`0x00407e90`, called via `[eax+0x6c]` = DDraw `Restore`, then frame draw) fires enough times to put two sprites on-screen. That rendering must be happening inside the startup WM_PAINT chain our GetMessage phases deliver, via WndProc dispatch.

WinMain's post-init path has three early-returns with `xor eax,eax; ret` (0x40260c, 0x402879, 0x4028bf) — one of those almost certainly fires before the main loop. Init check returning 0 causes WinMain to return 0 → mainCRTStartup → exit(0).

Next step: breakpoint `--break=0x402600,0x402879,0x4028bf` and see which early-return path WinMain takes, then work backwards to which DDraw/init call we're getting wrong.

## Files & addresses

- `foxbear.art` mapped as read-only via `CreateFileA` (`OPEN_EXISTING`) → `CreateFileMappingA` (`PAGE_READONLY`) → `MapViewOfFile`.
- Error dialog string at `0x0040c8b4`: "Could not load art file".
- Sprite-draw dispatch site: call `edi` sequences around `0x004085ab..0x004086d1` (edi = `GetWindowLongA` — used as varargs log wrapper? actually `call edi` with matching-size arg blocks ⇒ likely a stdcall log helper of some sort; worth a second look if tracing this region).
