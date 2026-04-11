# WordPad (test/binaries/win98-apps/wordpad.exe)

## Status: FAIL (same root cause as mspaint-win98)

Current crash signature: `[API] IsBadWritePtr` → `memory access out of bounds`.
This is the *same* bug as mspaint Win98. Both apps dynamically load
advapi32.dll during MFC init, and advapi32 has 9 ordinal-only KERNEL32
imports that our DLL loader mis-thunks (marker `0x4F524400`, stored
api_id = 0xFFFF instead of the real ordinal). See
scratch/exe-status/mspaint-win98.md for the full analysis and fix sketch.

Earlier failure mode (ResumeThread/CreateThread) is likely masked by
this: WordPad used to reach `ResumeThread` because advapi32 wasn't being
loaded at all; now that dynamic LoadLibraryA works (commit b416e02), the
MFC flow goes through registry init first and trips the ordinal-thunk
crash before it ever reaches thread creation.

## Difficulty

Fixing the ordinal-thunk bug (see mspaint-win98.md) would likely get
WordPad back to its earlier ResumeThread crash, which is a separate,
harder problem (real multi-thread support). So this EXE is gated on
two fixes stacked: ordinal thunks first, then thread manager.
