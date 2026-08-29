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

The browser's experimental Worker backend is functional but substantially
slower during UE1 startup. An exact isolated Chrome run stayed live (changing
main-thread EIPs, no trapped Worker), created its third Worker and 648x508 game
window after roughly 45 seconds, and progressed from the gray allocation frame
through the animated Deus Ex title. It was still in that title sequence around
90–110 seconds. Keyboard events were routed with `hwnd=0` in this mode even
after a scripted viewport click, so the interactive acceptance remains the
cooperative backend; leave Threads off for the responsive demo path.

Compatibility work required for this route:

- root-clamped VFS `..` normalization for UE1 sibling asset wildcards;
- extensionless absolute DLL lookup (`C:\Core` matching `Core.dll`);
- `GetProcessWorkingSetSize` and `IsProcessorFeaturePresent` startup behavior.
