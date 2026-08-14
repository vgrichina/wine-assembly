# Non-GDI Work Plan

Last updated: 2026-08-12.

Status: planning baseline for work that can proceed while the software-GDI
rewrite is owned separately. This plan covers the currently known open work in
WordPad/RichEdit/OLE, common controls, IME, thread fidelity, selected app
bring-up, and supporting test infrastructure. Historical app notes remain
useful evidence, but an old hypothesis is not an active bug until a current-tip
probe reproduces it.

The software-GDI implementation itself is intentionally out of scope. Work in
this plan must not change rendering merely to make a screenshot pass.

## Boundary

```text
                              CAN PROCEED NOW

  guest/API state       COM/OLE lifetime       loaders/decoders
  messages/commands     persistence bytes      registry/VFS
  text readback         input sequencing        app control flow
  test observability    performance counters    nonvisual invariants
           \                   |                    /
            +------------------+-------------------+
                               |
                               v
                      STATE-COMPLETE FEATURES
                               |
                +--------------+---------------+
                |                              |
                v                              v
       remain state-testable          wait for GDI rejoin gate
                                      pixels, metrics, shaping,
                                      exact clipping/composition
```

### In scope now

- API contracts, object ownership, reference counts, error codes, and state
  transitions.
- Guest execution, scheduling, decoding, DLL/resource loading, registry, VFS,
  and persistence formats.
- Text and rich-text semantic readback, including formats that can be checked
  through messages or saved bytes.
- Menu, toolbar, ruler, ListView, and dialog command state that can be asserted
  without pixel comparisons.
- Unicode storage/input logic, clipboard formats, IME composition state, and
  logical bidi/selection behavior.
- DirectDraw, Direct3D, Direct3DRM, and DirectAnimation call-path discovery or
  object-model work whose acceptance does not require rendered pixels.
- Bounded app probes and better state/trace observability.

### Park until the GDI rejoin gate

- Exact glyph pixels, font fallback, complex-script shaping, bidi visual order,
  and printer-font metrics.
- Pixel-perfect RichEdit wrapping, clipping, caret, selection, toolbar images,
  disabled/hot states, or embedded-object presentation.
- Exact pagination and Print Preview geometry.
- Static-DIB reopen pixel validation and any `OleDraw` acceptance based only on
  screenshot contents.
- Paint, Calculator, pure-GDI screensaver, and Win32 control issues whose only
  demonstrated failure is visual.
- Software rasterizers, scan conversion, texture sampling, and final D3D/DA
  compositing. Their call and data paths may be implemented first, but visual
  completion is a later gate.

## Global execution rules

1. Reproduce current-tip behavior before promoting a historical note into the
   active queue.
2. Add state assertions before implementation. Screenshots may be captured for
   later comparison but are not a pass condition in this plan.
3. Put a timeout only around commands that launch the emulator. Default to 90
   seconds per emulator child; split multi-stage tests so each child has its own
   bound.
4. Builds, unit tests that do not launch the emulator, and Git commands do not
   need a timeout.
5. Preserve CRLF and Unicode semantics deliberately. Do not build a knowingly
   broken ANSI-only or LF-only intermediate format.
6. Keep commits small and scoped. Do not use `git reset`; stage only files that
   belong to the current slice.
7. Update the relevant app/design status document in the same slice as each
   feature or newly proven blocker.
8. Do not weaken a visual regression to a state-only test. Split it into a
   state gate that can pass now and a retained visual gate for the GDI rejoin.

## Recommended order

```text
P0  current-tip audit and state-test harness
 |
 +--> P1 WordPad thread-path proof
 |
 +--> P2 OLE storage/stream completeness
 |       |
 |       v
 |    P3 multi-format IDataObject and clipboard
 |       |
 |       v
 |    P4 persistent/general OLE objects
 |       |
 |       +--> P5 links, activation, and drag/drop
 |
 +--> P6 RichEdit semantic breadth and international state
 |
 +--> P7 common-control state fidelity
 |
 +--> P8 app bring-up tracks (AoE, MCM, screensavers)
 |
 v
P9  cross-app nonvisual regression and documentation
 |
 v
GDI REJOIN: retained pixel, metric, layout, and shaping gates
```

P1, P6, P7, and the audit portions of P8 do not depend on the OLE chain. Within
OLE, storage and multi-format transfer should precede general object activation
so later code has one ownership model instead of special cases.

### First implementation queue

Use these as commit-sized milestones. Do not begin a later OLE milestone while
an earlier ownership/persistence contract is still ambiguous.

1. **Thread trace:** generic event log plus bounded WordPad startup test.
2. **Stream core:** complete on 2026-08-12. `IStream::Clone`, independent
   cursors, shared backing lifetime, and edge-case coverage pass 23/23.
3. **Storage tree:** complete on 2026-08-12. Nested trees, mutations,
   enumeration, transactional checkpoints, and complete bounded `STATSTG`
   metadata pass 68/68.
4. **CFB persistence:** deterministic writer, defensive reader, and
   fresh-process tree comparison.
5. **Multi-format transfer:** in progress. Format collection, full enumerator,
   and caller-owned `GetDataHere` media are complete; Unicode text conversion,
   exact negotiation, clipboard snapshots, and remaining lifetime cases follow.
6. **Generic persistence:** storage-backed object record and complete
   `IPersistStorage` lifecycle, retaining unknown children.
7. **Synthetic OLE server:** lifecycle, cache, advisory, clipboard, and verb
   tests with no external app dependency.
8. **Links and target drag/drop:** moniker/ROT state, registration ownership,
   effect negotiation, and WordPad logical insertion.
9. **RichEdit breadth:** semantic RTF/large-document fixtures, then Unicode and
   IME logical state.
10. **Control state:** WordPad ruler/commands, then advanced ListView messages
    and notifications.
11. **App audit batch:** AoE, MCM, screensavers, Pinball, RCT, Abe, Tour,
    Spider, SkiFree, and Calculator; promote only current reproduced failures.
12. **Cross-app state regression:** execute P9 and update status documents,
    leaving the visual half intact for the GDI rejoin.

## P0 — Current-tip audit and state-test harness

### Work

- Create one manifest of non-GDI focused tests rather than another all-app
  mega-script. Record whether each entry is a Node unit test, one emulator
  child, or a parent test that launches multiple bounded children.
- Add structured trace/readback actions only where existing `test/run.js`
  actions cannot expose the required invariant. Prefer generic actions over
  WordPad- or game-specific switches.
- Separate mixed tests into:
  - semantic/state assertions that can run now;
  - saved-byte/fixture assertions that can run now;
  - retained screenshot assertions for the GDI rejoin.
- Re-run the documented low-level baselines before changing their subsystem:
  `test/test-thread-manager.js`, `test/test-ole-storage.js`,
  `test/test-ole-data-object.js`, and the focused WordPad semantic tests.
- Audit app documents by newest dated status. Treat superseded sections as a
  debugging log, not a to-do list.

### Acceptance

- Every active item below names a reproducible current-tip test or a concrete
  first probe.
- No test waits indefinitely, and no timeout wraps Git or ordinary builds.
- The non-GDI run list has no pixel/color-count requirement.

## P1 — Thread fidelity and WordPad startup proof

Status: complete on 2026-08-12. The scheduler models `CREATE_SUSPENDED`, suspend
counts, and `ResumeThread`, and the focused WordPad regression proves the real
startup path.

### Work

1. Add bounded thread-event observability containing thread handle, creation
   flags, suspend count before/after resume, and first runnable slice.
2. Add `test/test-wordpad-thread-startup.js` using the real WordPad binary.
3. Assert that a suspended worker cannot execute before the matching resume,
   `ResumeThread` reports the previous count, and the worker becomes runnable
   only when the count reaches zero.
4. Keep `test/test-thread-manager.js` as the lower-level contract suite and add
   pending-thread, invalid-handle, multiple-suspend, and termination regressions
   only if the app trace exposes a gap.

### Acceptance

- [x] One WordPad emulator child completes under 90 seconds.
- [x] The test proves event order and scheduler state; it does not depend on a
  WordPad screenshot.

Implementation result: the host receives `dwCreationFlags` as part of the
thread-creation call, so `CREATE_SUSPENDED` is atomic. `ThreadManager` exposes
structured `create`, `suspend`, `resume`, `spawn`, `first_run`, and `exit`
events. `test/test-wordpad-thread-startup.js` passes 8/8 and proves suspended
create -> final resume -> spawn -> first runnable slice at the original entry
point.

## P2 — Structured storage and stream completeness

The existing bounded implementation supports binary `ILockBytes`, root
`IStorage`, named stream children, and class identity. Complete the reusable
storage layer before adding more OLE object types.

### P2.1 Stream semantics

- [x] Implement `IStream::Clone` with shared backing bytes and an independent seek
  cursor.
- [x] Complete copy, set-size, sparse extension/zero fill, seek overflow, stat,
  lock/unlock-region, commit, and revert semantics used by Win9x OLE clients.
- [x] Make lifetime ownership explicit: a stream keeps its backing store alive;
  releasing a storage handle does not invalidate an independently retained
  stream.

2026-08-12 stream-core result: clones retain a canonical root stream, share its
mutable data/size/capacity, and keep their own positions. Write and SetSize are
visible across interfaces, shrink/grow zero-fills exposed bytes, HGLOBAL clones
return the same handle, and a clone remains readable after the original caller
and owning storage are released. `test/test-ole-storage.js` passes 27/27 after
the first storage-tree slice.

2026-08-12 stream-completion result: buffered `CopyTo` handles exact and partial
64-bit counts plus safe self-copy; shared-root checkpoints restore bytes/size
through any clone; root-visible region locks distinguish write/exclusive access,
enforce exact-owner unlock, gate resize, and disappear with their owner. The
combined storage/stream suite passes 68/68 after the metadata completion
described below.

### P2.2 Storage tree

- [x] Add nested `CreateStorage`/`OpenStorage` and case-insensitive child lookup.
- [x] Add stream/storage deletion and rename with collision/error behavior.
- [x] Add `CopyTo` and `MoveElementTo` for mixed stream/storage subtrees.
- [x] Implement `EnumElements` with a real `IEnumSTATSTG`, including `Next` counts,
  `Skip`, `Reset`, `Clone`, and stable enumeration while referenced.
- [x] Return correct `STATSTG` names, types, sizes, CLSIDs, and supported metadata.
- [x] Implement in-memory commit/revert snapshots rather than leaving successful
  no-ops that claim transactional behavior.

2026-08-12 nested-storage result: storage nodes now keep separate first-child
and next-sibling links, so arbitrary depth does not corrupt sibling traversal.
Parents own children, retained children survive ancestor release, names are
case-insensitive, and streams/storages share one collision namespace. The
public CreateStorage/OpenStorage handlers use the same helpers as the 27/27
focused storage suite. Rename/delete then raise it to 33/33: both element types
rename without identity changes, cross-type collisions fail, unlinking removes
lookup visibility, and retained streams/subtrees stay valid after deletion.
Deep `CopyTo` and identity-preserving `MoveElementTo` raise the suite to 41/41.
Copies own independent stream bytes and nested storage nodes; moves reject
cycles and collisions before unlinking, and `STGMOVE_COPY` retains the source.
Snapshot `IEnumSTATSTG` raises the suite to 47/47. `Next` returns exact partial
counts and caller-owned names; records preserve names, types, stream sizes, and
storage CLSIDs even after the live tree is renamed, deleted, and released.
`Skip`, `Reset`, and cloned independent cursors are covered through a generated
seven-method COM vtable.
Deep transaction checkpoints raise the suite to 53/53. `Commit` stages an
independent tree before atomically replacing the prior checkpoint; `Revert`
stages restoration before swapping live contents. Names, bytes, nested nodes,
and CLSIDs restore, post-commit additions disappear, old retained interfaces
detach safely, and later commits replace earlier checkpoints.

Completing bounded `STATSTG` metadata raises the suite to 68/68. `IStream`,
`IStorage`, and `ILockBytes` now share one 72-byte record implementation with
correct type, low/high size, name ownership, `STATFLAG_NONAME`, stream lock
capabilities, storage CLSID, and masked state bits. Enumerator snapshots retain
the same metadata, while deep copy and transaction checkpoints preserve state
bits.

### P2.3 Compound File Binary persistence

Status: bounded CFB v3-on-`ILockBytes` persistence complete on 2026-08-12.
Path-backed `StgCreateDocfile`/`StgOpenStorage` remain a separate filesystem
integration task.

- Define one internal tree model shared by in-memory storage and serialization.
- Implement a minimal valid CFB writer: header, DIFAT/FAT, directory, stream
  chains, mini-FAT/mini-stream where required, root CLSID, and deterministic
  ordering.
- Implement the corresponding reader with bounds/cycle validation and clear
  `STG_E_*` failures for malformed files.
- Reopen serialized bytes in a fresh emulator process and compare the full
  storage tree, stream bytes, and class identity.
- Add a small checked-in interoperability fixture produced by an external
  Win32/OLE implementation if licensing permits; otherwise document fixture
  provenance and generate it from a tiny test program.

2026-08-12 persistence result: the in-memory tree serializes to a valid CFB v3
container with a 512-byte header/sectors, DIFAT/FAT chains, directory sectors,
name-ordered red-black sibling trees, CLSIDs/state bits, regular stream chains,
and mini-stream/mini-FAT chains for data below 4 KiB. The independent byte-level
suite in `test/test-ole-cfb.js` passes 22/22. It checks Microsoft CFB name
ordering, deterministic bytes, nested parentage, exact small/large payloads,
fresh-backed reopen, public `IStorage::Commit` emission, and atomic rejection
of bad signatures, sector cycles, directory cycles, illegal names/colors, and
unsupported 64-bit sizes. `StgOpenStorageOnILockBytes` now invokes that defensive reader when no
live root is associated.

### Acceptance

- Existing `test/test-ole-storage.js` stays green.
- New storage-tree, enumerator, transaction, and CFB fresh-process tests pass
  without using any rendering API.

## P3 — General `IDataObject` and clipboard transfer

The core object now owns multiple formats/media and exposes stable snapshot
enumerators. General clipboard conversion and drag/drop need the remaining
transfer breadth below.

### Work

- [x] Replace the single `FORMATETC`/`STGMEDIUM` slot with an owned collection.
- [x] Implement matching across clipboard format, aspect, lindex, and compatible
  `tymed` masks with accurate `DV_E_*` errors.
- [x] Support `TYMED_HGLOBAL`, `TYMED_ISTREAM`, and `TYMED_ISTORAGE` ownership,
  duplication, local `pUnkForRelease`, and `ReleaseStgMedium` behavior.
- [x] Add suspended guest-callback completion to the public
  `ReleaseStgMedium` path for DLL-private IStream/IStorage interfaces and
  `pUnkForRelease`, preserving the required release order.
- [x] Extend final object-owned/transferred media destruction to DLL-private
  interfaces for `IDataObject` and static-handler caches.
- [x] Extend guest-media cleanup to `IDataObject::SetData` replacement,
  `IOleCache::SetData` replacement, and `IOleCache::Uncache`.
- [x] Add suspended guest `AddRef` completion when `IDataObject::GetData`
  returns a DLL-private stream or storage interface.
- [x] Add suspended guest `AddRef` completion for `fRelease=FALSE`
  `IDataObject::SetData` and `IOleCache::SetData` stream/storage media.
- [x] Add atomic multi-entry guest `AddRef` completion when
  `IOleObject::GetClipboardData` snapshots cached stream/storage media.
- [x] Add guest-aware, atomic `IOleObject::InitFromData` cache import and
  retirement of the displaced guest-owned cache.
- Add durable `OleFlushClipboard` value snapshots for DLL-private
  streams/storage.
- [x] Implement `GetDataHere` for compatible caller-provided global memory,
  streams, and storage.
- [x] Complete `IEnumFORMATETC::Next/Skip/Reset/Clone` for more than one entry.
- [x] Preserve stable format enumeration and media lifetime after clipboard owner
  changes, `OleSetClipboard`, `OleGetClipboard`, and `OleFlushClipboard`.
- [x] Add `CF_UNICODETEXT` alongside ANSI/OEM text and registered RTF; preserve
  CRLF and terminating-null conventions exactly.
- Add advisory plumbing only after a traced consumer requires it:
  `DAdvise`, `DUnadvise`, `EnumDAdvise`, and change notification.

2026-08-13 transfer result: `IDataObject` owns a growable collection of
deep-copied `FORMATETC`/`STGMEDIUM` entries. `SetData` appends or replaces
matching formats, honors `fRelease`, and retains stream/storage media with COM
ownership; `DVTARGETDEVICE` data is copied independently. `IEnumFORMATETC`
captures stable deep snapshots and implements exact multi-entry
`Next`/`Skip`/`Reset`/`Clone` behavior. `GetDataHere` fills caller-owned
HGLOBALs without replacing them, rejects undersized buffers before writing,
rewrites caller streams exactly, and atomically replaces caller storage trees
through a detached staging copy. The focused suite passes 28/28, while the
existing static-handler, storage, and CFB suites remain green at 13/13, 68/68,
and 22/22.

2026-08-13 negotiation result: format lookup now narrows clipboard format,
aspect, lindex, target-device bytes, and compatible media masks in a stable
order and returns `DV_E_FORMATETC`, `DV_E_DVASPECT`, `DV_E_LINDEX`,
`DV_E_DVTARGETDEVICE`, or `DV_E_TYMED` as appropriate. Distinct presentations
no longer overwrite each other, and enumeration advertises the concrete medium
each entry can actually return. The expanded focused suite passes 39/39.

2026-08-13 text-transfer result: public `SetData` canonicalizes HGLOBAL text
to Windows CRLF, publishes independently owned `CF_TEXT`, `CF_OEMTEXT`, and
`CF_UNICODETEXT` values, preserves exactly one terminating NUL, and leaves
registered RTF as an opaque coexisting format. Unicode input retains UTF-16
code units while the bounded ANSI/OEM fallback maps unrepresentable units to
`?`. The three-format replacement is failure-atomic through a preflighted
ownership-moving collection rebuild. The focused suite passes 45/45. The
WordPad rich clipboard test passes 21/21 and the Paint clipboard test passes
9/9 after restricting Paint's delayed bitmap materialization to `mspaint.exe`.

2026-08-13 clipboard-snapshot result: `OleFlushClipboard` now replaces a local
owner with a distinct data-object value snapshot. HGLOBAL bytes, IStream
backing, recursive IStorage trees, target-device metadata, and format
enumeration remain independent if the former owner mutates or adds data. The
bounded external Paint path wraps its already rendered CF_DIB in a local data
object. The focused suite passes 50/50.

2026-08-13 guest-media teardown result: final `IDataObject` and static-handler
cache destruction now scan all transferred media, validate every DLL-private
`Release` callback before mutation, and resume asynchronous guest callbacks in
entry order. Stream/storage interfaces release before `pUnkForRelease`; an
HGLOBAL delegated to a guest releaser remains untouched by the runtime. The
guest callback suite passes 39/39, the data-object and static-handler suites
remain green at 55/55 and 65/65, and WordPad static-DIB Copy/Cut/Paste remains
green at 13/13. Mutation-time cleanup is covered by the following result.

2026-08-13 guest-media mutation result: `IDataObject::SetData` and
`IOleCache::SetData` move displaced guest media into a temporary owned data
object, commit the replacement only after validating every guest `Release`,
then reuse the suspended final-release continuation. `IOleCache::Uncache` uses
the same path before removing an entry. Canonical text synthesis now moves
unrelated guest-owned entries without a fake local `AddRef`, retires replaced
text media, and asynchronously consumes a guest-released `fRelease` input.
Malformed methods leave the old entry and caller medium intact. The expanded
guest callback suite passes 48/48; data-object, static-handler, storage,
callback-state, and WordPad static-DIB gates remain green at 55/55, 65/65,
68/68, PASS, and 13/13. DLL-private `AddRef` during non-transferring copies and
snapshots is the next ownership slice.

2026-08-13 guest-GetData result: public `IDataObject::GetData` now detects a
DLL-private IStream/IStorage presentation, validates its guest `AddRef`, and
suspends the API frame until the x86 callback returns. The output STGMEDIUM is
published only after the independent receiver reference exists and uses a NULL
`pUnkForRelease`, so ordinary `ReleaseStgMedium` balances that reference
without affecting the stored custom releaser. A missing guest method returns
`E_NOINTERFACE` with a fully zeroed output. The guest callback suite passes
52/52; data-object, static-handler, storage, callback-state, and WordPad gates
remain green at 55/55, 65/65, 68/68, PASS, and 13/13.

2026-08-13 guest-SetData result: non-transferring `IDataObject::SetData` and
`IOleCache::SetData` now stage DLL-private IStream/IStorage media, suspend for
their real guest `AddRef`, and publish through the ordinary transfer path only
after the new reference exists. The caller's `STGMEDIUM` remains unchanged. If
the later mutation fails, the continuation rolls the new reference back with
guest `Release`; successful replacement retires displaced guest media before
returning. Missing callback slots and malformed prior ownership leave both
object state and caller input intact. The guest callback suite passes 57/57;
data-object, static-handler, storage, and WordPad gates remain green at 55/55,
65/65, 68/68, and 13/13.

2026-08-13 guest-cache-snapshot result: `IOleObject::GetClipboardData` now
stages the complete multi-format `IDataObject` before invoking guest code,
prevalidates every DLL-private stream/storage `AddRef` and matching `Release`,
then retains each medium through the suspended x86 continuation. No output is
published until every entry owns its reference; malformed later entries do not
even AddRef earlier entries. The result remains independently alive after the
source cache is destroyed and final release balances every retained medium.
CF_DIB render-slot mirroring already deep-copies its HGLOBAL bytes and clears
`pUnkForRelease`, so it has no interface-reference gap. The guest callback
suite passes 63/63; data-object, static-handler, storage, and WordPad gates
remain green at 55/55, 65/65, 68/68, and 13/13.

2026-08-13 guest-cache-import result: `IOleObject::InitFromData` now constructs
a detached complete cache, prevalidates every imported guest `AddRef`/`Release`
and every displaced guest `Release`, and retains the new stream/storage media
before atomically swapping cache collections. The detached handler becomes the
retired owner of the old collection, allowing its DLL-private media to release
asynchronously after commit without exposing a half-imported cache. Malformed
new or old callbacks leave the live cache and all reference counts unchanged;
source and imported cache retain independent balanced ownership. The guest
callback suite passes 68/68; data-object, static-handler, storage, and WordPad
gates remain green at 55/55, 65/65, 68/68, and 13/13.

2026-08-13 medium-ownership result: transferred HGLOBAL media honor a local
`pUnkForRelease` without freeing the delegated payload, while stream/storage
media release both their interface reference and a distinct custom releaser.
`GetData` still returns independent caller-owned copies, and successful
`SetData(..., TRUE)` clears all caller medium fields only after ownership has
transferred. At this 55/55 milestone, DLL-private releasers still needed the
suspended guest callback completed by the public-release result below.

2026-08-13 public-release result: `ReleaseStgMedium` now suspends its API frame
for DLL-private guest interfaces. HGLOBAL with `pUnkForRelease` preserves the
delegated payload and releases only its provider; IStream/IStorage media release
the data interface first and the custom releaser second, including mixed
runtime-local/guest pairs. Every guest Release slot is validated before the
medium is cleared, so malformed inputs remain wholly intact instead of being
partially released by a void API. The guest-x86 callback suite passes 33/33,
the local data-object suite remains 55/55, and native WordPad object clipboard
coverage remains 13/13. Internal object-owned guest media teardown remains the
next medium-lifetime slice.

### Acceptance

- Existing data-object and static-DIB clipboard tests remain green.
- A new multi-format suite proves enumeration cloning, format negotiation,
  ownership transfer, Unicode/RTF coexistence, and fresh-process snapshots.

## P4 — Persistent and general OLE objects

Static `CF_DIB` is a useful first handler, not the general object model.

### P4.1 Persistence and cache model

- Introduce a generic embedded-object record containing CLSID, storage,
  extent/aspect, user type, client site, dirty/closed state, and zero or more
  cached presentations.
- [x] Implement real `IPersistStorage::InitNew`, `Load`, `Save`,
  `SaveCompleted`, and `HandsOffStorage` against the P2 storage model.
- [x] Generalize `IOleCache` beyond one DIB presentation with stable
  connections, exact format/aspect entries, independent media ownership, and
  targeted replace/remove behavior.
- [x] Implement `IOleCache::EnumCache` as a stable `IEnumSTATDATA` snapshot
  over the generalized presentation collection.
- Preserve unknown streams and storage children during load/save so an object
  can round-trip even when wine-assembly cannot activate its server.

2026-08-13 persistence-state result: the bounded embedded handler now enforces
uninitialized, normal, no-scribble, and both hands-off states. `Load` starts
clean, `InitNew` starts dirty, repeated initialization returns
`CO_E_ALREADYINITIALIZED`, and `SaveCompleted` validates its handoff storage.
Save As recursively stages and atomically replaces the destination, preserving
unknown streams, storage children, root CLSID, and state bits without needing
to understand their schema. The static-handler suite passes 26/26. General
multi-presentation caching and user/lifecycle metadata remain in P4.1/P4.2.

2026-08-13 cache-collection result: `IOleCache::Cache` now assigns stable
connection IDs to distinct format/aspect presentations and suppresses matching
duplicates. `SetData` copies or transfers independently owned media, replaces
only the matching presentation, and keeps the first usable CF_DIB mirrored into
the proven render path. `Uncache` removes only its connection and returns
`OLE_E_NOCONNECTION` for an unknown ID. The focused handler suite passes 34/34,
and WordPad inline object Copy/Cut/Paste remains green at 13/13.
`IEnumSTATDATA` now snapshots complete format/ADVF/sink/connection fields,
deep-copies target-device metadata, and supports exact Next/Skip/Reset/Clone
cursor semantics. The expanded focused suite passes 38/38.

### P4.2 Object lifecycle contracts

- [x] Complete owned host names, close/running transitions, run locks,
  contained state, validated dirty extents, static user type, and misc-status
  bookkeeping.
- [x] Complete client-site ownership, `GetClientSite` AddRef behavior, and
  dirty-close `SaveObject` calls for the synthetic in-process site fixture.
- [x] Complete multiple advisory connections, targeted `Unadvise`, and stable
  `EnumAdvise`/clone ownership for synthetic in-process sinks.
- [x] Extend client-site ownership to DLL-private interfaces through suspended
  guest AddRef/Release/SaveObject callbacks.
- [x] Extend live advisory ownership and `OnSave`/`OnClose` notifications to
  DLL-private interfaces through the same guest COM callback bridge.
- [x] Extend `EnumAdvise` snapshot creation, `Next`, `Clone`, and final release
  ownership to DLL-private sinks through suspended guest callbacks.
- [x] Implement clipboard `InitFromData`/`GetClipboardData` through the
  generalized P3 object rather than DIB-only branches for runtime-owned
  `IDataObject` instances.
- Add a synthetic in-process OLE server fixture. Use it to test client calls,
  failure paths, refcounts, and persistence without depending on an installed
  desktop application or rendered pixels.

2026-08-13 clipboard-conversion result: `IOleObject::GetClipboardData` now
returns a distinct local `IDataObject` containing every cached presentation,
with deep `FORMATETC` metadata and independently owned media.
`IOleObject::InitFromData` validates the bounded local object kind, stages all
presentations, and swaps the collection only after every copy succeeds; the
first usable CF_DIB is then restored into the proven render slot. Later cache
replacement/removal cannot mutate an earlier clipboard result. DLL-private
data objects still require the deferred guest COM callback bridge. The focused
static-handler suite passes 42/42, and native WordPad object clipboard
regression remains a separate acceptance gate.

2026-08-13 lifecycle-metadata result: the bounded handler now deep-copies and
atomically replaces both host names, validates content aspect for extent
queries, marks successful extent changes dirty, returns caller-owned `Static
Object` user-type text, and advertises `OLEMISC_RECOMPOSEONRESIZE |
OLEMISC_STATIC`. It records validated close options, maintains running and
nested run-lock state, honors last-unlock-close, and tracks whether the object
is contained. Owned host strings are released with the handler. The later guest
client-site and live-advisory results below complete DLL-private `SaveObject`,
live sink notifications, handler ownership, and guest-owned advisory
enumeration snapshots. The focused static-handler suite passes 52/52 at this
milestone.

2026-08-13 guest-client-site result: a stack-resident continuation context now
suspends an OLE API frame, invokes DLL-private guest x86 vtable methods, and
resumes the exact caller EIP/ESP after stdcall cleanup. `SetClientSite` AddRefs
before publishing and releases the replaced site, repeated assignment is
neutral, `GetClientSite` returns an independently AddRefed interface, and final
handler destruction releases its ownership before freeing WAT storage.
SAVEIFDIRTY/PROMPTSAVE `Close` propagates a failing guest `SaveObject` HRESULT
without clearing dirty state and clears it after success. The real-vtable guest
callback suite passes 10/10; the existing local static-handler suite remains
65/65, and native WordPad static-object Copy/Cut/Paste remains 13/13.

2026-08-13 local-advisory result: `IOleObject::Advise` now assigns monotonic
connection IDs and retains each synthetic local sink independently.
`Unadvise` removes only its requested connection and returns
`OLE_E_NOCONNECTION` without mutation for an unknown ID. `EnumAdvise` returns a
stable `IEnumSTATDATA` snapshot whose Next and Clone operations own local sink
references and preserve independent cursors even after the live collection is
changed. Final enumerator/object release balances all retained references. The
focused suite passes 65/65. At that local-only milestone, DLL-private sinks
remained borrowed and could not receive notifications without the guest
callback bridge.

2026-08-13 guest-advisory result: `IOleObject::Advise` now invokes DLL-private
sink `AddRef`, `Unadvise` invokes its matching `Release`, and final handler
destruction balances every remaining guest client-site and advisory reference
before freeing WAT storage. Successful dirty `Close` calls every live guest
sink's `OnSave` followed by `OnClose`; clean and `OLECLOSE_NOSAVE` paths emit
only `OnClose`, while a failing guest `SaveObject` preserves dirty state and
suppresses both notifications. Traversal is bounded by stable connection IDs,
so mutation cannot skip a following sink and newly advised sinks wait for the
next sequence. At this milestone the real guest-x86 callback suite passed
18/18, with guest-owned `EnumAdvise` snapshot references as the next lifecycle
slice.

2026-08-13 guest-EnumAdvise result: each DLL-private sink now receives a
distinct guest `AddRef` for the `IEnumSTATDATA` snapshot, every returned
`STATDATA`, and every cloned snapshot. Final source and clone release execute
the matching guest `Release` sequence before freeing enumerator storage.
Snapshots remain usable after live `Unadvise` and after the source enumerator
is destroyed. Missing guest AddRef/Release slots fail before publishing output,
advancing a cursor, or partially releasing ownership. The expanded real guest
x86 callback suite passes 29/29; the local static-handler suite remains 65/65,
the continuation regression passes, and native WordPad static-object
Copy/Cut/Paste remains 13/13.

### Acceptance

- Static DIB remains a supported presentation through the generic path.
- An unknown embedded object survives save/reopen byte-for-byte.
- The synthetic object passes persistence, close, advisory, clipboard, and
  lifetime tests in a fresh process.

## P5 — Links, activation, verbs, and drag/drop

This is the final nonvisual OLE layer. Rendering an activated object remains a
GDI-rejoin concern, but its protocol and state machine can be completed now.

### P5.1 Linked objects and activation

- Implement the needed moniker/bind-context/Running Object Table contracts,
  beginning with file monikers and deterministic bind failure.
- Persist link source, display name, update policy, and last cached
  presentation independently of server availability.
- Add class-object registration and activation plumbing sufficient for the
  synthetic OLE server; only then attempt an actual guest server binary.
- Implement `EnumVerbs` and `DoVerb` state transitions for show/open/hide and
  explicit unsupported responses for unimplemented in-place UI.
- Add `IOleInPlaceObject`/site/window-context support only to the method set
  proven necessary by a traced WordPad insertion/activation flow.

### P5.2 Drag/drop

- Replace no-op `RegisterDragDrop`/`RevokeDragDrop` with a per-window target
  table that retains/releases the COM target correctly.
- Add synthetic harness actions for `DragEnter`, `DragOver`, `DragLeave`, and
  `Drop`, carrying the generalized P3 data object and key/effect state.
- Implement target-side text, RTF, and object insertion first. Add source-side
  `DoDragDrop`/`IDropSource` only after target behavior is stable.
- Assert negotiated effects, call order, cancellation, destruction, and final
  RichEdit object/text state. Defer drag-image and drop-feedback pixels.

### Acceptance

- WordPad can logically receive text, RTF, static DIB, and an unknown cached
  object through drag/drop.
- Linked and embedded synthetic objects preserve identity and storage through
  save/reopen even when activation is unavailable.

## P6 — RichEdit semantic and international breadth

The current app-level suite already covers representative advanced RTF,
printing, layout stress, ruler/dialog commands, Unicode input, and version
differences. Expand semantic coverage without conflating it with exact layout.

### P6.1 RTF semantics

- Add fixtures for deeply nested groups, inherited styles, character and
  paragraph resets, code pages, `\uN` fallbacks, fields, list tables,
  sections, headers/footers, merged table cells, pictures, and multiple object
  destinations.
- Exercise edits across formatting and paragraph boundaries, then save/reopen
  and query text/character/paragraph/object state by range.
- Validate saved RTF structurally and through a fresh native RichEdit reopen;
  do not require byte-identical output from RichEdit.
- Preserve unknown destinations where native RichEdit preserves them and
  document intentional normalization.

### P6.2 Large-document and version behavior

- Add bounded large-document insert, replace, undo, stream, and save/reopen
  tests with dynamic readback buffers and explicit memory ceilings.
- Expand RichEdit 1.0/2.0 class and message differences only from real app
  traces: text limits, selection units, notifications, stream flags, and
  unsupported-message results.
- Keep exact wrapping, line height, printer pagination, and preview geometry in
  the GDI rejoin suite.

### P6.3 International logical behavior

- Cover full UTF-16 clipboard and stream round-trips, surrogate pairs,
  combining sequences, variation selectors, and CRLF around non-ASCII text.
- Define cluster-safe selection/deletion behavior and test native RichEdit
  readback after edits. Do not claim visual grapheme correctness from this.
- Replace no-op IME behavior with an `HIMC` state model, association per window,
  composition string/attributes/clauses, result string, candidate state, and
  `WM_IME_STARTCOMPOSITION`/`COMPOSITION`/`ENDCOMPOSITION` order.
- Add host actions for start/update/commit/cancel composition. Keep the
  candidate/composition UI and font shaping behind the GDI rejoin.
- Test logical bidi storage, navigation, selection, and clipboard ordering;
  visual order is deferred.

### Acceptance

- Semantic assertions pass for every fixture before and after save/reopen.
- IME commit/cancel works in WordPad and one plain Edit control without a
  composition overlay.
- No test equates UTF-16 readback success with correct glyph rendering.

## P7 — Common-control state fidelity

### P7.1 WordPad UI state

- Complete uncommon ruler interactions: tab creation/move/removal, indent
  handles, units, and paragraph-state synchronization.
- Expand toolbar/menu enable, check, radio, hot, tooltip, command-update, image
  list, padding, and ordering behavior through messages and command routing.
- Complete less-used WordPad dialogs/commands where their result can be
  asserted from document or app state.
- Retain exact icon remapping, dimming, row geometry, and menu-font appearance
  as GDI-rejoin tests.

### P7.2 Advanced ListView

- Audit report-mode gaps first, then add list/icon/small-icon modes only with a
  consumer or focused contract test.
- Complete item/state-image masks, focus/selection transitions, keyboard
  navigation, label editing, sorting callbacks, hit tests, scrolling,
  ensure-visible, and owner-data behavior needed by target apps.
- Complete header insertion/order/width/track notifications and ListView
  notification order (`LVN_*`, `NM_*`) with correct structures and parent
  routing.
- Reuse shared scrollbar mechanics; do not fork a ListView-only scroll model.
- Test rectangles and logical order numerically. Pixel layout and glyphs wait
  for the GDI rejoin.

### Acceptance

- Existing TreeView/ListView report regressions stay green.
- New tests assert messages, notifications, state, ordering, and scroll
  positions without screenshots.

## P8 — App bring-up independent of GDI

These tracks begin with a current-tip audit because their documents contain
long superseded investigation histories.

### P8.1 Age of Empires

- Re-run the current browser gameplay/profile harness and establish whether
  the documented CLI idle/vsprintf notes are still relevant.
- Keep correctness work separate from performance experiments. Decoder/stack,
  message/input timing, VFS/DRS, audio, save/load, AI progression, and guest
  control-flow failures are non-GDI work.
- Use handler histograms to select decoder optimizations; require repeated
  no-hist measurements before retaining an optimization.
- Do not use frame rate or rendered appearance as the acceptance gate here.
  Prefer elapsed guest progress, API/control-flow milestones, save/load state,
  and absence of traps or memory corruption.

### P8.2 Motocross Madness / D3D call path

- Promote the 2026-06-14 splash smoke as the current baseline and archive older
  superseded black-frame hypotheses.
- Add deterministic input to move from the first-run/splash flow toward menu
  and gameplay; assert control-flow milestones and COM call sequences.
- Trace and complete Direct3D QI, device, viewport, execute-buffer, primitive,
  texture, and color-key contracts at the data/state level.
- Validate execute-buffer parsing with synthetic buffers and DX SDK samples.
  Rasterization and final texture pixels remain outside this plan.
- Audit older MCM open-task labels against current status before acting; for
  example, the old ESP leak and per-module resources have documented fixes.

### P8.3 Screensavers and DirectAnimation

- CITYSCAP: trace startup messages, registry gates, and timer/invalidation
  control flow. The blank frame is not itself a non-GDI acceptance result.
- PHODISC: trace asset discovery, registry/VFS paths, decoding requests, and
  error handling. Stop before pixel-composition work.
- D3DRM: revalidate the `MeshBuilder::Load`/ProgressiveMesh path with the DX SDK
  viewer and a minimal plain-Mesh fixture. Complete loader/parser/object
  conversion semantics independent of rendering.
- DirectAnimation: first make missing DA classes fail cleanly without runaway
  EIP. Then inventory the exact `IDispatch` names/DISPIDs and `VARIANT` shapes
  used by one saver.
- If DirectAnimation proceeds, implement reusable Automation plumbing and a
  state-only expression DAG before any compositor. Do not hand-roll visual DA
  behavior merely for four savers without a new scope decision.
- FOXTROT silhouette fidelity and other pure-GDI saver output wait for a
  reference image and the GDI rejoin.

### P8.4 Task Manager

- No known functional blocker is active. Keep the existing browser multi-app
  workflow as a regression consumer for process/window enumeration and shared
  control changes.
- Add work only when a current-tip regression or missing Task Manager command
  is reproduced; do not create speculative feature work from a passing app.

### P8.5 Other documented app gaps

These are real non-GDI candidates recorded in current app documents, but they
rank below the shared foundations above. Audit each on current tip before
implementation because several files retain superseded debugging chronicles.

- **Pinball:** remove remaining app-specific state pokes by repairing the
  natural attract-mode/callback sequence; test posted-message versus input
  fairness without violating normal queue order; reproduce the four
  `PINBALL.DAT` visual-count mismatches with block-level tracing; and complete
  state/input/audio progression independently of table pixels. Web Audio
  output is a separate optional slice after `waveOut` state is correct.
- **RollerCoaster Tycoon:** extend the promoted splash smoke to a deterministic
  runtime/game-tick milestone. Re-audit the documented generated-code buffer
  overwrite, zero-width clipping inputs, and low-address execution stop on
  current tip; fix a decoder/flags/memory defect only after the first bad state
  transition is proven. Canonical surface presentation remains outside this
  plan.
- **Abe's Oddysee:** script progression beyond the title/load state and assert
  input, timer, worker-thread, audio-buffer, and level-state milestones. Plan a
  memory-map/loader change for the original 32 MB self-extracting PE as a
  separate architecture slice with overlap guards and large-image tests.
- **Win98 Tour:** inventory the missing `Discover.exe` and tour assets, define
  their VFS/CD mapping and provenance, and test the helper's registry/path
  handoff. Actual tour bring-up cannot start until the legitimate asset set is
  available; do not fake success with the helper error dialog.
- **Spider Solitaire:** cover card dragging, restart, available-move, and
  Save/Open commands through state/file assertions. Resolve only the OLEAUT
  ordinal and help contracts exercised by those flows. About/status-bar pixels
  remain a GDI-rejoin concern.
- **SkiFree:** add a browser input regression for skier movement and a longer
  timer/game-state smoke. The documented palette and visual cleanup waits for
  GDI; cross-app dispatcher regression remains part of P9.
- **Calculator:** parse the dialog-template class instead of relying on the
  most-recent registered class, and assert child class/style/text/layout state
  numerically. Back-canvas preservation, bezels, missing visual controls, and
  DLU-to-pixel fidelity remain behind the GDI gate.
- **Solitaire and already-functional games/apps:** add no speculative feature
  work. Keep them as message, input, common-dialog, file, and control
  regression consumers; promote a task only from a reproduced functional gap.

### Acceptance

- Each app track ends in a deterministic state/control-flow milestone test.
- Rendering can remain unchanged without preventing a non-GDI slice from being
  complete.

## P9 — Integration and documentation

- After each shared USER, COM, OLE, RichEdit, common-control, loader, decoder,
  or scheduler change, run the smallest relevant cross-app set rather than the
  entire emulator catalog.
- Minimum WordPad integration set after OLE/RichEdit changes:
  - low-level storage and data-object suites;
  - WordPad basic edit/readback;
  - RTF save/reopen semantic state;
  - static-image clipboard object-count/state test;
  - Notepad edit/clipboard regression;
  - one installer license RichEdit regression.
- Minimum common-control set: TreeView, ListView report mode, WordPad command
  state, and Task Manager browser workflow.
- Minimum scheduler/decoder set: unit suite plus one real app path that uses
  the changed behavior.
- Update app status with exact test names and assertion counts only after a
  current run. Record timeouts and unverified visual claims explicitly.

## GDI rejoin gate

When the software-GDI work is stable, do not reopen every feature design. Run
the retained visual half of this plan:

1. WordPad static-DIB fresh-process reopen and delete/reopen pixels.
2. WordPad toolbar/menu/ruler geometry, icon states, text metrics, wrapping,
   selection, caret, and clipping.
3. Printer pagination and Print Preview against stable printer/font metrics.
4. Unicode fallback, IME overlay, bidi visual order, and complex shaping.
5. ListView/TreeView pixel layout and state-image rendering.
6. Screensaver, MCM/D3D, and DirectAnimation final composition.
7. Paint/Calculator/pure-GDI app issues explicitly excluded above.

Any state test that already passed remains part of the regression set; the GDI
gate adds visual proof rather than replacing semantic proof.

## Definition of done for this plan

- WordPad has a proven suspended-thread startup trace.
- Structured storage can serialize and reopen general trees in a fresh process.
- `IDataObject` supports multiple formats/media with correct ownership.
- Unknown, embedded, and linked OLE object state can persist without a live
  server; activation and drag/drop protocols are covered with a synthetic
  server/target.
- RichEdit has broader semantic RTF, large-document, Unicode, IME-state, and
  version coverage independent of pixels.
- Advanced WordPad/ListView command and notification state is covered.
- The selected app tracks have current deterministic control-flow tests and no
  unresolved nonvisual crash or corruption in the covered path.
- App/design docs distinguish completed state fidelity from visual work waiting
  on GDI.
