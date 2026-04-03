# XP End of Life (xp_eos.exe) — XP

**Status:** WARN (54→246 APIs, no window)

## Behavior
Stuck in MFC CriticalSection init loop — same pattern as write.exe, winipcfg.

## Blocking Issue
MFC init CriticalSection cycling.

## See: write.md (same MFC init issue)

## Difficulty: Hard (MFC infrastructure)
