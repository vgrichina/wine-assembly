# Production desktop idle CPU audit

Goal: all non-realtime games on the production desktop should use little CPU
while idle. **Not complete; fixes below are local, not deployed.**

User clarification: **do not deploy to production**. The production desktop
inventory defines which games to fix; implementation and acceptance stay local.
No credentials are needed, and publishing is not a completion requirement.

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
Final acceptance still needs headful local verification across that inventory.

The initial screenshot is part of the evidence: an empty launch/splash screen
does not establish that a dealt game board sleeps. Start-game commands come
from the guest's actual menu labels/IDs, not guessed command numbers.

Temporary harness: `/private/tmp/audit-idle-games.js`; raw production baseline:
`/private/tmp/wa-idle-prod-baseline/*.json` and matching PNGs.

## First production sweep

| Game | Renderer core % | Observed state / follow-up |
|---|---:|---|
| FreeCell | 0.65 | Empty launch; populated local board verified below |
| Solitaire | 0.60 | Dealt board |
| Cruel | 0.78 | Dealt board |
| Golf | 1.41 | Dealt board |
| Pegged | 0.65 | Board |
| Taipei | 0.57 | Splash; populated local board verified below |
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
just its title screen. Bricks is a Klotski sliding-block puzzle and belongs in
the non-realtime board-game inventory (15 card/board titles, not 14). EmPipe,
Funtris and CWordZap still need explicit state classification:
inspect static menus/paused states but do not mistake
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

Headful FreeCell game16371 and Taipei game10112 were screenshot-verified as
actual populated boards, not launch/splash screens. Renderer samples0.58% and
0.71%, respectively, but host load9.68/19.42 means these establish absence of
a core spin, not precise final performance. Raw `wa-idle-dealt-headful304`.

Marbles actual one-player board reached using existing playability readiness
predicates: wait for menu pixel guest(300,105), held Play click at page(500,650),
wait for skill-panel pixel guest(100,300), then Enter held500ms. Fixed5s startup
delays were insufficient; earlier clicks landed in intro transitions and their
results were rejected. Actual board has two competing marble grids and continues
simulating without input (32.07% renderer, host loaded12+). This is active
realtime gameplay, not static turn-based idle acceptance. Practice/paused state
still needs checking. Raw `wa-idle-marbles-board304`, screenshot inspected.

Implementation checkpoint: isolated commit `1ce2532e`, after phone UI/runtime
commit `f298b7f9`. No main merge or production deployment. The subsequent user
clarification prohibits deployment; the earlier credential request is withdrawn.

Three-app headful check (`wa-idle-three-apps304`): populated FreeCell, Four
Stones and Blackjack's opening dialog run together. Across20s, main slice
counters FreeCell5 ->5 and Four Stones6 ->6 remain parked; Blackjack319 ->712
is about20 queue-park wakes/s, not an immediate loop. All three remain running,
document visible, no page errors; combined renderer1.45%. Host load10.56 means
repeat on a quiet box for exact CPU acceptance, but no shared core spin appears.

Heroes settled headful run:60s warmup followed by30s measurement at host load2.43
still15.59% renderer,7037 clock parks. Startup compilation is ruled out as the
residual explanation. Profile: WASM3.6% wall time, native/program7.7%, remaining
host scheduling/presentation costs. Evidence `wa-idle-heroes-settled304`.

Marbles `p` key did **not** produce a verified paused screen; its resulting
19.53% sample must not be recorded as paused acceptance. Actual pause binding
remains to be established (guest pause routine0x41a975, thunk0x401370).
The physical Pause key also fails to pause: `wa-idle-marbles-pause-key304`
screenshots show the opponent counter changing1 ->2 and both grids advancing.
Its42.52% loaded-host sample is active gameplay, not paused acceptance.

Extended production sweep: Bricks menu0.46%, EmPipe8.34%, Funtris102.18%,
CWordZap2.16%, Heroes II menu107.04%. Funtris has a sleeping helper (not a
runnable one); the same local scheduler fix reduces it to **0.76%** and EmPipe
to **0.55%**. Heroes II's menu is explicitly in scope per the user's follow-up;
see its RE notes for the clock-context fix and remaining work.

Local source/cache version 304, canonical and compat build pass, layout hash
`7dc7fccf292ba722`. Focused Win16 stack, dialog timer/command, common modal,
park-sleep, cooperative-deadline and Worker scheduler tests pass.

## Completion checklist (still open)

### Visible local304 inventory sweep

`/private/tmp/wa-idle-cards-headful304`,10s per game, separate visible Chrome
processes; all ten screenshots inspected in `wa-idle-cards-all.png`, no page
errors and all guests remain running in message wait7. Host load ranged6..23,
so these rule out core spins but are not precise quiet-box performance claims.

| Game | Renderer core % | Main slices during sample |
|---|---:|---|
| Solitaire | 1.02 | 23 ->63 |
| Cruel | 0.65 | 29 ->69 |
| Golf | 5.32 | 21 ->73; timer/repaint follow-up |
| Pegged | 0.48 | 1 ->1 |
| TicTactics | 0.85 | 13 ->33 |
| Reversi | 0.50 | 1 ->1 |
| Minesweeper | 0.74 | 6 ->16; board still unopened |
| Spider | 0.49 | 2 ->2 |
| Peaks | 0.63 | 4 ->4 |
| Pyramid | 1.67 | 12 ->22 |

Golf's higher result is **not** an unparked main loop:52 guest runs over10s,
with message wait7 and timer deadlines between runs. Profile timer/presentation
cost and repeat under low host load before accepting the5.32% as persistent.

Follow-up `wa-idle-golf-settled304`:30s warmup,20s sample gives **1.00%**
renderer, main slices125 ->205, no errors. Host phases total57.5ms/20s, of
which guest work7.9ms, present30.8ms and other18.8ms. Thus the5.32% outlier is
not persistent. Load5.44;3s CPU profile is96.7% idle and0.1% WASM.

After-input checks (both headful,15s samples):

- **Minesweeper0.94%**, `wa-idle-mines-revealed304`: click first tile at(100,145)
  held180ms. A1 is revealed; counter advances004 ->019, screenshots inspected.
  The earlier(100,130) edge click did not reveal a tile and was rejected.
- **Blackjack1.75%**, `wa-idle-blackjack-dealt304`: Close notice(760,360), Play
  menu(168,30), Minimum Bet(222,52), then OK(286,855),180ms holds. The5-unit
  bet is on the table, player7+8 totals15, dealer shows3; helper strategy
  window is visible. Main returns to yield7, slices134 ->164 over15s,
  no errors. This verifies real deal input after the modal idle fix.

Heroes actual player-turn map, headful (`wa-idle-heroes-map-headful304`):
NEW GAME / STANDARD / OKAY through real mouse input, screenshot inspected.
Renderer10.37%, GPU2.59%, audio utility0.74%,4441 clock parks over20s;
no page errors, map remains running. Music and palette animation remain enabled.
This completes the map-state verification, not a claim of sub-percent CPU for
the audible animated game. The separate menu audio-isolation evidence above
explains why real-time synthesis must be distinguished from idle guest polling.

### Remaining work

Bricks headful local304 follow-up: actual started Klotski board **0.93%**
renderer, then **0.84% after a real drag**,15s samples. Main slice counters
remain4 ->4 and9 ->9 respectively, message wait7, no page errors. The drag
changes1838 board pixels and the rendered counter reads `MOVES: 1`; this is
not an untouched launch screen. Raw `wa-idle-bricks-board304` and
`wa-idle-bricks-drag304`, screenshots inspected. Host loads18.15/15.65 limit
numerical precision, but zero guest runs during each sample establishes that
the board is not spinning. No additional runtime change was needed.

- Classify remaining realtime puzzle practice/paused states; Heroes actual
  player-turn map is now verified headfully above.
- Golf, Minesweeper after reveal, and Blackjack after deal pass locally above.
- Verify additional sleeping-helper games after input; Four Stones passes locally.
- Finish real-game/after-input checks, not only launch states.
- Headful measurements with visible pages and a blank-page CPU floor.
- Integrate/commit scoped work without foreign changes; keep paired local
  artifacts and cache graph coherent. Do not deploy.
- Repeat the passing local three-app shared-scheduler check on a quiet box.
