#!/usr/bin/env node
// Aggregate hot AoE blocks into compiler optimization shapes.
//
// This is an offline classifier. It reads an existing hot-block profile,
// decodes block entries, and summarizes which compiler-stage optimizations are
// most common: flag-dead branches, register-write coalescing, identity writes,
// repeated EA/g2w opportunities, SIB shapes, and stack/setup-heavy blocks.

const fs = require('fs');
const path = require('path');
const { scanFile } = require('./superinstruction-census');
const {
  DEFAULT_EXE,
  DEFAULT_OPT_REGS,
  REGS,
  accessInfo,
  analyzeBlock,
  argValue,
  blockInstructions,
  findLatestHotBlockProfile,
  formatRegs,
  hex,
  intArg,
  isJcc,
  pct,
} = require('./aoe-reg-liveness-estimate');

const CC_NAMES = ['o', 'no', 'b', 'ae', 'z', 'nz', 'be', 'a', 's', 'ns', 'p', 'np', 'l', 'ge', 'le', 'g'];

function regName(reg) {
  return REGS[reg] || `r${reg}`;
}

function add(map, key, weight, siteKey) {
  const row = map.get(key) || { key, weight: 0, sites: new Set() };
  row.weight += weight;
  if (siteKey !== undefined) row.sites.add(siteKey);
  map.set(key, row);
}

function sortedRows(map, limit) {
  return Array.from(map.values())
    .sort((a, b) => b.weight - a.weight)
    .slice(0, limit);
}

function printWeightedRows(title, rows, total, limit) {
  if (!rows.length) return;
  console.log('');
  console.log(title);
  for (const row of rows.slice(0, limit)) {
    const sites = row.sites ? row.sites.size : 0;
    console.log(`  ${String(Math.round(row.weight)).padStart(10)}  ${pct(row.weight, total).padStart(6)}  sites=${String(sites).padStart(3)}  ${row.key}`);
  }
}

function memRawShape(mem, exactDisp) {
  if (!mem) return 'none';
  const parts = [];
  if (mem.base >= 0) parts.push(regName(mem.base));
  if (mem.index >= 0) parts.push(mem.scale > 1 ? `${regName(mem.index)}*${mem.scale}` : regName(mem.index));
  if (mem.disp) {
    if (exactDisp) {
      const d = mem.disp < 0 ? `-${hex(-mem.disp, 0)}` : hex(mem.disp, 0);
      parts.push(d);
    } else {
      parts.push('disp');
    }
  } else if (!parts.length) {
    parts.push('0');
  }
  if (!parts.length) parts.push(exactDisp ? '0' : 'abs');
  return `[${parts.join('+').replace(/\+-/g, '-')}]`;
}

function memKey(mem) {
  if (!mem) return '';
  return `${mem.base}|${mem.index}|${mem.scale}|${mem.disp}`;
}

function memAccesses(insns, infos) {
  const out = [];
  for (let i = 0; i < insns.length; i++) {
    const ins = insns[i];
    const info = infos[i];
    if (ins.mem && (info.memoryRead || info.memoryWrite)) out.push(ins.mem);
  }
  return out;
}

function dispatchCost(ins) {
  let cost = 1;
  if (ins.mem && ins.mem.index >= 0) cost++;
  return cost;
}

function isSignedJcc(ins) {
  return isJcc(ins) && ins.cc >= 12 && ins.cc <= 15;
}

function fullFlagWriter(ins) {
  if (!ins) return false;
  if (ins.kind === 'cmp_r32_r32' || ins.kind === 'cmp_r32_m32' || ins.kind === 'cmp_m32_r32') return true;
  if (ins.kind === 'test_r32_r32' || ins.kind === 'test_m32_r32') return true;
  if (ins.kind === 'xor_zero' || ins.kind === 'xor_rr') return true;
  if (ins.kind === 'add_r32_rm32' || ins.kind === 'add_rm32_r32') return true;
  if (ins.kind === 'sub_r32_rm32' || ins.kind === 'sub_rm32_r32') return true;
  if (ins.kind === 'alu_r32_r32' || ins.kind === 'alu_r32_m32' || ins.kind === 'alu_m32_r32') return ins.alu !== 2 && ins.alu !== 3;
  if (ins.kind === 'alu_r32_i8' || ins.kind === 'alu_m32_i8') return ins.alu !== 2 && ins.alu !== 3;
  if (ins.kind === 'inc_r32' || ins.kind === 'dec_r32') return true;
  if (ins.kind === 'shift_r32_i8' || ins.kind === 'shift_m32_i8') return true;
  return false;
}

function flagReaderBeforeWrite(ins) {
  if (!ins) return false;
  if (isJcc(ins)) return true;
  if ((ins.kind === 'alu_r32_r32' || ins.kind === 'alu_r32_m32' || ins.kind === 'alu_m32_r32') && (ins.alu === 2 || ins.alu === 3)) return true;
  if ((ins.kind === 'alu_r32_i8' || ins.kind === 'alu_m32_i8') && (ins.alu === 2 || ins.alu === 3)) return true;
  return false;
}

function flagPathState(report, startIndex, maxInsns = 8) {
  if (startIndex === undefined || startIndex < 0 || startIndex >= report.instructions.length) return 'unknown';
  for (let i = startIndex; i < report.instructions.length && i < startIndex + maxInsns; i++) {
    const ins = report.instructions[i];
    if (flagReaderBeforeWrite(ins)) return 'read';
    if (fullFlagWriter(ins)) return 'dead';
    if (!ins || ins.kind === 'unknown') return 'unknown';
  }
  return 'unknown';
}

function branchFlagExit(report, branch) {
  if (!branch) return null;
  const fallIndex = report.byVa.get(branch.fall >>> 0);
  const targetIndex = report.byVa.get(branch.target >>> 0);
  const fallState = flagPathState(report, fallIndex);
  const targetState = flagPathState(report, targetIndex);
  return {
    fallState,
    targetState,
    flagsDead: fallState === 'dead' && targetState === 'dead',
  };
}

function branchProducer(insns) {
  if (insns.length < 2) return null;
  const branch = insns[insns.length - 1];
  if (!isJcc(branch)) return null;
  return insns[insns.length - 2] || null;
}

function producerKind(ins) {
  if (!ins) return 'none';
  if (ins.kind === 'cmp_r32_m32') return `cmp ${regName(ins.dst)},${memRawShape(ins.mem, false)}`;
  if (ins.kind === 'cmp_m32_r32') return `cmp ${memRawShape(ins.mem, false)},${regName(ins.src)}`;
  if (ins.kind === 'cmp_r32_r32') return `cmp ${regName(ins.dst)},${regName(ins.src)}`;
  if (ins.kind === 'test_r32_r32') return `test ${regName(ins.dst)},${regName(ins.src)}`;
  if (ins.kind === 'test_m32_r32') return `test ${memRawShape(ins.mem, false)},${regName(ins.src)}`;
  if (ins.kind === 'alu_r32_r32' && ins.src === ins.dst && (ins.alu === 1 || ins.alu === 4)) {
    return `${ins.aluName} ${regName(ins.dst)},${regName(ins.src)} identity`;
  }
  if (ins.kind === 'alu_r32_i8' && ins.alu === 7) return `cmp ${regName(ins.dst)},i8`;
  return ins.kind;
}

function producerExact(ins) {
  if (!ins) return 'none';
  if (ins.kind === 'cmp_r32_m32') return `cmp ${regName(ins.dst)},${memRawShape(ins.mem, true)}`;
  if (ins.kind === 'cmp_m32_r32') return `cmp ${memRawShape(ins.mem, true)},${regName(ins.src)}`;
  if (ins.kind === 'cmp_r32_r32') return `cmp ${regName(ins.dst)},${regName(ins.src)}`;
  if (ins.kind === 'test_r32_r32') return `test ${regName(ins.dst)},${regName(ins.src)}`;
  if (ins.kind === 'test_m32_r32') return `test ${memRawShape(ins.mem, true)},${regName(ins.src)}`;
  if (ins.kind === 'alu_r32_r32' && ins.src === ins.dst && (ins.alu === 1 || ins.alu === 4)) {
    return `${ins.aluName} ${regName(ins.dst)},${regName(ins.src)} identity`;
  }
  if (ins.kind === 'alu_r32_i8' && ins.alu === 7) return `cmp ${regName(ins.dst)},${ins.imm}`;
  return ins.kind;
}

function branchKey(insns, report, exact) {
  const branch = insns[insns.length - 1];
  const producer = branchProducer(insns);
  if (!producer || !isJcc(branch)) return '';
  const flagExit = branchFlagExit(report, branch);
  const cc = CC_NAMES[branch.cc] || String(branch.cc);
  const state = flagExit ? (flagExit.flagsDead ? 'flags-dead' : `flags-${flagExit.fallState}-${flagExit.targetState}`) : 'flags-unknown';
  const sign = isSignedJcc(branch) ? 'signed' : 'other';
  return `${exact ? producerExact(producer) : producerKind(producer)} -> j${cc} ${sign} ${state}`;
}

function blockSignature(insns) {
  return insns.map(ins => {
    if (isJcc(ins)) return `j${CC_NAMES[ins.cc] || ins.cc}`;
    if (ins.mem) return `${ins.kind}:${memRawShape(ins.mem, false)}`;
    return ins.kind;
  }).join(' ; ');
}

function primaryBucket(insns, analysis, infos, report) {
  const branch = insns[insns.length - 1];
  const producer = branchProducer(insns);
  const flagExit = branchFlagExit(report, branch);
  const hasUnknown = insns.some(ins => ins.kind === 'unknown');
  const hasStack = insns.some(ins => ins.kind === 'push_r32' || ins.kind === 'pop_r32' || (ins.mem && ins.mem.base === 4));
  if (producer && isJcc(branch) && flagExit && flagExit.flagsDead && insns.length <= 2) return 'branch-only flag-dead';
  if (analysis.blockCompilerSavedWrites > 0) return 'reg-coalescing block';
  if (analysis.identityWrites > 0) return 'identity-write block';
  if (producer && isJcc(branch)) return 'branch-only or branch-tail';
  if (hasStack) return 'stack/setup block';
  if (hasUnknown) return 'unknown decode boundary';
  if (memAccesses(insns, infos).some(mem => mem.index >= 0)) return 'SIB memory block';
  return 'other';
}

function analyzeProfile(profileFile, exeFile, opts) {
  const profile = JSON.parse(fs.readFileSync(profileFile, 'utf8'));
  const hot = profile.handlerHistogram && profile.handlerHistogram.hotBlocks;
  if (!hot || !hot.top || !hot.top.length) throw new Error(`${profileFile} has no hotBlocks.top data`);
  const report = scanFile(exeFile, { includeInstructions: true });

  const totals = {
    usedBlocks: 0,
    skippedBlocks: 0,
    coveredWeight: 0,
    weightedInsns: 0,
    currentDispatches: 0,
    currentG2W: 0,
    optimizedG2W: 0,
    savedG2W: 0,
    regWrites: 0,
    exitFlushes: 0,
    savedRegWrites: 0,
    identityWrites: 0,
    flagDeadBranches: 0,
    branchFusionSaves: 0,
    memoryAccessBlocks: 0,
    multiG2WBlocks: 0,
    repeatedEaBlocks: 0,
    unknownWeight: 0,
  };
  const primary = new Map();
  const signals = new Map();
  const signatures = new Map();
  const branchNorm = new Map();
  const branchExact = new Map();
  const regFlushShapes = new Map();
  const eaShapes = new Map();

  for (const row of hot.top.slice(0, opts.hotLimit)) {
    const weight = row.count || 0;
    const addr = row.addr >>> 0;
    const insns = blockInstructions(report, addr, opts.blockInsns);
    if (!insns.length) {
      totals.skippedBlocks++;
      continue;
    }

    const infos = insns.map(ins => accessInfo(ins, DEFAULT_OPT_REGS));
    const analysis = analyzeBlock(insns, DEFAULT_OPT_REGS);
    const accesses = memAccesses(insns, infos);
    const distinctEa = new Set(accesses.map(memKey));
    const currentDispatches = insns.reduce((sum, ins) => sum + dispatchCost(ins), 0);
    const currentG2W = accesses.length;
    const optimizedG2W = distinctEa.size;
    const branch = insns[insns.length - 1];
    const producer = branchProducer(insns);
    const flagExit = branchFlagExit(report, branch);

    totals.usedBlocks++;
    totals.coveredWeight += weight;
    totals.weightedInsns += insns.length * weight;
    totals.currentDispatches += currentDispatches * weight;
    totals.currentG2W += currentG2W * weight;
    totals.optimizedG2W += optimizedG2W * weight;
    totals.savedG2W += Math.max(0, currentG2W - optimizedG2W) * weight;
    if (currentG2W > 0) totals.memoryAccessBlocks += weight;
    if (currentG2W >= 2) totals.multiG2WBlocks += weight;
    if (Math.max(0, currentG2W - optimizedG2W) > 0) totals.repeatedEaBlocks += weight;
    totals.regWrites += analysis.candidateDefs * weight;
    totals.exitFlushes += analysis.finalFlushes * weight;
    totals.savedRegWrites += analysis.blockCompilerSavedWrites * weight;
    totals.identityWrites += analysis.identityWrites * weight;
    if (insns.some(ins => ins.kind === 'unknown')) totals.unknownWeight += weight;

    if (producer && isJcc(branch)) {
      totals.branchFusionSaves += weight;
      if (flagExit && flagExit.flagsDead) totals.flagDeadBranches += weight;
      add(branchNorm, branchKey(insns, report, false), weight, addr);
      add(branchExact, branchKey(insns, report, true), weight, addr);
    }

    const bucket = primaryBucket(insns, analysis, infos, report);
    add(primary, bucket, weight, addr);
    add(signatures, blockSignature(insns), weight, addr);

    if (flagExit && flagExit.flagsDead) add(signals, 'flag-dead branch', weight, addr);
    if (analysis.blockCompilerSavedWrites > 0) add(signals, 'register writes coalescible', weight, addr);
    if (analysis.identityWrites > 0) add(signals, 'identity register write', weight, addr);
    if (currentG2W > 0) add(signals, 'has EA/g2w memory access', weight, addr);
    if (currentG2W >= 2) add(signals, 'multiple EA/g2w accesses', weight, addr);
    if (Math.max(0, currentG2W - optimizedG2W) > 0) add(signals, 'repeated same-EA/g2w in block', weight, addr);
    if (accesses.some(mem => mem.index >= 0)) add(signals, 'SIB memory access', weight, addr);
    if (insns.some(ins => ins.kind === 'push_r32' || ins.kind === 'pop_r32' || (ins.mem && ins.mem.base === 4))) add(signals, 'stack/setup access', weight, addr);
    if (insns.some(ins => ins.kind === 'unknown')) add(signals, 'unknown decode boundary', weight, addr);

    if (analysis.blockCompilerSavedWrites > 0) {
      add(regFlushShapes, `${blockSignature(insns)} | writes=${analysis.candidateDefs} flushes=${analysis.finalFlushes} saved=${analysis.blockCompilerSavedWrites} regs=${formatRegs(analysis.definedRegs)}`, weight, addr);
    }
    for (const mem of accesses) {
      add(eaShapes, memRawShape(mem, false), weight, addr);
    }
  }

  return {
    profile,
    hot,
    report,
    profileFile,
    exeFile,
    opts,
    totals,
    primary,
    signals,
    signatures,
    branchNorm,
    branchExact,
    regFlushShapes,
    eaShapes,
  };
}

function printReport(result) {
  const { profile, hot, profileFile, exeFile, opts, totals } = result;
  const runSlice = profile.profile && profile.profile.counters && profile.profile.counters['main.runSlice'];
  const totalHandlers = profile.handlerHistogram && profile.handlerHistogram.totalHandlers || 0;
  console.log(`profile: ${profileFile}`);
  console.log(`exe:     ${exeFile}`);
  console.log(`blocks:  used ${totals.usedBlocks}/${Math.min(opts.hotLimit, hot.top.length)}, skipped ${totals.skippedBlocks}`);
  console.log(`covered: ${Math.round(totals.coveredWeight)} of ${hot.totalBlocks || 0} block entries (${pct(totals.coveredWeight, hot.totalBlocks || 0)})`);
  if (totalHandlers) console.log(`handlers total in profile: ${totalHandlers}`);
  if (runSlice) console.log(`main.runSlice: ${runSlice.totalMs.toFixed(1)} ms`);

  console.log('');
  console.log('Weighted compiler-stage summary:');
  console.log(`  current dispatches in covered blocks: ${Math.round(totals.currentDispatches)} (${pct(totals.currentDispatches, totalHandlers)} vs all handlers)`);
  console.log(`  branch fusion dispatch saves:         ${Math.round(totals.branchFusionSaves)} (${pct(totals.branchFusionSaves, totalHandlers)} vs all handlers)`);
  console.log(`  flag-dead branch opportunities:       ${Math.round(totals.flagDeadBranches)} (${pct(totals.flagDeadBranches, totals.coveredWeight)} of covered blocks)`);
  console.log(`  register writes seen:                 ${Math.round(totals.regWrites)}`);
  console.log(`  block-exit register flushes:          ${Math.round(totals.exitFlushes)}`);
  console.log(`  coalescible register writes:          ${Math.round(totals.savedRegWrites)} (${pct(totals.savedRegWrites, totalHandlers)} vs all handlers)`);
  console.log(`  identity register writes:             ${Math.round(totals.identityWrites)} (${pct(totals.identityWrites, totalHandlers)} vs all handlers)`);
  console.log(`  blocks with any EA/g2w access:        ${Math.round(totals.memoryAccessBlocks)} (${pct(totals.memoryAccessBlocks, totals.coveredWeight)} of covered blocks)`);
  console.log(`  blocks with multiple EA/g2w accesses: ${Math.round(totals.multiG2WBlocks)} (${pct(totals.multiG2WBlocks, totals.coveredWeight)} of covered blocks)`);
  console.log(`  blocks with repeated same EA/g2w:      ${Math.round(totals.repeatedEaBlocks)} (${pct(totals.repeatedEaBlocks, totals.coveredWeight)} of covered blocks)`);
  console.log(`  current g2w-like memory accesses:     ${Math.round(totals.currentG2W)} (${pct(totals.currentG2W, totalHandlers)} vs all handlers, ${(totals.currentG2W / Math.max(1, totals.coveredWeight)).toFixed(3)} per covered block)`);
  console.log(`  repeated-EA g2w saves in block:       ${Math.round(totals.savedG2W)} (${pct(totals.savedG2W, totalHandlers)} vs all handlers)`);
  console.log(`  unknown decode boundary weight:       ${Math.round(totals.unknownWeight)} (${pct(totals.unknownWeight, totals.coveredWeight)} of covered blocks)`);

  printWeightedRows('Primary buckets:', sortedRows(result.primary, opts.topRows), totals.coveredWeight, opts.topRows);
  printWeightedRows('Overlapping signals:', sortedRows(result.signals, opts.topRows), totals.coveredWeight, opts.topRows);
  printWeightedRows('Top normalized branch candidates:', sortedRows(result.branchNorm, opts.topRows), totals.coveredWeight, opts.topRows);
  printWeightedRows('Top exact branch candidates:', sortedRows(result.branchExact, opts.topRows), totals.coveredWeight, opts.topRows);
  printWeightedRows('Top register-coalescing block signatures:', sortedRows(result.regFlushShapes, opts.topRows), totals.coveredWeight, opts.topRows);
  printWeightedRows('Top EA/g2w access shapes:', sortedRows(result.eaShapes, opts.topRows), totals.currentG2W, opts.topRows);
  printWeightedRows('Top block signatures:', sortedRows(result.signatures, opts.topRows), totals.coveredWeight, opts.topRows);
}

function main() {
  const profileFile = path.resolve(argValue('profile') || findLatestHotBlockProfile());
  if (!profileFile) throw new Error('No AoE hot-block profile found in /private/tmp; run a profile with hotBlocks first');
  const exeFile = path.resolve(argValue('exe') || DEFAULT_EXE);
  const opts = {
    hotLimit: intArg('hot-limit', 120),
    blockInsns: intArg('block-insns', 64),
    topRows: intArg('top-rows', 12),
  };
  printReport(analyzeProfile(profileFile, exeFile, opts));
}

if (require.main === module) main();

module.exports = { analyzeProfile };
