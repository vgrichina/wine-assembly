# Runtime TrueType hinting design

## Decision

TrueType programs run in WAT at runtime. They are not converted into bitmap
strikes during the build, and this work does not change the independent
`MS Sans Serif` bitmap-font path.

The interpreter uses one bounded 256-way `br_table` dispatch. Direct opcodes
have direct targets; encoded families such as `MDRP`, `MIRP`, and `PUSHB/W`
share one target per family and decode their low bits there. This gives the
hot instruction loop one range check and one indirect branch without a long
chain of comparisons.

The implementation is direct handwritten WAT in `src/10c1-truetype-hint.wat`.
There is no C intermediary, generated interpreter, host-side bytecode path, or
external renderer implementation used as a blueprint. Its inputs are the
Apple and Microsoft TrueType specifications, the repository's existing sfnt
and raster paths, and measurements from the local original Windows 98 fonts.

```
                               RUNTIME ONLY

 guest TTF bytes
       |
       v
 +------------------+       +----------------------------------+
 | existing sfnt    |------>| bounded font inputs              |
 | parser           |       |                                  |
 |                  |       | cvt / fpgm / prep / maxp limits  |
 | head hhea cmap   |       | function + instruction defs      |
 | loca glyf hmtx   |       +----------------+-----------------+
 +--------+---------+                        |
          |                                  | once per ppem
          | outline                          v
          |                    +-------------------------------+
          |                    | size hint context             |
          |                    |                               |
          |                    | scaled CVT / storage          |
          |                    | prep result / graphics-state  |
          |                    | template / scan controls      |
          |                    +---------------+---------------+
          |                                    |
          v                                    v
 +----------------------------------------------------------------+
 | glyph hint context                                             |
 |                                                                |
 | real points + 4 phantom points                                 |
 | current 26.6 | original 26.6 | touched X/Y | contour endpoints |
 | twilight zone | stack | call stack | zp0/zp1/zp2 | vectors     |
 +-------------------------------+--------------------------------+
                                 |
                                 v
                    +----------------------------+
                    | fetch -> validate ->       |
                    | br_table[opcode 0..255]    |
                    | -> execute -> next         |
                    +-------------+--------------+
                                  |
                       glyph end / IUP complete
                                  |
                                  v
 +----------------+    +--------------------+    +----------------+
 | hinted advance |<---| hinted point array |--->| existing curve |
 | + side bearings|    |                    |    | flatten + scan |
 +----------------+    +--------------------+    +-------+--------+
                                                         |
                                                         v
                                                  existing FNT-like
                                                  glyph cache / GDI
```

## Why runtime hinting is the target

The local reference material contains byte-for-byte fonts extracted from the
user's Windows 98 VM. They remain ignored local data and must never be
committed. The initial oracle used the regular Arial, Times New Roman, and
Courier New files.

An earlier black-box native-hinter measurement established that executing the
embedded programs explained most of the Win98 pixel delta. That measurement
was diagnostic only. No external hinter source was consulted, and it is not
an implementation or compatibility oracle.

```
                         aligned ink overlap vs Win98

 current WAT, unhinted          54.00%  |#################.............|
 native hinter control         95.45%  |#############################.|
   Arial                       96.03%
   Times New Roman             94.33%
   Courier New                 96.07%
```

The roughly 41-point recovery establishes grid fitting as the missing layer.
The remaining roughly 4.5 points include raster/dropout behavior, TrueType
engine-version differences, and small origin/rounding differences. Therefore
the implementation gate compares both hinted point coordinates and final
pixels; a bitmap-only comparison cannot identify which layer is wrong.

The existing Win98 `GetGlyphOutline` capture also found identical bytes for
the tested Arial glyphs with and without `GGO_UNHINTED`. The compatibility
tests must preserve this measured Win98 behavior rather than assuming the flag
has modern Windows semantics.

The stronger point-level check decoded Win98's quadratic `GGO_NATIVE` data
and compared it with the native-hinter control in 26.6 coordinates at 24
ppem:

```
 glyph       topology       exact coordinates       largest difference

 A           identical          28 / 30                   1 / 64 px
 g           identical         101 / 112                  1 / 64 px
 e-acute     identical          81 / 86                   1 / 64 px
 -----------------------------------------------------------------------
 total                          210 / 228                  1 / 64 px
```

This establishes both the ppem mapping and an attainable point-level target.
It also gives the implementation a strict diagnostic rule: coordinate errors
larger than 1/64 px are interpreter/scaling errors before raster differences
are considered.

## Current implementation gate

The shipping-font gate runs `A`, `g`, and `e-acute` at 9, 16, and 24 ppem
through all 14 scalable subset faces: 126 runtime programs. A separate dense
gate executes every outlined ANSI glyph in the full Liberation Sans source
face and verifies that corrupt or unsupported bytecode falls back without a
trap.

When the ignored local Windows 98 fonts are installed, the oracle additionally
checks:

- Arial `A`: all y coordinates and the hinted advance match exactly; 13 of 15
  x coordinates match exactly and the other two differ by 1/64 pixel;
- Arial `e-acute`: all four child-acute points match the Win98 quadratic
  capture exactly after child and parent programs run;
- Arial `A`, `g`, and `e-acute`: all six public `GLYPHMETRICS` fields match the
  Win98 `GGO_NATIVE` capture exactly;
- the representative Arial, Times New Roman, and Courier New programs all
  execute through the handwritten WAT engine.

The emitted `GGO_NATIVE` polygon packing is not yet byte-identical to Win98 and
is not claimed or tested as such. The compatibility claims above are limited
to the measured point, advance, and metrics gates.

## Ownership and lifetime

```
 face: loaded once per font file
   |
   +-- immutable sfnt table bounds
   +-- raw fpgm / prep / CVT / glyph-program bounds
   +-- maxp-declared capacities, clamped to hard engine limits
   |
   `-- size[ppem, relevant render mode]
         |
         +-- scaled CVT
         +-- storage
         +-- FDEF definitions produced by fpgm
         +-- prep graphics-state template
         +-- scan_control / scan_type / instruction_control
         +-- twilight storage
         |
         `-- glyph[glyph id, transform class]
               |
               +-- decoded composite/simple outline
               +-- hinted points and phantom points
               +-- hinted metrics
               `-- raster/cache entry
```

The current bounded cache owns eight size contexts. `fpgm` and `prep` execute
when a ppem context is initialized; definitions, CVT, storage, twilight
points, and the post-`prep` template live in that context. Each glyph begins
from the size's saved
post-`prep` graphics-state template while using the size-owned CVT and
storage. Per-glyph stacks, call frames, point zones, and touched flags are
fresh. A failed initialization marks only that face or size program unusable;
it does not poison unrelated faces or sizes.

Hinting occurs in the ppem grid before an affine `MAT2` transform is applied.
The cache key must consequently distinguish at least face, ppem, glyph,
render mode, and the transform class that can affect the final result. The
existing unhinted outline remains reusable across sizes.

## Point representation

The existing compact six-byte outline records remain the parser's durable
form. The hinter expands a glyph into bounded scratch arrays:

```
 point i
 +----------------+----------------+----------------+----------------+
 | current.x 26.6 | current.y 26.6 | original.x 26.6| original.y 26.6|
 +----------------+----------------+----------------+----------------+
 | onCurve        | contour end    | touched.x      | touched.y      |
 +----------------+----------------+----------------+----------------+

 glyph zone = decomposed real points || phantom[0..3]
 zone 0     = bounded twilight points
```

Each composite child is independently scaled and grid-fitted, then transformed
and translated into the parent's point-number space. The parent composite
program runs over the accumulated contours. `ROUND_XY_TO_GRID`, point-matched
placement, nested components, and `USE_MY_METRICS` are bounded explicitly;
the selected component phantoms become the parent's phantoms. Hinted phantom
points provide advance and side-bearing results and are never flattened.

All coordinate math is signed and uses explicit 26.6 or 2.14 helpers. Each
multiply/divide states its rounding rule; implicit WAT truncation is not a
rounding policy.

## Interpreter loop

`br_table` is appropriate, but only after validation. The handwritten
structured dispatch groups encoded opcode families at shared targets while
retaining an explicit reject target for the remaining byte values.

```
 run(program, length, state)
          |
          v
   +--------------+    no    +----------------------+
   | pc < length? |--------->| reject this program  |
   +------+-------+          +----------------------+
          | yes
          v
   +--------------+    no    +----------------------+
   | budget left? |--------->| reject this program  |
   +------+-------+          +----------------------+
          | yes
          v
   opcode = byte[pc++]
          |
          v
   +--------------------------------------------------------------+
   | br_table[opcode]                                             |
   |                                                              |
   | SVTCA -> vector         PUSHB/PUSHW -> width-family handler   |
   | MDAP  -> point          MDRP[32]    -> flag-family handler    |
   | MIAP  -> CVT+point      MIRP[32]    -> flag-family handler    |
   | CALL/LOOPCALL -> calls  FDEF        -> definition handler    |
   | IF/ELSE/EIF -> control  unknown/IDEF -> reject               |
   +-------------------------------+------------------------------+
                                   |
                         validate every operand
                                   |
                                   `---------------> next opcode
```

The dispatch table accounts for all 256 byte values. Reserved or unimplemented
opcodes do not silently become no-ops. `IDEF` is deliberately rejected for the
measured Windows 98 font set, which declares zero instruction definitions.

The first compatibility tranche must cover the instruction surface actually
present in the three original Win98 oracle fonts. The census includes control
flow and functions, vector/round state, CVT/storage, interpolation, delta
instructions, point/contour shifts, and the `MDRP`/`MIRP` families. It is not
enough to implement only `MIAP` plus `IUP`: the original programs heavily use
`CALL`, `IP`, `SHP`, `SHC`, `DELTAP1`, and both relative-move families.

## Failure and safety contract

A malformed or unsupported program never leaves a half-hinted glyph.

```
 snapshot unhinted points + metrics
                |
                v
       execute complete program
          |              |
        success        any fault
          |              |
          v              v
 use hinted result   restore snapshot
                           |
                           v
                    render unhinted glyph
```

Faults include:

- bytecode reads outside the current program;
- stack underflow/overflow or invalid call depth;
- point, contour, CVT, storage, function, or zone indices out of bounds;
- division by zero or invalid vector normalization;
- instruction/call budgets being exhausted;
- a reserved opcode with neither a built-in handler nor an `IDEF`.

Limits come from `maxp` only after clamping to engine hard maxima. Separate
budgets cover executed instructions and nested calls, so a legal backward
jump cannot hang the browser. Arithmetic helpers avoid host traps and define
saturation/rounding explicitly. A font failure is cached at the narrowest
correct lifetime so repeated text does not repeatedly execute a known-bad
program.

## Raster and dropout boundary

The interpreter owns point positions, touched flags, phantom metrics, and the
scan-control state. The existing rasterizer continues to own quadratic
flattening and coverage generation initially.

```
       point oracle                         pixel oracle
 GGO_NATIVE polygon bytes            GGO_BITMAP / gray bytes
           |                                   |
           v                                   v
 interpreter correctness  ----->  scan conversion / dropout correctness
```

If hinted `GGO_NATIVE` points match Win98 but bitmap pixels do not, the fix
belongs in scan conversion or dropout control—not in opcode behavior. The
`SCANCTRL`, `SCANTYPE`, and `INSTCTRL` results cross this boundary explicitly
instead of being discarded.

## Implementation order and gates

```
 [0] original-font oracle
      hashes + Win98 GGO_NATIVE/GGO_BITMAP + local control
                         |
 [1] state/decoder shell + br_table + hard limits
                         |
 [2] fpgm definitions, calls, stack, flow, storage/CVT
                         |
 [3] vectors, projection math, rounding, point moves
                         |
 [4] interpolation, shifts, deltas, MDRP/MIRP families
                         |
 [5] prep-per-ppem and glyph/phantom integration
                         |
 [6] scan/dropout compatibility and cache integration
                         |
 [7] Arial + Times + Courier Win98 point/pixel gates
```

Each stage needs focused malformed-font tests as well as positive opcode
tests. The integration is accepted only when all of these hold:

1. The exact local Win98 fonts execute at runtime; no pre-rendered strike is
   involved in the shipping path.
2. Original Arial/Times/Courier hinted outline coordinates are compared with
   the Win98 `GGO_NATIVE` oracle at representative ppem values.
3. Final monochrome and gray outputs are compared separately, with shifts and
   ink counts reported rather than hidden by one aggregate score.
4. Hinted advances and bearings feed text measurement and drawing from the
   same cached glyph result.
5. Unsupported or corrupt programs reproduce the clean unhinted result and
   cannot trap or loop indefinitely.
6. The existing bitmap/MS Sans tests remain unchanged in behavior.

## ASCII TL;DR

```
 original Win98 TTF
        |
        v
 fpgm + prep once/ppem context -> glyph program on each cache miss
        |                 |                    |
        +-----------------+--------------------+
                          v
              guarded 256-way br_table VM
                          |
                 hinted points + metrics
                          |
                 existing WAT raster/GDI

 unhinted today: 54.00%       native-hint control: 95.45%

 malformed / unsupported bytecode => discard ALL partial moves
                                    => render clean unhinted glyph

 MS Sans bitmap work =================================> untouched
```
