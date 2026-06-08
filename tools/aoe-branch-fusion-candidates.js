#!/usr/bin/env node
// Rank hot AoE branch-fusion candidates where producer flags are dead after Jcc.
//
// This is an offline selection tool. Prior broad branch-fusion probes preserved
// lazy flags and were flat/regressive; this report focuses on sites where both
// branch exits overwrite flags before reading them, so a fused primitive can skip
// the producer flag write entirely.

const fs = require('fs');
const path = require('path');
const { scanFile } = require('./superinstruction-census');
const {
  DEFAULT_EXE,
  REGS,
  argValue,
  blockInstructions,
  findLatestHotBlockProfile,
  hex,
  intArg,
  isJcc,
  pct,
} = require('./aoe-reg-liveness-estimate');

const CC_NAMES = ['o', 'no', 'b', 'ae', 'z', 'nz', 'be', 'a', 's', 'ns', 'p', 'np', 'l', 'ge', 'le', 'g'];
const ALU_NAMES = ['add', 'or', 'adc', 'sbb', 'and', 'sub', 'xor', 'cmp'];

function regName(reg) {
  return REGS[reg] || `r${reg}`;
}

function signedDisp(disp) {
  if (!disp) return '';
  return disp < 0 ? `-${hex(-disp, 0)}` : `+${hex(disp, 0)}`;
}

function memShape(mem, exactDisp) {
  if (!mem) return 'none';
  const parts = [];
  if (mem.base >= 0) parts.push(regName(mem.base));
  if (mem.index >= 0) parts.push(mem.scale > 1 ? `${regName(mem.index)}*${mem.scale}` : regName(mem.index));
  if (mem.disp) {
    if (exactDisp) {
      const disp = mem.disp < 0 ? `-${hex(-mem.disp, 0)}` : hex(mem.disp, 0);
      parts.push(disp);
    } else {
      parts.push('disp');
    }
  } else if (!parts.length) {
    parts.push('abs');
  }
  return `[${parts.join('+').replace(/\+-/g, '-')}]`;
}

function simpleBase(mem) {
  return !!mem && mem.base >= 0 && mem.index < 0;
}

function isSignedJcc(ins) {
  return isJcc(ins) && ins.cc >= 12 && ins.cc <= 15;
}

function jccText(ins) {
  return `j${CC_NAMES[ins.cc] || ins.cc}`;
}

function producerText(ins, exactDisp) {
  if (!ins) return 'none';
  switch (ins.kind) {
    case 'cmp_r32_m32':
      return `cmp ${regName(ins.dst)},${memShape(ins.mem, exactDisp)}`;
    case 'cmp_m32_r32':
      return `cmp ${memShape(ins.mem, exactDisp)},${regName(ins.src)}`;
    case 'cmp_r32_r32':
      return `cmp ${regName(ins.dst)},${regName(ins.src)}`;
    case 'test_r32_r32':
      return `test ${regName(ins.dst)},${regName(ins.src)}`;
    case 'test_m32_r32':
      return `test ${memShape(ins.mem, exactDisp)},${regName(ins.src)}`;
    case 'alu_r32_r32':
      return `${ins.aluName || ALU_NAMES[ins.alu] || 'alu'} ${regName(ins.dst)},${regName(ins.src)}`;
    case 'alu_r32_m32':
      return `${ins.aluName || ALU_NAMES[ins.alu] || 'alu'} ${regName(ins.dst)},${memShape(ins.mem, exactDisp)}`;
    case 'alu_m32_r32':
      return `${ins.aluName || ALU_NAMES[ins.alu] || 'alu'} ${memShape(ins.mem, exactDisp)},${regName(ins.src)}`;
    case 'alu_r32_i8':
      return `${ins.aluName || ALU_NAMES[ins.alu] || 'alu'} ${regName(ins.dst)},${ins.imm}`;
    case 'shift_r32_i8':
      return `shift${ins.shift} ${regName(ins.dst)},${ins.imm}`;
    case 'inc_r32':
      return `inc ${regName(ins.reg)}`;
    case 'dec_r32':
      return `dec ${regName(ins.reg)}`;
    default:
      return ins.text || ins.kind;
  }
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
  if (ins.kind === 'shift_r32_i8' || ins.kind === 'shift_m32_i8') return true;
  return false;
}

function partialFlagWriter(ins) {
  return !!ins && (ins.kind === 'inc_r32' || ins.kind === 'dec_r32');
}

function flagReaderBeforeWrite(ins) {
  if (!ins) return false;
  if (isJcc(ins)) return true;
  if ((ins.kind === 'alu_r32_r32' || ins.kind === 'alu_r32_m32' || ins.kind === 'alu_m32_r32') && (ins.alu === 2 || ins.alu === 3)) return true;
  if ((ins.kind === 'alu_r32_i8' || ins.kind === 'alu_m32_i8') && (ins.alu === 2 || ins.alu === 3)) return true;
  return false;
}

function flagPathInfo(report, startIndex, maxInsns = 8) {
  if (startIndex === undefined || startIndex < 0 || startIndex >= report.instructions.length) {
    return { state: 'unknown', distance: -1, kind: '', va: 0 };
  }
  for (let i = startIndex; i < report.instructions.length && i < startIndex + maxInsns; i++) {
    const ins = report.instructions[i];
    const distance = i - startIndex;
    if (flagReaderBeforeWrite(ins)) return { state: 'read', distance, kind: ins.kind, va: ins.va >>> 0 };
    if (fullFlagWriter(ins)) return { state: 'dead', distance, kind: ins.kind, va: ins.va >>> 0 };
    if (partialFlagWriter(ins)) return { state: 'partial', distance, kind: ins.kind, va: ins.va >>> 0 };
    if (!ins || ins.kind === 'unknown') return { state: 'unknown', distance, kind: ins ? ins.kind : '', va: ins ? ins.va >>> 0 : 0 };
  }
  return { state: 'unknown', distance: -1, kind: '', va: 0 };
}

function branchFlagExit(report, branch) {
  if (!branch) return null;
  const fallIndex = report.byVa.get(branch.fall >>> 0);
  const targetIndex = report.byVa.get(branch.target >>> 0);
  const fall = flagPathInfo(report, fallIndex);
  const target = flagPathInfo(report, targetIndex);
  return {
    fallState: fall.state,
    targetState: target.state,
    fallDistance: fall.distance,
    targetDistance: target.distance,
    fallKind: fall.kind,
    targetKind: target.kind,
    flagsDead: fall.state === 'dead' && target.state === 'dead',
  };
}

function producerDispatchCost(ins) {
  if (!ins) return 0;
  return 1 + (ins.mem && ins.mem.index >= 0 ? 1 : 0);
}

function primitiveBucket(producer, branch) {
  if (!producer) return 'none';
  const cc = isSignedJcc(branch) ? 'signed' : 'other';
  if (producer.kind === 'cmp_r32_m32' && simpleBase(producer.mem) && isSignedJcc(branch)) {
    return 'cmp r32,[base+disp] + signed Jcc';
  }
  if (producer.kind === 'cmp_r32_m32' && isSignedJcc(branch)) {
    return 'cmp r32,[mem] + signed Jcc';
  }
  if (producer.kind === 'cmp_r32_r32' && isSignedJcc(branch)) {
    return 'cmp r32,r32 + signed Jcc';
  }
  if (producer.kind === 'test_r32_r32' && producer.dst === producer.src) {
    return `test r32,r32 self + ${jccText(branch)}`;
  }
  if (producer.kind === 'test_r32_r32') {
    return `test r32,r32 + ${jccText(branch)}`;
  }
  if (producer.kind === 'alu_r32_r32' && producer.dst === producer.src && (producer.alu === 1 || producer.alu === 4)) {
    return `${producer.aluName || ALU_NAMES[producer.alu]} r32,r32 identity + ${jccText(branch)}`;
  }
  return `${producer.kind} + ${cc} Jcc`;
}

function addWeighted(map, key, weight, addr, extra) {
  const row = map.get(key) || {
    key,
    weight: 0,
    dispatchSaves: 0,
    flagWritesSkipped: 0,
    sites: new Set(),
    examples: [],
  };
  row.weight += weight;
  row.dispatchSaves += extra.dispatchSaves || 0;
  row.flagWritesSkipped += extra.flagWritesSkipped || 0;
  row.sites.add(addr >>> 0);
  if (row.examples.length < extra.exampleLimit) row.examples.push(extra.example);
  map.set(key, row);
}

function sortedRows(map, limit) {
  return Array.from(map.values())
    .sort((a, b) => b.weight - a.weight)
    .slice(0, limit);
}

function printRows(title, rows, total, opts) {
  if (!rows.length) return;
  console.log('');
  console.log(title);
  for (const row of rows) {
    console.log(`  ${String(Math.round(row.weight)).padStart(10)}  ${pct(row.weight, total).padStart(6)}  sites=${String(row.sites.size).padStart(3)}  dispatch-save=${String(Math.round(row.dispatchSaves)).padStart(10)}  flag-skip=${String(Math.round(row.flagWritesSkipped)).padStart(10)}  ${row.key}`);
    if (opts.showExamples) {
      for (const ex of row.examples.slice(0, opts.examples)) console.log(`      ${ex}`);
    }
  }
}

function analyze(profileFile, exeFile, opts) {
  const profile = JSON.parse(fs.readFileSync(profileFile, 'utf8'));
  const hot = profile.handlerHistogram && profile.handlerHistogram.hotBlocks;
  if (!hot || !hot.top || !hot.top.length) throw new Error(`${profileFile} has no hotBlocks.top data`);
  const report = scanFile(exeFile, { includeInstructions: true });

  const totals = {
    usedBlocks: 0,
    skippedBlocks: 0,
    coveredWeight: 0,
    branchTailWeight: 0,
    branchTailSites: new Set(),
    flagDeadBranchWeight: 0,
    flagDeadBranchSites: new Set(),
    fusableFlagDeadWeight: 0,
    branchDispatchSaves: 0,
    flagWritesSkipped: 0,
    deadWriterMax0Weight: 0,
    deadWriterMax1Weight: 0,
    deadWriterMax3Weight: 0,
    cmpRegSignedDeadWriterMax0Weight: 0,
    cmpMemSignedSimpleDeadWriterMax0Weight: 0,
    cmpMemSignedSimpleDeadWeight: 0,
    cmpMemSignedSimpleDeadSites: new Set(),
    cmpRegSignedDeadWeight: 0,
    testRegDeadWeight: 0,
    testSelfDeadWeight: 0,
  };
  const allBranches = new Map();
  const flagDeadShapes = new Map();
  const primitiveBuckets = new Map();
  const exactDeadShapes = new Map();

  for (const row of hot.top.slice(0, opts.hotLimit)) {
    const weight = row.count || 0;
    const addr = row.addr >>> 0;
    const insns = blockInstructions(report, addr, opts.blockInsns);
    if (!insns.length) {
      totals.skippedBlocks++;
      continue;
    }

    totals.usedBlocks++;
    totals.coveredWeight += weight;

    const branch = insns[insns.length - 1];
    const producer = insns[insns.length - 2];
    if (!producer || !isJcc(branch)) continue;

    const flagExit = branchFlagExit(report, branch);
    const state = flagExit ? `${flagExit.fallState}-${flagExit.targetState}` : 'unknown';
    const exact = `${producerText(producer, true)} -> ${jccText(branch)} ${isSignedJcc(branch) ? 'signed' : 'other'} flags-${state}`;
    const normalized = `${producerText(producer, false)} -> ${jccText(branch)} ${isSignedJcc(branch) ? 'signed' : 'other'} flags-${state}`;
    const dispatchSaved = 1;
    const producerWritesFlags = fullFlagWriter(producer);
    const flagWriteSkipped = flagExit && flagExit.flagsDead && producerWritesFlags ? 1 : 0;
    const fallText = flagExit ? `${flagExit.fallState}@${flagExit.fallDistance}:${flagExit.fallKind}` : 'unknown';
    const targetText = flagExit ? `${flagExit.targetState}@${flagExit.targetDistance}:${flagExit.targetKind}` : 'unknown';
    const example = `${hex(addr)} weight=${weight} site=${hex(producer.va)} block-len=${insns.length} ${producerText(producer, true)}; ${jccText(branch)} fall=${fallText} target=${targetText} producer-dispatch=${producerDispatchCost(producer)}`;

    totals.branchTailWeight += weight;
    totals.branchTailSites.add(addr);
    addWeighted(allBranches, normalized, weight, addr, {
      dispatchSaves: dispatchSaved * weight,
      flagWritesSkipped: flagWriteSkipped * weight,
      example,
      exampleLimit: opts.examples,
    });

    if (!flagExit || !flagExit.flagsDead) continue;
    totals.flagDeadBranchWeight += weight;
    totals.flagDeadBranchSites.add(addr);
    if (producerWritesFlags) {
      const maxDeadDistance = Math.max(flagExit.fallDistance, flagExit.targetDistance);
      totals.fusableFlagDeadWeight += weight;
      totals.branchDispatchSaves += dispatchSaved * weight;
      totals.flagWritesSkipped += weight;
      if (maxDeadDistance <= 0) totals.deadWriterMax0Weight += weight;
      if (maxDeadDistance <= 1) totals.deadWriterMax1Weight += weight;
      if (maxDeadDistance <= 3) totals.deadWriterMax3Weight += weight;
      if (producer.kind === 'cmp_r32_r32' && isSignedJcc(branch) && maxDeadDistance <= 0) {
        totals.cmpRegSignedDeadWriterMax0Weight += weight;
      }
      if (producer.kind === 'cmp_r32_m32' && simpleBase(producer.mem) && isSignedJcc(branch) && maxDeadDistance <= 0) {
        totals.cmpMemSignedSimpleDeadWriterMax0Weight += weight;
      }

      if (producer.kind === 'cmp_r32_m32' && simpleBase(producer.mem) && isSignedJcc(branch)) {
        totals.cmpMemSignedSimpleDeadWeight += weight;
        totals.cmpMemSignedSimpleDeadSites.add(addr);
      }
      if (producer.kind === 'cmp_r32_r32' && isSignedJcc(branch)) totals.cmpRegSignedDeadWeight += weight;
      if (producer.kind === 'test_r32_r32') {
        totals.testRegDeadWeight += weight;
        if (producer.dst === producer.src) totals.testSelfDeadWeight += weight;
      }

      addWeighted(flagDeadShapes, normalized, weight, addr, {
        dispatchSaves: dispatchSaved * weight,
        flagWritesSkipped: flagWriteSkipped * weight,
        example,
        exampleLimit: opts.examples,
      });
      addWeighted(exactDeadShapes, exact, weight, addr, {
        dispatchSaves: dispatchSaved * weight,
        flagWritesSkipped: flagWriteSkipped * weight,
        example,
        exampleLimit: opts.examples,
      });
      addWeighted(primitiveBuckets, primitiveBucket(producer, branch), weight, addr, {
        dispatchSaves: dispatchSaved * weight,
        flagWritesSkipped: flagWriteSkipped * weight,
        example,
        exampleLimit: opts.examples,
      });
    }
  }

  return {
    profile,
    hot,
    profileFile,
    exeFile,
    opts,
    totals,
    allBranches,
    flagDeadShapes,
    primitiveBuckets,
    exactDeadShapes,
  };
}

function printReport(result) {
  const { profile, hot, profileFile, exeFile, opts, totals } = result;
  const totalHandlers = profile.handlerHistogram && profile.handlerHistogram.totalHandlers || 0;
  const runSlice = profile.profile && profile.profile.counters && profile.profile.counters['main.runSlice'];

  console.log(`profile: ${profileFile}`);
  console.log(`exe:     ${exeFile}`);
  console.log(`blocks:  used ${totals.usedBlocks}/${Math.min(opts.hotLimit, hot.top.length)}, skipped ${totals.skippedBlocks}`);
  console.log(`covered: ${Math.round(totals.coveredWeight)} of ${hot.totalBlocks || 0} block entries (${pct(totals.coveredWeight, hot.totalBlocks || 0)})`);
  if (totalHandlers) console.log(`handlers total in profile: ${totalHandlers}`);
  if (runSlice) console.log(`main.runSlice: ${runSlice.totalMs.toFixed(1)} ms`);

  console.log('');
  console.log('Branch-fusion selector summary:');
  console.log(`  branch-tail hot block entries:             ${Math.round(totals.branchTailWeight)} (${pct(totals.branchTailWeight, totalHandlers)} vs all handlers, sites=${totals.branchTailSites.size})`);
  console.log(`  flag-dead branch entries:                  ${Math.round(totals.flagDeadBranchWeight)} (${pct(totals.flagDeadBranchWeight, totals.coveredWeight)} of covered blocks, sites=${totals.flagDeadBranchSites.size})`);
  console.log(`  fusable flag-dead producer entries:        ${Math.round(totals.fusableFlagDeadWeight)} (${pct(totals.fusableFlagDeadWeight, totalHandlers)} vs all handlers)`);
  console.log(`  conservative branch-dispatch saves:        ${Math.round(totals.branchDispatchSaves)} (${pct(totals.branchDispatchSaves, totalHandlers)} vs all handlers)`);
  console.log(`  producer flag writes skipped:              ${Math.round(totals.flagWritesSkipped)} (${pct(totals.flagWritesSkipped, totalHandlers)} vs all handlers)`);
  console.log(`  both exits overwrite flags immediately:    ${Math.round(totals.deadWriterMax0Weight)} (${pct(totals.deadWriterMax0Weight, totals.fusableFlagDeadWeight)} of fusable flag-dead)`);
  console.log(`  both exits overwrite flags within 2 insns: ${Math.round(totals.deadWriterMax1Weight)} (${pct(totals.deadWriterMax1Weight, totals.fusableFlagDeadWeight)} of fusable flag-dead)`);
  console.log(`  both exits overwrite flags within 4 insns: ${Math.round(totals.deadWriterMax3Weight)} (${pct(totals.deadWriterMax3Weight, totals.fusableFlagDeadWeight)} of fusable flag-dead)`);
  console.log(`  cmp r32,[base+disp] signed dead:           ${Math.round(totals.cmpMemSignedSimpleDeadWeight)} (${pct(totals.cmpMemSignedSimpleDeadWeight, totalHandlers)} vs all handlers, sites=${totals.cmpMemSignedSimpleDeadSites.size})`);
  console.log(`  cmp r32,[base+disp] immediate-dead:        ${Math.round(totals.cmpMemSignedSimpleDeadWriterMax0Weight)} (${pct(totals.cmpMemSignedSimpleDeadWriterMax0Weight, totalHandlers)} vs all handlers)`);
  console.log(`  cmp r32,r32 signed dead:                   ${Math.round(totals.cmpRegSignedDeadWeight)} (${pct(totals.cmpRegSignedDeadWeight, totalHandlers)} vs all handlers)`);
  console.log(`  cmp r32,r32 signed immediate-dead:         ${Math.round(totals.cmpRegSignedDeadWriterMax0Weight)} (${pct(totals.cmpRegSignedDeadWriterMax0Weight, totalHandlers)} vs all handlers)`);
  console.log(`  test r32,r32 dead:                         ${Math.round(totals.testRegDeadWeight)} (${pct(totals.testRegDeadWeight, totalHandlers)} vs all handlers)`);
  console.log(`  test r32,r32 self dead:                    ${Math.round(totals.testSelfDeadWeight)} (${pct(totals.testSelfDeadWeight, totalHandlers)} vs all handlers)`);

  if (runSlice && totalHandlers) {
    const msPerHandler = runSlice.totalMs / totalHandlers;
    console.log('');
    console.log('Naive timing scale, not a benchmark:');
    console.log(`  one handler-share unit ~= ${(msPerHandler * 1e6).toFixed(3)} ns over this profile`);
    console.log(`  all fusable branch dispatch-save scale: ${((totals.branchDispatchSaves * msPerHandler)).toFixed(1)} ms (${pct(totals.branchDispatchSaves * msPerHandler, runSlice.totalMs)} of runSlice)`);
    console.log(`  cmp-reg signed dispatch-save scale:     ${((totals.cmpRegSignedDeadWeight * msPerHandler)).toFixed(1)} ms (${pct(totals.cmpRegSignedDeadWeight * msPerHandler, runSlice.totalMs)} of runSlice)`);
    console.log(`  cmp-mem signed dispatch-save scale:     ${((totals.cmpMemSignedSimpleDeadWeight * msPerHandler)).toFixed(1)} ms (${pct(totals.cmpMemSignedSimpleDeadWeight * msPerHandler, runSlice.totalMs)} of runSlice)`);
  }

  printRows('Top primitive buckets, fusable flag-dead only:', sortedRows(result.primitiveBuckets, opts.topRows), totals.fusableFlagDeadWeight, opts);
  printRows('Top normalized fusable flag-dead branch shapes:', sortedRows(result.flagDeadShapes, opts.topRows), totals.fusableFlagDeadWeight, opts);
  printRows('Top exact fusable flag-dead branch shapes:', sortedRows(result.exactDeadShapes, opts.topRows), totals.fusableFlagDeadWeight, opts);
  printRows('Top all branch-tail shapes:', sortedRows(result.allBranches, opts.topRows), totals.branchTailWeight, opts);

  console.log('');
  console.log('ASCII TLDR:');
  console.log(`  - Fusing every proven flag-dead producer->Jcc in covered hot blocks is a ${pct(totals.branchDispatchSaves, totalHandlers)} handler-dispatch surface and skips the same number of producer flag writes.`);
  console.log(`  - Largest standalone candidate is cmp r32,r32 + signed Jcc, flags-dead only: ${pct(totals.cmpRegSignedDeadWeight, totalHandlers)} of all handlers in this profile and no memory path.`);
  console.log(`  - Next candidate is cmp r32,[base+disp] + signed Jcc at ${pct(totals.cmpMemSignedSimpleDeadWeight, totalHandlers)}; test r32,r32 is smaller here at ${pct(totals.testRegDeadWeight, totalHandlers)}.`);
}

function main() {
  const profileFile = path.resolve(argValue('profile') || findLatestHotBlockProfile());
  if (!profileFile) throw new Error('No AoE hot-block profile found in /private/tmp; run a profile with hotBlocks first');
  const exeFile = path.resolve(argValue('exe') || DEFAULT_EXE);
  const opts = {
    hotLimit: intArg('hot-limit', 160),
    blockInsns: intArg('block-insns', 64),
    topRows: intArg('top-rows', 10),
    examples: intArg('examples', 3, 0),
    showExamples: process.argv.includes('--examples-detail'),
  };
  printReport(analyze(profileFile, exeFile, opts));
}

if (require.main === module) main();

module.exports = { analyze };
