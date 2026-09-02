// test/watx-compiler-typed-pointers.test.js — Tiers 1 and 3 of
// docs/watx-typed-pointers-design.md: `ptr<Layout>` on params/locals/lets/results,
// and `(cast ptr<Layout> EXPR)`.
//
// ── what this proves, and why each part is here ────────────────────────────
//
//   (1) ERASURE. The whole feature is worthless if it changes the shipped
//       module, so the FIRST assertion is byte identity: the same program
//       written with and without annotations and a cast compiles to the same
//       bytes. This is the unit-level twin of the full-build oracle (a clean
//       worktree build of the emulator at the same commit, with and without
//       these compiler files, produced the same 997848-byte artifact).
//
//   (2) REFUSALS, one per check site. A pointer whose declared pointee
//       disagrees is refused at a layout accessor, at local.set/set!, at a let,
//       at a call argument and at an explicit (return ...). Each is asserted to
//       be LOCATED (a line number) — an unlocated refusal in a 61-file build is
//       barely better than none.
//
//   (3) THE QUIET DIRECTION. Untyped i32 stays untyped: unknown is BOTTOM, not
//       i32, and a module that never writes ptr<...> must compile exactly as it
//       did. Without this the feature would be a tree-wide cast storm rather
//       than opt-in, so it is asserted, not assumed.
//
//   (4) PRODUCTION MODE. Every refusal is re-checked with { mode: 'production' },
//       because that is the mode the emulator is built in and it is the mode
//       where checkTypes does NOT walk function bodies. A rule that only fires
//       in debug mode does not hold for the artifact we ship — the reason these
//       checks live in codegen at all.
//
// Run: node test/watx-compiler-typed-pointers.test.js
'use strict';
const path = require('path');
const { compile } = require(path.join(__dirname, '..', 'tools', 'watx.js'));

let pass = 0, fail = 0;
function ck(name, ok, got) {
  if (ok) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${got !== undefined ? ' (got ' + JSON.stringify(got) + ')' : ''}`); }
}

const PRELUDE = `
  (memory 1)
  (layout Foo (field a i32) (field b i32))
  (layout Bar (field x i32) (field y i32))
`;

function build(src, opts = {}) {
  return compile(PRELUDE + src, new Map(), { mode: 'production', streaming: false, ...opts });
}

// A refusal is only useful if it names a place and says the right thing.
function ckRefused(name, src, needles, opts) {
  const r = build(src, opts);
  if (r.success) { ck(name, false, 'compiled'); return; }
  const msg = r.error || '';
  const missing = needles.filter(n => !msg.includes(n));
  ck(name, missing.length === 0 && r.errorLine > 0,
     missing.length ? { missing, msg } : { line: r.errorLine, msg });
}

function ckAccepted(name, src, opts) {
  const r = build(src, opts);
  ck(name, r.success === true, r.success ? undefined : r.error);
}

console.log('\n== 1. erasure: annotations and casts must not change one byte ==');
{
  const plain = build(`
  (func $f (param $q i32) (result i32) (effects)
    (local $p i32)
    (local.set $p (i32.add (local.get $q) (i32.const 8)))
    (load.field Foo b (local.get $p)))`);
  const typed = build(`
  (func $f (param $q i32) (result i32) (effects)
    (local $p ptr<Foo>)
    (local.set $p (cast ptr<Foo> (i32.add (local.get $q) (i32.const 8))))
    (load.field Foo b (local.get $p)))`);
  ck('both compile', plain.success && typed.success, plain.error || typed.error);
  if (plain.success && typed.success) {
    const a = Buffer.from(plain.wasmBinary).toString('hex');
    const b = Buffer.from(typed.wasmBinary).toString('hex');
    ck('annotated + cast build is BYTE-IDENTICAL to the bare one', a === b,
       a === b ? undefined : { plainBytes: plain.wasmBinary.length, typedBytes: typed.wasmBinary.length });
  }
  // --checked-casts on a cast with nothing to check is a DOCUMENTED no-op. It
  // once still allocated a scratch local, which is a difference with no
  // instruction behind it; that is what this line is guarding.
  const checked = build(`
  (func $f (param $q i32) (result i32) (effects)
    (local $p ptr<Foo>)
    (local.set $p (cast ptr<Foo> (i32.add (local.get $q) (i32.const 8))))
    (load.field Foo b (local.get $p)))`, { checkedCasts: true });
  ck('--checked-casts on a non-union cast is a true no-op (no phantom local)',
     checked.success && Buffer.from(checked.wasmBinary).equals(Buffer.from(plain.wasmBinary)),
     checked.success ? checked.wasmBinary.length : checked.error);
}

console.log('\n== 2. a typed base is checked at every accessor ==');
for (const acc of [
  ['load.field',        '(load.field Bar x (local.get $p))'],
  ['load.field.memarg', '(load.field.memarg Bar x (local.get $p))'],
  ['store.field',       '(store.field Bar x (local.get $p) (i32.const 1))'],
  ['load.elem',         '(load.elem Bar x (local.get $p) (i32.const 0))'],
  ['store.elem',        '(store.elem Bar x (local.get $p) (i32.const 0) (i32.const 1))'],
  ['load.field-elem',   '(load.field-elem Bar x (local.get $p) (i32.const 0))'],
  ['elem-addr',         '(elem-addr Bar x (local.get $p) (i32.const 0))'],
]) {
  ckRefused(`${acc[0]}: ptr<Foo> base under a Bar accessor is refused`,
    `(func $f (param $p ptr<Foo>) (result i32) (effects) (drop ${acc[1]}) (i32.const 0))`,
    ['ptr<Foo> where ptr<Bar> is required', 'cast ptr<Bar>']);
}
ckAccepted('the matching accessor is accepted',
  `(func $f (param $p ptr<Foo>) (result i32) (effects) (load.field Foo a (local.get $p)))`);

console.log('\n== 3. the other three check sites ==');
ckRefused('local.set of ptr<Bar> into a ptr<Foo> local',
  `(func $mk (result ptr<Bar>) (effects) (i32.const 16))
   (func $f (result i32) (effects)
     (local $p ptr<Foo>)
     (local.set $p (call $mk))
     (load.field Foo a (local.get $p)))`,
  ['local.set $p', 'ptr<Bar> where ptr<Foo> is required']);

ckRefused('let annotated ptr<Foo> initialised from ptr<Bar>',
  `(func $mk (result ptr<Bar>) (effects) (i32.const 16))
   (func $f (result i32) (effects) (drop (let $p ptr<Foo> (call $mk))) (i32.const 0))`,
  ['let $p', 'ptr<Bar> where ptr<Foo> is required']);

ckRefused('call argument of the wrong pointee',
  `(func $use (param $p ptr<Foo>) (result i32) (effects) (load.field Foo a (local.get $p)))
   (func $mk (result ptr<Bar>) (effects) (i32.const 16))
   (func $f (result i32) (effects) (call $use (call $mk)))`,
  ['call $use arg 0', 'ptr<Bar> where ptr<Foo> is required']);

ckRefused('explicit (return ...) of the wrong pointee',
  `(func $mk (result ptr<Bar>) (effects) (i32.const 16))
   (func $f (result ptr<Foo>) (effects) (return (call $mk)))`,
  ['return from $f', 'ptr<Bar> where ptr<Foo> is required']);

console.log('\n== 4. a cast is what makes the narrowing legal ==');
ckAccepted('cast turns the refused local.set into an accepted one',
  `(func $mk (result ptr<Bar>) (effects) (i32.const 16))
   (func $f (result i32) (effects)
     (local $p ptr<Foo>)
     (local.set $p (cast ptr<Foo> (call $mk)))
     (load.field Foo a (local.get $p)))`);
ckRefused('a cast target must be a pointer type',
  `(func $f (result i32) (effects) (cast i32 (i32.const 0)))`,
  ['a cast target must be a pointer type']);
ckRefused('a cast to an unknown layout is refused',
  `(func $f (result i32) (effects) (cast ptr<Nope> (i32.const 0)))`,
  ["no such (layout ...) declaration named 'Nope'"]);

console.log('\n== 5. unknown is BOTTOM: untyped i32 stays quiet ==');
ckAccepted('an untyped i32 base is accepted at any accessor (opt-in typing)',
  `(func $f (param $p i32) (result i32) (effects) (load.field Bar x (local.get $p)))`);
ckAccepted('a plain i32 may be stored into a typed local without a cast',
  `(func $f (result i32) (effects)
     (local $p ptr<Foo>)
     (local.set $p (i32.const 64))
     (load.field Foo a (local.get $p)))`);
ckAccepted('pointer arithmetic leaves the type system rather than lying about it',
  `(func $f (param $p ptr<Foo>) (result i32) (effects)
     (load.field Bar x (i32.add (local.get $p) (i32.const 8))))`);

console.log('\n== 6. declaration-site refusals ==');
ckRefused('an unknown layout in a param is refused at the DECLARATION',
  `(func $f (param $p ptr<Nope>) (result i32) (effects) (i32.const 0))`,
  ["(param $p ptr<Nope>) of $f", "no such (layout ...) declaration"]);
ckRefused('an unknown layout in a result is refused at the DECLARATION',
  `(func $f (result ptr<Nope>) (effects) (i32.const 0))`,
  ["(result ptr<Nope>) of $f"]);
ckRefused('a malformed pointer type is refused',
  `(func $f (param $p ptr<) (result i32) (effects) (i32.const 0))`,
  ['is not a well-formed pointer type']);
ckRefused("(field x i8 N) says 'spell the signedness' instead of internal-erroring",
  `(layout Baz (field a i8 4))
   (func $f (result i32) (effects) (i32.const 0))`,
  ['u8 or s8', 'ACCESS WIDTH']);

console.log('\n== 7. the refusals hold in DEBUG mode too ==');
// Production is the mode that matters (it is what tools/build.sh uses, and the
// mode in which checkTypes does not walk bodies at all). Debug mode runs the
// advisory checker as well, so this re-run proves the new refusals are not
// accidentally dependent on which pass got there first.
ckRefused('accessor refusal survives mode:debug',
  `(func $f (param $p ptr<Foo>) (result i32) (effects) (load.field Bar x (local.get $p)))`,
  ['ptr<Foo> where ptr<Bar> is required'], { mode: 'debug', collectWarnings: false });

// ─────────────────────────────────────────────────────────────────────────────
// Tier 2: (enum ...) / (layout-union ...) / (view ...)
//
// The offsets are asserted by RUNNING the module, not by reading the source.
// That is not ceremony: the first implementation dropped the first prefix field
// silently (it read a (prefix ...) form from index 2, where a (layout NAME ...)
// keeps its name), so every variant compiled, every type check passed, and every
// offset after the tag was short by four bytes. Only the numbers showed it.
// ─────────────────────────────────────────────────────────────────────────────

const UNION = `
  (enum GdiType (PEN 1) (BRUSH 2) (BITMAP 3) (WMF 6) (EMF 7))
  (layout-union GdiObject
    (tag type GdiType)
    (prefix (field handle i32) (field type i32))
    (variant GdiPen      (tag-value PEN)     (field style i32) (field width i32))
    (variant GdiBitmap   (tag-value BITMAP)  (field w i32) (field h i32) (field bpp i32) (field bits i32))
    (variant GdiMetafile (tag-value WMF EMF) (field records i32)))
`;

function run(src, opts = {}) {
  const r = build(src, opts);
  if (!r.success) return { error: r.error };
  const inst = new WebAssembly.Instance(new WebAssembly.Module(Buffer.from(r.wasmBinary)), {});
  return { exports: inst.exports };
}

console.log('\n== 8. a union lays every variant out over one prefix ==');
{
  const g = run(UNION + `
    (func (export "size_union")  (result i32) (effects) (size-of GdiObject))
    (func (export "size_pen")    (result i32) (effects) (size-of GdiPen))
    (func (export "size_bitmap") (result i32) (effects) (size-of GdiBitmap))
    (func (export "size_meta")   (result i32) (effects) (size-of GdiMetafile))
    (func (export "off_union_handle")  (result i32) (effects) (offset-of GdiObject handle))
    (func (export "off_union_type")    (result i32) (effects) (offset-of GdiObject type))
    (func (export "off_pen_handle")    (result i32) (effects) (offset-of GdiPen handle))
    (func (export "off_pen_type")      (result i32) (effects) (offset-of GdiPen type))
    (func (export "off_bitmap_type")   (result i32) (effects) (offset-of GdiBitmap type))
    (func (export "off_meta_type")     (result i32) (effects) (offset-of GdiMetafile type))
    (func (export "off_pen_style")     (result i32) (effects) (offset-of GdiPen style))
    (func (export "off_bitmap_w")      (result i32) (effects) (offset-of GdiBitmap w))
    (func (export "off_bitmap_bits")   (result i32) (effects) (offset-of GdiBitmap bits))`);
  if (g.error) { ck('union module compiles', false, g.error); }
  else {
    const e = g.exports;
    // The widest variant is GdiBitmap: 2 prefix + 4 own = 24 bytes.
    ck('size-of pins ONE stride from any variant or from the union name',
       e.size_union() === 24 && e.size_pen() === 24 && e.size_bitmap() === 24 && e.size_meta() === 24,
       [e.size_union(), e.size_pen(), e.size_bitmap(), e.size_meta()]);
    ck('every variant agrees with the prefix on handle@0',
       e.off_union_handle() === 0 && e.off_pen_handle() === 0, [e.off_union_handle(), e.off_pen_handle()]);
    ck('every variant agrees with the prefix on type@4 (the dropped-prefix-field regression)',
       e.off_union_type() === 4 && e.off_pen_type() === 4 &&
       e.off_bitmap_type() === 4 && e.off_meta_type() === 4,
       [e.off_union_type(), e.off_pen_type(), e.off_bitmap_type(), e.off_meta_type()]);
    ck('each variant\'s own fields start after the prefix',
       e.off_pen_style() === 8 && e.off_bitmap_w() === 8 && e.off_bitmap_bits() === 20,
       [e.off_pen_style(), e.off_bitmap_w(), e.off_bitmap_bits()]);
  }
}

console.log('\n== 9. union pointer rules: widen freely, narrow only by cast ==');
ckAccepted('a variant pointer is accepted where the union is expected',
  UNION + `
  (func $anytype (param $o ptr<GdiObject>) (result i32) (effects) (load.field GdiObject type (local.get $o)))
  (func $f (param $b ptr<GdiBitmap>) (result i32) (effects) (call $anytype (local.get $b)))`);
ckRefused('a union pointer is NOT accepted where a variant is expected',
  UNION + `(func $f (param $o ptr<GdiObject>) (result i32) (effects) (load.field GdiBitmap w (local.get $o)))`,
  ['ptr<GdiObject> where ptr<GdiBitmap> is required']);
ckRefused('one variant is not another',
  UNION + `(func $f (param $p ptr<GdiPen>) (result i32) (effects) (load.field GdiBitmap w (local.get $p)))`,
  ['ptr<GdiPen> where ptr<GdiBitmap> is required']);
ckRefused('a union pointer reaches only prefix fields',
  UNION + `(func $f (param $o ptr<GdiObject>) (result i32) (effects) (load.field GdiObject bits (local.get $o)))`,
  ["a union pointer reaches only the shared prefix [handle, type]",
   "belongs to variant 'GdiBitmap'", '(cast ptr<GdiBitmap> ...)']);
ckAccepted('a cast is what makes the narrowing legal',
  UNION + `(func $f (param $o ptr<GdiObject>) (result i32) (effects)
             (load.field GdiBitmap w (cast ptr<GdiBitmap> (local.get $o))))`);

console.log('\n== 10. --checked-casts turns the claim into a runtime check ==');
{
  // A record whose tag says BITMAP, read through both variants. In the default
  // build the pen read succeeds and returns the bitmap's width as a pen style —
  // the wrong-layout bug in miniature. The checked build must trap on it.
  const PROG = UNION + `
    (memory 1)
    (func $seed (effects)
      (store.field GdiObject handle (i32.const 64) (i32.const 7))
      (store.field GdiObject type   (i32.const 64) (i32.const 3))
      (store.field GdiBitmap w      (i32.const 64) (i32.const 99)))
    (func (export "as_bitmap") (result i32) (effects)
      (call $seed) (load.field GdiBitmap w (cast ptr<GdiBitmap> (i32.const 64))))
    (func (export "as_pen") (result i32) (effects)
      (call $seed) (load.field GdiPen style (cast ptr<GdiPen> (i32.const 64))))`;
  // PRELUDE already declares (memory 1); drop the duplicate for this one.
  const src = PROG.replace('\n    (memory 1)', '');
  const plain = run(src);
  const checked = run(src, { checkedCasts: true });
  const trapped = (f) => { try { f(); return false; } catch (e) { return e instanceof WebAssembly.RuntimeError; } };
  if (plain.error || checked.error) ck('both builds compile', false, plain.error || checked.error);
  else {
    ck('default build: the right variant reads correctly', plain.exports.as_bitmap() === 99, plain.exports.as_bitmap());
    ck('default build: the WRONG variant reads silently (the bug this feature is about)',
       plain.exports.as_pen() === 99, plain.exports.as_pen());
    ck('--checked-casts: the right variant still reads', checked.exports.as_bitmap() === 99);
    ck('--checked-casts: the WRONG variant traps', trapped(checked.exports.as_pen));
  }
}

console.log('\n== 11. union and enum declaration refusals, all located ==');
for (const [name, src, needles] of [
  ['a tag field must live in the prefix',
   `(enum E (A 1)) (layout-union U (tag kind E) (prefix (field handle i32)) (variant UA (tag-value A) (field x i32)))`,
   ['tag field', 'has to live in the prefix']],
  ['a tag must name a declared enum',
   `(layout-union U (tag type Nope) (prefix (field type i32)) (variant UA (field x i32)))`,
   ['names no (enum ...) declaration']],
  ['a tag-value must name a real member',
   `(enum E (A 1)) (layout-union U (tag type E) (prefix (field type i32)) (variant UA (tag-value ZZZ) (field x i32)))`,
   ['names no member of enum']],
  ['no two variants may claim one tag value',
   `(enum E (A 1) (B 2)) (layout-union U (tag type E) (prefix (field type i32))
      (variant UA (tag-value A) (field x i32)) (variant UB (tag-value A) (field y i32)))`,
   ['is claimed by both variant']],
  ['a variant name may not collide with a layout',
   `(layout GdiPen (field a i32)) (enum E (PEN 1))
    (layout-union Gdi (tag type E) (prefix (field type i32)) (variant GdiPen (tag-value PEN) (field x i32)))`,
   ["Duplicate layout 'GdiPen'"]],
  ['an i8 inside a variant is refused like any other field',
   `(layout-union U (prefix (field handle i32)) (variant UA (field x i8 4)))`,
   ['u8 or s8']],
]) {
  ckRefused(name, src + ` (func $f (result i32) (effects) (i32.const 0))`, needles);
}
ckAccepted('a variant with no (tag-value ...) matches the enum member by name',
  `(enum GdiType (PEN 1) (BITMAP 3))
   (layout-union Gdi (tag type GdiType) (prefix (field type i32))
     (variant GdiPen (field x i32)) (variant GdiBitmap (field y i32)))
   (func $f (result i32) (effects) (size-of GdiPen))`);
ckAccepted('an untagged union is legal (it simply has no tag to check)',
  `(layout-union U (prefix (field handle i32)) (variant UA (field x i32)) (variant UB (field y i32) (field z i32)))
   (func $f (result i32) (effects) (size-of UA))`);

console.log('\n== 12. a view projects its targets\' offsets, and must agree ==');
{
  const g = run(`
  (layout ButtonState (field text_buf_ptr i32) (field text_len i32) (field style i32))
  (layout EditState   (field text_buf_ptr i32) (field text_len i32) (field sel i32) (field caret i32))
  (view ControlTextState (of ButtonState EditState)
    (field text_buf_ptr i32) (field text_len i32))
  (func (export "off_len")   (result i32) (effects) (offset-of ControlTextState text_len))
  (func (export "size_view") (result i32) (effects) (size-of ControlTextState))`);
  if (g.error) ck('view module compiles', false, g.error);
  else ck('the view takes its targets\' offsets, not fresh sequential ones',
          g.exports.off_len() === 4 && g.exports.size_view() === 8,
          [g.exports.off_len(), g.exports.size_view()]);
}
ckAccepted('a member pointer widens into a view over it',
  `(layout ButtonState (field text_buf_ptr i32) (field text_len i32))
   (layout EditState   (field text_buf_ptr i32) (field text_len i32) (field sel i32))
   (view CtlText (of ButtonState EditState) (field text_len i32))
   (func $agnostic (param $s ptr<CtlText>) (result i32) (effects) (load.field CtlText text_len (local.get $s)))
   (func $f (param $b ptr<ButtonState>) (result i32) (effects) (call $agnostic (local.get $b)))`);
ckRefused('a view is NOT usable where a concrete member is required',
  `(layout ButtonState (field a i32) (field b i32))
   (layout EditState   (field a i32) (field b i32))
   (view TextView (of ButtonState EditState) (field b i32))
   (func $f (param $v ptr<TextView>) (result i32) (effects) (load.field ButtonState a (local.get $v)))`,
  ['ptr<TextView> where ptr<ButtonState> is required']);
ckRefused('a view over disagreeing offsets is refused',
  `(layout ButtonState  (field text_buf_ptr i32) (field text_len i32))
   (layout ListBoxState (field count i32) (field sel i32) (field text_len i32))
   (view CtlText (of ButtonState ListBoxState) (field text_len i32))
   (func $f (result i32) (effects) (i32.const 0))`,
  ['lands at +4 in one target and +8']);
ckRefused('a view naming a field a target lacks is refused',
  `(layout ButtonState  (field text_buf_ptr i32) (field text_len i32))
   (layout ListBoxState (field text_buf_ptr i32) (field count i32))
   (view CtlText (of ButtonState ListBoxState) (field text_len i32))
   (func $f (result i32) (effects) (i32.const 0))`,
  ['has no such field', 'ALL of its targets agree on']);

console.log('\n== 13. the holes review found in the first cut ==');
// Every one of these compiled silently before. They are grouped because they
// share a cause: the first implementation checked pointers where a pointer is
// obviously produced or consumed, and missed the places where one is STORED,
// TAIL-CALLED, or merely DECLARED.

// A pointer field has a pointee, and storing the wrong record into one launders
// it -- every later reader of that field trusts the declaration.
for (const [form, args] of [
  ['store.field',      'Node next (local.get $n) (local.get $w)'],
  ['store.elem',       'Node next (local.get $n) (i32.const 0) (local.get $w)'],
  ['store.field-elem', 'Node next (local.get $n) (i32.const 0) (local.get $w)'],
]) {
  ckRefused(`${form} refuses a wrong pointee in the stored VALUE`,
    `(layout Other (field q i32))
     (layout Node (field next ptr<Node>) (field pad i32))
     (func $f (param $n ptr<Node>) (param $w ptr<Other>) (effects) (${form} ${args}))`,
    [`${form} Node.next value`, 'ptr<Other> where ptr<Node> is required']);
}
ckAccepted('the right pointee still stores',
  `(layout Node (field next ptr<Node>) (field pad i32))
   (func $f (param $n ptr<Node>) (param $w ptr<Node>) (effects)
     (store.field Node next (local.get $n) (local.get $w)))`);

// A field's pointee has to name something. `ptr<Nope>` became a plain i32.
ckRefused('a field pointing at an undeclared layout is refused',
  `(layout Node (field next ptr<Nope>))
   (func $f (result i32) (effects) (i32.const 0))`,
  ['ptr<Nope> names no (layout ...)']);
ckRefused('a malformed field pointer type is refused',
  `(layout Node (field next ptr<))
   (func $f (result i32) (effects) (i32.const 0))`,
  ['is not a well-formed pointer type']);

// A tail call passes arguments and produces this function's result, exactly as
// call + return does, so it gets the same two checks.
ckRefused('return_call checks its arguments',
  `(layout A (field x i32)) (layout B (field x i32))
   (func $g (param $p ptr<A>) (result i32) (effects) (load.field A x (local.get $p)))
   (func $f (param $q ptr<B>) (result i32) (effects) (return_call $g (local.get $q)))`,
  ['return_call $g arg 0', 'ptr<B> where ptr<A> is required']);
ckRefused('return_call checks the result it becomes',
  `(layout A (field x i32)) (layout B (field x i32))
   (func $g (result ptr<A>) (effects) (i32.const 0))
   (func $f (result ptr<B>) (effects) (return_call $g))`,
  ['it returns ptr<A>', 'declared (result ptr<B>)']);
ckAccepted('a matching tail call is fine',
  `(layout A (field x i32))
   (func $g (param $p ptr<A>) (result ptr<A>) (effects) (local.get $p))
   (func $f (param $q ptr<A>) (result ptr<A>) (effects) (return_call $g (local.get $q)))`);

// --checked-casts loads the tag and compares it as an integer, so a tag it
// cannot load that way is refused at the DECLARATION rather than emitted as a
// module the validator rejects.
ckRefused('a non-integer tag is refused',
  `(enum E (A 1))
   (layout-union U (tag t E) (prefix (field h i32) (field t f64))
     (variant UA (tag-value A) (field x i32)))
   (func $f (result i32) (effects) (i32.const 0))`,
  ['the tag field \'t\' is f64', 'must be one of u8/s8/u16/s16/i32']);
// i64 admits the same wasm-invalid emission as f64 did (i64.load into i32.ne),
// so it is refused at the declaration, not left for the validator.
ckRefused('an i64 tag is refused',
  `(enum E (A 1))
   (layout-union U (tag t E) (prefix (field h i32) (field t i64))
     (variant UA (tag-value A) (field x i32)))
   (func $f (result i32) (effects) (i32.const 0))`,
  ['the tag field \'t\' is i64', 'must be one of u8/s8/u16/s16/i32']);

// A tag value outside the tag width's range can never match a load of the tag:
// the checked cast it feeds is false on every record and traps the very variant
// it names. Refused at the declaration, via enum member and via bare literal.
ckRefused('an enum value overflowing a narrow tag is refused',
  `(enum E (A 1) (BIG 256))
   (layout-union U (tag t E) (prefix (field h i32) (field t u8))
     (variant UA (tag-value A) (field x i32))
     (variant UBig (tag-value BIG) (field y i32)))
   (func $f (result i32) (effects) (i32.const 0))`,
  ['tag value 256 cannot fit the u8 tag field \'t\'', '(0..255)']);
ckRefused('a negative literal tag value on an unsigned tag is refused',
  `(enum E (A 1))
   (layout-union U (tag t E) (prefix (field h i32) (field t u16))
     (variant UA (tag-value -1) (field x i32)))
   (func $f (result i32) (effects) (i32.const 0))`,
  ['tag value -1 cannot fit the u16 tag field \'t\'', '(0..65535)']);
ckAccepted('a tag value at the width boundary is fine',
  `(enum E (A 255))
   (layout-union U (tag t E) (prefix (field h i32) (field t u8))
     (variant UA (tag-value A) (field x i32)))
   (func $f (result i32) (effects) (i32.const 0))`);

// A projection over no layouts checks nothing: every field agrees vacuously.
ckRefused('a view over nothing is refused',
  `(layout A (field x i32))
   (view V (of) (field x i32))
   (func $f (result i32) (effects) (i32.const 0))`,
  ['(of) names no layout']);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
