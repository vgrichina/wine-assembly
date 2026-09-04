# Total Annihilation Demo

## Original installer

The local fixture is the unchanged 21,540,864-byte `Total Annihilation.exe`
self-extractor linked from `sources.md`. Wine-Assembly runs that executable
directly. Its numeric `ADD` resources produce `TADemo.exe`, `TADemo.hpi`, and
the readme; the browser/CLI app launches those installer-produced files rather
than a host-extracted substitute. The installer and installed payload remain
local and gitignored.

## Frozen gameplay route

`test/test-total-annihilation-gameplay.js` launches the registered
`total_annihilation_demo` app through the headless CLI with frozen stdio
control and the internal `--max-seconds` guard. It advances to the title menu,
then uses real canvas clicks for **Single**, **New Campaign**, the default Arm
campaign on Medium difficulty, and the mission briefing's **Start** button.

The unchanged game completes its textures, terrain, units, animation, 3D data,
and explosions load phases and enters the first battlefield. The visual gate
requires green terrain, the left-side minimap, the Metal/Energy resource HUD,
and a rendered pointer response after real edge input. The four preceding menu
clicks each advance the game to a distinct screen. The manually inspected capture is
`/private/tmp/ta-frozen-gameplay.png`; an explicit run can retain its final
frame with:

```bash
TA_SCREENSHOT=/private/tmp/ta-gameplay.png \
  node test/test-total-annihilation-gameplay.js
```

The route reaches gameplay after 69,000 controlled 1,000-block batches on the
current build. Intermediate reviewed captures are
`/private/tmp/ta-frozen-menu.png`, `/private/tmp/ta-frozen-single.png`,
`/private/tmp/ta-frozen-campaign.png`, and
`/private/tmp/ta-frozen-started.png`.
