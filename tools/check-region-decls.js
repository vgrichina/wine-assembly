#!/usr/bin/env node
// check-region-decls.js — src/00-regions.wat says the same thing the globals do.
//
// The fixed memory map exists twice while Milestone 6 is in flight:
//
//   (global $WND_RECORDS      i32 (i32.const 0x00007000))   <- what code reads
//   (global $WND_RECORDS_SIZE i32 (i32.const 0x00001800))
//   (region.declare-fixed $WND_RECORDS (base 0x00007000) (size 0x00001800))
//
// The compiler validates the DECLARATIONS against each other — overlap,
// alignment, memory bounds — and that is worth nothing if the declarations
// describe a map the code does not use. A declaration set that has drifted from
// the globals is not a safety net, it is a second opinion nobody asked for. So
// this gate is what makes the declarations TRUE, and it runs before compilation
// in tools/build.sh.
//
// Direction of travel: today the globals are authoritative and the declarations
// mirror them. Milestone 6 step 2 inverts that — consumers address regions by
// name, the base globals are generated from the declarations, and this gate's
// job shrinks to nothing because there is only one copy left. Until then it is
// the thing standing between "we declared the map" and "we declared a map".
//
// WAVE 3 TURNED THAT ROUND. Most regions are now `region.declare`, so their base
// is the ALLOCATOR's output and there is no number in the source to compare
// against; and their mirrors read `(region.addr $R 0)`, so there is no second
// copy to disagree. What is left for this gate is two things worth keeping:
//
//   1. Every declared region still has a `$NAME`/`$NAME_SIZE` mirror behind it,
//      and every sized global still has a declaration. Coverage, in both
//      directions.
//   2. A region that is NOT pinned must have a SYMBOLIC mirror. A literal
//      mirror on an allocated region is a stale copy the moment the allocator
//      chooses a different address — silently, since nothing else compares
//      them any more. This is the check that replaces the base comparison.
//
// It reads the placed layout through tools/region-layout.js, which asks the
// compiler. The old "a gate must not need the thing it gates" rule gave way
// here for the reason it had to: after wave 3 the compiler's output IS the map,
// and a second parser would be a second map.
//
// The declaration set is complete, so the build gate runs --strict: a sized
// global with no mirror declaration is an ERROR. Without --strict it degrades
// to a warning — that mode exists only for mid-edit inspection.
//
// Usage:
//   node tools/check-region-decls.js --strict   # the build gate
//   node tools/check-region-decls.js            # lenient (mid-edit inspection)
//   node tools/check-region-decls.js --list     # print the declared map
//   node tools/check-region-decls.js --file=X   # check a fixture instead of src/00-regions.wat
//   node tools/check-region-decls.js --check-owners    # ratchet on (owner "file:line")
//   node tools/check-region-decls.js --record-owners   # re-cut that ratchet's baseline
'use strict';

const fs = require('fs');
const path = require('path');
const { WAT_FILES } = require('../lib/compile-wat');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const DECLS = '00-regions.wat';
const STRICT = process.argv.includes('--strict');
const LIST = process.argv.includes('--list');
const CHECK_OWNERS = process.argv.includes('--check-owners');
const RECORD_OWNERS = process.argv.includes('--record-owners');

const hex = (n) => `0x${(n >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;

// Whole-token: `0x10zz` and `1_000_000junk` are rejected, not silently
// truncated the way Number.parseInt would. Underscore separators are legal per
// the WATX literal grammar.
function parseInt32(text) {
  const t = String(text).trim().replace(/_/g, '');
  if (!/^(0x[0-9a-fA-F]+|\d+)$/.test(t)) return null;
  return Number.parseInt(t, /^0x/i.test(t) ? 16 : 10) >>> 0;
}

// The same `(global $NAME i32 (i32.const N))` shape test/test-wat-memory-map.js
// and tools/wat-memory-map.js use, deliberately: a gate that recognized a
// different set of globals than the tools it is reconciling would reconcile
// nothing.
function collectGlobals() {
  return require('./wat-globals.js').collect();
}

// The reader still walks the declaration text — for the NAME, the source line,
// the `(within …)` nesting and the grammar refusal — but the BASE and SIZE come
// from the placed layout, because an allocated region has no base in the source
// and its size may be stated as `(end N)`. The grammar it accepts is deliberately
// narrow: anything it does not recognize is an error, never something quietly
// skipped.
const HEADS = /^\s*\(region\.declare(?:-fixed|-derived|-span)?\s+\$([A-Za-z0-9_]+)\b/;
const KNOWN_CLAUSES = new Set(['base', 'size', 'end', 'align', 'owner', 'within',
  'stride', 'mask', 'size-is-power-of-2']);
const NUMERIC_CLAUSES = new Set(['size', 'end', 'align']);

// The --file= CLI flag is read only when this script IS the CLI: importers
// (tools/region-census.js) have their own --file= meaning a file to census,
// and honoring argv here made collectDeclarations() parse that file as the
// declaration set — 0 regions, confidently wrong output.
// `shake` asks for the SHAKEN placement (§8) instead of the canonical one, so a
// generated mirror can be made to match a shaken artifact. Nothing in the build
// passes it; only tools/region-shake-smoke.js does.
function collectDeclarations(overrideFile, shake) {
  const fileArg = overrideFile ||
    (require.main === module
      ? (process.argv.find(a => a.startsWith('--file=')) || '').slice('--file='.length)
      : '');
  const file = fileArg ? path.resolve(fileArg) : path.join(SRC, DECLS);
  const text = fs.readFileSync(file, 'utf8');
  // Where the regions actually landed. Asked of the compiler (tools/region-layout.js)
  // rather than read out of the clauses, because since wave 3 most bases are the
  // allocator's choice and simply are not written down anywhere.
  const placed = require('./region-layout.js').layout(shake ? { shake } : {});
  const decls = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const head = HEADS.exec(lines[i]);
    if (!head) continue;
    const kind = /-fixed\s/.test(lines[i]) ? 'fixed'
      : /-derived\s/.test(lines[i]) ? 'derived'
      : /-span\s/.test(lines[i]) ? 'span' : 'alloc';
    // A declaration may wrap onto following lines; take everything up to the
    // line whose parentheses close it. Line comments are stripped first so a
    // parenthesized aside in a comment is not read as a clause.
    let depth = 0, body = '', j = i;
    do {
      body += lines[j].replace(/;;.*$/, '') + '\n';
      for (const ch of lines[j].replace(/;;.*$/, '')) {
        if (ch === '(') depth++; else if (ch === ')') depth--;
      }
      j++;
    } while (depth > 0 && j < lines.length);
    const d = {
      name: head[1], kind, file: path.relative(ROOT, file), line: i + 1,
      base: null, size: null, within: null, parseErrors: [],
    };
    // Split the declaration body into its depth-1 clause forms. Every clause
    // must be a recognized `(name value)` — an unknown head, a duplicate, a
    // nested value where a flat one belongs, or a malformed number is an error
    // here, never something the mirror check silently reads past.
    const clauseRe = /\(([^()\s]+)((?:[^()"]|"[^"]*")*?)\)/g;
    let afterHead = body.replace(/^\s*\(region\.declare(?:-fixed|-derived|-span)?\s+\$[A-Za-z0-9_]+/, '');
    // `(base (g2w VA))` is the one NESTED clause in the grammar, and it is what
    // a derived region is: the base is stated as the guest address it means, so
    // the g2w arithmetic is in the source instead of a comment beside a magic
    // number. Consumed here, before the flat-clause scan that cannot see it.
    const g2w = /\(base\s+\(g2w\s+([^)\s]+)\)\s*\)/.exec(afterHead);
    if (g2w) {
      afterHead = afterHead.replace(g2w[0], '');
      if (kind !== 'derived') {
        d.parseErrors.push(`(base (g2w ...)) is only for region.declare-derived`);
      } else if (parseInt32(g2w[1]) === null) {
        d.parseErrors.push(`(base (g2w ${g2w[1]})) is not a whole-token integer`);
      } else {
        d.guestVa = parseInt32(g2w[1]);
      }
    }
    // `(stride N (count N))` is the second NESTED clause in the grammar, and
    // the flat scan below cannot read it: it would take `(count …)` for a
    // clause of its own and leave `(stride $X` as unrecognized leftover. The
    // law itself is the COMPILER's to check (it holds stride x count == size
    // and resolves each $-named operand against a real i32 constant global);
    // all this reader has to do is accept the spelling and not mistake it for
    // a broken declaration.
    const strideLaw = /\(stride\s+([^()\s]+)\s+\(count\s+([^()\s]+)\s*\)\s*\)/.exec(afterHead);
    if (strideLaw) {
      afterHead = afterHead.replace(strideLaw[0], '');
      d.strideLaw = { stride: strideLaw[1], count: strideLaw[2] };
    } else if (/\(stride\b/.test(afterHead)) {
      d.parseErrors.push(`(stride ...) is spelled (stride N (count N))`);
    }
    const seenClauses = new Set();
    const values = new Map();
    let m;
    while ((m = clauseRe.exec(afterHead)) !== null) {
      const key = m[1];
      if (!KNOWN_CLAUSES.has(key)) {
        d.parseErrors.push(`unknown clause (${key} ...)`);
        continue;
      }
      if (seenClauses.has(key)) {
        d.parseErrors.push(`duplicate (${key} ...) clause`);
        continue;
      }
      seenClauses.add(key);
      const value = m[2].trim();
      if (NUMERIC_CLAUSES.has(key)) {
        const n = parseInt32(value);
        if (n === null) d.parseErrors.push(`(${key} ${value}) is not a whole-token integer`);
        else values.set(key, n);
      } else {
        values.set(key, value);
      }
    }
    // Anything at depth 1 that was not consumed as a clause (a bare atom, a
    // nested form the regex skipped) is grammar this reader does not accept.
    const leftover = afterHead.replace(clauseRe, '').replace(/[)\s]/g, '');
    if (leftover) d.parseErrors.push(`unrecognized text in declaration: ${leftover.slice(0, 40)}`);
    if (values.has('size') && values.has('end')) {
      d.parseErrors.push('has both (size N) and (end N); declare one');
    }
    // Base and size come from the PLACED layout, not from the clauses: an
    // allocated region has no (base ...) to read, and the compiler is the only
    // thing that knows where the allocator put it.
    const placedRegion = placed.byName.get(d.name);
    if (!placedRegion) d.parseErrors.push('is not in the placed layout');
    d.base = placedRegion ? placedRegion.base : null;
    d.size = placedRegion ? placedRegion.size : null;
    const w = values.get('within');
    d.within = w && /^\$[A-Za-z0-9_]+$/.test(w) ? w.slice(1) : null;
    if (w && d.within === null) d.parseErrors.push(`(within ${w}) is not a $NAME`);
    // Carried so --check-owners can ask whether the source location still names
    // this region. Kept as the raw quoted text: some owners are deliberately not
    // a file:line ("01-header.wat: (string.pool ...)"), and mangling those into a
    // line number here would invent a target that was never claimed.
    d.owner = values.get('owner') || null;
    // A SPAN is not in this list. Every importer — the mirror gate, the JS
    // generator, the census — means "a region that owns bytes", and a span owns
    // none: it has no mirror to hold it against, nothing to generate a base and
    // size for, and its base of 0x00000000 would make the census score every
    // literal zero in the tree as a copy of the map. It is validated by the
    // compiler (bounds) and by its mandatory (owner "…"), which is the whole of
    // what can be said about a limit.
    if (d.kind !== 'span') decls.push(d);
    i = j - 1;
  }
  return decls;
}

// ---------------------------------------------------------------------------
// --check-owners: does the (owner "file:line") still point at this region?
//
// Every declaration carries an (owner "…") naming the source location that
// USES the region. That string is a comment as far as the compiler is
// concerned: nothing has ever checked it, and after two waves of moving code
// around, most of them are off by tens or hundreds of lines. A wrong owner is
// worse than none — it sends the next reader to a line that has nothing to do
// with the region and looks authoritative doing it.
//
// This is a RATCHET, not a sweep. Re-deriving the ~150 already-stale owners is
// a separate piece of work with a separate review; what this mode buys is that
// the number cannot GROW. The currently-stale set is recorded in
// check-region-decls.owners.json, and only a region absent from that file is
// held to a correct owner. Fixing a stale owner and dropping it from the
// baseline is always allowed (and --record-owners will prune it); adding a
// region to the baseline is what review is for.
//
// The test is deliberately loose: read the named file, take the named line
// plus or minus THREE, and ask whether the region's name appears anywhere in
// that window. It is looking for "this location still knows about this
// region", not for an exact expression, because the owner points at a use site
// whose spelling is not this tool's business.
//
// Not covered: spans (collectDeclarations drops them before this sees them,
// for the reasons in its comment) and owners that are deliberately not a
// file:line — "01-header.wat: (string.pool …)" names a mechanism, not a
// location, and there is nothing to grep. Both are reported as SKIP so the
// counts add up rather than silently shrinking.
const OWNERS_BASELINE = path.join(__dirname, 'check-region-decls.owners.json');
const OWNER_WINDOW = 3;

function ownerVerdict(d) {
  if (!d.owner) return { state: 'missing' };
  // The clause value arrives with its quotes still on.
  const text = d.owner.trim().replace(/^"|"$/g, '').trim();
  const m = /^([A-Za-z0-9_.\-]+\.wat):(\d+)$/.exec(text);
  if (!m) return { state: 'skip', why: 'owner is not a file:line' };
  const file = path.join(SRC, m[1]);
  if (!fs.existsSync(file)) return { state: 'stale', why: `${m[1]} does not exist` };
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const at = Number(m[2]);
  const lo = Math.max(1, at - OWNER_WINDOW);
  const hi = Math.min(lines.length, at + OWNER_WINDOW);
  if (at > lines.length) {
    return { state: 'stale', why: `${m[1]} has only ${lines.length} lines` };
  }
  const window = lines.slice(lo - 1, hi).join('\n');
  return window.includes(d.name)
    ? { state: 'ok' }
    : { state: 'stale', why: `${m[1]}:${lo}-${hi} does not mention $${d.name}` };
}

function checkOwners(list) {
  const stale = [];
  const skipped = [];
  let ok = 0;
  for (const d of list) {
    const v = ownerVerdict(d);
    if (v.state === 'ok') { ok++; continue; }
    if (v.state === 'skip') { skipped.push(`${d.name}: ${v.why}`); continue; }
    if (v.state === 'missing') {
      stale.push({ name: d.name, why: 'has no (owner "…")', where: `${d.file}:${d.line}` });
      continue;
    }
    stale.push({ name: d.name, why: v.why, where: `${d.file}:${d.line}` });
  }
  stale.sort((a, b) => a.name.localeCompare(b.name));

  if (RECORD_OWNERS) {
    fs.writeFileSync(OWNERS_BASELINE, `${JSON.stringify({
      comment: 'Regions whose (owner "file:line") does not point at a line ' +
        'mentioning them. Ratchet baseline for check-region-decls.js ' +
        '--check-owners: a region NOT listed here must have a correct owner. ' +
        'Removing a name after fixing its owner is always welcome; adding one ' +
        'means a new declaration shipped with a wrong owner and should be ' +
        'fixed instead.',
      stale: stale.map(s => s.name),
    }, null, 2)}\n`);
    console.log(`check-region-decls: recorded ${stale.length} stale owner(s) ` +
      `in ${path.relative(ROOT, OWNERS_BASELINE)}`);
    return 0;
  }

  let baseline;
  try {
    baseline = new Set(JSON.parse(fs.readFileSync(OWNERS_BASELINE, 'utf8')).stale);
  } catch (err) {
    console.error(`check-region-decls: cannot read ${path.relative(ROOT, OWNERS_BASELINE)}: ` +
      `${err.message}\n  regenerate it with --record-owners`);
    return 1;
  }

  const fresh = stale.filter(s => !baseline.has(s.name));
  const fixed = [...baseline].filter(n => !stale.some(s => s.name === n)).sort();

  for (const s of fresh) {
    console.error(`check-region-decls: $${s.name} (${s.where}) ${s.why}`);
  }
  if (fresh.length) {
    console.error(`check-region-decls: ${fresh.length} region(s) declared or ` +
      `moved since the baseline have an (owner "…") that does not name them.\n` +
      `  Point the owner at a line that uses the region. Do NOT add these to ` +
      `${path.relative(ROOT, OWNERS_BASELINE)}.`);
    return 1;
  }
  console.log(`check-region-decls: owners ok — ${ok} verified, ` +
    `${stale.length} stale (baseline), ${skipped.length} not a file:line`);
  if (fixed.length) {
    console.log(`check-region-decls: ${fixed.length} baseline owner(s) now ` +
      `correct — drop them with --record-owners: ${fixed.join(', ')}`);
  }
  return 0;
}

// Importable: tools/region-census.js reads the same declaration set, so the
// odometer and the gate can never disagree about what a region is.
module.exports = { collectDeclarations, collectGlobals, ownerVerdict };
if (require.main !== module) return;

const globals = collectGlobals();
const decls = collectDeclarations();

if (CHECK_OWNERS || RECORD_OWNERS) {
  process.exit(checkOwners(decls));
}

if (LIST) {
  for (const d of [...decls].sort((a, b) => a.base - b.base)) {
    console.log(`${hex(d.base)} +${String(d.size).padStart(9)}  ${d.name}` +
      (d.within ? `  (within $${d.within})` : ''));
  }
  process.exit(0);
}

const errors = [];
const warnings = [];
const seen = new Set();

for (const d of decls) {
  const where = `${d.file}:${d.line}`;
  if (seen.has(d.name)) {
    errors.push(`$${d.name} is declared more than once (${where})`);
    continue;
  }
  seen.add(d.name);
  for (const pe of d.parseErrors) {
    errors.push(`$${d.name} (${where}): ${pe}`);
  }
  if (d.parseErrors.length) continue;
  // A SPAN owns no bytes, so there is nothing to store and no mirror to hold it
  // against. It is checked by the compiler (bounds) and by its mandatory
  // (owner "…"), not here.
  if (d.kind === 'span') continue;
  if (d.base === null || d.size === null) {
    errors.push(`$${d.name} (${where}) has no readable base/extent`);
    continue;
  }
  const base = globals.get(d.name);
  const size = globals.get(`${d.name}_SIZE`);
  if (!base) {
    errors.push(`$${d.name} (${where}) declares a region with no ` +
      `(global $${d.name} i32 ...) behind it — a declaration must describe a ` +
      `region that exists, not invent one`);
    continue;
  }
  if (!size) {
    errors.push(`$${d.name} (${where}) has no (global $${d.name}_SIZE i32 ...); ` +
      `declare the extent where the region's other globals live`);
    continue;
  }
  if (base.value !== d.base) {
    errors.push(`$${d.name} base disagrees: declaration ${hex(d.base)} (${where}) ` +
      `vs global ${hex(base.value)} (${base.file}:${base.line})`);
  }
  if (size.value !== d.size) {
    errors.push(`$${d.name} size disagrees: declaration ${hex(d.size)} (${where}) ` +
      `vs $${d.name}_SIZE ${hex(size.value)} (${size.file}:${size.line})`);
  }
  // The check that replaces the base comparison for a region whose base is the
  // allocator's to choose. A literal mirror on a non-pinned region is a copy of
  // an address nobody promised to keep: it is right today and stale the moment
  // an earlier region changes size. Nothing else compares the two any more, so
  // the failure would be silent — which is exactly why it is an error here.
  if (d.kind !== 'fixed' && base.form !== 'region') {
    errors.push(`$${d.name} (${where}) is allocated, but its mirror ` +
      `(${base.file}:${base.line}) is a literal ${hex(base.value)}. An allocated ` +
      `region's address is not a constant anybody wrote down; spell the mirror ` +
      `(region.addr $${d.name} 0) — node tools/region-mirrors.js --rewrite`);
  }
}

for (const [name, g] of globals) {
  if (!name.endsWith('_SIZE')) continue;
  const region = name.slice(0, -'_SIZE'.length);
  if (!globals.has(region) || seen.has(region)) continue;
  const msg = `$${region} is a sized region (${g.file}:${g.line}) with no ` +
    `(region.declare-fixed $${region} ...) in src/${DECLS}`;
  (STRICT ? errors : warnings).push(msg);
}

for (const w of warnings) console.warn(`check-region-decls: WARN ${w}`);
if (errors.length) {
  for (const e of errors) console.error(`check-region-decls: ${e}`);
  console.error(`check-region-decls: ${errors.length} disagreement(s) between ` +
    `src/${DECLS} and the region globals.`);
  process.exit(1);
}
console.log(`region declarations OK: ${decls.length} declared, ` +
  `all agree with their $NAME/$NAME_SIZE globals` +
  (warnings.length ? `, ${warnings.length} sized region(s) not yet declared` : ''));
