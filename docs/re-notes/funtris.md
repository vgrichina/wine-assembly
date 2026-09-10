# Funtris local idle audit

2026-09-10, source304, headful Chrome. This is a realtime falling-tetromino
game. Actual Game/New menu command40001 starts a piece; the before/after
screenshots show it falling while no further input is sent. Renderer CPU1.68%
over10s, host load5.57, main parked at414fd1 (yield7), helper
sleeping at403f3a. Raw `/private/tmp/wa-idle-puzzles-start304/funtris.json`
and matching PNGs. The previous102% startup helper-wait spin is fixed by the
generic cooperative deadline change; this confirms gameplay still advances.
Existing browser gameplay regression: `test/test-funtris-web-launch.js`.
