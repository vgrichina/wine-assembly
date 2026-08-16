# Plain-Mesh `.x` fixtures for D3DRM

Two hand-authored DirectX `.x` files in text format (`xof 0303txt 0032`), each a
`Header` plus a single plain `Mesh`: `tetra.x` (4 verts, 4 faces) and `cube.x`
(8 verts, 12 faces).

They exist because the DX SDK sample `viewer.exe` opens `camera.x`, `mslogo.x`
and `sphere2.x` by name, and **our extract of the SDK contains none of those
files** — every `.x` it ships is a `pm_*.x` ProgressiveMesh. On 2026-04-30 those
three names were fabricated locally by copying `pm_cam.x`, `pm_mslog.x` and
`pm_sph2.x`, which is what produced the long-standing
`D3DRMERR_NOTFOUND (0x88760311)` on `IDirect3DRMMeshBuilder::Load`.

That HRESULT was correct. `MeshBuilder::Load` builds its type filter as a single
`TID_D3DRMMesh` entry and gates the dispatcher's ProgressiveMesh arm on that
filter, so a PM top-level object is refused — a ProgressiveMesh is loaded
through `IDirect3DRMProgressiveMesh::Load`, not through a MeshBuilder. Feeding
`viewer.exe` a real plain-Mesh file loads and renders it.

`test/test-all-exes.js` VFS-imports these over the three fabricated names rather
than replacing the files on disk, so the SDK directory stays as extracted.
