# WebAssembly Engine Feature Support

ASCII TLDR:

```text
Probed, not recalled -- each row below is a hand-built module the engine either
validated or rejected, with a passing control and a passing NEGATIVE control.

                        multi-memory    wasm tail calls
  Node 23.10 / V8 12.9      YES              YES
  Chrome 151                YES              (not probed)
  Safari 26.4 / JSC         NO               implemented, shell default OFF
  iOS Safari                NO               same JSC, WebKit-only platform

Multi-memory is OFF THE TABLE for anything we ship: JSC has not implemented it
(no such flag exists in `jsc --options`), and unlike tail calls it is not
runtime-switchable -- it would mean two structurally different builds, not two
encodings of one build.
```

## Why this file exists

The build already ships two wasm binaries — `build/wine-assembly.wasm`
(`return_call`) and `build/wine-assembly.compat.wasm` (`call; return`) — chosen
at load time by `WineAssembly.supportsWasmTailCalls()`. That split only makes
sense against real engine data, and "I believe Safari shipped that in 18.x" is
not data. Reprobe rather than trust this table if it matters; the scripts are
small and listed at the bottom.

Note the deployment target: this project is served to browsers
(`wine-assembly.berrry.app`), so **Safari and iOS Safari are first-class**, not
an afterthought. A feature Chrome has and JSC lacks is a feature we do not have.

## Multi-memory

Proposal is standardised (phase 4). The memory section becomes an ordinary
vector, and `memarg`'s align byte gains bit 6 (`0x40`) meaning "a memory index
follows". So `i32.load` from memory 1 encodes as `0x28 0x42 0x01 0x00` rather
than `0x28 0x02 0x00`.

```text
Node 23.10 / V8 12.9
  YES  control: single memory, plain memarg
  YES  two memories declared in one module
  YES  i32.load addressed to memory index 1
  NO   negative control: memidx=1 with only one memory   <- correctly rejected

HeadlessChrome/151.0.0.0
  YES  control: single memory, plain memarg
  YES  two memories declared in one module
  YES  i32.load addressed to memory index 1
  NO   negative control: memidx=1 with one memory        <- correctly rejected

Safari 26.4 / JavaScriptCore
  YES  control: single memory, plain memarg
  NO   two memories declared in one module
  NO   i32.load addressed to memory index 1
  NO   negative control
```

The negative control matters: an engine that merely *ignored* the extra
immediate would have accepted it, so its rejection proves the memidx form is
really being parsed.

JSC's "NO" is **not implemented**, not "disabled by default": `jsc --options`
dumps every VM flag and contains no multi-memory entry at all, while sibling
wasm features do appear (`useWebAssemblyFastMemory`, `useWebAssemblyTailCalls`,
`maxNumWebAssemblyFastMemories`, …).

**Consequence for us.** Multi-memory looked attractive as a way to give each
thread instance its own unshared register file (see
[interpreter-dispatch-perf.md](interpreter-dispatch-perf.md)). It is not usable:

- JSC has not implemented it, so iOS/Safari users get nothing.
- It is not switchable at load time the way tail calls are. Tail calls differ by
  one instruction encoding for the same program; a register file in memory 1 vs
  memory 0 is a different program. That is two builds to maintain, not two
  lowerings.
- Even where supported, the hoped-for win is doubtful: engines special-case
  memory 0 (its base gets pinned), while a secondary memory's base and bound come
  out of the instance struct — putting you back at the dependent load the change
  was meant to avoid.

Still worth remembering for anything that genuinely wants a *separate address
space* — e.g. moving the emulator's own tables out of the guest's 128MB where a
wild guest pointer cannot reach them — if JSC ever ships it.

## WebAssembly tail calls

```text
Node 23.10 / V8 12.9
  YES  control: plain call + return
  YES  return_call        (validates, instantiates, returns the right value)

Safari 26.4 / JavaScriptCore, shell defaults
  YES  control: plain call + return
  NO   return_call

Safari 26.4 / JavaScriptCore, --useWebAssemblyTailCalls=true
  YES  control: plain call + return
  YES  return_call
```

So JSC **has** the implementation; the `jsc` shell just defaults it off
(`useWebAssemblyTailCalls=false` in `--options`). What could **not** be
established from this machine is whether Safari itself ships it enabled — the
shell default and Safari's WebKit feature default are separate settings, and the
WebKit binary lives in the dyld shared cache so the default cannot be read out
of it with `strings`.

That uncertainty costs nothing in practice: `supportsWasmTailCalls()` resolves it
per-engine at load time, which is precisely why the compat build exists. And per
[interpreter-dispatch-perf.md](interpreter-dispatch-perf.md), tail calls measured
*zero* benefit for our dispatch loop anyway, so nothing rides on the answer.

## Typed function-reference tables

Measured 2026-08-24.

|                          | V8 (node 23 / Chrome 151) | JavaScriptCore (Safari 26.4) |
|--------------------------|---------------------------|------------------------------|
| `(table N (ref null $t))` | YES                      | NO                           |
| `call_indirect` through it | YES                     | NO                           |

The interest is the dispatch tail. Our handler table is declared
`(table $handlers 426 funcref)` — untyped — so every `call_indirect` carries a
runtime signature check. In the SpiderMonkey Ion disassembly of `$next`
(`node tools/wasm-native.js --func='$next'`) that check is a load of a type word
out of the *callee's own code* followed by a compare, and it sits at the end of
the dependent load chain that produces the indirect branch target:

```
table bounds load -> table base load -> entry load -> instance ptr -> code ptr
    -> signature word (from the callee) -> br x8
```

Declaring the table with a concrete element type (`reftype 0x63` followed by the
type index, i.e. `(ref null $handler_t)`) makes the signature statically known
and lets an engine drop that last load and compare. V8 accepts such a table
today; JavaScriptCore rejects it outright, so it cannot be an unconditional
change — though note Safari is already conditional on tail calls, which the JSC
shell has off by default.

Compiler side, `lib/compile-wat.js` hardcodes the `0x70` (funcref) element byte
in the table section (two sites, one per emit path) and would need to emit the
typed encoding instead.

The negative control here is a non-nullable `(ref $t)` table declared with no
init expression, which every engine must reject; it does.

## Compiler-side gap

`lib/compile-wat.js` cannot emit either extension without work:

- Memarg encoding (`lib/compile-wat.js:1029`) writes `naturalAlign(op)` then the
  offset. There is no memidx path, and it does not honour an explicit `align=`
  in the source either.
- `return_call` `0x12` **is** implemented, with a compat lowering to
  `call; return` gated on `useTailCalls`. `return_call_indirect` `0x13` was added
  during the dispatch experiment and lives on `perf/next-tailcall-dispatch`, not
  on `main`.
- There are two import-emitting paths. The one at `lib/compile-wat.js:659`
  hardcodes the memory limits flag to `0x00`, dropping both `max` and `shared`;
  the one at `:1152` computes flags properly. Our shared-memory import must go
  through `:1152`, so `:659` looks stale — worth confirming and deleting rather
  than leaving as a trap.

## Reprobing

Everything above is reproduced by one tool. Re-run it rather than trusting this
page; engine support moves, and a stale table is worse than none.

```sh
node tools/wasm-feature-probe.js            # this node/V8 only
node tools/wasm-feature-probe.js --jsc      # + JavaScriptCore (Safari)
node tools/wasm-feature-probe.js --chrome   # + installed Chrome
node tools/wasm-feature-probe.js --all
```

It builds module bytes by hand because there is no other honest way to ask: a
compatibility table is hearsay, and asking `lib/compile-wat.js` would only report
what *we* emit. Each feature carries a positive control, and where the extension
reinterprets an existing encoding it carries a negative control too — the tool
prints `<-- CONTROL FAILED` and a warning if either misbehaves, because at that
point the YES/NO answers prove nothing.

To add a feature, append a case to the `cases` array in `PROBE_SRC`. Keep it
plain ES5 with no `require`/`Buffer`/`console`: the same source string is run by
node, by the `jsc` shell, and inside a browser page.

Two gotchas that cost time when writing it: the macOS JSC shell lives in
`Helpers/`, not `Resources/` (where the docs say); and puppeteer here has no
downloaded browser, so it needs an explicit `executablePath` —
`tools/profile-web-frames.js:70` has the path this project uses. The tool
handles both, and skips an engine cleanly when it is absent.
