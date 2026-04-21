# FoxBear — DX5 DDraw sprite sample

`test/binaries/dx-sdk/foxbear/foxbear.exe` (+ `foxbear.art`, 1.6 MB sprite atlas).

DirectDraw sample from the DX5 SDK: animated fox-and-bear sprite demo using color-keyed BltFast against a primary+back buffer pair.

## History

- **2026-04-21 early** — stuck at 93 API calls: EIP=0 right after `SetDisplayMode`. Two back-to-back fixes:
  - `4962118` — `QueryInterface(IID_IDirectDraw2)` was mutating the primary wrapper's vtable in-place. FoxBear QIs for DDRAW2 then continues calling v1-signature methods on the original pointer; the mutated vtable made `SetDisplayMode` pop 28 bytes (v2) when only 20 were pushed (v1). ESP 8 bytes too high → ret-to-0. Fixed by allocating a separate DDRAW2 wrapper via `dx_get_wrapper_for_vtbl`.
  - `229a5bb` — `fs_create_file_mapping` didn't normalize `hFile >>> 0`, so the handle came in signed and missed the Map. FoxBear's art-file load bailed with "Could not load art file".
- **2026-04-21 mid** — reached the render-loop init, crashed at `0x00408e67` on unimplemented **`bsearch`**.
- **2026-04-21 late** — `bsearch` implemented via a CACA000C continuation thunk (WAT drives the binary search one probe at a time, invoking the guest comparator via the usual push-args/push-thunk/jump pattern; continuation pops the 2 pushed args, inspects `eax`, narrows `[low, high)` and re-probes or returns). First render shows the bear sprite blitted in the top-left corner (`test/output/foxbear.png`). 3114 API calls before the message pump idles without input.

## Next blocker — animation / sprite placement

Only the bear renders, and only in the top-left. Expected output is both fox and bear animating across a tiled background. Likely causes to investigate:
- Timer-driven frame tick: no `SetTimer` WM_TIMER firing → no animation.
- Sprite list: bsearch finds one entry and returns; second sprite may come from a different draw path. Confirm by checking further BltFast calls after first frame.
- Offset / placement math could be short-circuiting (bsearch returns the first art entry for every sprite name).

## Files & addresses

- `foxbear.art` mapped as read-only via `CreateFileA` (`OPEN_EXISTING`) → `CreateFileMappingA` (`PAGE_READONLY`) → `MapViewOfFile`.
- Error dialog string at `0x0040c8b4`: "Could not load art file".
- Sprite-draw dispatch site: call `edi` sequences around `0x004085ab..0x004086d1` (edi = `GetWindowLongA` — used as varargs log wrapper? actually `call edi` with matching-size arg blocks ⇒ likely a stdcall log helper of some sort; worth a second look if tracing this region).
