// ═══════════════════════════════════════════════════════════════
// WATX compiler loader (Node).
// Loads the vendored browser-global compiler stages into a vm
// context and re-exports compile() + helpers as CommonJS.
// Source: watx.berrry.app (canvas runtime intentionally not vendored).
// ═══════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, 'watx-src');
const FILES = [
  'compiler-parser.js',   // tokenize, parseSexpr, ParseError
  'compiler-stages.js',   // resolveIncludes, expandMacros, checkTypes
  'compiler-codegen.js',  // lowerIR, generateWasm, disassembleWasm
  'compiler.js',          // compile(), formatSexpr, formatLowered
];

// Route the compiler's chatty [WATX] logs to stderr so stdout stays clean
// for test output.
const quietConsole = {
  log: (...a) => process.stderr.write('[watx] ' + a.join(' ') + '\n'),
  warn: (...a) => process.stderr.write('[watx] ' + a.join(' ') + '\n'),
  error: (...a) => process.stderr.write('[watx] ' + a.join(' ') + '\n'),
};
const ctx = {
  console: quietConsole,
  TextEncoder, TextDecoder,
  Float32Array, Float64Array, Uint8Array, ArrayBuffer,
  Map, Set, RegExp, Array, Object, String, Number, Math,
  parseInt, parseFloat, isNaN,
};
vm.createContext(ctx);
for (const f of FILES) {
  vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), ctx, { filename: f });
}

module.exports = {
  compile: ctx.compile,
  tokenize: ctx.tokenize,
  parseSexpr: ctx.parseSexpr,
  parseSource: ctx.parseSource,
};
