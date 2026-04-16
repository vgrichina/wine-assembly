# Tracing & debug flag performance

Every `--trace-*`, `--break*`, `--watch`, and `--count` flag adds per-block or per-API work to the emulator hot path. Right now the cost is paid even when a flag is not set — the checks are unconditional WAT/JS branches, just with zero/empty inputs. This doc records what each flag costs so we know what to cut when we start dynamically compiling blocks.

## The hot loop

`src/13-exports.wat` `$run` dispatches one x86 block per iteration. At the top of each iteration, *unconditionally*:

- `$yield_flag` check
- `$watch_addr` check (+ `gl32` load if non-zero)
- `$bp_addr == $eip` compare
- `$hit_count_n` check, then loop over up to N slots comparing `$eip` to each (new — `--count=`)
- `$yield_reason == 1` check
- Thunk-zone range check (`thunk_guest_base <= eip < thunk_guest_end`)
- Hard-coded debug EIP probe at `0x01009604` (FUCOMPP legacy)
- `cache_lookup` (hash probe)

All of these fire on every block dispatch, whether or not the user set a flag.

## Per-flag cost

| Flag | Where it costs | Hot-path cost when disabled | Hot-path cost when enabled |
|---|---|---|---|
| `--trace` | JS, batch boundary | 1 bool check per batch | 1 `console.log` per batch (cheap — batch ≈ 200 blocks) |
| `--trace-api` | JS, per API call | 0 | 1 `console.log` per API call |
| `--trace-gdi` / `--trace-dc` / `--trace-dx` | JS, wraps host imports | 0 | closure call + log per wrapped import |
| `--trace-host=fn,...` | JS, wraps host imports | 0 | same |
| `--break=ADDR` | WAT `$bp_addr` compare | **1 i32.eq per block** (`$bp_addr`=0 always false) | 1 i32.eq per block + `br $halt` on hit |
| `--break-api=Name` | JS, per API call | 0 | 1 Set lookup per API call |
| `--watch=ADDR` | WAT, per block | **1 i32 load + compare per block** if `$watch_addr` live; 1 nullcheck otherwise | same |
| `--skip=ADDR` | JS, per batch-boundary EIP | 1 Array.includes per batch | same |
| `--count=ADDR,...` | WAT, per block | **1 null-check per block** (`$hit_count_n=0` → skip loop) | N i32.eq per block |
| `--trace-seh` | JS, on SEH ops (rare) | 0 | trivial |
| `--dump-*` | JS, end-of-run only | 0 | dump time |

Notes:
- "per block" ≈ 1 dispatch iteration in `$run`. On a busy frame, 200k+/sec.
- "per batch" ≈ 1 per ~200 blocks (BATCH_SIZE default).
- The always-on FUCOMPP probe at `0x01009604` adds one unconditional i32.eq per block — it's a leftover debug aid and should be deleted once we trust that fix.
- `$watch_addr` currently costs a nullcheck even when unused; same for `$bp_addr`.

## Rough impact today

Ballpark: the always-on per-block overhead (bp nullcheck + watch nullcheck + thunk range check + FUCOMPP probe + count nullcheck) is ~5-8 extra i32 ops per block dispatch. Against a decoded block that typically emits dozens of threaded-code `$next` calls, this is **a few percent** — measurable but not disastrous.

When hit counters are active with N=16, each dispatch does 16 compares. At ~200k blocks/sec that's 3.2M compares/sec — still <1% CPU, but worth noting for long soaks.

## When dynamic compile lands

Once we have a JIT/cache that emits per-block WASM, every one of these per-block checks should be hoisted out:

1. **Compile-time specialization**: generate one block body with all probes disabled (fast path) and one with them enabled (debug path). Swap at the block-start trampoline based on a single "any-debug-active" flag.
2. **Drop the FUCOMPP probe** entirely (it's one address, and we have `--break`/`--count` now).
3. **Fold `$bp_addr` into the decoder**: when decoding a block whose start == `$bp_addr`, emit a halt at entry. No runtime compare needed.
4. **Fold `$count_addrs` the same way**: at decode time, check whether the block's start EIP is in the active count set; if yes, emit one store-increment at block entry, otherwise nothing. This turns per-block O(N) into O(0).
5. **Keep `$watch_addr` runtime-checked** (memory watches can't be specialized per-block), but move the load outside the block loop into a periodic poll if watch granularity allows.

The `--count=` flag added today is a good motivating example: useful for forensics, but we don't want to pay for it on every block forever.
