# Reviewed Windows 98 References

These 640x480 captures are the visually reviewed reference corpus produced by
`tools/v86-reference/capture.js` with the pinned v86 Windows 98 profile.

Every PNG has a JSON sidecar recording the v86 revision, VM asset sources,
application payload hashes, capture dimensions, and PNG SHA-256. The test suite
checks that every non-skipped target in `tools/v86-reference/apps.json` is
represented and that each digest matches.

The images document native Windows 98 rendering. They are not VM firmware,
disk images, saved states, executable payloads, or runtime binaries.
