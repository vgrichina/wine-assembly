# DOS game corpus

This manifest records official playable DOS game demos separately from the
small scene-program corpus. Payloads live under the ignored
`test/binaries/dos-games/` tree and are never deployment assets unless their
redistribution terms are independently cleared.

Fetch the pinned local fixtures with:

```sh
node tools/fetch-dos-game-corpus.js
```

The first entry is the official 1997 Grand Theft Auto Liberty City demo. Keep
its complete `GTA24` tree: `DEMO24.EXE` is a DOS/4GW, VESA game and depends on
the sibling drivers, configuration, maps, graphics, and audio data.
