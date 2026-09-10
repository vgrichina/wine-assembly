#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { readPE } = require('../lib/pe');
const { decodeX87 } = require('../lib/x87-semantics');
const { disasmAt } = require('./disasm');

const MIXED_WHITELIST = new Set([
  'mov', 'movzx', 'movsx', 'lea', 'xchg', 'add', 'adc', 'sub', 'sbb', 'imul',
  'inc', 'dec', 'neg', 'not', 'and', 'or', 'xor', 'shl', 'shr', 'sar', 'sal',
  'rol', 'ror', 'test', 'cmp', 'push', 'pop', 'nop',
]);

function parseDisasmLine(line, fileOffset, va) {
  const rawText = line.slice(10, 38).trim();
  const raw = rawText ? Buffer.from(rawText.split(/\s+/).map(h => parseInt(h, 16))) : Buffer.alloc(0);
  let text = line.slice(39).trim();
  text = text.replace(/^(?:es|cs|ss|ds|fs|gs):\s+/, '');
  return { fileOffset, va, length: raw.length || 1, raw, text, mnemonic: (text.match(/^([a-z][a-z0-9]*)/i) || ['', 'decode-error'])[1].toLowerCase() };
}

function decodeLinear(buffer, start, size, va, options = {}) {
  const end = Math.min(buffer.length, start + size);
  const result = [];
  let p = start;
  let address = va;
  const cap = options.maxInstructions || Infinity;
  while (p < end && result.length < cap) {
    const line = disasmAt(buffer, p, address, 1, null, { bits: options.bits || 32 })[0];
    const insn = parseDisasmLine(line, p, address);
    if (p + insn.length > end) break;
    const x87 = decodeX87(insn.raw, 0, { bits: options.bits || 32 });
    insn.x87 = x87 && x87.length === insn.raw.length ? x87 : null;
    result.push(insn);
    p += insn.length;
    address += insn.length;
  }
  return result;
}

function directBranch(insn) {
  if (!/^(?:j[a-z]+|loop[a-z]*|jmp)$/.test(insn.mnemonic)) return null;
  const match = insn.text.match(/\b0x([0-9a-f]+)\b/i);
  if (!match) return { kind: 'indirect-branch', target: null };
  return { kind: insn.mnemonic === 'jmp' ? 'direct-jump' : 'conditional-branch', target: parseInt(match[1], 16) >>> 0 };
}

function nonX87Barrier(insn) {
  if (insn.analysisBarrier) return insn.analysisBarrier;
  const branch = directBranch(insn);
  if (branch) return branch.kind;
  if (/^(?:call|ret|retf|iret|int|sysenter|ud2|hlt)$/.test(insn.mnemonic)) return `control-${insn.mnemonic}`;
  if (insn.mnemonic === 'decode-error' || insn.mnemonic === 'db') return 'decode-unknown';
  if (!MIXED_WHITELIST.has(insn.mnemonic)) return `mixed-not-whitelisted:${insn.mnemonic}`;
  return null;
}

function stackSummary(ops) {
  let relative = 0;
  let requiredInitial = 0;
  for (const insn of ops) {
    if (!insn.x87) continue;
    const s = insn.x87.stack;
    for (const index of s.reads) requiredInitial = Math.max(requiredInitial, index + 1 - relative);
    relative += s.delta;
  }
  requiredInitial = Math.max(0, requiredInitial);
  relative = 0;
  let maxLiveDepth = requiredInitial;
  for (const insn of ops) {
    if (!insn.x87) continue;
    relative += insn.x87.stack.delta;
    maxLiveDepth = Math.max(maxLiveDepth, requiredInitial + relative);
  }
  return { netDelta: relative, requiredInitialDepth: requiredInitial, maxLiveDepth, balanced: relative === 0 };
}

function summarizeRegion(ops, terminal, options) {
  const x87Ops = ops.filter(i => i.x87);
  const stackShape = stackSummary(ops);
  const memoryShapes = {};
  for (const op of x87Ops) {
    const m = op.x87.memory;
    if (m.access !== 'none') {
      const key = `${m.access}:${m.format}:${m.shape}`;
      memoryShapes[key] = (memoryShapes[key] || 0) + 1;
    }
  }
  const rejectionReasons = [];
  if (x87Ops.length < options.minX87) rejectionReasons.push('too-few-x87');
  if (!stackShape.balanced) rejectionReasons.push('unbalanced-stack');
  if (stackShape.maxLiveDepth > 8) rejectionReasons.push('x87-stack-overflow');
  const x87Barrier = x87Ops.find(i => i.x87.barrier);
  if (x87Barrier) rejectionReasons.push(`x87-barrier:${x87Barrier.x87.barrier}`);
  const branch = terminal && directBranch(terminal);
  const loopBackedges = [];
  if (branch && branch.target !== null && branch.target <= terminal.va && branch.target >= ops[0].va) {
    loopBackedges.push({ from: terminal.va, to: branch.target, kind: branch.kind });
  }
  return {
    startVa: ops[0].va, endVa: ops[ops.length - 1].va + ops[ops.length - 1].length,
    byteLength: ops.reduce((n, i) => n + i.length, 0), instructionCount: ops.length,
    x87Count: x87Ops.length, mixedCount: ops.length - x87Ops.length,
    x87Names: x87Ops.map(i => i.x87.name), stack: stackShape, memoryShapes,
    loopBackedges, terminalBarrier: terminal ? (terminal.analysisBarrier || (terminal.x87 ? `x87:${terminal.x87.barrier}` : nonX87Barrier(terminal))) : 'section-end',
    accepted: rejectionReasons.length === 0, rejectionReasons,
    trace: options.trace ? ops.map(i => ({ va: i.va, bytes: i.raw.toString('hex'), text: i.text,
      x87: i.x87 ? { name: i.x87.name, stack: i.x87.stack, memory: i.x87.memory, barrier: i.x87.barrier } : null })) : undefined,
  };
}

function collectRegions(instructions, inputOptions = {}) {
  const options = Object.assign({ maxInstructions: 64, maxMixedGap: 12, minX87: 2, trace: false }, inputOptions);
  const regions = [];
  let i = 0;
  while (i < instructions.length) {
    while (i < instructions.length && !instructions[i].x87) i++;
    if (i >= instructions.length) break;
    if (instructions[i].x87.barrier) {
      regions.push(summarizeRegion([instructions[i]], instructions[i], options));
      i++;
      continue;
    }
    const start = i;
    const ops = [];
    let gap = 0;
    let terminal = null;
    while (i < instructions.length && ops.length < options.maxInstructions) {
      const insn = instructions[i];
      if (insn.x87) {
        if (insn.x87.barrier) { terminal = insn; break; }
        gap = 0; ops.push(insn); i++; continue;
      }
      const barrier = nonX87Barrier(insn);
      if (barrier) { terminal = insn; break; }
      gap++;
      if (gap > options.maxMixedGap) { terminal = Object.assign({}, insn, { analysisBarrier: 'mixed-gap-bound' }); break; }
      ops.push(insn); i++;
    }
    if (!terminal && ops.length >= options.maxInstructions && instructions[i]) {
      terminal = Object.assign({}, instructions[i], { analysisBarrier: 'region-instruction-bound' });
    }
    if (ops.length) regions.push(summarizeRegion(ops, terminal || instructions[i] || null, options));
    if (i === start) i++;
  }
  return regions;
}

function scanPE(file, options = {}) {
  const buffer = fs.readFileSync(file);
  const pe = readPE(buffer);
  const regions = [];
  let instructionCount = 0;
  for (const section of pe.sections.filter(s => s.isCode && s.rawSize > 0)) {
    const start = section.rawOff;
    const size = Math.min(section.rawSize, Math.max(0, buffer.length - start));
    if (!buffer.subarray(start, start + size).some(b => b >= 0xd8 && b <= 0xdf)) continue;
    const instructions = decodeLinear(buffer, start, size, section.va, options);
    instructionCount += instructions.length;
    for (const region of collectRegions(instructions, options)) {
      region.section = section.name;
      regions.push(region);
    }
  }
  return { file, bytes: buffer.length, instructionCount, regions };
}

function aggregate(files) {
  const result = { files: files.length, bytes: 0, instructions: 0, regions: 0, accepted: 0,
    x87Instructions: 0, scanMode: 'linear-code-section-sweep',
    acceptedShapes: [],
    distributions: { x87Count: {}, instructionCount: {}, maxLiveDepth: {}, memoryShapes: {}, terminalBarrier: {}, rejectionReason: {}, loopBackedges: 0 },
    acceptedDistributions: { x87Count: {}, instructionCount: {}, maxLiveDepth: {}, memoryShapes: {} } };
  const acceptedShapes = {};
  const bump = (obj, key, n = 1) => { obj[key] = (obj[key] || 0) + n; };
  for (const file of files) {
    result.bytes += file.bytes; result.instructions += file.instructionCount; result.regions += file.regions.length;
    for (const r of file.regions) {
      if (r.accepted) {
        result.accepted++;
        const shape = r.x87Names.join(';');
        acceptedShapes[shape] = (acceptedShapes[shape] || 0) + 1;
        bump(result.acceptedDistributions.x87Count, r.x87Count);
        bump(result.acceptedDistributions.instructionCount, r.instructionCount);
        bump(result.acceptedDistributions.maxLiveDepth, r.stack.maxLiveDepth);
        for (const [shape, n] of Object.entries(r.memoryShapes)) bump(result.acceptedDistributions.memoryShapes, shape, n);
      }
      result.x87Instructions += r.x87Count;
      bump(result.distributions.x87Count, r.x87Count);
      bump(result.distributions.instructionCount, r.instructionCount);
      bump(result.distributions.maxLiveDepth, r.stack.maxLiveDepth);
      for (const [shape, n] of Object.entries(r.memoryShapes)) bump(result.distributions.memoryShapes, shape, n);
      bump(result.distributions.terminalBarrier, r.terminalBarrier || 'none');
      for (const reason of r.rejectionReasons) bump(result.distributions.rejectionReason, reason);
      result.distributions.loopBackedges += r.loopBackedges.length;
    }
  }
  result.acceptedShapes = Object.entries(acceptedShapes)
    .map(([shape, count]) => ({ shape, count }))
    .sort((a, b) => b.count - a.count || a.shape.localeCompare(b.shape))
    .slice(0, 50);
  return result;
}

function expandInputs(inputs) {
  const out = [];
  const visit = p => {
    // Corpus directories contain convenience symlinks, including a historical
    // self-link at test/binaries/binaries and optional links to downloads that
    // may not exist on every checkout. A census must not recurse through or
    // fail on either kind.
    let st;
    try { st = fs.lstatSync(p); }
    catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) for (const name of fs.readdirSync(p)) visit(path.join(p, name));
    else if (/\.(?:exe|dll|ocx|cpl|drv|scr)$/i.test(p)) out.push(p);
  };
  for (const input of inputs) visit(path.resolve(input));
  return out;
}

function main(argv) {
  const options = { trace: false, summaryOnly: false };
  const inputs = [];
  for (const arg of argv) {
    if (arg === '--trace') options.trace = true;
    else if (arg === '--summary-only') options.summaryOnly = true;
    else if (arg.startsWith('--max-insns=')) options.maxInstructions = Number(arg.slice(12));
    else if (arg.startsWith('--max-mixed-gap=')) options.maxMixedGap = Number(arg.slice(16));
    else if (arg.startsWith('--min-x87=')) options.minX87 = Number(arg.slice(10));
    else if (arg.startsWith('-')) throw new Error(`unknown option ${arg}`);
    else inputs.push(arg);
  }
  if (!inputs.length) throw new Error('usage: node tools/x87-region-census.js [--trace] PE-or-directory [...]');
  const paths = expandInputs(inputs);
  const files = [];
  const errors = [];
  for (const file of paths) {
    try { files.push(scanPE(file, options)); }
    catch (error) { errors.push({ file, error: error.message }); }
  }
  const output = { summary: aggregate(files), errors };
  if (!options.summaryOnly) output.files = files;
  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
}

if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { parseDisasmLine, decodeLinear, directBranch, nonX87Barrier, stackSummary, collectRegions, scanPE, aggregate, expandInputs };
