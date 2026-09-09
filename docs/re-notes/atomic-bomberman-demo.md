# Atomic Bomberman alpha demo

## Package

The tested April 7, 1997 alpha is the ready-to-run `BMANDEMO` tree from the
local Windows 98 A-D compatibility archive documented in `sources.md`. That
selected package contains no setup program, cabinet, or self-extractor, so
launching `_BOMB.EXE` does not bypass an available installer. The package and
all gameplay files stay local and gitignored.

Pinned SHA-256 values:

- `_BOMB.EXE`: `0ff14a352d6626660ceb66ea0e6743cd33c457e754cfd5705120bacae0530638`
- `LEVELS.DAT`: `7f647eb426f93799e190b5697bec20c81d350cc5cc23b0adc9a29e2d814ad796`
- `README.BM`: `8cf26bf5541592dae04769eb3e50a90b506214dd1941ab84b15f445faadf3433`

The bundled readme describes the release as unsupported and says all rights
are reserved. It grants no redistribution permission, so neither the loose
tree nor the executable belongs in a public deployment.

## Gameplay route

`test/test-atomic-bomberman-gameplay.js` launches the registered browser app
in headless Chromium. It waits for each publisher logo to render, skips it,
and synchronizes on the title, main menu, input selection, options, and arena
frames. Four Enter presses select
Start Regular Game, keyboard input, the default level options, and the match.

The acceptance then holds Right, presses Space, and captures the arena before
movement, after movement, with a placed bomb, and during its explosion. It
requires the game to remain live, rejects browser/runtime compatibility
failures, and checks rich arena pixels, visible movement, bomb placement, and
explosion colors. Captures are written to
`build/local-candidate-smoke/atomic-bomberman/`.

Run explicitly with:

```bash
node test/test-atomic-bomberman-gameplay.js
```
