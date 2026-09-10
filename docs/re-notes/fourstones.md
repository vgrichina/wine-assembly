# Four Stones

Registry `fourstones`, `test/binaries/wep32-community/Funpack/FourStones.exe`
with `FunPack.dll`. Win32 Connect Four game, window400x300 at desktop(20,20).

## Idle CPU and helper wakeup (2026-09-10)

Production298 static board burns102% of one core. The main thread is already
in message wait7; its only active helper is in infinite event wait1 at guest
EIP0x405320. In10s, main slices remain523 while helper wait polls grow from
2,557,559 to5,269,727. The browser mistakes a live helper for runnable work.

Local304 `ThreadManager.parkedThreadDelay()` allows a host sleep after an
observed no-work cooperative pass, bounded by all observed deadlines and
interrupted by new input. Initial board drops to0.80% headless renderer.

Actual headful gameplay verification: click **Start!** at(90,50), then first
column entry(126,84), each held220ms. Human red stone lands at bottom left;
computer blue reply lands in column4. Renderer settles to0.94%, main yield7.
Screenshot/JSON: `/private/tmp/wa-idle-fourstones-move304/fourstones.*`.

Start! is command40005 (also used by existing playability tests). Game/New is
40001 and is not equivalent to starting play. The click belongs above the
column, not inside a yellow board hole; no-stone screenshots are not proof
that the helper woke to compute a move. Changes are local, not deployed yet.
