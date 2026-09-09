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
//   node tools/check-region-decls.js --check-owners    # validate (owner "file:$symbol")
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
    // Carried so --check-owners can resolve the stable file:$symbol source owner.
    // The raw quotes are retained because this reader validates declaration
    // grammar independently of the compiler.
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
// --check-owners: does (owner "file:$symbol") still own this region?
//
// The original representation named an exact source line. Its matcher was
// eventually made exact and its 155-entry stale baseline drained, but exact
// line numbers made every unrelated insertion above an owner a mandatory edit
// to 00-regions.wat. A source symbol is the stable identity the line number was
// trying to approximate.
//
// For WAT, a named top-level form must still reference the region. This catches
// both halves of semantic drift: deleting/renaming the owning function, and
// moving the region access out of it while leaving the function behind.
// Globals and compiler forms such as `(string.pool $NAME)` are top-level named
// forms too. Test-only regions may name a repository-relative non-WAT source;
// those require exact occurrences of both the anchor and region symbols.

const WAT_SYMBOL_CHARS = 'A-Za-z0-9_.\\-';

function symbolPattern(symbol) {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${escaped}(?![${WAT_SYMBOL_CHARS}])`);
}

function watCodeOnly(source) {
  const out = source.split('');
  let state = 'code';
  let blockDepth = 0;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    const n = source[i + 1];
    if (state === 'line-comment') {
      if (c === '\n') state = 'code';
      else out[i] = ' ';
      continue;
    }
    if (state === 'string') {
      out[i] = ' ';
      if (c === '\\' && i + 1 < source.length) {
        i++;
        out[i] = source[i] === '\n' ? '\n' : ' ';
      }
      else if (c === '"') state = 'code';
      continue;
    }
    if (state === 'block-comment') {
      out[i] = c === '\n' ? '\n' : ' ';
      if (c === '(' && n === ';') { blockDepth++; out[++i] = ' '; }
      else if (c === ';' && n === ')') {
        blockDepth--;
        out[++i] = ' ';
        if (blockDepth === 0) state = 'code';
      }
      continue;
    }
    if (c === ';' && n === ';') {
      state = 'line-comment';
      out[i] = out[++i] = ' ';
    } else if (c === '(' && n === ';') {
      state = 'block-comment';
      blockDepth = 1;
      out[i] = out[++i] = ' ';
    } else if (c === '"') {
      state = 'string';
      out[i] = ' ';
    }
  }
  return out.join('');
}

// Return complete depth-zero WAT forms while ignoring strings and both comment
// kinds. Source files are module fragments, so depth zero is their top level.
function watTopLevelForms(source) {
  const code = watCodeOnly(source);
  const forms = [];
  let depth = 0;
  let start = -1;
  let line = 1;
  let startLine = 1;

  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === '\n') line++;
    if (c === '(') {
      if (depth === 0) { start = i; startLine = line; }
      depth++;
      continue;
    }
    if (c !== ')' || depth === 0) continue;
    depth--;
    if (depth !== 0) continue;
    const text = source.slice(start, i + 1);
    const formCode = code.slice(start, i + 1);
    const header = /^\(\s*([^\s()]+)(?:\s+(\$[A-Za-z0-9_.\-]+))?/.exec(formCode);
    forms.push({
      start,
      end: i + 1,
      line: startLine,
      head: header ? header[1] : null,
      symbol: header ? header[2] || null : null,
      text,
      code: formCode,
    });
    start = -1;
  }
  return forms;
}

function resolveOwnerFile(fileText) {
  if (path.isAbsolute(fileText) || fileText.split('/').includes('..')) return null;
  const relative = fileText.includes('/') ? fileText : path.join('src', fileText);
  const resolved = path.resolve(ROOT, relative);
  if (resolved !== ROOT && !resolved.startsWith(`${ROOT}${path.sep}`)) return null;
  return { relative, resolved };
}

function ownerVerdict(d) {
  if (!d.owner) return { state: 'missing' };
  // The clause value arrives with its quotes still on.
  const text = d.owner.trim().replace(/^"|"$/g, '').trim();
  const m = /^([A-Za-z0-9_.\/-]+):(\$[A-Za-z0-9_.\-]+)$/.exec(text);
  if (!m) {
    return { state: 'stale', why: 'owner must be file:$symbol (line-number owners are unsupported)' };
  }
  const target = resolveOwnerFile(m[1]);
  if (!target) return { state: 'stale', why: `${m[1]} is not a safe repository-relative source path` };
  if (!fs.existsSync(target.resolved)) return { state: 'stale', why: `${target.relative} does not exist` };

  const source = fs.readFileSync(target.resolved, 'utf8');
  const anchorRe = symbolPattern(m[2]);
  const regionRe = symbolPattern(`$${d.name}`);

  if (!target.resolved.endsWith('.wat')) {
    if (!anchorRe.test(source)) {
      return { state: 'stale', why: `${target.relative} does not define or mention ${m[2]}` };
    }
    return regionRe.test(source)
      ? { state: 'ok' }
      : { state: 'stale', why: `${target.relative} mentions ${m[2]} but not $${d.name}` };
  }

  const forms = watTopLevelForms(source);
  const definitions = forms.filter(f => f.symbol === m[2]);
  if (!definitions.length) {
    return { state: 'stale', why: `${target.relative} does not define top-level ${m[2]}` };
  }
  return definitions.some(definition => regionRe.test(definition.code))
    ? { state: 'ok' }
    : { state: 'stale', why: `${target.relative} ${m[2]} no longer references $${d.name}` };
}

function checkOwners(list) {
  const stale = [];
  let ok = 0;
  for (const d of list) {
    const v = ownerVerdict(d);
    if (v.state === 'ok') { ok++; continue; }
    if (v.state === 'missing') {
      stale.push({ name: d.name, why: 'has no (owner "…")', where: `${d.file}:${d.line}` });
      continue;
    }
    stale.push({ name: d.name, why: v.why, where: `${d.file}:${d.line}` });
  }
  stale.sort((a, b) => a.name.localeCompare(b.name));

  for (const s of stale) {
    console.error(`check-region-decls: $${s.name} (${s.where}) ${s.why}`);
  }
  if (stale.length) {
    console.error(`check-region-decls: ${stale.length} region owner(s) are invalid.\n` +
      `  Name a stable owner as (owner "file:$symbol"); a WAT symbol's ` +
      `top-level form must reference the region.`);
    return 1;
  }
  console.log(`check-region-decls: owners ok — ${ok} symbol owners verified`);
  return 0;
}

// Importable: tools/region-census.js reads the same declaration set, so the
// odometer and the gate can never disagree about what a region is.
module.exports = { collectDeclarations, collectGlobals, ownerVerdict, watTopLevelForms };
if (require.main !== module) return;

const globals = collectGlobals();
const decls = collectDeclarations();

if (CHECK_OWNERS) {
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
