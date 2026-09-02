# Bring Your Own Media — design

Status: **all six phases landed** (4d7497ed provider/lazy-VFS, 6a876ff0 zip,
60407f55 iso + WAT parking, 29dab90a/9c1003b9 overlay, 0995b5a7 save
bundles/sync, ed3d7b72 import UI + media library); this doc now records the
as-built contracts plus the remaining follow-ups in the risk register and
"Overlay semantics". How the browser build grows
from "server-supplied apps" to "drop in your own ISOs, installers, zips and
game folders" — the storage backends, the lazy VFS machinery, the containers,
save sync, and the UI. Written 2026-08-30; corrected the same day from an
external (codex) review — see the risk register at the end.

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
| **IndexedDB** | Yes | Library metadata (names, types, hashes); stores Blobs natively, async-only — a transactional object store, not byte-range I/O |
| **Cache API** | Yes | Chunk cache for *remote* media — but `Cache.put()` rejects 206 responses, so chunks must be wrapped as synthetic 200s keyed by a synthetic URL (media id + validator + offset + length), or simply kept in OPFS/IDB |
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
- **Safari 17+**: policy ceiling of roughly 60% of disk in Safari proper,
  ~15% inside another app's WebView. These are *ceilings, not allocations* —
  `navigator.storage.estimate().quota` is approximate, varies with free disk
  and browsing mode, and doesn't guarantee that much can actually be written.
  Older Safari started around 1GiB and could prompt for more.

**Safari's two real gotchas**, both mitigable:

- **7-day eviction**: with ITP on, all script-writable storage (OPFS and
  IndexedDB included) is wiped if the user hasn't interacted with the site in
  7 days of Safari use. `navigator.storage.persist()` (fully supported since
  Safari 17) *requests* eviction protection — it can return `false`, so the
  import flow must await the result and surface failure, not treat the call
  as durability. Home-screen installation improves retention (separate
  interaction accounting) but is not a categorical exemption either. Read
  `navigator.storage.estimate()` to show the budget — and label it "site
  storage available", because it is origin headroom, not disk free space.
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
 │   no-copy import     cached chunks         survives reload   │
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
 │   cue/bin   →  D:\ + CD-DA          data ranges ▪ lazy PCM │
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

Everything above `VirtualFS` is new, and the guest never learns any of it
exists. But "below it doesn't change" is only true for the *interface* —
`entry.data` has many direct consumers (ReadFile, `_lread`, MapViewOfFile
and mapped-view writeback, copy/truncate/write, DLL and resource loading,
audio) and each must either support the parked read or force
pre-materialization; see the risk register.

## The keystone: how a lazy read meets a synchronous guest

The guest's `ReadFile` is synchronous WAT; every interesting source is async.
The bridge is the `yield_reason` mechanism — but note this is *harder than
prior art*: `_fetchMissingFile` in `host.js` only starts a fetch and mounts
the file later (its consumers don't need the bytes in the same turn), and a
JS host import cannot suspend and resume its Wasm caller. Parking must happen
in WAT, before the handler pops its stdcall frame, with EIP reset to the
thunk (`src/09b-dispatch.wat` documents the constraint). The continuation
contract: a pending status the handler observes, unchanged file position,
restored ESP, EIP at the thunk for retry, per-thread/per-handle keyed pending
state (never one global), request dedup, and an error latch so a failed fill
completes the call with a Win32 error instead of retrying forever.

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

Worker guest threads do NOT get a free shortcut today: they broker every
host import through `lib/guest-rpc.js` to the main thread and expect an
immediate numeric result, so worker-local OPFS (`createSyncAccessHandle` is
synchronous in a worker) would need a separate worker-side filesystem import
implementation with provider/handle ownership and shared-position sync. It's
the right end state, not a given.

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

- **Parsing is tail-first**: EOCD scan over the trailing 65,557 bytes
  (22-byte EOCD + max 65,535-byte comment), then read the central directory —
  which may lie *outside* that tail, so the general remote case is a tail
  fetch plus a directory fetch; one-request mounting is an optimization. The
  central directory's offset points at the *local* file header — the reader
  must skip that header's own filename/extra fields to find the payload.
- **Decompression is native**: `DecompressionStream('deflate-raw')` handles
  method 8 — but it arrived in Safari 16.4, a later floor than OPFS's 15.2;
  accept that floor (or ship an inflater fallback). Accept methods 0 (stored)
  and 8 (deflate); anything else gets a clear "unsupported method" error,
  never a guess.
- **Archives are untrusted input**: verify CRC-32 after inflation; enforce a
  hard materialization budget against the declared uncompressed size (zip
  bombs); reject encrypted entries and unknown required GP flags; sanitize
  paths (no absolute/UNC/device names, no `..` — "Zip Slip"), and define
  collision behavior after Win32 case-folding and folder unwrapping. Name
  encoding: GP bit 11 → UTF-8, else the 0x7075 Unicode Path extra field, else
  CP437-ish fallback.
- **Lazy granularity differs from ISO**: a deflated entry cannot be
  range-read — the lazy unit is "materialize the whole entry on first open",
  LRU-cached, subject to the materialization budget above (installers can
  carry videos and nested archives; refuse before allocating).
- Mount at `C:\Program Files\<zipname>\`; a single top-level folder gets
  unwrapped. Then scan for `.exe`s and offer launch candidates (same shape as
  `test/candidate-corpus/manifest.json`).
- Zip64 out of scope — but its triggers are broader than ">4GB": 65,535+
  entries and 0xFFFF/0xFFFFFFFF sentinel values in any count/size/offset
  field. Detect the sentinels and reject explicitly.

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

Files are *typically* one contiguous run of blocks — the ideal case for range
reads, local or remote (`fetch` with `Range: bytes=N-M`; `Accept-Ranges` is
advisory, so correctness means checking for a 206, validating
`Content-Range`, and handling a server that answers with the whole file as a
200; cross-origin also needs CORS — this is how v86/js-dos-style sites stream
disk images). But contiguity is not a format guarantee: multi-extent files
(record flag bit 7) and interleaved file units exist, and the parser must
detect and explicitly reject them, never silently truncate. Parsing details
that matter: sector 16 starts the volume descriptor *sequence* (a boot record
may precede the PVD — scan until the type-255 terminator); Joliet is a full
supplementary descriptor with its own UCS-2BE root tree, walked *instead of*
the PVD's; offsets use the PVD's Logical Block Size field, not a hardcoded
2048; honor each record's Extended Attribute Record length; strip `;1`
version suffixes; records never cross sector boundaries (a zero length byte
skips to the next sector). Create lazy entries under `D:\`.

The *first-milestone* drive-identity surface: `GetDriveType → DRIVE_CDROM`,
and `GetVolumeInformationA` returning the PVD's volume label (and serial, if
cheap). Real CD checks can also probe volume serials, `GetLogicalDrives`,
`GetDiskFreeSpaceA`, root enumeration, MCI CD audio, or raw device opens —
those stay fail-fast until a real app demands one. Read-only, so no overlay
questions: ISO is still the easiest mount. `GetLogicalDrives`, fabricated
free-space geometry and raw device opens remain follow-ups; MCI CD audio is
implemented by the mixed-mode path below.

### Mixed-mode CUE/BIN — data and soundtrack are one disc

A Redump-style PC game is a set, not one file: a small `.cue`, one raw
MODE1/2352 data BIN, and one or more raw AUDIO BINs (or a shared BIN with
several indexed tracks). The picker and drop handler therefore analyze all
files from one selection together. Each CUE consumes the safe relative names
it references; a missing or ambiguous part is rejected with a request to
select the complete set rather than importing the BINs as unrelated files.

The raw data track is not copied into a synthesized ISO. A provider view maps
each 2352-byte mode-1 sector to its 2048-byte user-data payload at offset 16,
and `iso9660` parses/mounts that virtual stream at `D:\`. This preserves the
same chunk-cache and parked-read behavior as a standalone ISO. The CUE table
of contents is attached to that same CD-ROM drive.

Audio BINs remain unopened at analysis and mount time. MCI `cdaudio`
open/status/play/pause/resume/stop/close calls use the CUE's MSF/TMSF track
positions; playback reads only the requested backing BIN and decodes raw
44.1kHz signed 16-bit stereo PCM onto the Wave mixer bus. A kept set is one
IndexedDB catalog row with multiple OPFS part files. Original part names are
stored in the row, so a reload can resolve the CUE again even though the OPFS
filenames themselves are opaque. Existing schema-1 single-file library rows
remain valid.

A standalone raw BIN gets a deliberately best-effort fallback. If its
2352-byte Mode 1 sectors expose a valid ISO 9660 volume, that data volume is
mounted at `D:\` and the insert dialog warns that a matching CUE is required
for authoritative track layout, pregaps, and exact CD-audio timing. The
fallback scans sectors after the ISO volume: authentic Mode 1 headers extend
the data track through mastered padding, while smooth signed 16-bit stereo PCM
identifies a likely audio tail. Repeated 120–225-sector digital-silence runs
with consistent lengths and plausible spacing become inferred track pregaps.
If PCM is convincing but those boundaries are not, the complete tail is
offered as one combined audio track. Ambiguous/random-looking tails remain
unmounted. Every inferred result stays visibly labelled as best effort; a CUE
always wins when supplied.

The same multi-file selection rule covers offline installers: a setup `.exe`
and numbered `.bin` files sharing its full basename are one import, stored
together and mounted beside one another on `C:\`. This is the generic path for
GOG-style offline packages; it does not depend on a title-specific catalog
entry.

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
          download file     POST /api/data/wine-saves-<app>
          "memory card" —   berrry account ▪ opt-in ▪
          works today       cross-device ▪ LWW
```

- The OPFS mirror reuses the *wrapping* idea of
  `vfs-persistence.attach(vfs, {storage})` but is not a drop-in `storage`
  swap: that seam assumes synchronous Web Storage calls and serializes whole
  `entry.data` buffers. OPFS needs an async persistence repository — dirty
  extents, batched flush with error state, startup hydration, unload flush.
- The `persistFiles` allow-list is for *registered* apps' saves. An arbitrary
  installer has no `apps.js` entry and no globs — "run the installer, keep
  the result" means persisting the **complete per-import overlay** (or the
  installer's recorded mutation set), with save-specific filtering applied
  later. The installed tree then becomes a synthesized `apps.js`-style entry.
- **Save sync**: berrry has a **production per-user data API** that deployed
  apps call same-origin (docs: `GET /api/nomcp/docs/backend` on berrry.app;
  the owner-keyed deploy API in `tools/deploy-berrry.js` is a separate,
  unrelated surface): `POST/GET/PUT/DELETE /api/data/:key` stores JSON *or*
  binary (multipart or a raw Content-Type) privately per authenticated berrry
  user, with `GET /api/data/:key/metadata` giving `updatedAt` for
  last-write-wins. So the sync target is `/api/data/wine-saves-<appId>` with
  the bundle as `application/zip` — no server to build. `lib/save-sync.js`
  speaks this protocol with a configurable base (default same-origin);
  `tools/save-sync-server.js` *emulates* the same API shape so headless tests
  exercise the identical client code. Saves are tiny — INIs are bytes, even a
  Diablo save is a few hundred KB — so size is a non-issue. Big media never
  syncs: ISOs are content, not state; reference them by hash and reattach
  saves on re-import.
- **Identity**: the user's berrry account. `GET /api/auth/user` says who is
  signed in (401 otherwise); sign-in is a redirect to `/api/auth/login`,
  which bounces back to the app, and the session cookie is server-set — the
  durable slot Safari's purge doesn't touch. Saves follow the account across
  devices; no sync-code phrase to lose. Signed-out users keep the full local
  experience plus the export-file path below.
- **Zero-server fallback first**: export/import the save bundle as a
  downloaded `.zip` — the retro "memory card" gesture; sync is then the same
  bundle PUT to an endpoint. Last-write-wins with timestamps is fine.
  Implemented in `lib/save-bundle.js` (a deterministic store-only zip holding
  `manifest.json` + `vfs/…` + `registry.json` + `ini.json`, every member
  SHA-256'd and every path re-checked against the running app's own
  `persistFiles` globs on import), driven headlessly by `test/run.js
  --export-saves=FILE` / `--import-saves=FILE` and inspected by
  `tools/save-bundle.js`.

## What lives where, and what survives

```
 what                  backend         size         survives
 ────────────────────  ─────────────   ──────────   ─────────────────────
 ISOs ▪ installers     OPFS            MB … GB      reload ✓   purge ✗ *
 media library index   IndexedDB       KB           reload ✓   purge ✗ *
 written C:\ files     OPFS            KB … MB      reload ✓   purge ✗ *
 registry ▪ INI        localStorage    KB           reload ✓   purge ✗ *
 save bundle           berrry ▪ file   KB … 1MB     everything ✓
 sync identity         berrry session  cookie       purge ✓  (server-set)

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
 selected files ─▶ group any .cue with its referenced .bin files
                    │
                    ├─ CUE/BIN set         ──▶ mixed CD dialog ──▶ D:\ + CD-DA
                    ▼
                  sniff magic
                    │
                    ├─ "CD001" @ 0x8001 ──▶ ISO dialog ──▶ D:\ + tray CD
                    ├─ raw Mode 1 + ISO  ──▶ warned best effort ──▶ D:\ data
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
 │   signed in:  vg @ berrry        [ log out ]  │
 │                                              │
 │   [ Export .zip ]  [ Sync now ]  [ Sign in ] │
 └──────────────────────────────────────────────┘
```

`Export .zip` is the memory-card gesture that works with no server or
account; `Sign in` redirects to berrry's `/api/auth/login` (it bounces back
to the app), after which saves follow the account to any device. Rows come
straight from each app's `persistFiles` matches plus its `storage.js`
registry/INI slice.

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

Integration realities the mocks gloss over (from review):

- DOM windows are a *second window manager*: they don't participate in guest
  z-order, focus, modal capture, or the renderer-owned taskbar
  (`renderer.updateTaskbar()` rebuilds task buttons from guest windows only).
  Either add a shared shell-window registry or keep these panels visually
  outside the taskbar/window metaphor. And Eject/Properties/My Media must
  stay reachable *while a guest runs* — exactly when the canvas owns input.
- Imported apps need a **dynamic registry**: desktop icons are built once
  from static `apps.js`, launch rejects unknown ids
  (`lib/browser-shell.js`), and `loadExe`/`resources-icon.js` assume URLs to
  fetch. A synthesized entry needs a launch descriptor that accepts
  bytes/providers, and the icon extractor needs a bytes entry point.
- The drop target must be wired on `#screen-wrap`/capture-phase listeners
  with `preventDefault()` (the canvas already overlays the desktop icons),
  with an explicit policy for drops while a guest owns the canvas.
- "One decision" is the goal, not the guarantee: archives with several exes,
  or none, need a candidate-picker step; folder imports need
  `webkitdirectory` + drag-drop traversal (with no iOS folder story).
- Phone mode hides the taskbar entirely in-game, so the CD-tray affordance
  needs a persistent mobile control or a pause/shell gesture.

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

## Risk register (codex review, 2026-08-30)

Architectural cautions not yet resolved by the design; each is a decision to
make during the phase that hits it, not a reason to redesign now:

1. **Parking contract completeness (①)** — every `entry.data` consumer must
   be classified: parked-read capable (ReadFile) or pre-materialize at
   CreateFile/MapViewOfFile time (`_lread`, mappings and writeback, module/
   resource/audio loads, copy/truncate/write). A "pending" throw that unwinds
   nested Wasm is never acceptable.
2. **Worker-thread I/O (①)** — `lib/guest-rpc.js` brokers imports to the
   main thread and expects an immediate numeric result; worker-local OPFS is
   a separate follow-up project (worker-side FS imports, handle ownership,
   shared position sync).
3. **Overlay semantics (⑤)** — read-only mount under a writable C: needs
   whiteouts, rename/delete-through rules, case-insensitive collision
   handling, and copy-on-write that cannot synchronously materialize a large
   uncached provider file. Needs its own mini-design before ⑤ starts.
4. **Crash consistency (④)** — IDB metadata and OPFS content can't share a
   transaction: imports need staged states (`copying → complete`), content
   validators, orphan cleanup, schema versioning.
5. **32-bit ceilings** — enumeration publishes a zero high-DWORD size and
   provider offsets pass through i32 in places; state explicit max media/
   entry/seek/mapping sizes before advertising multi-GB images.
6. **Provider failure → Win32 errors (①)** — rejected fetch, short 206,
   changed ETag, revoked File, ejection: each needs a stable error code and
   `GetLastError` mapping, with cancellation and retry policy.

## Overlay semantics (⑤) — the mini-design risk item 3 asked for

Implemented by `lib/vfs-overlay.js` (tracker) over `lib/overlay-store.js`
(async repository). This section is the contract; the tests in
`test/test-vfs-overlay.js` are its executable form.

**The overlay is a journal, not a second filesystem.** `VirtualFS` is one flat
`Map` that mounts populate, so there is no union-mount lookup to implement —
what has to survive a reload is the *difference* the guest made. One record per
normalized path, last-write-wins, in three kinds:

```
 file      bytes + attrs + FILETIMEs      created or modified
 dir       (no bytes)                     CreateDirectory
 whiteout  (no bytes)                     DeleteFile / RemoveDirectory
```

- **Keys are `vfs._resolvePath()` output** — the same lowercasing, `/`→`\`,
  `.`/`..`-collapsing function the VFS itself indexes by. Case-insensitive
  collisions therefore cannot drift from VirtualFS's rule, because it *is*
  VirtualFS's rule; a second normalizer in the store would be a second answer.
- **Hydration order is base mounts → `file`/`dir` records → whiteouts.**
  Whiteouts last is what makes a delete stick: a `FindFirstFile` over a mounted
  container after hydration cannot resurrect a deleted file, because the replay
  removed it from `files` *and* `dirs` after the mount put it there. A whiteout
  for a path the base does not carry is a no-op, so replay is idempotent.
- **Rename is whiteout(src) + file(dst)**, recorded in that single batch.
  Enumeration stays consistent because both halves replay in the same phase.
- **Scope is the writable drives only** (default `c`). A path on a
  `readOnlyDrives` drive is never recorded — `D:\` is the mounted disc, and
  its content is content, not state.

**Read-only mounts refuse writes.** `VirtualFS` already declines
`createFile`-for-write, `writeFile`, `setEndOfFile`, `deleteFile`,
`createDirectory`, `removeDirectory`, `moveFile` and `copyFile` onto a
read-only drive. What was missing is *why*: the overlay latches
`ERROR_WRITE_PROTECT` (19) — the code Win9x returns for a write to
write-protected media — on `vfs.lastFsError` and on `overlay.lastError`.
It is not yet visible to the guest's `GetLastError`: `$handle_CreateFileA`
sets `$last_error` on success only, and there is no host→WAT error import to
set it from JS. That import is the follow-up; inventing a silent one here
would have been a stub that lies.

**Copy-on-write over a provider-backed base file** (a zip mounted under
`C:\Program Files\…`) has three cases, and the middle one is the honest
failure the risk register asked for:

1. *Bytes already resident* (chunk-cache hit, or a synchronous provider):
   the existing `entry.data` getter/setter pair already copies on write —
   reading materializes, writing drops the provider. Nothing new is needed.
2. *Bytes not resident*: the open **fails** with `ERROR_NOT_READY` (21) and a
   loud host log naming the path, rather than materializing. It cannot be
   parked: parking must happen in WAT before the handler pops its stdcall
   frame (`src/09b-dispatch.wat`), `$handle_CreateFileA` has no pending status
   to observe, and a "pending" throw that unwinds nested Wasm is forbidden by
   risk item 1. A `CreateFile`-side parking contract is the fix when an app
   demands it; until then the failure is visible, not silent.
3. *Pre-materialize*: mount code that knows a file will be written calls
   `await vfs.materialize(path)` from the async side before launch. This is
   the documented escape hatch for case 2.

**Persistence is batched and its failures are held, not dropped.** Dirty paths
accumulate; `flush()` snapshots the set, reads the bytes, and hands one batch
to the store. The guest never sees a store failure — its write already
succeeded in RAM — so the host must: `flush()` resolves to
`{written, removed, failed, errors}` and `overlay.errors` keeps every failure
(quota exhaustion, a `VfsPendingError` from a still-lazy entry, a store
reject). Silence there would be a "kept" import that quietly kept nothing.

**Crash consistency** (risk item 4, in the small): the Node store writes blobs
first and the index last, and the index goes to a temp file that is then
renamed. A torn flush loses the newest batch and never the index. Every record
carries its `size`, so a missing or short blob is reported at hydrate time
rather than mounted as a truncated file.

**Relationship to `lib/vfs-persistence.js`**: unchanged and still the right
thing for a *registered* app's saves — an explicit `persistFiles` glob list, a
per-file cap, synchronous localStorage. The overlay is the other mode: an
arbitrary import has no globs and no `apps.js` entry, so "run the installer,
keep the result" persists everything the guest wrote, with no size cap beyond
the backend's own quota. Both can be attached to one VFS; they wrap disjoint
concerns and each delegates to the original method.

**The browser seam.** `attach(vfs, {store})` takes any object implementing the
repository interface:

```js
 list()                -> Promise<Array<{path, kind, attrs, size, times}>>
 read(path)            -> Promise<Uint8Array|null>
 writeBatch(records)   -> Promise<{written, removed}>
 remove(path)          -> Promise<void>
```

`lib/overlay-store.js` ships three: `memoryStore()` (tests, and the private-
browsing fallback where OPFS is unavailable), `nodeDirStore(dir)` (the CLI
`--overlay-dir=DIR`, which is what lets an installer be tested headlessly end
to end — run once to install, run again to prove the tree came back), and
`opfsStore(importId)` for the browser. The OPFS store keeps one isolated
journal per kept import, writes new blobs before publishing their index, and
removes pre-index crash orphans when it next opens. It implements the same four
methods and `lib/browser-shell.js` wires it as
`attach(vfs, {store: opfsStore(importId)})` after the immutable container mount
and before resolving the EXE. The shell checkpoints dirty paths every two
seconds and starts a final snapshot on every stop path. Session imports use a
memory store retained for the life of the page; if browser storage becomes
unavailable after a kept import was restored, the shell logs the downgrade to
session-only instead of claiming those new writes are durable.
