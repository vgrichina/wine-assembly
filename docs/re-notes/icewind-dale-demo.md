# Icewind Dale demo — local candidate

The official English demo is pinned in `test/candidate-corpus/manifest.json`
from Archive item `icewind_dale_eng_demo`. Its README expressly prohibits
copying/electronic distribution, so the extracted fixture stays ignored and
must not be deployed or rehosted.

Fetch and test (the fetch recipe requires `unshield`):

```sh
node tools/fetch-candidate-corpus.js --id=icewind-dale-demo
node test/test-icewind-dale-demo.js
```

The package is an outer ZIP containing an InstallShield cabinet and CD-resident
data. The fetch recipe extracts the `Recommended compressed` group and merges
the official `CD2/Data` tree into the local installed `Data` directory. Without
that merge the real executable renders its “insert CD in D:\” screen forever.

The smoke test reaches the 640x480 Icewind Dale menu, injects a real mouse
press/release into its DirectDraw window, and requires the resulting centered
modal to change the rendered frame. Dynamic menu labels currently render
blank, so this is an interactive menu acceptance, not a gameplay claim.

