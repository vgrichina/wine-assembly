# Wine font sources

These files come from Wine commit
[`ab0b3e2526827110319ea8d0b8a738e629e9472b`](https://gitlab.winehq.org/wine/wine/-/commit/ab0b3e2526827110319ea8d0b8a738e629e9472b),
downloaded from the official Wine GitLab repository on 2026-08-13.

The `.sfd` files are the editable FontForge sources. The matching `.ttf` files
are Wine's generated artifacts and retain the same embedded monochrome bitmap
strikes. They are checked in so `tools/gen-wine-fonts.sh` is reproducible on a
machine with FreeType but without FontForge.

## Bitmap stock-font sources

These feed the generated `.FON` resources consumed by the WAT bitmap font path.

| File | SHA-256 |
|---|---|
| `fixedsys.sfd` | `9019eab07b9a19f994829e88556a5df4332a6cce9543c1aa83ee2433fb58c07c` |
| `fixedsys.ttf` | `097a42b9802617ab884bf19e36fe7f90cfec764f8d74151f82fda9f1b83261d7` |
| `system.sfd` | `88596900ca3df8dcf6ef257793a3b52baf666cc7f72140598bd2aef4787e9a41` |
| `system.ttf` | `fae4ce39aeb8d5fb93a228e43e54342cf6d3b9f8dffe40a5df9a87fefb4d5d7c` |
| `ms_sans_serif.sfd` | `d8cc5e8e93d70478e810b9aa3272006da57e819a063c2b34f5cf92a233b0f3f3` |
| `ms_sans_serif.ttf` | `91877b45939e98d01b4c82e20c575db692c3e82a01ec3748277f3a3471d359cd` |
| `courier.sfd` | `ab712b8cf0682a5dea331b4f518401039099c6426470763da2f8269d0dae6fa8` |
| `courier.ttf` | `61c980bf21584c46cfc3d29a6dcce45ce27d7a7b50356ccc6534b2f783e4483c` |

## Scalable substitute sources

Downloaded from the same commit on 2026-08-14 for the scalable-font work
described in [`../../docs/scalable-font-design.md`](../../docs/scalable-font-design.md).
These are outline (`glyf`) faces; `tahoma` and `small_fonts` additionally carry
embedded monochrome `EBDT` strikes.

| File | SHA-256 |
|---|---|
| `tahoma.sfd` | `0c1a3182a3a6b3d444113421121cbacf87322111aff245ee616109bd47479710` |
| `tahoma.ttf` | `90f1abad4da0ce03da5d2277ee75a9600ce812d37c90eab76e0838ffa7937e55` |
| `tahomabd.sfd` | `90e42b98fc092034e6485a7f8f811195ca2ca148b6704e5d2df56a4c97dfca49` |
| `tahomabd.ttf` | `508a2acc88cd6abdd399ae79c9965db43fba75a46bb115117b55d2be2272d889` |
| `small_fonts.sfd` | `9d31cc3988f1d7ecb6a650ff2b312722b0114bfedc86c03f95c4c15d0b680ca5` |
| `small_fonts.ttf` | `c8b7ec4e4db4b9de2f588094376c21306cf829ad5d90b3238f86b34070b74ef6` |
| `marlett.sfd` | `eaaf88567db49cdacac4ec9e61a4ce14648e682f48343d8b9c9056cb5a1d3970` |
| `marlett.ttf` | `1a9b951ca1815344050ae6158263991e2145918bc74ad65d82bc6ec4056a57d1` |
| `symbol.sfd` | `b146fffd2713a55b7f5101f32b3199b47542c2d5234f61cb5626ce2c886193d6` |
| `symbol.ttf` | `d79da0fbd9a9f3cf806059bb1f2c9d7ce43dd9e3e4c7d4dcc5d9f2759b81196f` |
| `wingding.sfd` | `6d8d42e70c405f41d9a9a3c54479cee0b022b5b0509ab8c9ada0402ac3007478` |
| `wingding.ttf` | `cf5784b53e365ecfad1661b8b23d133effa1d3b54fb7a51137c8a9548f0db08e` |
| `webdings.sfd` | `52eea2ba6ea5bb5e5db89ce2a01e578d7bb768e8da04a0e235fa04a1c1821b09` |
| `webdings.ttf` | `bbaf4df7911928cbb196fc48f1c7237f68aba2aec3e53c01761b89fdd038ac7a` |

Wine's Wingdings (53 glyphs) and Webdings (10 glyphs) are deliberate partial
sets covering only what Wine itself needed; they are approximations with known
gaps, not complete repertoires.

Wine distributes these fonts under the GNU Lesser General Public License,
version 2.1 or later. The complete license is in `../Wine-LGPL-2.1.txt`.
