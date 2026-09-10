# Semantic expression fusion benchmark brief

## Question

Can a stack or register interpreter profitably lower short arithmetic sequences
to expression dataflow, instead of dispatching one handler per guest opcode?

The transformation is:

```text
guest stack/register operations        semantic expression

FLD a                                  STORE d
FMUL b                                    |
FADD c                                   ADD
FSTP d                                  /   \
                                       MUL   LOAD c
                                      /   \
                                LOAD a     LOAD b
```

The exact arm must retain the source program's evaluation order. It may remove
temporary stack movement and intermediate architectural-state writes, but it
must not reassociate arithmetic or introduce an FMA.

## Representations to compare

Use one common seeded state and checksum every observable result.

1. **Opcode handlers:** one indirect dispatch per guest operation; architectural
   stack/register state is read and written by each handler.
2. **Micro-op VM:** enter once, then one `switch`/`br_table` case per semantic
   operation; values may use locals, but there is still per-operation dispatch.
3. **Fused descriptor:** one dispatch selects a parameterized expression shape;
   the complete formula runs straight-line using locals.
4. **Straight region:** a specialized straight-line function for the expression,
   with architectural state materialized only at entry, exit and side exits.
5. **Direct-memory control:** straight-line expression, but temporary stack slots
   stay in interpreter memory. This isolates the value of locals from the value
   of eliminating dispatch.

## Primitive vocabulary

```text
Leaves:   load_f32/f64, load_i16/i32/i64, constant, existing_stack_slot
Unary:    neg, abs, sqrt
Binary:   add, sub, mul, div
Outputs:  store_f32/f64, integer conversion/store, write_stack_slot
Address:  base + index*scale + displacement
```

Stack actions such as push, pop, duplicate and swap should become decode-time
reference renaming where possible. They should not be runtime micro-ops in the
fused and straight-region arms.

## x86 integer expression lowering

The same representation applies to ordinary x86 integer code, and its core
arithmetic is simpler because Wasm `i32` wrapping matches 32-bit x86 addition,
subtraction and multiplication:

```text
mov eax,[x]
imul eax,3             STORE32 z
add eax,[y]               |
xor eax,mask             XOR
mov [z],eax             /   \
                      ADD   mask
                     /   \
                   MUL   LOAD32 y
                  /   \
            LOAD32 x    3
```

The expression IR should distinguish a value from the flags produced by that
value. Flags may remain lazy when nothing observes them:

```text
v1 = add32(a,b)             ; wrapping value
f1 = flags_add32(a,b,v1)    ; materialize only if consumed
```

Examples:

```text
add eax,ebx; add eax,ecx; mov [p],eax
  -> store32(p, add32(add32(eax,ebx),ecx))

add eax,ebx; adc edx,0
  -> t = add_with_carry32(eax,ebx,0)
     eax = t.value
     edx = add32(edx,t.carry)

cmp eax,limit; jl target
  -> branch(signed_lt32(eax,limit), target, fallthrough)
```

Start with full-register `i32` operations. Treat `AL/AH/AX` writes as barriers
until the IR explicitly models insert/extract operations, because `AH` aliases
bits 8-15 rather than a separate register. Likewise, do not initially fuse
across `PUSHFD`, `LAHF`, `SETcc`, `ADC`, `SBB`, rotates-through-carry or a branch
unless the region carries the required flag value to that consumer.

Memory accesses remain an ordered side-effect list even when arithmetic becomes
a tree:

```text
r = load32(a)       # access 0
s = load32(b)       # access 1
store32(c,r+s)      # access 2
```

Do not move the store ahead of either load unless alias analysis proves it safe.
Preserve original fault order in exact mode. `DIV/IDIV` require explicit zero and
quotient-overflow checks matching x86 traps; shifts require x86's masked count
and exact flag rules. These are later primitives, not ordinary Wasm `/` or `>>`.

Useful integer benchmark arms should include:

```text
flag-dead arithmetic chain
arithmetic followed by Jcc
ADC/SBB carry chain
base+index address-update loop
partial-register near miss
possibly-aliasing load/store near miss
DIV zero/overflow side exits
```

Exact integer fusion should be bit- and state-identical. There is little reason
for an integer "fast math" mode: reassociation is safe only when both value and
all intermediate flag observations are proven irrelevant. That is an optimizer
proof, not an application tolerance setting.

## Workloads

Test at least these exact-order shapes at lengths 4, 8, 16 and 32 semantic
operations, with 1, 2, 4, 8, 16, 64 and 256 repetitions per entry:

```text
pipeline:       out = ((a * b) + c)
tree:           out = (a * b) + (c * d)
deep stack:     out = ((a + b) * (c - d)) / e
mixed integer:  out = ((x * 3) + y) ^ mask
mixed address:  out[i] = in[i] * scale + bias
```

Include register/local pressure comparable to the host interpreter: eight live
integer registers, flags, stack TOP/tags, instruction/budget state and address
temporaries. A tiny formula with nothing else live gives a misleading ceiling.

## Exact and relaxed modes

```text
exact:
  preserve source operation order
  preserve wrapping integer behavior
  preserve flag/status results at every observable boundary
  no reassociation and no implicit FMA

relaxed floating-point (separate opt-in arm):
  permit reassociation of add/multiply trees
  permit FMA
  permit independent-lane SIMD
```

Never compare relaxed output by exact bits alone. Report maximum absolute error,
maximum ULP error, image PSNR/hash-distance for pixel kernels, and whether any
comparison/branch outcome changes. Exact mode must remain bit/state identical.

## Safepoints and side exits

Charge entry/exit materialization in the timed region. Compare safepoint periods
`K = 1, 4, 8, 16, 32, 64`. A side exit must materialize all live architectural
values before returning to the scalar interpreter.

Initially treat these as barriers:

```text
status/control-word observation or mutation
unknown calls
memory alias not represented by the expression
branch merge with incompatible stack shape
unsupported conversion or transcendental operation
```

## Measurements

For every engine and workload report:

```text
ns per semantic guest operation
ratio to opcode-handler baseline
break-even repetition count
generated Wasm bytes
projection/compile/instantiate time
branch or dispatch count when available
entry/exit materialization cost
checksum or exact-state equality
```

Run Node/V8, browser Chrome/V8 and JavaScriptCore. Label a JSC shell result as
JSC, not Safari. Rotate arm order and use multiple warm median samples.

## Expected hypothesis

The local-stack micro-op VM is expected to provide only a small, engine-sensitive
gain because it retains one unpredictable branch per operation. Fused descriptors
and straight regions should win when they turn several guest operations into one
predictable straight-line host expression. Previous Wine-Assembly experiments
found straight local regions crossing direct-memory regions after roughly 4-8
repetitions and a useful safepoint neighborhood around `K=16`; ToyVM should test
those values independently rather than treating them as constants.

## Wine-Assembly calibration (2026-09-10)

The first production prototype now supplies three opt-in lowering arms:

```text
H448  straight  FLD mem; arithmetic mem; arithmetic mem; FSTP mem
H449  tree      FLD mem; FLD mem; arithmetic-pop; FSTP mem
H450  island    arbitrary contiguous H188/H189/H190 stream, canonical helpers
```

On Node/V8, 200,000 real decoded guest iterations with nine rotated rounds gave:

```text
shape       scalar median   fused median   local speedup
pipeline       23.50 ms       16.68 ms         1.41x
tree           26.50 ms       18.13 ms         1.46x
Alpha island   53.71 ms       40.21 ms         1.34x
```

The Alpha Centauri movie's actual hot x87 sequence is not either four-op leaf.
It is two longer islands separated by integer work. H450 executes 412,060 times
over the fixed movie window and removes 2,472,360 threaded handler dispatches:
57,814,507 total handlers become 55,342,147, a 4.28% count reduction. All 20
anchored 640x480 frame hashes remain identical.

That did not produce a resolvable whole-movie gain on the loaded benchmark host:
the fixed-frame ratio was 0.982x while the fixed-wall arm happened to produce
four extra frames, a contradictory result inside machine noise. The profile
explains the ceiling: x87 is about 5.7% of the handler stream and the integer
Smacker decoder dominates. Treat H450 as evidence that generic micro-op islands
are viable and exact, not as evidence that they solve Alpha's frame rate. The
next useful experiment is direct semantic lowering of proven trees/islands, then
the same expression machinery applied to the dominant integer decode regions.
