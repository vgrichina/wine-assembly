#!/usr/bin/env node
'use strict';

// Structural inventory for automatically converting the threaded x86 handler
// table into one generated br_table dispatcher. This deliberately analyzes WAT
// control flow rather than x86 semantics.

const fs = require('fs');
const path = require('path');
const {
  WAT_FILES,
  tokenize,
  parseSExprs,
  parseFuncSig,
  iterTopLevel,
} = require('../lib/compile-wat');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');

function walk(node, visit) {
  if (!Array.isArray(node)) return;
  visit(node);
  for (const child of node) walk(child, visit);
}

function isName(value) {
  return typeof value === 'string' && value.startsWith('$');
}

function loadModule() {
  const functions = new Map();
  const elements = [];
  // Do not analyze the generated clone as an input to itself.
  for (const file of WAT_FILES.filter(name => name !== '05a-full-brtable.generated.wat')) {
    const source = fs.readFileSync(path.join(SRC, file), 'utf8');
    const expressions = parseSExprs(tokenize(source));
    for (const item of iterTopLevel(expressions)) {
      if (item[0] === 'func' && isName(item[1])) {
        if (functions.has(item[1])) throw new Error(`duplicate function ${item[1]}`);
        functions.set(item[1], { file, item });
      } else if (item[0] === 'elem') {
        elements.push({ file, item });
      }
    }
  }
  return { functions, elements };
}

function findHandlerNames(elements) {
  const candidates = elements.map(({ file, item }) => ({
    file,
    names: item.filter(isName).filter(name => name.startsWith('$th_')),
  })).filter(candidate => candidate.names.length > 0);
  if (candidates.length !== 1) {
    throw new Error(`expected one threaded handler element segment, found ${candidates.length}`);
  }
  return candidates[0].names;
}

function analyzeHandler(id, name, entry) {
  if (!entry) return { id, name, missing: true, convertible: false };
  const bodyItems = entry.item.slice(2);
  const sig = parseFuncSig(bodyItems);
  const body = bodyItems.slice(sig.bodyStart);
  const facts = {
    nextTailCalls: 0,
    nextCalls: 0,
    otherTailCalls: [],
    tailCallIndirects: 0,
    explicitReturns: 0,
    numericLocalRefs: 0,
    instructions: 0,
  };
  for (const expression of body) walk(expression, node => {
    const op = node[0];
    facts.instructions++;
    if (op === 'return_call') {
      if (node[1] === '$next') facts.nextTailCalls++;
      else facts.otherTailCalls.push(node[1]);
    } else if (op === 'call' && node[1] === '$next') {
      facts.nextCalls++;
    } else if (op === 'return_call_indirect') {
      facts.tailCallIndirects++;
    } else if (op === 'return') {
      facts.explicitReturns++;
    }
    if ((op === 'local.get' || op === 'local.set' || op === 'local.tee') &&
        typeof node[1] === 'string' && /^\d+$/.test(node[1])) {
      facts.numericLocalRefs++;
    }
  });

  // $next tail calls and plain returns have direct dispatcher equivalents.
  // Non-tail calls to $next and tail calls to other functions need a more
  // general CPS/call-graph transform, so fail closed for the first generator.
  const blockers = [];
  if (facts.nextCalls) blockers.push('non-tail-call-next');
  if (facts.otherTailCalls.length) blockers.push('other-tail-call');
  if (facts.tailCallIndirects) blockers.push('tail-call-indirect');
  if (facts.numericLocalRefs) blockers.push('numeric-local-reference');

  let exitShape = 'terminal';
  if (facts.nextTailCalls && (facts.explicitReturns || facts.nextTailCalls > 1)) exitShape = 'mixed';
  else if (facts.nextTailCalls) exitShape = 'continue';

  return {
    id,
    name,
    file: entry.file,
    params: sig.params,
    locals: sig.locals,
    localNames: sig.localNames,
    exitShape,
    blockers,
    convertible: blockers.length === 0,
    ...facts,
  };
}

function analyzeThreadedWat() {
  const module = loadModule();
  const handlerNames = findHandlerNames(module.elements);
  const handlers = handlerNames.map((name, id) =>
    analyzeHandler(id, name, module.functions.get(name)));
  const byExit = {};
  const byBlocker = {};
  const byFile = {};
  for (const handler of handlers) {
    byExit[handler.exitShape || 'missing'] = (byExit[handler.exitShape || 'missing'] || 0) + 1;
    byFile[handler.file || 'missing'] = (byFile[handler.file || 'missing'] || 0) + 1;
    for (const blocker of handler.blockers || ['missing']) {
      byBlocker[blocker] = (byBlocker[blocker] || 0) + 1;
    }
  }
  return {
    handlerCount: handlers.length,
    convertibleCount: handlers.filter(handler => handler.convertible).length,
    blockedCount: handlers.filter(handler => !handler.convertible).length,
    missingCount: handlers.filter(handler => handler.missing).length,
    byExit,
    byBlocker,
    byFile,
    handlers,
  };
}

function printSummary(report) {
  console.log(`threaded handlers: ${report.handlerCount}`);
  console.log(`automatic first-pass conversion: ${report.convertibleCount}`);
  console.log(`blocked: ${report.blockedCount}; missing: ${report.missingCount}`);
  console.log(`exit shapes: ${JSON.stringify(report.byExit)}`);
  console.log(`source files: ${JSON.stringify(report.byFile)}`);
  if (report.blockedCount) {
    console.log('blocked handlers:');
    for (const handler of report.handlers.filter(item => !item.convertible)) {
      console.log(`  ${handler.id} ${handler.name}: ${(handler.blockers || ['missing']).join(', ')}`);
    }
  }
}

if (require.main === module) {
  const report = analyzeThreadedWat();
  if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else printSummary(report);
}

module.exports = {
  analyzeThreadedWat,
  analyzeHandler,
  findHandlerNames,
  loadModule,
  walk,
};
