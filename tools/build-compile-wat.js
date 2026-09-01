#!/usr/bin/env node
'use strict';

// Compiles the two canonical artifacts, build/wine-assembly.wasm (tail calls)
// and build/wine-assembly.compat.wasm (no tail calls).
//
// The compiler is the vendored WATX compiler (tools/watx.js over
// src/main.watx's include closure) — Milestone 5 of docs/watx-migration-plan.md
// flipped the default on 2026-08-31 at the commit where WATX and
// lib/compile-wat.js emitted byte-identical modules in both modes, and the M6
// symbolization wave RETIRED the legacy rollback the same day
// (docs/watx-region-safety-design.md §11): the tree now contains
// region-symbolic spellings legacy compiles to runtime traps, so
// WINE_WAT_COMPILER=legacy is a hard error rather than a footgun. Rolling the
// compiler back now means reverting the symbolization commits.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

const DEFAULT_COMPILER = 'watx';

function getArg(name, fallback = null) {
  const prefix = `--${name}=`;
  const hit = process.argv.find(arg => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function parseReplicatedDispatch() {
  if (hasFlag('replicated-dispatch')) return true;
  const value = getArg('dispatch', 'shared');
  if (value === 'shared' || value === 'none' || value === '0' || value === 'false') return false;
  if (value === 'replicated' || value === 'all' || value === '1' || value === 'true') return true;
  return value.split(',').map(s => s.trim()).filter(Boolean);
}

const OUT = path.resolve(ROOT, getArg('out', path.join('build', 'wine-assembly.wasm')));
const COMPAT_OUT = path.resolve(ROOT, getArg('compat-out', path.join('build', 'wine-assembly.compat.wasm')));

// Opt-in third artifact carrying a wasm `name` section. Off unless asked for,
// so the two canonical files above are byte-for-byte what they were.
const WANT_NAMES = process.argv.includes('--names') || process.env.WINE_WAT_NAMES === '1';
const NAMED_OUT = path.resolve(ROOT, getArg('named-out', path.join('build', 'wine-assembly.named.wasm')));

// Reports WHERE the choice came from as well as what it is: a build log that
// only says "watx" cannot distinguish a deliberate flip from a stray exported
// variable in somebody's shell, and that is exactly the question after a bad
// deploy.
function selectedCompiler() {
  const fromArg = getArg('compiler', null);
  const source = fromArg !== null ? '--compiler'
    : process.env.WINE_WAT_COMPILER ? 'WINE_WAT_COMPILER'
    : 'default';
  const name = (fromArg !== null ? fromArg : (process.env.WINE_WAT_COMPILER || DEFAULT_COMPILER)).trim();
  if (name === 'legacy') {
    // Retired 2026-08-31, deliberately, at the start of the M6 symbolization
    // wave (docs/watx-region-safety-design.md §11): the tree now contains
    // region-symbolic spellings — bare $REGION operands and
    // (data (region.addr ...)) segments — that lib/compile-wat.js does not
    // reject but compiles to `unreachable`, so a "rollback" build would
    // instantiate cleanly and trap mid-app. Rolling back the compiler now
    // means reverting the symbolization commits, not setting an env var.
    console.error(`build-compile-wat: the legacy compiler is RETIRED (selected via ${source}).`);
    console.error('The source tree contains region-symbolic WATX spellings that legacy');
    console.error('silently compiles to runtime traps. See docs/watx-region-safety-design.md §11.');
    process.exit(1);
  }
  if (name !== 'watx') {
    console.error(`build-compile-wat: compiler must be "watx" (got ${JSON.stringify(name)} from ${source}; "legacy" is retired)`);
    process.exit(1);
  }
  return { name, source };
}

// The WATX path drives the vendored compiler over src/main.watx's (include ...)
// closure, through the SAME helper tools/watx-matrix.js uses, so the bytes this
// ships are the bytes that gate certified. It has no --dispatch knob: replicated
// dispatch is a legacy-compiler source transform, so asking for it here would
// silently produce a different module than requested rather than fail.
// The shake (docs/watx-region-safety-design.md §8) is requested per build and
// reaches the region allocator only:
//
//   WINE_REGION_SHAKE=gap|rotate|reverse|pad|0xSEED bash tools/build.sh
//
// A shaken build is deliberately NOT canonical, which is why the layout is
// printed in the banner: an artifact whose provenance cannot be read off the
// build log is one somebody will eventually ship.
function selectedRegionShake() {
  const fromArg = getArg('region-shake', null);
  const source = fromArg !== null ? '--region-shake'
    : process.env.WINE_REGION_SHAKE ? 'WINE_REGION_SHAKE'
    : null;
  const value = (fromArg !== null ? fromArg : (process.env.WINE_REGION_SHAKE || '')).trim();
  if (!value || value === '0' || value === 'off' || value === 'none') return null;
  return { value, source };
}

function reportRegionLayout(layout, shake) {
  if (!layout) return;
  const hx = (n) => `0x${(n >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
  // A span (region.declare-span) is a named address limit, not storage — it is
  // neither pinned nor allocated, so it gets its own count in the banner.
  const spans = layout.regions.filter(r => r.kind === 'span').length;
  const pinned = layout.regions.length - layout.allocated - spans;
  if (!shake) {
    console.log(`Region layout: CANONICAL — ${layout.regions.length} regions ` +
      `(${pinned} pinned/derived, ${layout.allocated} allocated` +
      (spans ? `, ${spans} span${spans === 1 ? '' : 's'}` : '') +
      `), floor ${hx(layout.floor)}`);
    return;
  }
  // Nothing to move is not a passing shake, it is a shake that measured
  // nothing — and it emits the canonical bytes, so it would read as a green run
  // of the whole pool against a map that never moved. Refuse instead.
  if (layout.allocated === 0) {
    console.error(`build-compile-wat: WINE_REGION_SHAKE=${shake.value} was requested, but 0 of ` +
      `${layout.regions.length} regions are allocated — every one is declare-fixed or derived, and ` +
      `the shake never moves a pin. This build would emit the canonical bytes and prove nothing. ` +
      `Convert regions to (region.declare ...) first.`);
    process.exit(1);
  }
  // A shake's inflation is a request, not a requirement — a region that fits
  // nowhere at its padded footprint is placed at its declared size instead. Say
  // how often, because a shake that quietly could not inflate is a weaker
  // experiment than the one that was asked for, and silence about that is the
  // same trap as a mirror that quietly did not match.
  const scaled = layout.shakeScaledDown || 0;
  console.log(`Region layout: SHAKEN (${layout.shake}) — ${layout.shaken} of ${layout.regions.length} ` +
    `regions permuted, floor ${hx(layout.floor)}` +
    (scaled ? `, ${scaled} placed without their gap/padding (no window held it)` : '') +
    `. THIS ARTIFACT IS NOT CANONICAL.`);
}

function compileWatx(replicatedDispatch) {
  if (replicatedDispatch !== false) {
    console.error('build-compile-wat: --dispatch/--replicated-dispatch was a lib/compile-wat.js transform ' +
      'and does not exist in the WATX path (legacy is retired); drop it.');
    process.exit(1);
  }
  const { watxSourceClosure, compileClosure } = require(path.join(__dirname, 'watx-closure.js'));
  const closure = watxSourceClosure();
  const shake = selectedRegionShake();
  console.log(`WATX entry: ${closure.entry}`);
  if (shake) console.log(`WATX region shake: ${shake.value} (from ${shake.source})`);
  const out = {};
  // Every artifact this function emits carries a fingerprint of the layout it
  // was built against, in a `wine-region-layout` custom section. The mirror
  // lib/region-map.generated.js carries the same hash in LAYOUT_HASH, and the
  // hosts refuse to run a pair that disagrees — see tools/region-layout-hash.js
  // for why a mismatch is otherwise silent rather than loud.
  const { layoutHash, appendSection } = require(path.join(__dirname, 'region-layout-hash.js'));
  let stamp = null;
  for (const [key, tailCalls] of [['bytes', true], ['compatBytes', false]]) {
    const r = compileClosure(closure, { tailCalls, regionShake: shake ? shake.value : null });
    if (tailCalls && r && r.success) reportRegionLayout(r.regions, shake);
    if (r && r.success && r.regions && !stamp) {
      stamp = layoutHash(r.regions.regions);
      console.log(`Region layout hash: ${stamp}`);
    }
    if (!r || !r.success || !r.wasmBinary) {
      const where = r && r.file ? ` at ${r.file}:${r.line || '?'}:${r.col || '?'}` : '';
      console.error(`WATX compile failed (tailCalls=${tailCalls})${where}: ` +
        String((r && (r.error || r.message)) || 'compile() returned no binary'));
      process.exit(1);
    }
    for (const d of (r.diagnostics || [])) {
      const at = d.file ? ` (${d.file}:${d.line || '?'})` : '';
      console.warn(`WATX ${d.type || 'diagnostic'}${at}: ${d.message || JSON.stringify(d)}`);
    }
    out[key] = appendSection(Buffer.from(r.wasmBinary), stamp);
  }
  // A THIRD, optional artifact: the same module with a wasm `name` custom
  // section. Opt in with WINE_WAT_NAMES=1 or --names.
  //
  // Why it is a separate file and not a flag on the canonical one: an
  // instantiation failure or a trap reports a function INDEX and nothing else
  // (`Compiling function #3849 failed: …`), which is why tools/func-index.js
  // exists at all; a name section puts the answer in the artifact so node,
  // DevTools and every profiler print `$handle_CreateWindowExA`. But the
  // canonical artifacts' byte-identity is how every compiler change is proved
  // safe, and ~100KB of names would take that instrument away. So this writes
  // build/wine-assembly.named.wasm ALONGSIDE and replaces nothing — the two
  // canonical files are compiled without the option and are unaffected.
  if (WANT_NAMES) {
    const r = compileClosure(closure, {
      tailCalls: true, regionShake: shake ? shake.value : null, nameSection: 'wine-assembly',
    });
    if (!r || !r.success || !r.wasmBinary) {
      console.error('WATX name-section compile failed: ' +
        String((r && (r.error || r.message)) || 'compile() returned no binary'));
      process.exit(1);
    }
    out.namedBytes = appendSection(Buffer.from(r.wasmBinary), stamp);
  }
  return out;
}

(async () => {
  const replicatedDispatch = parseReplicatedDispatch();
  const compiler = selectedCompiler();
  console.log(`Compiler: ${compiler.name} (from ${compiler.source})`);
  const { bytes, compatBytes, namedBytes } = compileWatx(replicatedDispatch);
  // compileWat emits bytes without validating operand stacks, so a WAT edit
  // that leaves a function's result value unproduced — one paren too few, and
  // an (if) that should yield i32 yields nothing — used to "build" fine and
  // then fail at WebAssembly.instantiate in whatever test ran next, reported as
  // a function *index*. WebAssembly.Module does the real validation and needs
  // no imports, so do it here and name the function.
  for (const [label, buf] of [['wine-assembly.wasm', bytes], ['wine-assembly.compat.wasm', compatBytes]]) {
    try {
      new WebAssembly.Module(buf);
    } catch (err) {
      const m = /function #(\d+)/.exec(err.message || '');
      console.error(`Validation failed for ${label}: ${err.message}`);
      if (m) {
        console.error(`  Name that function with: node tools/wasm-func-name.js ${m[1]}`);
      }
      process.exit(1);
    }
  }

  await fs.promises.mkdir(path.dirname(OUT), { recursive: true });
  await fs.promises.mkdir(path.dirname(COMPAT_OUT), { recursive: true });
  await fs.promises.writeFile(OUT, Buffer.from(bytes));
  await fs.promises.writeFile(COMPAT_OUT, Buffer.from(compatBytes));
  const st = await fs.promises.stat(OUT);
  const compatSt = await fs.promises.stat(COMPAT_OUT);
  console.log(`Build complete: ${path.relative(ROOT, OUT)} (${st.size} bytes)`);
  console.log(`Build complete: ${path.relative(ROOT, COMPAT_OUT)} (${compatSt.size} bytes)`);
  if (namedBytes) {
    // Validated like the other two, and for the same reason: a custom section
    // the decoder refuses would otherwise only surface wherever it is loaded.
    new WebAssembly.Module(namedBytes);
    await fs.promises.writeFile(NAMED_OUT, Buffer.from(namedBytes));
    const namedSt = await fs.promises.stat(NAMED_OUT);
    console.log(`Build complete: ${path.relative(ROOT, NAMED_OUT)} (${namedSt.size} bytes, ` +
      `with a wasm name section — NOT canonical, do not ship or hash-compare this one)`);
  } else {
    // A STALE named build is worse than no named build, and nothing else here
    // can catch one. The two canonical artifacts are rewritten on every build,
    // so they cannot go stale; this third one is only written when it is ASKED
    // for, so an ordinary build leaves whatever the last --names run produced
    // sitting beside two fresh files with no marking and no mtime anybody
    // reads. Its whole job is to turn `Compiling function #3849 failed` into a
    // name, and a name section from a different build answers that question
    // CONFIDENTLY WRONG — indices move whenever a function is added.
    //
    // No gate for an opt-in artifact: just delete it, so the choice is a real
    // name or no file at all. `--names` is one flag away.
    try {
      await fs.promises.unlink(NAMED_OUT);
      console.log(`Removed stale ${path.relative(ROOT, NAMED_OUT)} ` +
        `(name sections are indices; rebuild it with --names)`);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
})().catch((err) => {
  console.error(err && err.stack || err);
  process.exit(1);
});
