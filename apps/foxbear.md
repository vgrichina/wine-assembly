# FoxBear — DX5 DDraw sprite sample

`test/binaries/dx-sdk/foxbear/foxbear.exe` (+ `foxbear.art`, 1.6 MB sprite atlas).

DirectDraw sample from the DX5 SDK: animated fox-and-bear sprite demo using color-keyed BltFast against a primary+back buffer pair.

## History

- **2026-04-21 early** — stuck at 93 API calls: EIP=0 right after `SetDisplayMode`. Two back-to-back fixes:
  - `4962118` — `QueryInterface(IID_IDirectDraw2)` was mutating the primary wrapper's vtable in-place. FoxBear QIs for DDRAW2 then continues calling v1-signature methods on the original pointer; the mutated vtable made `SetDisplayMode` pop 28 bytes (v2) when only 20 were pushed (v1). ESP 8 bytes too high → ret-to-0. Fixed by allocating a separate DDRAW2 wrapper via `dx_get_wrapper_for_vtbl`.
  - `229a5bb` — `fs_create_file_mapping` didn't normalize `hFile >>> 0`, so the handle came in signed and missed the Map. FoxBear's art-file load bailed with "Could not load art file".
- **2026-04-21 current** — reaches the render-loop init, then crashes at `0x00408e67` on unimplemented **`bsearch`** (`last API: bsearch`).

## Next blocker — `bsearch`

`void *bsearch(const void *key, const void *base, size_t nmemb, size_t size, int (*compar)(const void *, const void *));`

Requires guest-callback dispatch (WAT calls back into guest x86 for the comparator). Same pattern as `qsort` — neither is implemented yet.

Implementation sketch:
- Either invoke the comparator by setting EIP + stack and driving the emulator for one call (like SendMessageA's CACA0005 continuation thunk), or
- Add a CACA000X continuation that loops through the array performing a binary search, invoking the callback for each comparison.

Until one of those lands, FoxBear stops here.

## Files & addresses

- `foxbear.art` mapped as read-only via `CreateFileA` (`OPEN_EXISTING`) → `CreateFileMappingA` (`PAGE_READONLY`) → `MapViewOfFile`.
- Error dialog string at `0x0040c8b4`: "Could not load art file".
- Sprite-draw dispatch site: call `edi` sequences around `0x004085ab..0x004086d1` (edi = `GetWindowLongA` — used as varargs log wrapper? actually `call edi` with matching-size arg blocks ⇒ likely a stdcall log helper of some sort; worth a second look if tracing this region).
