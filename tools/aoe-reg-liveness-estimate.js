#!/usr/bin/env node
// Offline toy compiler estimate for AoE register global-write elimination.
//
// This does not change emulator runtime code. It decodes hot block entries from
// an existing handler-histogram profile, computes conservative block-local
// register liveness, and estimates how many full 32-bit register writes a block
// compiler could avoid by keeping registers virtual until block exit.

const fs = require('fs');
const path = require('path');
const { scanFile } = require('./superinstruction-census');

const ROOT = path.join(__dirname, '..');
const DEFAULT_EXE = path.join(ROOT, 'test/binaries/shareware/aoe/aoe_ex/Empires.exe');
const REGS = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi'];
const DEFAULT_OPT_REGS = new Set([0, 1, 2, 3, 5, 6, 7]); // ESP is special.

function hex(v, width = 8) {
  return '0x' + (v >>> 0).toString(16).padStart(width, '0');
}

function argValue(name) {
  const flag = `--${name}`;
  const withEquals = `${flag}=`;
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg.startsWith(withEquals)) return arg.slice(withEquals.length);
    if (arg === flag && i + 1 < process.argv.length) return process.argv[i + 1];
  }
  return '';
}

function hasFlag(name) {
  return process.argv.slice(2).includes(`--${name}`);
}

function intArg(name, fallback, min = 1) {
  const raw = argValue(name);
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

function pct(part, whole) {
  if (!whole) return '0.0%';
  return (100 * part / whole).toFixed(1) + '%';
}

function findLatestHotBlockProfile() {
  const dir = '/private/tmp';
  const rows = fs.readdirSync(dir)
    .filter(name => name.endsWith('.json') && name.includes('aoe'))
    .map(name => path.join(dir, name))
    .map(file => ({ file, mtimeMs: fs.statSync(file).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const row of rows) {
    try {
      const data = JSON.parse(fs.readFileSync(row.file, 'utf8'));
      const hot = data.handlerHistogram && data.handlerHistogram.hotBlocks;
      if (hot && (hot.totalBlocks || 0) > 0 && hot.top && hot.top.length) return row.file;
    } catch (_) {}
  }
  return '';
}

function memUses(mem, out) {
  if (!mem) return;
  if (mem.base >= 0) out.add(mem.base);
  if (mem.index >= 0) out.add(mem.index);
}

function addFullReg(set, reg, optRegs) {
  if (reg >= 0 && optRegs.has(reg)) set.add(reg);
}

function addPartialRegUse(set, reg, optRegs) {
  if (reg < 0) return;
  const full = reg < 4 ? reg : reg - 4;
  if (optRegs.has(full)) set.add(full);
}

function isJcc(ins) {
  return !!ins && (ins.kind === 'jcc8' || ins.kind === 'jcc32');
}

function isBoundary(ins) {
  return !ins || ins.kind === 'unknown' || isJcc(ins);
}

function accessInfo(ins, optRegs) {
  const uses = new Set();
  const defs = new Set();
  const currentWrites = new Set();
  let flagsRead = false;
  let flagsWrite = false;
  let memoryRead = false;
  let memoryWrite = false;
  let partialWrite = false;
  let fullWriteKind = '';
  let identityWriteKind = '';

  const use = r => addFullReg(uses, r, optRegs);
  const def = (r, kind) => {
    addFullReg(defs, r, optRegs);
    addFullReg(currentWrites, r, optRegs);
    if (optRegs.has(r)) fullWriteKind = kind || ins.kind;
  };
  const curWrite = (r, kind) => {
    addFullReg(currentWrites, r, optRegs);
    if (optRegs.has(r)) {
      fullWriteKind = kind || ins.kind;
      identityWriteKind = kind || ins.kind;
    }
  };
  const useMem = mem => memUses(mem, uses);

  switch (ins.kind) {
    case 'xor_zero':
      def(ins.reg, 'zero');
      flagsWrite = true;
      break;
    case 'xor_rr':
      use(ins.dst);
      use(ins.src);
      def(ins.dst, 'alu');
      flagsWrite = true;
      break;
    case 'mov_r32_r32':
      if (ins.dst === ins.src) {
        curWrite(ins.dst, 'identity-mov');
      } else {
        use(ins.src);
        def(ins.dst, 'mov');
      }
      break;
    case 'mov_r32_m32':
    case 'mov_eax_moffs32':
      useMem(ins.mem);
      memoryRead = true;
      def(ins.dst, 'load');
      break;
    case 'mov_m32_r32':
    case 'mov_moffs32_eax':
      useMem(ins.mem);
      use(ins.src);
      memoryWrite = true;
      break;
    case 'mov_r32_i32':
      def(ins.dst, 'mov');
      break;
    case 'mov_r8_r8':
      addPartialRegUse(uses, ins.src, optRegs);
      addPartialRegUse(uses, ins.dst, optRegs);
      partialWrite = true;
      break;
    case 'mov_r8_m8':
      useMem(ins.mem);
      addPartialRegUse(uses, ins.dst, optRegs);
      memoryRead = true;
      partialWrite = true;
      break;
    case 'mov_m8_r8':
      useMem(ins.mem);
      addPartialRegUse(uses, ins.src, optRegs);
      memoryWrite = true;
      break;
    case 'movzx8':
    case 'movsx8':
    case 'movzx16':
    case 'movsx16':
      if (ins.src >= 0) use(ins.src);
      else {
        useMem(ins.mem);
        memoryRead = true;
      }
      def(ins.dst, 'extend');
      break;
    case 'lea':
      useMem(ins.mem);
      def(ins.dst, 'lea');
      break;
    case 'add_r32_rm32':
    case 'sub_r32_rm32':
    case 'alu_r32_m32':
    case 'alu_r32_r32':
      use(ins.dst);
      if (ins.src >= 0) use(ins.src);
      else {
        useMem(ins.mem);
        memoryRead = true;
      }
      if (ins.src === ins.dst && (ins.alu === 1 || ins.alu === 4)) curWrite(ins.dst, 'identity-flag-alu');
      else def(ins.dst, 'alu');
      flagsWrite = true;
      break;
    case 'add_rm32_r32':
    case 'sub_rm32_r32':
    case 'alu_m32_r32':
      use(ins.src);
      if (ins.dst >= 0) {
        use(ins.dst);
        def(ins.dst, 'alu');
      } else {
        useMem(ins.mem);
        memoryRead = true;
        memoryWrite = true;
      }
      flagsWrite = true;
      break;
    case 'test_r32_r32':
      use(ins.dst);
      use(ins.src);
      flagsWrite = true;
      break;
    case 'test_m32_r32':
      useMem(ins.mem);
      use(ins.src);
      memoryRead = true;
      flagsWrite = true;
      break;
    case 'cmp_r32_r32':
      use(ins.dst);
      use(ins.src);
      flagsWrite = true;
      break;
    case 'cmp_r32_m32':
      use(ins.dst);
      useMem(ins.mem);
      memoryRead = true;
      flagsWrite = true;
      break;
    case 'cmp_m32_r32':
      useMem(ins.mem);
      use(ins.src);
      memoryRead = true;
      flagsWrite = true;
      break;
    case 'alu_r32_i8':
      use(ins.dst);
      if (ins.alu === 2 || ins.alu === 3) flagsRead = true;
      if (ins.alu !== 7) {
        const identityImm =
          ((ins.alu === 0 || ins.alu === 1 || ins.alu === 5 || ins.alu === 6) && ins.imm === 0) ||
          (ins.alu === 4 && ins.imm === -1);
        if (identityImm) curWrite(ins.dst, 'identity-flag-alu');
        else def(ins.dst, 'alu');
      }
      flagsWrite = true;
      break;
    case 'alu_m32_i8':
      useMem(ins.mem);
      if (ins.alu === 2 || ins.alu === 3) flagsRead = true;
      memoryRead = true;
      memoryWrite = ins.alu !== 7;
      flagsWrite = true;
      break;
    case 'shift_r32_i8':
      use(ins.dst);
      def(ins.dst, 'shift');
      flagsWrite = true;
      break;
    case 'shift_m32_i8':
      useMem(ins.mem);
      memoryRead = true;
      memoryWrite = true;
      flagsWrite = true;
      break;
    case 'inc_r32':
    case 'dec_r32':
      use(ins.reg);
      def(ins.reg, 'incdec');
      flagsWrite = true;
      break;
    case 'push_r32':
      use(ins.reg);
      memoryWrite = true;
      break;
    case 'pop_r32':
      memoryRead = true;
      def(ins.reg, 'pop');
      break;
    case 'jcc8':
    case 'jcc32':
      flagsRead = true;
      break;
  }

  return {
    uses,
    defs,
    currentWrites,
    identityWrites: new Set(identityWriteKind ? currentWrites : []),
    flagsRead,
    flagsWrite,
    memoryRead,
    memoryWrite,
    partialWrite,
    fullWriteKind,
  };
}

function blockInstructions(report, startVa, maxInsns) {
  const start = report.byVa.get(startVa >>> 0);
  if (start === undefined) return [];
  const out = [];
  for (let i = start; i < report.instructions.length && out.length < maxInsns; i++) {
    const ins = report.instructions[i];
    out.push(ins);
    if (isBoundary(ins)) break;
  }
  return out;
}

function analyzeBlock(insns, optRegs) {
  const infos = insns.map(ins => accessInfo(ins, optRegs));
  const live = new Set(optRegs);
  const rows = [];
  const kindCounts = Object.create(null);
  let candidateDefs = 0;
  let deadDefs = 0;
  let identityWrites = 0;
  let finalFlushes = 0;
  let partialWrites = 0;

  for (let i = infos.length - 1; i >= 0; i--) {
    const ins = insns[i];
    const info = infos[i];
    const liveAfter = new Set(live);
    const dead = [];
    const liveDefs = [];
    for (const r of info.currentWrites) {
      candidateDefs++;
      kindCounts[info.fullWriteKind || ins.kind] = (kindCounts[info.fullWriteKind || ins.kind] || 0) + 1;
      if (info.identityWrites.has(r)) identityWrites++;
    }
    for (const r of info.defs) {
      if (liveAfter.has(r)) liveDefs.push(r);
      else {
        dead.push(r);
        deadDefs++;
      }
      live.delete(r);
    }
    for (const r of info.uses) live.add(r);
    if (info.partialWrite) partialWrites++;
    rows[i] = { ins, info, liveAfter, dead, liveDefs };
  }

  const definedRegs = new Set();
  for (const info of infos) {
    for (const r of info.defs) definedRegs.add(r);
  }
  finalFlushes = definedRegs.size;
  const blockCompilerSavedWrites = Math.max(0, candidateDefs - finalFlushes);

  return {
    rows,
    candidateDefs,
    deadDefs,
    identityWrites,
    finalFlushes,
    blockCompilerSavedWrites,
    partialWrites,
    kindCounts,
    definedRegs,
  };
}

function mergeCounts(dst, src, weight) {
  for (const [key, value] of Object.entries(src)) {
    dst[key] = (dst[key] || 0) + value * weight;
  }
}

function topEntries(map, n) {
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n);
}

function formatRegs(regs) {
  return Array.from(regs).sort((a, b) => a - b).map(r => REGS[r]).join(',');
}

function estimate(profileFile, exeFile, opts) {
  const profile = JSON.parse(fs.readFileSync(profileFile, 'utf8'));
  const hot = profile.handlerHistogram && profile.handlerHistogram.hotBlocks;
  if (!hot || !hot.top || !hot.top.length) {
    throw new Error(`${profileFile} has no hotBlocks.top data`);
  }
  const report = scanFile(exeFile, { includeInstructions: true });
  const optRegs = hasFlag('include-esp') ? new Set([0, 1, 2, 3, 4, 5, 6, 7]) : DEFAULT_OPT_REGS;
  const top = hot.top.slice(0, opts.hotLimit);
  const totals = {
    inputBlocks: top.length,
    usedBlocks: 0,
    skippedBlocks: 0,
    coveredWeight: 0,
    candidateDefs: 0,
    deadDefs: 0,
    identityWrites: 0,
    finalFlushes: 0,
    blockCompilerSavedWrites: 0,
    partialWrites: 0,
    weightedInsns: 0,
    kindCounts: Object.create(null),
    examples: [],
  };

  for (const row of top) {
    const weight = row.count || 0;
    const insns = blockInstructions(report, row.addr >>> 0, opts.blockInsns);
    if (!insns.length) {
      totals.skippedBlocks++;
      continue;
    }
    totals.usedBlocks++;
    totals.coveredWeight += weight;
    totals.weightedInsns += insns.length * weight;

    const a = analyzeBlock(insns, optRegs);
    totals.candidateDefs += a.candidateDefs * weight;
    totals.deadDefs += a.deadDefs * weight;
    totals.identityWrites += a.identityWrites * weight;
    totals.finalFlushes += a.finalFlushes * weight;
    totals.blockCompilerSavedWrites += a.blockCompilerSavedWrites * weight;
    totals.partialWrites += a.partialWrites * weight;
    mergeCounts(totals.kindCounts, a.kindCounts, weight);

    if (totals.examples.length < opts.examples &&
        (a.deadDefs > 0 || a.identityWrites > 0 || a.blockCompilerSavedWrites > 0 || row.count >= 50000)) {
      const lines = [];
      for (const r of a.rows) {
        const dead = r.dead.length ? ` dead=${formatRegs(r.dead)}` : '';
        const writes = r.info.currentWrites.size ? ` write=${formatRegs(r.info.currentWrites)}` : '';
        const defs = r.info.defs.size ? ` def=${formatRegs(r.info.defs)}` : '';
        const uses = r.info.uses.size ? ` use=${formatRegs(r.info.uses)}` : '';
        const identity = r.info.identityWrites.size ? ` identity=${formatRegs(r.info.identityWrites)}` : '';
        lines.push(`    ${hex(r.ins.va)} ${r.ins.text || r.ins.kind}${writes}${defs}${uses}${identity}${dead}`);
      }
      totals.examples.push({
        addr: row.addr >>> 0,
        count: weight,
        candidateDefs: a.candidateDefs,
        finalFlushes: a.finalFlushes,
        saved: a.blockCompilerSavedWrites,
        dead: a.deadDefs,
        identity: a.identityWrites,
        definedRegs: formatRegs(a.definedRegs),
        lines,
      });
    }
  }

  return { profile, hot, profileFile, exeFile, optRegs, totals };
}

function printEstimate(result) {
  const { profile, hot, profileFile, exeFile, optRegs, totals } = result;
  const runSlice = profile.profile && profile.profile.counters && profile.profile.counters['main.runSlice'];
  const totalHandlers = profile.handlerHistogram && profile.handlerHistogram.totalHandlers || 0;
  const runSliceMs = runSlice && runSlice.totalMs || 0;
  const guestMs = profile.profile && profile.profile.runSliceBreakdown
    ? profile.profile.runSliceBreakdown.guestOrUnwrappedMs
    : runSliceMs;

  console.log(`profile: ${profileFile}`);
  console.log(`exe:     ${exeFile}`);
  console.log(`regs:    ${Array.from(optRegs).sort((a, b) => a - b).map(r => REGS[r]).join(',')} (${optRegs.has(4) ? 'ESP included' : 'ESP excluded'})`);
  console.log(`blocks:  used ${totals.usedBlocks}/${totals.inputBlocks}, skipped ${totals.skippedBlocks}`);
  console.log(`covered: ${Math.round(totals.coveredWeight)} of ${hot.totalBlocks || 0} block entries (${pct(totals.coveredWeight, hot.totalBlocks || 0)})`);
  console.log(`handlers total in profile: ${totalHandlers || 'n/a'}`);
  if (runSliceMs) console.log(`main.runSlice: ${runSliceMs.toFixed(1)} ms, guest/unwrapped: ${guestMs.toFixed(1)} ms`);

  console.log('');
  console.log('Weighted toy-compiler estimate:');
  console.log(`  decoded insns in covered hot blocks:        ${Math.round(totals.weightedInsns)}`);
  console.log(`  full register writes seen:                 ${Math.round(totals.candidateDefs)}`);
  console.log(`  final block-exit register flushes needed:  ${Math.round(totals.finalFlushes)}`);
  console.log(`  block-compiler global writes avoidable:    ${Math.round(totals.blockCompilerSavedWrites)} (${pct(totals.blockCompilerSavedWrites, totals.candidateDefs)} of seen reg writes)`);
  console.log(`  easy dead overwritten writes:              ${Math.round(totals.deadDefs)} (${pct(totals.deadDefs, totals.candidateDefs)} of seen reg writes)`);
  console.log(`  easy identity writes:                      ${Math.round(totals.identityWrites)} (${pct(totals.identityWrites, totals.candidateDefs)} of seen reg writes)`);
  console.log(`  partial-byte writes ignored for now:        ${Math.round(totals.partialWrites)}`);
  if (totals.coveredWeight) {
    console.log(`  writes seen per covered block entry:        ${(totals.candidateDefs / totals.coveredWeight).toFixed(3)}`);
    console.log(`  avoidable writes per covered block entry:   ${(totals.blockCompilerSavedWrites / totals.coveredWeight).toFixed(3)}`);
    console.log(`  dead writes per covered block entry:        ${(totals.deadDefs / totals.coveredWeight).toFixed(3)}`);
    console.log(`  identity writes per covered block entry:    ${(totals.identityWrites / totals.coveredWeight).toFixed(3)}`);
  }
  if (totalHandlers) {
    console.log(`  avoidable writes vs all handler dispatches: ${pct(totals.blockCompilerSavedWrites, totalHandlers)}`);
    console.log(`  dead writes vs all handler dispatches:      ${pct(totals.deadDefs, totalHandlers)}`);
    console.log(`  identity writes vs all handler dispatches:  ${pct(totals.identityWrites, totalHandlers)}`);
  }

  console.log('');
  console.log('Top full-write kinds, weighted:');
  for (const [kind, count] of topEntries(totals.kindCounts, 10)) {
    console.log(`  ${String(Math.round(count)).padStart(10)}  ${kind}`);
  }

  if (runSliceMs && totalHandlers) {
    const naiveMsPerHandler = runSliceMs / totalHandlers;
    const upperMs = totals.blockCompilerSavedWrites * naiveMsPerHandler;
    const deadMs = totals.deadDefs * naiveMsPerHandler;
    const identityMs = totals.identityWrites * naiveMsPerHandler;
    console.log('');
    console.log('Naive timing scale, not a benchmark:');
    console.log(`  one handler-share unit ~= ${(naiveMsPerHandler * 1e6).toFixed(3)} ns over this profile`);
    console.log(`  block-compiler saved-write upper scale: ${upperMs.toFixed(1)} ms (${pct(upperMs, runSliceMs)} of runSlice)`);
    console.log(`  easy-dead-write scale:                  ${deadMs.toFixed(1)} ms (${pct(deadMs, runSliceMs)} of runSlice)`);
    console.log(`  easy-identity-write scale:              ${identityMs.toFixed(1)} ms (${pct(identityMs, runSliceMs)} of runSlice)`);
  }

  if (totals.examples.length) {
    console.log('');
    console.log('Examples:');
    for (const ex of totals.examples) {
      console.log(`  ${hex(ex.addr)} count=${ex.count} writes=${ex.candidateDefs} flushes=${ex.finalFlushes} saved=${ex.saved} dead=${ex.dead} identity=${ex.identity} defined=${ex.definedRegs}`);
      for (const line of ex.lines) console.log(line);
    }
  }
}

function main() {
  const profileFile = path.resolve(argValue('profile') || findLatestHotBlockProfile());
  if (!profileFile) throw new Error('No AoE hot-block profile found in /private/tmp; run a profile with hotBlocks first');
  const exeFile = path.resolve(argValue('exe') || DEFAULT_EXE);
  const opts = {
    hotLimit: intArg('hot-limit', 200),
    blockInsns: intArg('block-insns', 64),
    examples: intArg('examples', 5, 0),
  };
  printEstimate(estimate(profileFile, exeFile, opts));
}

if (require.main === module) main();

module.exports = {
  DEFAULT_EXE,
  DEFAULT_OPT_REGS,
  REGS,
  accessInfo,
  analyzeBlock,
  argValue,
  blockInstructions,
  findLatestHotBlockProfile,
  formatRegs,
  hasFlag,
  hex,
  intArg,
  isBoundary,
  isJcc,
  pct,
};
