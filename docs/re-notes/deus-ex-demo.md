# Deus Ex demo — local candidate

The official 1.002f demo is pinned in `test/candidate-corpus/manifest.json` from
Archive item `DeusExDemo`. Its bundled license permits private/domestic use but
does not grant redistribution, so the extracted fixture stays ignored and must
not be deployed or rehosted.

Fetch and test:

```sh
node tools/fetch-candidate-corpus.js --id=deus-ex-demo
node test/test-deus-ex-demo.js
```

The test uses a generated local INI to skip the first-run renderer wizard and
select the software renderer. It seeds the native UE1 DLLs, mounts the sibling
packages/maps/textures, dismisses the startup sequence, opens New Game, and
requires the rendered Training Mission prompt plus live audio. The acceptance
is not process-only.

Compatibility work required for this route:

- root-clamped VFS `..` normalization for UE1 sibling asset wildcards;
- extensionless absolute DLL lookup (`C:\Core` matching `Core.dll`);
- `GetProcessWorkingSetSize` and `IsProcessorFeaturePresent` startup behavior.

