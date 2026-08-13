# GDI migration status

The machine-readable inventory is
[`gdi-migration-status.json`](gdi-migration-status.json). It classifies every
`gdi_*` import in `src/01-header.wat` by functional area and current ownership.
`test/test-gdi-migration-status.js` rejects missing, duplicate, or stale entries.

Ownership labels mean:

- `wat_owned_presentation_bridge`: WAT owns semantics; JavaScript only rebuilds
  or uploads derived browser presentation data.
- `wat_semantics_with_host_mirror_or_fallback`: WAT owns the supported path,
  but a JavaScript mirror or compatibility path is still reachable.
- `host_read_only_descriptor`: JavaScript exposes state or storage to a WAT
  rasterizer. Ownership has not fully moved because the descriptor source is
  still JavaScript.
- `host_owned`: the operation or state remains implemented in JavaScript.
- `canvas_text_policy`: retained JavaScript/Canvas font policy, outside the
  non-text migration target.

This records implementation ownership, not Win98 pixel fidelity. Wide-line
pixel masks under `test/fixtures` are deterministic migration regressions until
they are replaced or supplemented by independently captured Win98 references.
