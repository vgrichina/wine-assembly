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

