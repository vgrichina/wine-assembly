# MSPaint Debugging Notes

## Current Status (2026-03-31)

### Bugs Fixed This Session

1. **__p__wcmdln returning NULL** — shared `$msvcrt_wcmdln_ptr` not written at offset +32 when `__wgetmainargs` runs first
2. **GetVersionExA platformId encoding** — derived from bit 31 of winver (NT=2 when clear, Win9x=1 when set)
3. **PatBlt missing host imports** — replaced with `gdi_bitblt` call
4. **HeapSize missing** — added as API 699 with heap range validation
5. **API_HASH_COUNT off-by-one** — was 699, now 700
6. **`jmp reg` no thunk check** — `$th_jmp_r` now checks thunk zone (was just `set $eip`)
7. **GetProcAddress missing api_id** — thunks created by GetProcAddress now store hash-looked-up api_id
8. **Thunk end not updated dynamically** — `$update_thunk_end` called on every thunk creation

### Current Block: Unknown APIs hitting fallback

With `--winver=nt4` and 2 DLLs (msvcrt.dll + mfc42u.dll), MFC init proceeds:
- msvcrt DllMain: EAX=0x2002cc8 (success)
- mfc42u DllMain: EAX=1 (success)
- CRT startup: all checks pass
- MFC WinMain entered
- 8 API calls before stuck at EIP=0

Unknown APIs hitting fallback (stack corruption - only pops 4 bytes):
- `IsProcessorFeaturePresent` (1 arg, stdcall)
- `CoRegisterMessageFilter` (2 args, stdcall → needs 12 bytes ESP cleanup)

**Next**: Add these as proper stubs with correct ESP cleanup, then trace further.

### DLLs Needed
- msvcrt.dll (CRT) — required
- mfc42u.dll (MFC) — required
- msvcp60.dll — NOT needed (MSPaint doesn't import it)
- oleaut32.dll — NOT needed (MSPaint doesn't import it)

### Run Command
```bash
bash tools/build.sh && node test/run.js \
  --exe=test/binaries/entertainment-pack/mspaint.exe \
  --winver=nt4 \
  --dlls=test/binaries/dlls/msvcrt.dll,test/binaries/dlls/mfc42u.dll \
  --trace-api --max-batches=10000 --batch-size=100
```
