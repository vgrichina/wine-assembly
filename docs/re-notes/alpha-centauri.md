# Sid Meier's Alpha Centauri Classic (Windows 95 ISO)

Established against `SidMeierAlphaCentauriClassic-Windows95.iso`, Joliet
volume `SMAC-E1_0Z` (2,781 files).

## The autorun error is on the disc

The root `AUTORUN.INF` launches `AUTOMENU.EXE`. That wrapper reports:

> There was a problem loading one or more graphic images. Did you forget to
> copy the DATA directory?

The mounted ISO has no directory named `DATA`. Its `AUTOMENU.APM` also embeds
registry paths for an unrelated Jane's Combat Simulations title, so this is a
bad third-party menu packaged into the image, not a failed ISO mount. In the
media picker select `D:\PROGRAMS\TERRAN.EXE` directly.

## Startup API sequence

`TERRAN.EXE` ships `D:\PROGRAMS\ARIALN.TTF` and creates the relative resource
name `ARIALN.FOT` while its current directory is `D:\PROGRAMS`. The CD-ROM is
immutable, so `CreateScalableFontResourceA` validates the TTF and records a
process-local FOT-to-TTF association even when it cannot persist the FOT next
to the source. Subsequent `AddFontResourceA("arialn.fot")` and
`RemoveFontResourceA` resolve through that association.

The next startup stage opens multimedia content and calls
`mmioSetBuffer(hmmio, NULL, 16384, 0)`. Wine-Assembly's host-backed VFS reads
are synchronous, but the API must still accept and reserve the requested
internal storage. With both calls implemented, the exact ISO runs for the
full 180-second probe without an unimplemented-API crash (104,697 API calls,
2,721 batches) and creates the main 640x480 DirectDraw surface.

Focused coverage lives in `test/test-wat-font-resource.js` and
`test/test-wat-mmio.js`.
