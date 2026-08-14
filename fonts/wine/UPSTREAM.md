# Wine bitmap font sources

These files come from Wine commit
[`ab0b3e2526827110319ea8d0b8a738e629e9472b`](https://gitlab.winehq.org/wine/wine/-/commit/ab0b3e2526827110319ea8d0b8a738e629e9472b),
downloaded from the official Wine GitLab repository on 2026-08-13.

The `.sfd` files are the editable FontForge sources. The matching `.ttf` files
are Wine's generated artifacts and retain the same embedded monochrome bitmap
strikes. They are checked in so `tools/gen-wine-fonts.sh` is reproducible on a
machine with FreeType but without FontForge.

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

Wine distributes these fonts under the GNU Lesser General Public License,
version 2.1 or later. The complete license is in `../Wine-LGPL-2.1.txt`.
