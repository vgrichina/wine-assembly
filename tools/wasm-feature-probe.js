#!/usr/bin/env node
// Which WebAssembly extensions does each engine we ship to actually support?
//
// Answers by handing an engine hand-built module bytes it must either validate
// or reject -- not by consulting a compatibility table and not by asking our own
// compiler, which would only report what WE emit. Every feature probe ships with
// a positive control (a module the engine must accept) and, where the extension
// changes an existing encoding, a NEGATIVE control (a module it must reject);
// an engine that silently ignored the new immediate would pass the positive
// probe, so the negative one is what makes a YES trustworthy.
//
// Usage:
//   node tools/wasm-feature-probe.js              # this node/V8
//   node tools/wasm-feature-probe.js --jsc        # + JavaScriptCore (Safari)
//   node tools/wasm-feature-probe.js --chrome     # + installed Chrome
//   node tools/wasm-feature-probe.js --all
//
// Results and their consequences for this project are written up in
// docs/wasm-engine-support.md.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const JSC = process.env.JSC
  || '/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc';
// Same resolution tools/profile-web-frames.js uses: the installed browser, since
// puppeteer's own download cache is usually absent here.
const CHROME = process.env.CHROME
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const args = process.argv.slice(2);
const want = (f) => args.includes(f) || args.includes('--all');

// The probe body is plain ES5 with no require/Buffer/console so that the very
// same source runs under node, under the jsc shell, and inside a browser page.
// It leaves its results in `RESULTS` as [engineLabel, [[verdict, name], ...]].
const PROBE_SRC = `
var RESULTS = (function () {
  function u() { return new Uint8Array(Array.prototype.slice.call(arguments)); }
  function cat(a) {
    var n = 0, i, o = 0;
    for (i = 0; i < a.length; i++) n += a[i].length;
    var out = new Uint8Array(n);
    for (i = 0; i < a.length; i++) { out.set(a[i], o); o += a[i].length; }
    return out;
  }
  function section(id, b) { return cat([u(id, b.length), b]); }

  var HEADER = u(0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00);
  var TYPES  = section(1, u(0x01, 0x60, 0x00, 0x01, 0x7f));      // () -> i32
  var EXPORT = section(7, u(0x01, 0x01, 0x66, 0x00, 0x00));      // export "f" = func 0

  // --- multi-memory ------------------------------------------------------
  // memarg gains bit 6 (0x40) on the align byte meaning "a memory index
  // follows me", so i32.load from memory 1 is 0x28 0x42 0x01 0x00 rather than
  // the single-memory 0x28 0x02 0x00.
  var mmFuncs = section(3, u(0x01, 0x00));
  var mmBodyIdx1 = u(0x00, 0x41, 0x00, 0x28, 0x42, 0x01, 0x00, 0x0b);
  var mmBodyPlain = u(0x00, 0x41, 0x00, 0x28, 0x02, 0x00, 0x0b);
  function codeOf(b) { return section(10, cat([u(0x01, b.length), b])); }
  var ONE_MEM = section(5, u(0x01, 0x00, 0x01));
  var TWO_MEM = section(5, u(0x02, 0x00, 0x01, 0x00, 0x01));

  // --- tail calls --------------------------------------------------------
  var tcFuncs = section(3, u(0x02, 0x00, 0x00));
  var tcF0Tail = u(0x00, 0x12, 0x01, 0x0b);          // return_call 1; end
  var tcF0Call = u(0x00, 0x10, 0x01, 0x0f, 0x0b);    // call 1; return; end
  var tcF1 = u(0x00, 0x41, 0x07, 0x0b);              // i32.const 7; end
  function tcCode(f0) {
    return section(10, cat([u(0x02), u(f0.length), f0, u(tcF1.length), tcF1]));
  }

  // --- typed function references ----------------------------------------
  // Our handler table is (table $handlers 426 funcref). An untyped table
  // makes every call_indirect carry a runtime signature check -- SpiderMonkey
  // Ion emits a load of the callee's type word plus a compare, and that load
  // sits at the END of the dependent chain that produces the branch target.
  // Declaring the table with a concrete type ((ref null $t), reftype 0x63
  // followed by the type index) lets the engine drop the check. This probe
  // asks whether the engines we ship to accept such a table at all.
  var TYPES_T = section(1, u(0x02,
    0x60, 0x01, 0x7f, 0x00,        // type 0: (func (param i32))   -- handler_t
    0x60, 0x00, 0x01, 0x7f));      // type 1: (func) -> i32
  var tfFuncs = section(3, u(0x01, 0x01));                    // one func, type 1
  var TBL_FUNCREF = section(4, u(0x01, 0x70, 0x00, 0x01));    // funcref, min 1
  var TBL_TYPED   = section(4, u(0x01, 0x63, 0x00, 0x00, 0x01)); // (ref null 0)
  var TBL_NONNULL = section(4, u(0x01, 0x64, 0x00, 0x00, 0x01)); // (ref 0), no init
  // i32.const 0 (the arg); i32.const 0 (the table index); call_indirect 0 0
  var tfBody = u(0x00, 0x41, 0x00, 0x41, 0x00, 0x11, 0x00, 0x00, 0x41, 0x07, 0x0b);
  var TF_CODE = section(10, cat([u(0x01, tfBody.length), tfBody]));

  var cases = [
    ['multi-memory', 'control: single memory, plain memarg', false,
      cat([HEADER, TYPES, mmFuncs, ONE_MEM, codeOf(mmBodyPlain)])],
    ['multi-memory', 'two memories declared in one module', false,
      cat([HEADER, section(5, u(0x02, 0x00, 0x01, 0x00, 0x01))])],
    ['multi-memory', 'i32.load addressed to memory index 1', false,
      cat([HEADER, TYPES, mmFuncs, TWO_MEM, codeOf(mmBodyIdx1)])],
    ['multi-memory', 'NEGATIVE: memidx=1 with only one memory', true,
      cat([HEADER, TYPES, mmFuncs, ONE_MEM, codeOf(mmBodyIdx1)])],
    ['tail calls', 'control: plain call + return', false,
      cat([HEADER, TYPES, tcFuncs, EXPORT, tcCode(tcF0Call)])],
    ['tail calls', 'return_call', false,
      cat([HEADER, TYPES, tcFuncs, EXPORT, tcCode(tcF0Tail)])],
    ['typed funcref table', 'control: funcref table + call_indirect', false,
      cat([HEADER, TYPES_T, tfFuncs, TBL_FUNCREF, TF_CODE])],
    ['typed funcref table', 'table declared (ref null $handler_t)', false,
      cat([HEADER, TYPES_T, TBL_TYPED])],
    ['typed funcref table', 'call_indirect through a typed table', false,
      cat([HEADER, TYPES_T, tfFuncs, TBL_TYPED, TF_CODE])],
    ['typed funcref table', 'NEGATIVE: non-nullable (ref $t) table with no init', true,
      cat([HEADER, TYPES_T, TBL_NONNULL])],
  ];

  var out = [];
  for (var i = 0; i < cases.length; i++) {
    var feature = cases[i][0], name = cases[i][1];
    var mustReject = cases[i][2], bytes = cases[i][3];
    var verdict;
    if (!WebAssembly.validate(bytes)) verdict = 'NO';
    else {
      try {
        var inst = new WebAssembly.Instance(new WebAssembly.Module(bytes));
        // Where there is an export, run it: validating is not executing, and a
        // wrong answer is a failure even though nothing threw.
        if (inst.exports.f && inst.exports.f() !== 7) verdict = 'BAD(value)';
        else verdict = 'YES';
      } catch (e) { verdict = 'NO(instantiate)'; }
    }
    // A negative control that passes means the probe proves nothing.
    var ok = mustReject ? (verdict.indexOf('NO') === 0) : true;
    out.push([verdict, feature, name, ok]);
  }
  return out;
})();
`;

const EMIT = `
var _p = (typeof print === 'function') ? print : console.log;
_p('@@' + JSON.stringify(RESULTS));
`;

function parse(stdout) {
  const line = stdout.split('\n').find((l) => l.startsWith('@@'));
  if (!line) throw new Error(`probe produced no result line:\n${stdout}`);
  return JSON.parse(line.slice(2));
}

function runNode() {
  // Wrapped in an IIFE so the probe's `var RESULTS` stays function-scoped --
  // a bare eval of it declares into this module's scope and collides.
  // eslint-disable-next-line no-eval
  const results = eval(`(function(){${PROBE_SRC}; return RESULTS;})()`);
  return [`node ${process.version} / v8 ${process.versions.v8}`, results];
}

function runJsc(file) {
  if (!fs.existsSync(JSC)) return null;
  const out = execFileSync(JSC, [file], { encoding: 'utf-8' });
  // The shell defaults tail calls off, which is NOT the same as absent -- rerun
  // with the flag so the report can say "implemented but off" instead of "no".
  let flagged = null;
  try {
    flagged = parse(execFileSync(JSC, ['--useWebAssemblyTailCalls=true', file],
      { encoding: 'utf-8' }));
  } catch (e) { /* option may not exist on older JSC */ }
  return [`JavaScriptCore (Safari ${safariVersion()})`, parse(out), flagged];
}

function safariVersion() {
  try {
    return execFileSync('defaults',
      ['read', '/Applications/Safari.app/Contents/Info.plist', 'CFBundleShortVersionString'],
      { encoding: 'utf-8' }).trim();
  } catch (e) { return '?'; }
}

async function runChrome() {
  let puppeteer;
  try { puppeteer = require('puppeteer'); }
  catch (e) { console.log('  (puppeteer not installed, skipping Chrome)'); return null; }
  if (!fs.existsSync(CHROME)) { console.log(`  (no Chrome at ${CHROME})`); return null; }
  const browser = await puppeteer.launch({
    headless: 'new', executablePath: CHROME, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    const r = await page.evaluate(`(function(){${PROBE_SRC}; return RESULTS;})()`);
    const ua = await page.evaluate('navigator.userAgent');
    return [ua.replace(/^.*?(HeadlessChrome|Chrome)\//, '$1/').split(' ')[0], r];
  } finally { await browser.close(); }
}

function report(label, results, flagged) {
  console.log(`\n=== ${label} ===`);
  let lastFeature = null, unsound = false;
  for (const [verdict, feature, name, ok] of results) {
    if (feature !== lastFeature) { console.log(`  [${feature}]`); lastFeature = feature; }
    console.log(`    ${verdict.padEnd(15)} ${name}${ok ? '' : '   <-- CONTROL FAILED'}`);
    if (!ok) unsound = true;
  }
  if (flagged) {
    const before = results.find((r) => r[2] === 'return_call');
    const after = flagged.find((r) => r[2] === 'return_call');
    if (before && after && before[0] !== after[0]) {
      console.log(`    note: return_call is ${after[0]} with `
        + `--useWebAssemblyTailCalls=true -- implemented, shell default off.`);
      console.log('    Whether SAFARI ships it enabled cannot be read from here;'
        + ' supportsWasmTailCalls() settles it at load time.');
    }
  }
  if (unsound) console.log('    WARNING: a control failed, so these results prove nothing.');
}

(async () => {
  const file = path.join(os.tmpdir(), `wasm-feature-probe-${process.pid}.js`);
  fs.writeFileSync(file, PROBE_SRC + EMIT);
  try {
    const [label, results] = runNode();
    report(label, results);

    if (want('--jsc')) {
      const r = runJsc(file);
      if (r) report(r[0], r[1], r[2]);
      else console.log(`\n  (no jsc shell at ${JSC})`);
    }
    if (want('--chrome')) {
      const r = await runChrome();
      if (r) report(r[0], r[1]);
    }
    if (!want('--jsc') && !want('--chrome')) {
      console.log('\n  (pass --jsc / --chrome / --all to probe other engines)');
    }
  } finally { fs.unlinkSync(file); }
})();
