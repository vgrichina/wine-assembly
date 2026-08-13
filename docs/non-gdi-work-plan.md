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
3. **Storage tree:** in progress. Nested create/open and lifetime pass; next are
   enumeration and commit/revert tests. Rename/delete/copy/move pass.
4. **CFB persistence:** deterministic writer, defensive reader, and
   fresh-process tree comparison.
5. **Multi-format transfer:** format collection, full enumerator, Unicode text,
   `GetDataHere`, and lifetime tests.
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
- [ ] Complete copy, set-size, sparse extension/zero fill, seek overflow, stat,
  lock/unlock-region, commit, and revert semantics used by Win9x OLE clients.
- [x] Make lifetime ownership explicit: a stream keeps its backing store alive;
  releasing a storage handle does not invalidate an independently retained
  stream.

2026-08-12 stream-core result: clones retain a canonical root stream, share its
mutable data/size/capacity, and keep their own positions. Write and SetSize are
visible across interfaces, shrink/grow zero-fills exposed bytes, HGLOBAL clones
return the same handle, and a clone remains readable after the original caller
and owning storage are released. `test/test-ole-storage.js` passes 27/27 after
the first storage-tree slice. The
unchecked line above remains open for full CopyTo/locking/transaction breadth.

### P2.2 Storage tree

- [x] Add nested `CreateStorage`/`OpenStorage` and case-insensitive child lookup.
- [x] Add stream/storage deletion and rename with collision/error behavior.
- [x] Add `CopyTo` and `MoveElementTo` for mixed stream/storage subtrees.
- Implement `EnumElements` with a real `IEnumSTATSTG`, including `Next` counts,
  `Skip`, `Reset`, `Clone`, and stable enumeration while referenced.
- Return correct `STATSTG` names, types, sizes, CLSIDs, and supported metadata.
- Implement in-memory commit/revert snapshots rather than leaving successful
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

### P2.3 Compound File Binary persistence

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

### Acceptance

- Existing `test/test-ole-storage.js` stays green.
- New storage-tree, enumerator, transaction, and CFB fresh-process tests pass
  without using any rendering API.

## P3 — General `IDataObject` and clipboard transfer

The current object is intentionally single-format. General OLE clipboard and
drag/drop need a real collection of formats and media.

### Work

- Replace the single `FORMATETC`/`STGMEDIUM` slot with an owned collection.
- Implement matching across clipboard format, aspect, lindex, and compatible
  `tymed` masks with accurate `DV_E_*` errors.
- Support `TYMED_HGLOBAL`, `TYMED_ISTREAM`, and `TYMED_ISTORAGE` ownership,
  duplication, `pUnkForRelease`, and `ReleaseStgMedium` behavior.
- Implement `GetDataHere` for compatible caller-provided global memory,
  streams, and storage.
- Complete `IEnumFORMATETC::Next/Skip/Reset/Clone` for more than one entry.
- Preserve stable format enumeration and media lifetime after clipboard owner
  changes, `OleSetClipboard`, `OleGetClipboard`, and `OleFlushClipboard`.
- Add `CF_UNICODETEXT` alongside ANSI/OEM text and registered RTF; preserve
  CRLF and terminating-null conventions exactly.
- Add advisory plumbing only after a traced consumer requires it:
  `DAdvise`, `DUnadvise`, `EnumDAdvise`, and change notification.

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
- Implement real `IPersistStorage::InitNew`, `Load`, `Save`, `SaveCompleted`,
  and `HandsOffStorage` against the P2 storage model.
- Generalize `IOleCache` beyond one DIB presentation, including replace/remove,
  cache enumeration, and format/aspect selection.
- Preserve unknown streams and storage children during load/save so an object
  can round-trip even when wine-assembly cannot activate its server.

### P4.2 Object lifecycle contracts

- Complete client-site ownership, host names, close/dirty transitions,
  extents, user class/type, misc-status, advisory connection, and running-state
  bookkeeping.
- Implement clipboard `InitFromData`/`GetClipboardData` through the generalized
  P3 object rather than DIB-only branches.
- Add a synthetic in-process OLE server fixture. Use it to test client calls,
  failure paths, refcounts, and persistence without depending on an installed
  desktop application or rendered pixels.

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
