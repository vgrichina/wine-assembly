# Total Annihilation demo

The original `Total Annihilation.exe` self-extractor is retained locally at
`test/binaries/candidates/total-annihilation-demo/`. The end-to-end regression
runs that unchanged Win32 installer, accepts its native EULA, clicks Install,
and launches the resulting untouched `TADemo.exe` with `TADemo.hpi` mounted at
`C:\tademo.hpi`. No host-side archive extraction is used.

## Exact files

| File | SHA-256 |
|---|---|
| `Total Annihilation.exe` | `5e41cf05226c274b4ac9e4398f74f6b321506bd7a4317ee1744ff7aceba34c49` |
| `TADemo.exe` | `216e4f39617cb979cd2bc1fba92e9e5136b33a98790d9fc6d3d1cb901ecfbb57` |
| `TADemo.hpi` | `fd53a2637ecf8fb5ca6d2c02a34b4ef783a4441f8be070137276afc4d5627e1e` |

The native installer route matters. Its `ADD` resources are larger than the
old PE staging buffer, and running it in the emulator exposed both string-form
`#decimal` resource lookup and mapped-section-tail hydration bugs. Do not
replace this with host-side archive extraction.

## Gameplay route

`test/test-total-annihilation-candidate.js` uses the frozen stdin CLI at
640x480, with a 20,000-block batch and 16ms deterministic tick:

1. Run the original installer through EULA, destination, extraction, and its
   completion dialog; verify the fresh EXE and HPI hashes.
2. Run 1,600 batches to the animated title menu and click **Single**.
3. Click **New Campaign**, retain **Arm**, and click **Start**.
4. At the `MISSION 10001ARME` briefing, click **Start**.
5. Capture the live battlefield, hold Right, and verify the scrolled frame
   changes by more than 5,000 pixels.

The inspected 2026-09-03 run rendered the Cavedog logo, title menu, campaign
selector, mission briefing, and the first Arm battlefield with units, terrain,
commander, minimap, metal/energy HUD, and active simulation. Screenshots are
written under `build/total-annihilation-candidate/`.

The CLI remains parked between commands. Its `--max-seconds=180` is only the
test safety bound; the automated path contains no inspection delays.

## Distribution

This is a publisher demo, not freeware. The EULA embedded in the original
installer expressly permits using, copying, and distributing the program only
when every copy includes the notice, no fee is charged for the copy or its
distribution, the stated reverse-engineering restriction is observed except
where law prevents it, and the recipient accepts its as-is/no-warranty and
no-liability terms. Preserve the complete original package and notice; do not
publish the extracted runtime as a substitute package.
