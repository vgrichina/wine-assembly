# Beneath a Steel Sky — GOG Windows ScummVM

The local fixture is the GOG offline installer recorded under
`gog-free-beneath-a-steel-sky` in `test/candidate-corpus/manifest.json` and
`sources.md`. GOG listed the game at USD 0.00 when the corpus was inventoried;
that price does not make the proprietary installer redistributable, so the
installer and extracted payload remain gitignored local fixtures.

## Payload and launch

The selected English payload contains 113,787,793 bytes (108.5 MiB). Its two
large files are `sky.dsk` at 72,395,713 bytes (69.0 MiB) and the bundled
32-bit Windows `scummvm.exe` at 34,898,432 bytes (33.3 MiB). It is retained
locally at:

```text
test/binaries/candidates/gog-free-beneath-a-steel-sky/installed
```

The runtime is GOG's ScummVM 2.0.0 package. It runs directly in
Wine-Assembly—there is no host Wine process and no DOSBox layer:

```sh
node test/run.js \
  --exe=test/binaries/candidates/gog-free-beneath-a-steel-sky/installed/scummvm/scummvm.exe \
  '--args=-c c:\beneath.ini --path=c:\ beneath' \
  --env=SDL_RENDER_DRIVER=software \
  --vfs-include=../sky.cpt --vfs-include=../sky.dnr \
  --vfs-include=../sky.dsk \
  '--vfs-mount=test/binaries/candidates/gog-free-beneath-a-steel-sky/installed/__support/app/beneath.ini=c:\beneath.ini' \
  --dll-seed=test/binaries/candidates/gog-free-beneath-a-steel-sky/installed/scummvm/SDL2.dll \
  --winver=win2k --screen=800x600 --batch-size=5000
```

`node test/test-beneath-scummvm.js` is the bounded local acceptance. It checks
that ScummVM selects `Beneath a Steel Sky (v0.0372 cd)`, remains live, and
visibly renders the Virgin Interactive splash instead of an empty SDL window.

## Installer investigation

The installer is a two-process Inno Setup package. Wine-Assembly directly ran
the 91,327,544-byte outer PE32/i386 executable. It extracted a 1,259,104-byte
inner runner and called `CreateProcessW`, which Wine-Assembly deliberately does
not implement. The exact child command was recovered with
`--break-api=CreateProcessW`; the inner `.tmp` was then executed directly with
its `/SL5` loader metadata and the original installer mounted at
`C:\setup_beneath_a_steel_sky_1.0_(20270).exe`.

The harness normally exposes a running image as `C:\<basename>`. Using the
inner runner's original basename therefore occupied
`C:\setup_beneath_a_steel_sky_1.0_(20270).tmp`, but Inno later opens that path
with `CREATE_NEW` as a staging destination. The resulting collision produced a
misleading "source file does not exist" dialog. Keeping the `.tmp` extension
while giving the runner a different basename removes the collision and reaches
the Installing page.

That corrected direct run did not complete: after a 900-second bound the setup
log still ended immediately after `Starting the installation process`, and the
VFS contained no destination game files. The changing slideshow and EIP proved
the UI remained live, but this is effectively a hang in the first payload step,
not merely a large install—the complete selected payload is only 108.5 MiB.
For runtime testing, the same GOG Inno records were therefore unpacked with a
local `innoextract` 1.9 build. This is a payload-extraction workaround, not a
claim that the installer completes inside Wine-Assembly.

Like Lure of the Temptress, this SDL 2.0 build needs the per-process
`SDL_RENDER_DRIVER=software` setting. Wine-Assembly's software GDI presentation
then renders the game correctly; no global renderer policy is changed.
