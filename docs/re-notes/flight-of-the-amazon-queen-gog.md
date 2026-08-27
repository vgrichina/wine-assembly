# Flight of the Amazon Queen — GOG Windows ScummVM

The local fixture is the GOG offline installer recorded under
`gog-free-flight-of-the-amazon-queen` in
`test/candidate-corpus/manifest.json` and `sources.md`. GOG listed the game at
USD 0.00 when the corpus was inventoried; that price does not make the
proprietary installer redistributable, so the installer and extracted payload
remain gitignored local fixtures.

## Payload and launch

The selected English payload contains 236,240,681 bytes (225.3 MiB). Its large
files include `queen.1` at 190,787,021 bytes (181.9 MiB) and the bundled 32-bit
Windows `scummvm.exe` at 34,898,432 bytes (33.3 MiB). It is retained locally at:

```text
test/binaries/candidates/gog-free-flight-of-the-amazon-queen/installed
```

The runtime is GOG's ScummVM 2.0.0 package. It runs directly in
Wine-Assembly—there is no host Wine process and no DOSBox layer:

```sh
node test/run.js \
  --exe=test/binaries/candidates/gog-free-flight-of-the-amazon-queen/installed/scummvm/scummvm.exe \
  '--args=-c c:\queen.ini --path=c:\ queen' \
  --env=SDL_RENDER_DRIVER=software \
  --vfs-include=../queen.1 \
  '--vfs-mount=test/binaries/candidates/gog-free-flight-of-the-amazon-queen/installed/__support/app/queen.ini=c:\queen.ini' \
  --dll-seed=test/binaries/candidates/gog-free-flight-of-the-amazon-queen/installed/scummvm/SDL2.dll \
  --winver=win2k --screen=800x600 --batch-size=5000
```

`node test/test-fotaq-scummvm.js` is the bounded local acceptance. It checks
that ScummVM selects `Flight of the Amazon Queen (Talkie/DOS/English)`, remains
live, and visibly renders the gold Amazon Queen title plus cyan copyright copy
instead of an empty SDL window.

## Installer investigation

The installer is a two-process Inno Setup package. Wine-Assembly directly ran
the 140,413,224-byte outer PE32/i386 executable, extracted a 1,259,104-byte
inner runner, and called `CreateProcessW`. Wine-Assembly deliberately leaves
that API unimplemented. Dumping the child command recovered the exact loader
metadata:

```text
/SL5="$10001,139876477,185856,C:\setup_flight_of_the_amazon_queen_1.0_(20270).exe"
```

As with Beneath a Steel Sky, the inner runner must keep its `.tmp` extension
but use a different basename so the harness's automatic `C:\<basename>` mount
does not occupy Inno's staging destination. Executed that way and with the
original installer explicitly mounted, the inner runner opens
`Setup - Flight of the Amazon Queen` and recognizes its original setup EXE.

A 90-second direct silent run extracted the GOG support DLLs, EULA, and fonts,
but never created a destination game file; its setup log ended during temporary
support-file extraction. The game payload was therefore unpacked from the same
GOG Inno records with a local `innoextract` 1.9 build. This is a local
payload-extraction workaround, not a claim that the installer completes inside
Wine-Assembly.

Like the other GOG ScummVM fixtures, this SDL 2.0 build needs the per-process
`SDL_RENDER_DRIVER=software` setting. Wine-Assembly's software GDI presentation
then renders the game correctly; no global renderer policy is changed.
