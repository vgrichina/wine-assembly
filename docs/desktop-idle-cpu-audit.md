# Production desktop idle CPU audit

Goal: all non-realtime games on the production desktop should use little CPU
while idle. **Not complete; fixes below are local, not deployed.**

Inventory fetched from production `lib/apps.js` on 2026-09-10. Production
`host.js` reports source version 298. Work is isolated in
`/private/tmp/wa-rodent-phone`; shared main has unrelated concurrent changes.

## Measurement contract

Fresh Chrome per app, visible page (`document.hidden === false`), 1280x900
desktop viewport, 5s startup settle and 10s cumulative process CPU deltas via
CDP SystemInfo. Percentages below are **renderer CPU as percent of one core**,
not total-machine utilization. Raw files include browser/GPU/utility costs,
load averages, guest state and screenshots. These first-pass measurements are
headless Chrome on Apple M1 and the host is loaded: use them to identify core
spins, not to claim sub-percent performance precision or real iPhone battery.
Final acceptance still needs headful verification and production remeasurement.

The initial screenshot is part of the evidence: an empty launch/splash screen
does not establish that a dealt game board sleeps. Start-game commands come
from the guest's actual menu labels/IDs, not guessed command numbers.

Temporary harness: `/private/tmp/audit-idle-games.js`; raw production baseline:
`/private/tmp/wa-idle-prod-baseline/*.json` and matching PNGs.

## First production sweep

| Game | Renderer core % | Observed state / follow-up |
|---|---:|---|
| FreeCell | 0.65 | Empty launch; started local board 0.60%, verify final production deal |
| Solitaire | 0.60 | Dealt board |
| Cruel | 0.78 | Dealt board |
| Golf | 1.41 | Dealt board |
| Pegged | 0.65 | Board |
| Taipei | 0.57 | Splash; started local board 0.59%, verify final production game |
| TicTactics | 0.61 | Board |
| Reversi | 0.54 | Board |
| Minesweeper | 0.57 | Unopened board; also verify running game timer |
| Spider | 0.52 | Dealt board |
| Peaks | 0.85 | Dealt board, startup notice dismissed by existing registry policy |
| Pyramid | 0.86 | Dealt board |
| Four Stones | **102.17** | Static board; blocked helper mistaken for runnable work |
| Quick Blackjack | **102.85** | Opening dialog; empty native dialog pump busy-yields |
| Rodent | **101.99** | Known Win16 WaitMessage busy loop |
| Marbles | **52.92** | Animated mode menu; GPU 11.87%, needs gameplay/practice check |

Non-realtime scope also includes Heroes II's player-turn adventure map, not
just its title screen. Bricks, EmPipe, Funtris and CWordZap still need explicit
state classification: inspect static menus/paused states but do not mistake
active realtime simulation for an idle wait. Rodent is included because it
initiated the investigation. SkiFree, Pinball, DX-Ball, Blobby Volley, Rattler
and RollerCoaster Tycoon have realtime active play, not a turn-based idle board.

## Local fixes and evidence

1. Win16 USER.112 WaitMessage completes its Pascal far return, then parks with
   queue yield 15. Fresh queue/clock parks override the host's 120ms
   recent-input busy window. Rodent idle 101.1% -> 0.66%, paused 101.9% ->
   0.60%, playing ~102% -> 2.22–2.56%. See the Rodent reverse-engineering notes.
2. Four Stones' main is in message wait 7; its only helper is in event wait 1
   at `0x00405320`. Across 10s the main slice counter stayed 523, while helper
   wait polls grew 2,557,559 -> 5,269,727. `hasActiveThreads()` means alive,
   not runnable. After a no-work cooperative pass, `parkedThreadDelay()` lets
   the host sleep to the earliest observed wait/sleep/timer deadline. It does
   not call waitSingle again (which would consume auto-reset events), and
   remains conservative for pending spawns, productive passes, unknown yields
   and true Workers. Local CPU **0.80%**, from 101.24% on the preceding local
   run. Regression checks pending messages, timeouts and runnable work.
3. Both native dialog idle pumps now request queue park 15 only after their
   pending work is drained. The DialogBox continuation keeps EIP/ESP intact;
   compiled tests verify an idle park, subsequent WM_TIMER, and posted
   WM_COMMAND. Common-dialog tests verify cross-instance completion after
   park. Actual Blackjack opening-dialog CPU **0.74%**, table awaiting bets
   **1.44%** after its Close button; the rendered table was inspected.
4. Heroes II alternates four stack contexts inside its clock polling wrapper;
   the single-context detector kept resetting before K=8. A bounded four-context
   MRU retains each context's independent same-time/no-activity proof. Existing
   ABI and one-park-per-ms safeguards remain. Menu headless CPU108% ->13.68%,
   actual player-turn map22.51% ->7.36%. Headful menu **16.15%** with same-browser
   blank renderer0.005% at host load3.42. Residual is still too high to close the
   audit; about235 clock parks/s plus palette presentation remain.
   Production headful confirmation is105.59% with zero new parks (host load7.73);
   local repeat14.99%. Palette census rules out identical updates:15 updates in3s
   all change RGB, alongside11 surface updates. No timing-default or animation
  suppression change was made.

### After-input acceptance, local304

Four Stones, headful Chrome: click **Start!** at desktop(90,50), then the first
column's entry area at(126,84), holding each click220ms. Screenshot shows the
human red stone at the bottom left and the computer's blue reply in column4;
the red selection marker remains above column1. After both moves, renderer CPU
is **0.94%** and the main is back in message wait7. Evidence:
`/private/tmp/wa-idle-fourstones-move304/fourstones.{json,png}`.

Do not substitute Game/New (40001) for Start! (40005): New resets the board.
Clicking a hole in the board rather than the column entry also does not prove
a move. Earlier no-stone screenshots were rejected as gameplay acceptance.

Extended production sweep: Bricks menu0.46%, EmPipe8.34%, Funtris102.18%,
CWordZap2.16%, Heroes II menu107.04%. Funtris has a sleeping helper (not a
runnable one); the same local scheduler fix reduces it to **0.76%** and EmPipe
to **0.55%**. Heroes II's menu is explicitly in scope per the user's follow-up;
see its RE notes for the clock-context fix and remaining work.

Local source/cache version 304, canonical and compat build pass, layout hash
`7dc7fccf292ba722`. Focused Win16 stack, dialog timer/command, common modal,
park-sleep, cooperative-deadline and Worker scheduler tests pass.

## Completion checklist (still open)

- Inspect remaining puzzle games and Heroes II actual player-turn map.
- Verify Blackjack can leave its notice and deal a game; trace remaining hot paths.
- Verify additional sleeping-helper games after input; Four Stones passes locally.
- Finish real-game/after-input checks, not only launch states.
- Headful measurements with visible pages and a blank-page CPU floor.
- Integrate/commit scoped work without foreign changes; check production has
  not changed, deploy paired artifacts/cache graph, then remeasure production.
- Multiple open non-realtime games must not revive a shared scheduler spin.
