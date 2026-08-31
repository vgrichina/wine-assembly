# Bring Your Own Media — design

Status: **design only, nothing built.** How the browser build grows from
"server-supplied apps" to "drop in your own ISOs, installers, zips and game
folders" — the storage backends, the lazy VFS machinery, the containers, save
sync, and the UI. Written 2026-08-30.

## Where we start from

The browser VFS today has no real storage backend — it is in-memory per
launch, with two small localStorage side-channels:

- **File content lives in RAM.** `VirtualFS` (`lib/filesystem.js`) is a `Map`
  of normalized path → `{data: Uint8Array, attrs}`, built fresh for every
  process. Content arrives over HTTP: the launch fetches the exe/DLLs/data
  files listed in the app's `lib/apps.js` entry via `fetchAssetBytes`
  (`host.js`, with the `.part000` split-file convention), and the file-open
  path mounts user-picked files the same way.
- **Writes are ephemeral unless opted in.** `lib/vfs-persistence.js` wraps the
  mutating VFS methods and saves only paths matching an app's explicit
  `persistFiles` globs into localStorage, as base64-in-JSON, with a 2MB
  per-file cap. Everything an installer writes outside those globs evaporates
  on reload.
- **Registry + INI** are separately localStorage-backed via `lib/storage.js`.

So: read-mostly, server-supplied media, tiny opt-in persistence.

## Storage backends: OPFS for bytes, IndexedDB for metadata

| Backend | Safari | Fit |
|---|---|---|
| **OPFS** (origin-private file system) | Yes, since 15.2; sync handles worker-only | **The byte store.** Real files, byte-range read/write/truncate, no base64 |
| **IndexedDB** | Yes | Library metadata (names, types, hashes); stores Blobs natively, but async-only and slower for big blobs |
| **Cache API** | Yes | URL-keyed chunk cache for *remote* media; not a general FS |
| **localStorage** | Yes | ~5MB, sync, base64 — keep for registry/INI only |
| File System Access pickers (`showOpenFilePicker` etc.) | **No** — Chrome/Edge only | Can't rely on it; `<input type=file>` + drag-drop is the portable import path |

The key Safari detail: OPFS's *synchronous* API (`createSyncAccessHandle` —
read/write at an offset, no promises) is worker-only in every browser, and in
Safari it is the well-supported write path (`createWritable` streams arrived
much later there). That matches our architecture: worker guest threads can
read OPFS synchronously, and the main guest thread goes through the existing
`yield_reason` seam.

**Quotas** (per origin, from MDN/WebKit policy as of 2026-08):

- **Chrome/Edge**: up to 60% of total disk.
- **Firefox**: best-effort 10% of disk capped at 10GB; up to 50% with
  persistent storage.
- **Safari 17+**: roughly 60% of disk in Safari proper (a 1TiB Mac gives an
  origin ~600GiB), ~15% inside another app's WebView. Older Safari was in the
  low-GB range.

**Safari's two real gotchas**, both mitigable:

- **7-day eviction**: with ITP on, all script-writable storage (OPFS and
  IndexedDB included) is wiped if the user hasn't interacted with the site in
  7 days of Safari use. `navigator.storage.persist()` (fully supported since
  Safari 17) exempts the origin — call it in the import flow, and read
  `navigator.storage.estimate()` to show the budget. A home-screen-installed
  web app is also exempt.
- **Private browsing**: OPFS is unavailable; detect and fall back to
  session-only in-memory.

Sources: MDN "Storage quotas and eviction criteria", WebKit blog "Updates to
Storage Policy" (webkit.org/blog/14403), MDN "Origin private file system".

## The big picture

```
 ┌──────────────────────────────────────────────────────────────┐
 │                            USER                              │
 │            drag-drop  ▪  <input type=file>  ▪  URL           │
 └──────────────────────────────┬───────────────────────────────┘
                                │  import
                                ▼
 ┌──────────────────────────────────────────────────────────────┐
 │  SOURCES ── where the raw bytes actually live                │
 │                                                              │
 │   File object        https:// + Range      OPFS copy         │
 │   session-only       streamed remote       "keep this"       │
 │   zero-copy slice    Cache API chunks      survives reload   │
 └──────────────────────────────┬───────────────────────────────┘
                                ▼
 ┌──────────────────────────────────────────────────────────────┐
 │  BYTE PROVIDER ── readRange(off, len) ▪ size ▪ one interface │
 └──────────────────────────────┬───────────────────────────────┘
                                ▼
 ┌──────────────────────────────────────────────────────────────┐
 │  CONTAINER MOUNTS                                            │
 │                                                              │
 │   iso9660   →  D:\                   read-only ▪ range reads │
 │   zip       →  C:\Program Files\<name>\           read-only  │
 │   bare exe  →  C:\                     today's apps.js path  │
 └──────────────────────────────┬───────────────────────────────┘
                                ▼
 ┌──────────────────────────────────────────────────────────────┐
 │  VirtualFS                                                   │
 │                                                              │
 │   eager    { data: Uint8Array }                     (today)  │
 │   lazy     { provider, offset, length }               (new)  │
 │   overlay  writable C:\  →  OPFS                      (new)  │
 └──────────────────────────────┬───────────────────────────────┘
                                ▼
 ┌──────────────────────────────────────────────────────────────┐
 │  EMULATOR    CreateFileA ▪ ReadFile ▪ FindFirstFileA ▪ …     │
 └──────────────────────────────────────────────────────────────┘
```

Everything above `VirtualFS` is new; everything below it doesn't change. The
guest never learns any of this exists.

## The keystone: how a lazy read meets a synchronous guest

The guest's `ReadFile` is synchronous WAT; every interesting source is async.
The bridge is the `yield_reason` mechanism that already exists —
`_fetchMissingFile` in `host.js` does this exact dance today:

```
 guest (WAT, synchronous)               host JS (async world)
 ────────────────────────               ──────────────────────────────
 ReadFile(h, buf, 4096)
    │
    ├── chunk in cache? ── yes ──▶ copy bytes, return    ← fast path,
    │                                                      no yield
    no
    │
    ▼
 $yield_reason = IO_WAIT  ────────────▶ provider.readRange(off, 256KB)
 park guest, end batch                     │
                                           ├─ File.slice().arrayBuffer()
                                           ├─ fetch(url, {Range: …})
                                           └─ OPFS access handle
                                           ▼
                                        chunk lands in LRU cache
    ┌──────────────────────────────────────┘
    ▼
 resume ▪ retry read ▪ cache hit ▪ return n

                              one yield per 256KB chunk with read-ahead,
                              not one yield per ReadFile
```

Worker guest threads get a shortcut: OPFS `createSyncAccessHandle` is
synchronous in a worker, so their reads never yield at all.

The lazy VFS entry carries a provider expressing both read shapes:
`readRange(off, len)` for ISO files and stored zip entries, and
`materialize()` for compressed entries that must be inflated whole.

## ZIP — read tail-first

Read-only container, and the natural packaging for the era: shareware
downloads were zips, and "bring your own game" mostly means "zip the game's
folder and drop it in". Archives-inside-archives come free later (a zip found
on a mounted ISO mounts the same way).

```
 offset 0                                                     tail
 ┌────────────┬────────────┬───────────────────────┬────────────────┐
 │  hdr DATA  │  hdr DATA  │   CENTRAL DIRECTORY   │  EOCD record   │
 │   file A   │   file B   │  names ▪ offsets ▪    │  the pointer   │
 │            │            │  sizes ▪ methods      │  to the dir    │
 └─────┬──────┴────────────┴───────────┬───────────┴───────┬────────┘
       │                              │                   │
       ▼ ③ on open only              ▼ ②                 ▼ ①
   deflated → inflate whole,     one small read       scan last 64KB
   LRU-cache the entry           = the whole          for the EOCD —
   stored   → range-read         catalog              1 Range fetch
   directly, like ISO                                 mounts a remote zip
```

- **Parsing is tail-first**: EOCD scan in the last ~64KB, then the central
  directory gives every entry's name, offset, sizes and method. One Range
  fetch mounts a remote zip; one small `slice()` mounts a local one.
- **Decompression is native**: `DecompressionStream('deflate-raw')` handles
  method 8 in every current browser including Safari. Accept methods 0
  (stored) and 8 (deflate); anything else gets a clear "unsupported method"
  error, never a guess.
- **Lazy granularity differs from ISO**: a deflated entry cannot be
  range-read — the lazy unit is "materialize the whole entry on first open",
  LRU-cached. Era files are small enough that this is the right trade.
- Mount at `C:\Program Files\<zipname>\`; a single top-level folder gets
  unwrapped. Then scan for `.exe`s and offer launch candidates (same shape as
  `test/candidate-corpus/manifest.json`).
- Zip64 (>4GB) explicitly out of scope until a real file needs it.

## ISO 9660 — the friendliest container

```
 ┌──────────────────┬────────────────────┬─────────────────────────────┐
 │  boot reserved   │   PVD  "CD001"     │   directory tree + extents  │
 │  sectors 0…15    │  sector 16         │  each file = (LBA, length)  │
 └──────────────────┴─────────┬──────────┴─────────────┬───────────────┘
                              │                        │
              volume label ◀──┤                        ▼
              root dir LBA ◀──┘             files stored CONTIGUOUS:
                                            readRange(LBA · 2048, len)
                                            no decompression, ever
```

Every file is one contiguous run of sectors — the ideal case for range reads,
local or remote (`fetch` with `Range: bytes=N-M`; needs `Accept-Ranges` and,
cross-origin, CORS — this is how v86/js-dos-style sites stream disk images).
Parse the PVD at sector 16, walk directory records (Joliet supplement for
long names), create lazy entries under `D:\`.

The drive-identity surface is small: `GetDriveType → DRIVE_CDROM`, and
`GetVolumeInformationA` returning the PVD's volume label — what era CD-checks
actually read. Read-only, so no overlay questions: ISO is the easiest mount.

## Writes — the overlay and the save bundle

```
                        guest writes C:\SAVE001.SV
                                    │
                                    ▼
              ┌──────────────────────────────────────────┐
              │           WRITABLE C:\ OVERLAY           │
              │      copy-on-write over the mounts       │
              └──────┬──────────────────────┬────────────┘
            matches  │                      │  everything else
       persistFiles  │                      │  (temp, caches)
                     ▼                      ▼
          ┌─────────────────────┐     gone at exit —
          │     OPFS mirror     │     by design
          │  async batch flush  │
          └──────────┬──────────┘
                     │  zip + timestamp
                     ▼
          ┌─────────────────────────────┐
          │         SAVE BUNDLE         │
          │   saves ▪ registry ▪ INI    │
          │       tens of KB … 1MB      │
          └──────┬───────────────┬──────┘
                 ▼               ▼
          download file     PUT /saves/<code>/<app>
          "memory card" —   berrry KV ▪ opt-in ▪
          works today       cross-device ▪ LWW
```

- The OPFS mirror slots into the existing
  `vfs-persistence.attach(vfs, {storage})` seam and removes the 2MB
  localStorage cap — which is what makes "run the installer, keep the result"
  real. The installed tree becomes a synthesized `apps.js`-style entry.
- **Save sync**: berrry as used today is static hosting behind an owner-keyed
  deploy API (`tools/deploy-berrry.js`) — visitors cannot write to it, and the
  deploy key can never ship to browsers. Sync needs a trivial dynamic
  endpoint (PUT/GET keyed by sync code, size-capped at a few MB) on berrry or
  elsewhere. Saves are tiny — INIs are bytes, even a Diablo save is a few
  hundred KB — so size is a non-issue. Big media never syncs: ISOs are
  content, not state; reference them by hash and reattach saves on re-import.
- **Identity**: a random 128-bit sync code shown once as phrase/QR.
  It cannot live only in localStorage (Safari's purge would wipe the key with
  the saves) — the user keeps the phrase, or a **server-set HTTP cookie**,
  which is exempt from Safari's script-writable-storage eviction.
- **Zero-server fallback first**: export/import the save bundle as a
  downloaded `.zip` — the retro "memory card" gesture; sync is then the same
  bundle PUT to an endpoint. Last-write-wins with timestamps is fine.

## What lives where, and what survives

```
 what                  backend         size         survives
 ────────────────────  ─────────────   ──────────   ─────────────────────
 ISOs ▪ installers     OPFS            MB … GB      reload ✓   purge ✗ *
 media library index   IndexedDB       KB           reload ✓   purge ✗ *
 written C:\ files     OPFS            KB … MB      reload ✓   purge ✗ *
 registry ▪ INI        localStorage    KB           reload ✓   purge ✗ *
 save bundle           berrry ▪ file   KB … 1MB     everything ✓
 sync code             cookie+phrase   16 bytes     purge ✓  (server-set)

 * Safari's 7-day ITP purge — softened by navigator.storage.persist()
   and home-screen install; the save bundle is the belt-and-braces.
   Big media is never precious: on a purge, re-import the ISO and the
   synced saves reattach to it by content hash.
```

## UI

The design principle: **Windows 98 already has UI for removable media.** No
new chrome panel — drive letters, a CD tray, drive Properties with the pie
chart, the Briefcase for sync. The host page (`index.html` desktop) renders
it in the Win98 style it already draws.

### One interaction: drop anything, sniff it, ask one question

```
 dropped bytes ──▶ sniff magic
                    │
                    ├─ "CD001" @ 0x8001 ──▶ ISO dialog ──▶ D:\ + tray CD
                    ├─ "PK.." zip        ──▶ ZIP dialog ──▶ folder + icon
                    ├─ "MZ" + NSIS sig   ──▶ installer  ──▶ run in guest
                    ├─ "MZ" plain        ──▶ bare exe   ──▶ desktop icon
                    └─ anything else     ──▶ data file  ──▶ pick a folder
```

The drop target is the whole desktop:

```
 ┌──────────────────────────────────────────────────────────────┐
 │                                                              │
 │   [S]      [M]      [P]         ╔══════════════════════╗     │
 │   sol      mine     paint       ║                      ║     │
 │                                 ║    +  DIABLO.ISO     ║     │
 │   [D]      [K]                  ║    drop to insert    ║     │
 │   pin      ski                  ║                      ║     │
 │                                 ╚══════════════════════╝     │
 │                                                              │
 ├──────────────────────────────────────────────────────────────┤
 │ [Start]                                       [CD D:]  4:20  │
 └──────────────────────────────────────────────────────────────┘
```

Then one dialog — the only decision the user ever makes:

```
 ┌──────────────────────────────────────────────────┐
 │ ▒ DIABLO.ISO — new media                   ─ □ ✕ │
 ├──────────────────────────────────────────────────┤
 │                                                  │
 │   (CD)   ISO 9660 ▪ label "DIABLO" ▪ 638 MB      │
 │          17 files ▪ found DIABLO.EXE             │
 │                                                  │
 │   (•) Insert as D:\      this session only       │
 │   ( ) Insert and keep    copy into library       │
 │                                                  │
 │   [x] Launch DIABLO.EXE after insert             │
 │                                                  │
 │          [   OK   ]      [ Cancel ]              │
 └──────────────────────────────────────────────────┘
```

Same dialog, three costumes: `(ZIP) 44 files ▪ found KEEN4.EXE ▪ mounts at
C:\Program Files\keen4\`, and for an MZ: `(EXE) looks like an installer
(NSIS) — (•) Run it  ( ) Just add to desktop`. "Session only" is the default —
zero-copy, zero quota, honest about Safari; "keep" streams into OPFS and
calls `persist()`.

### Where things live afterwards

My Computer is the mental model for mounts, My Media is the shelf of imports:

```
 ┌──────────────────────────────────────────────────┐
 │ ▒ My Computer                              ─ □ ✕ │
 ├──────────────────────────────────────────────────┤
 │                                                  │
 │   [C:]        [D:]        [A:]       [Media]     │
 │   WINEASM     DIABLO      (empty)    3 items     │
 │   writable    read-only                          │
 │                                                  │
 └──────────────────────────────────────────────────┘

 ┌──────────────────────────────────────────────────┐
 │ ▒ My Media                                 ─ □ ✕ │
 ├──────────────────────────────────────────────────┤
 │                                                  │
 │  (o) DIABLO.ISO      638 MB   kept ▪ in D:\      │
 │  (o) keen4.zip       1.2 MB   kept               │
 │  (~) QUAKE101.ISO    48 MB    session ▪ [ keep ] │
 │  (@) tomb.iso        remote URL ▪ 210 MB         │
 │                                                  │
 │  [ Import… ]             used 712 MB of 59 GB    │
 └──────────────────────────────────────────────────┘
```

Badge language, used on desktop icons too (same trick as the Win98 shortcut
arrow):

```
 (o) kept       solid icon      in OPFS, survives reload
 (~) session    dotted icon     gone on reload — one tap to keep
 (@) remote     tiny globe      streamed via Range, cached chunks
  ✓  synced     check overlay   save bundle is on berrry
```

A mounted disc shows a CD in the tray (taskbar, right side); right-click →
`Eject D:` unmounts, warning if the guest holds open handles.
Installed/imported games become ordinary desktop icons — synthesized registry
entries whose icons come from the exe via the existing `resources-icon.js`
walker, indistinguishable from the built-in `apps.js` roster.

### Quota and the Safari problem, in period costume

The classic drive-Properties pie is literally `navigator.storage.estimate()`:

```
 ┌────────────────────────────────────────┐
 │ ▒ (C:) Properties                ─ □ ✕ │
 ├────────────────────────────────────────┤
 │                                        │
 │            .──────.                    │
 │          ╱ ▓▓▓░░░░░ ╲                  │
 │         │ ▓▓▓▓░░░░░░ │                 │
 │          ╲ ▓▓▓░░░░░ ╱                  │
 │            '──────'                    │
 │                                        │
 │    ▓ used   712 MB                     │
 │    ░ free    58 GB   (storage.estimate)│
 │                                        │
 │  ┌───────────────────────────────────┐ │
 │  │ ! Safari may clear this after 7   │ │
 │  │   quiet days.  [ Keep my stuff ]  │ │
 │  └───────────────────────────────────┘ │
 └────────────────────────────────────────┘
```

`[ Keep my stuff ]` calls `navigator.storage.persist()`; the warning strip
appears only when `persisted()` is false and the browser is Safari.

### Saves: the Briefcase

Win98's Briefcase *was* the sync feature:

```
 ┌──────────────────────────────────────────────┐
 │ ▒ Briefcase — game saves               ─ □ ✕ │
 ├──────────────────────────────────────────────┤
 │                                              │
 │   diablo     spawn0.sv ▪ 232 KB   synced ✓   │
 │   sol        sol.ini   ▪ 1 KB     synced ✓   │
 │   caesar3    c3.sav    ▪ 890 KB   local only │
 │                                              │
 │   sync code:  ferry-lamp-oak-42   [ copy ]   │
 │                                              │
 │   [ Export .zip ]  [ Sync now ]  [ Link… ]   │
 └──────────────────────────────────────────────┘
```

`Export .zip` is the memory-card gesture that works with no server; `Link…`
shows the sync code as phrase + QR for the second device. Rows come straight
from each app's `persistFiles` matches plus its `storage.js` registry/INI
slice.

### The phone

No drag-drop on iOS, so import is a button; the persistence pitch becomes an
Add-to-Home-Screen card (which also exempts the origin from the 7-day purge —
the card is load-bearing, not decorative):

```
 ┌────────────────────────────┐
 │ ≡  wine-assembly        +  │
 ├────────────────────────────┤
 │                            │
 │   [S]   [M]   [P]   [D]    │
 │   sol   mine  paint diablo │
 │                            │
 │ ┌────────────────────────┐ │
 │ │ + Add a game…          │ │
 │ │   .iso .zip .exe       │ │
 │ └────────────────────────┘ │
 │                            │
 │ ┌────────────────────────┐ │
 │ │ ! Add to Home Screen   │ │
 │ │   to keep your games   │ │
 │ └────────────────────────┘ │
 └────────────────────────────┘
```

The `+` opens `<input type=file>` (Safari has no `showOpenFilePicker`; the
input accepts anything from Files/iCloud). Everything else — dialog, shelf,
badges — is the same components, single column.

### Implementation seams

All of this is host-page DOM in the existing Win98 skin, like the desktop and
dropdown already are — it exists before any guest runs, so it can't be a
guest window. The one exception worth considering later: My Computer browsing
*inside* a running guest could be a WAT-native window (the `0xFFFF0001`
wndproc path, like the help viewer and the Screen Savers applet), so the
guest's own file dialogs see the same drives. Every state shown here reads
from the same IndexedDB library index the mount layer uses — the UI holds no
state of its own, so the CLI and the browser stay two views of one model.

## Build order

```
 ①  byte provider ▪ lazy entry ▪ yield read path    ── the keystone
 ②  zip mount (read-only)                           ── first BYO win
 ③  iso9660 mount ▪ D:\ identity                    ── CD games
 ④  OPFS media library ▪ import UI ▪ persist()      ── "keep this"
 ⑤  writable C:\ overlay on OPFS                    ── installers survive
 ⑥  save bundle: export file, then berrry sync      ── cross-device
```

① is the only structural change to existing code; ②–⑥ stack on it
independently, and each step ships something a user can feel. One
cross-cutting rule: the parsers and providers live in `lib/` with a Node byte
provider (`fs.read`), so `test/run.js --iso=` / `--zip=` exercises the
identical code headlessly — CLI parity is what keeps all of this testable
(and gives `tools/iso-dir.js` / a zip lister for free, per the
build-tools-not-scripts rule).
