#!/usr/bin/env node
// Print toy block-compiler output for hot AoE blocks.
//
// This is an offline design aid. It decodes hot block entries, prints the
// original instructions, approximates current threaded handlers, and prints a
// block-local virtual-register / virtual-flag lowering with exit flushes.

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
  hasFlag,
  hex,
  intArg,
  isJcc,
  pct,
} = require('./aoe-reg-liveness-estimate');

function regName(reg) {
  return REGS[reg] || `r${reg}`;
}

function aluName(ins) {
  return ins.aluName || ['add', 'or', 'adc', 'sbb', 'and', 'sub', 'xor', 'cmp'][ins.alu] || ins.kind;
}

function immText(v) {
  if (v < 0) return '-' + hex(-v, 0);
  return hex(v, 0);
}

function memText(mem, state) {
  if (!mem) return '[?]';
  const parts = [];
  if (mem.base >= 0) parts.push(state ? state.regs[mem.base] : regName(mem.base));
  if (mem.index >= 0) {
    const idx = state ? state.regs[mem.index] : regName(mem.index);
    parts.push(mem.scale > 1 ? `${idx}*${mem.scale}` : idx);
  }
  if (mem.disp) {
    if (parts.length) parts.push(mem.disp < 0 ? `-${hex(-mem.disp, 0)}` : hex(mem.disp, 0));
    else parts.push(hex(mem.disp, 0));
  } else if (!parts.length) {
    parts.push('0');
  }
  return parts.join(' + ').replace(/\+ -/g, '- ');
}

function memOperand(mem, state) {
  return `[${memText(mem, state)}]`;
}

function memShape(mem) {
  if (!mem) return 'none';
  const base = mem.base >= 0 ? regName(mem.base) : 'none';
  const index = mem.index >= 0 ? regName(mem.index) : 'none';
  const disp = mem.disp ? '+disp' : '';
  return `[${base}+${index}*${mem.scale}${disp}]`;
}

function maybeInternEa(state, mem, opt) {
  const guest = memText(mem, state);
  const key = guest;
  let rec = state.eaCache.get(key);
  if (!rec) {
    rec = {
      guest,
      ea: `ea${state.nextEa++}`,
      wa: `wa${state.nextWa++}`,
      uses: 0,
    };
    state.eaCache.set(key, rec);
    opt.lines.push(`${rec.ea} = ${guest}`);
    opt.lines.push(`${rec.wa} = g2w(${rec.ea})`);
    opt.g2wCalls++;
  } else {
    opt.reusedEa++;
  }
  rec.uses++;
  return rec;
}

function operandExpr(ins, state) {
  if (ins.src >= 0) return state.regs[ins.src];
  if (ins.mem) {
    const rec = maybeInternEa(state, ins.mem, state.opt);
    state.opt.loads++;
    return `load32(${rec.wa})`;
  }
  return '?';
}

function currentThreadedOps(ins) {
  const out = [];
  const mem = ins.mem;
  const addMemPrefix = () => {
    if (mem && mem.index >= 0) out.push(`th_compute_ea_sib ${memShape(mem)}`);
  };
  const memSuffix = () => mem && mem.index >= 0 ? '[ea_temp]' : mem ? memOperand(mem, null) : '';
  switch (ins.kind) {
    case 'xor_zero':
      out.push(`th_xor_r_r ${regName(ins.reg)},${regName(ins.reg)}`);
      break;
    case 'xor_rr':
      out.push(`th_xor_r_r ${regName(ins.dst)},${regName(ins.src)}`);
      break;
    case 'mov_r32_r32':
      out.push(`th_mov_r_r ${regName(ins.dst)},${regName(ins.src)}`);
      break;
    case 'mov_r32_m32':
    case 'mov_eax_moffs32':
      addMemPrefix();
      out.push(`th_load32 ${regName(ins.dst)},${memSuffix()}`);
      break;
    case 'mov_m32_r32':
    case 'mov_moffs32_eax':
      addMemPrefix();
      out.push(`th_store32 ${memSuffix()},${regName(ins.src)}`);
      break;
    case 'mov_r32_i32':
      out.push(`th_mov_r_i32 ${regName(ins.dst)},${hex(ins.imm, 0)}`);
      break;
    case 'mov_r8_m8':
      addMemPrefix();
      out.push(`th_load8 ${regName(ins.dst)},${memSuffix()}`);
      break;
    case 'mov_m8_r8':
      addMemPrefix();
      out.push(`th_store8 ${memSuffix()},${regName(ins.src)}`);
      break;
    case 'add_r32_rm32':
    case 'sub_r32_rm32':
    case 'alu_r32_r32':
    case 'alu_r32_m32':
      addMemPrefix();
      out.push(`th_${aluName(ins)}_r_rm32 ${regName(ins.dst)},${ins.src >= 0 ? regName(ins.src) : memSuffix()}`);
      break;
    case 'add_rm32_r32':
    case 'sub_rm32_r32':
    case 'alu_m32_r32':
      addMemPrefix();
      out.push(`th_${aluName(ins)}_rm32_r ${ins.dst >= 0 ? regName(ins.dst) : memSuffix()},${regName(ins.src)}`);
      break;
    case 'alu_r32_i8':
      out.push(`th_${aluName(ins)}_r_i8 ${regName(ins.dst)},${immText(ins.imm)}`);
      break;
    case 'alu_m32_i8':
      addMemPrefix();
      out.push(`th_${aluName(ins)}_m_i8 ${memSuffix()},${immText(ins.imm)}`);
      break;
    case 'cmp_r32_r32':
      out.push(`th_cmp_r_r ${regName(ins.dst)},${regName(ins.src)}`);
      break;
    case 'cmp_r32_m32':
    case 'cmp_m32_r32':
      addMemPrefix();
      out.push(`th_cmp ${ins.kind === 'cmp_r32_m32' ? regName(ins.dst) : memSuffix()},${ins.kind === 'cmp_r32_m32' ? memSuffix() : regName(ins.src)}`);
      break;
    case 'test_r32_r32':
      out.push(`th_test_r_r ${regName(ins.dst)},${regName(ins.src)}`);
      break;
    case 'test_m32_r32':
      addMemPrefix();
      out.push(`th_test_m_r ${memSuffix()},${regName(ins.src)}`);
      break;
    case 'inc_r32':
    case 'dec_r32':
      out.push(`th_${ins.kind.slice(0, 3)}_r ${regName(ins.reg)}`);
      break;
    case 'shift_r32_i8':
      out.push(`th_shift_r_i8 ${regName(ins.dst)},${ins.imm}`);
      break;
    case 'lea':
      out.push(`th_lea ${regName(ins.dst)},${memOperand(mem, null)}`);
      break;
    case 'push_r32':
      out.push(`th_push_r ${regName(ins.reg)}`);
      break;
    case 'pop_r32':
      out.push(`th_pop_r ${regName(ins.reg)}`);
      break;
    case 'jcc8':
    case 'jcc32':
      out.push(`th_jcc_${ins.text ? ins.text.split(/\s+/)[0].slice(1) : ins.cc} fall=${hex(ins.fall)} target=${hex(ins.target)}`);
      break;
    default:
      out.push(`th_${ins.kind}`);
      break;
  }
  return out;
}

function fullFlagWriter(ins) {
  if (!ins) return false;
  if (ins.kind === 'cmp_r32_r32' || ins.kind === 'cmp_r32_m32' || ins.kind === 'cmp_m32_r32') return true;
  if (ins.kind === 'test_r32_r32' || ins.kind === 'test_m32_r32') return true;
  if (ins.kind === 'xor_zero' || ins.kind === 'xor_rr') return true;
  if (ins.kind === 'add_r32_rm32' || ins.kind === 'add_rm32_r32') return true;
  if (ins.kind === 'sub_r32_rm32' || ins.kind === 'sub_rm32_r32') return true;
  if (ins.kind === 'alu_r32_r32' || ins.kind === 'alu_r32_m32' || ins.kind === 'alu_m32_r32') {
    return ins.alu !== 2 && ins.alu !== 3;
  }
  if (ins.kind === 'alu_r32_i8' || ins.kind === 'alu_m32_i8') {
    return ins.alu !== 2 && ins.alu !== 3;
  }
  if (ins.kind === 'shift_r32_i8' || ins.kind === 'shift_m32_i8') return true;
  return false;
}

function flagReaderBeforeWrite(ins) {
  if (!ins) return false;
  if (isJcc(ins)) return true;
  if ((ins.kind === 'alu_r32_i8' || ins.kind === 'alu_m32_i8') && (ins.alu === 2 || ins.alu === 3)) return true;
  if ((ins.kind === 'alu_r32_r32' || ins.kind === 'alu_r32_m32' || ins.kind === 'alu_m32_r32') && (ins.alu === 2 || ins.alu === 3)) return true;
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

function assignReg(state, reg, expr, opt) {
  if (!DEFAULT_OPT_REGS.has(reg)) {
    opt.lines.push(`emit existing write ${regName(reg)} = ${expr}`);
    return;
  }
  state.regs[reg] = expr;
  state.changed.add(reg);
  opt.lines.push(`v_${regName(reg)} = ${expr}`);
}

function lowerInstruction(ins, state, opt) {
  state.opt = opt;
  switch (ins.kind) {
    case 'xor_zero':
      assignReg(state, ins.reg, '0', opt);
      opt.flags = 'logic(0)';
      opt.lines.push('flags = logic(0)');
      break;
    case 'mov_r32_r32':
      if (ins.dst === ins.src) {
        opt.lines.push(`skip identity write ${regName(ins.dst)} = ${regName(ins.src)}`);
      } else {
        assignReg(state, ins.dst, state.regs[ins.src], opt);
      }
      break;
    case 'mov_r32_m32':
    case 'mov_eax_moffs32': {
      const rec = maybeInternEa(state, ins.mem, opt);
      opt.loads++;
      assignReg(state, ins.dst, `load32(${rec.wa})`, opt);
      break;
    }
    case 'mov_m32_r32':
    case 'mov_moffs32_eax': {
      const rec = maybeInternEa(state, ins.mem, opt);
      opt.stores++;
      opt.lines.push(`store32(${rec.wa}, ${state.regs[ins.src]})`);
      break;
    }
    case 'mov_r32_i32':
      assignReg(state, ins.dst, hex(ins.imm, 0), opt);
      break;
    case 'mov_r8_m8': {
      const rec = maybeInternEa(state, ins.mem, opt);
      opt.loads++;
      const full = ins.dst < 4 ? ins.dst : ins.dst - 4;
      const lane = ins.dst < 4 ? 'low8' : 'high8';
      assignReg(state, full, `set_${lane}(${state.regs[full]}, load8(${rec.wa}))`, opt);
      opt.partialWrites++;
      break;
    }
    case 'mov_m8_r8': {
      const rec = maybeInternEa(state, ins.mem, opt);
      opt.stores++;
      const full = ins.src < 4 ? ins.src : ins.src - 4;
      const lane = ins.src < 4 ? 'low8' : 'high8';
      opt.lines.push(`store8(${rec.wa}, ${lane}(${state.regs[full]}))`);
      break;
    }
    case 'add_r32_rm32':
    case 'sub_r32_rm32':
    case 'alu_r32_r32':
    case 'alu_r32_m32': {
      const op = aluName(ins);
      const a = state.regs[ins.dst];
      const b = operandExpr(ins, state);
      if ((op === 'or' || op === 'and') && ins.src === ins.dst) {
        opt.lines.push(`flags = logic(${a})`);
        opt.lines.push(`skip identity write ${regName(ins.dst)} = ${regName(ins.dst)}`);
        opt.flags = `logic(${a})`;
        break;
      }
      const expr = op === 'add' ? `(${a} + ${b})`
        : op === 'sub' ? `(${a} - ${b})`
        : `${op}(${a}, ${b})`;
      assignReg(state, ins.dst, expr, opt);
      opt.flags = `${op}(${a}, ${b}, ${expr})`;
      opt.lines.push(`flags = ${opt.flags}`);
      break;
    }
    case 'add_rm32_r32':
    case 'sub_rm32_r32':
    case 'alu_m32_r32': {
      const op = aluName(ins);
      if (ins.dst >= 0) {
        const a = state.regs[ins.dst];
        const b = state.regs[ins.src];
        const expr = op === 'add' ? `(${a} + ${b})`
          : op === 'sub' ? `(${a} - ${b})`
          : `${op}(${a}, ${b})`;
        assignReg(state, ins.dst, expr, opt);
        opt.flags = `${op}(${a}, ${b}, ${expr})`;
        opt.lines.push(`flags = ${opt.flags}`);
      } else {
        opt.lines.push(`emit existing memory ${op} ${memOperand(ins.mem, state)}, ${state.regs[ins.src]}`);
      }
      break;
    }
    case 'alu_r32_i8': {
      const op = aluName(ins);
      const a = state.regs[ins.dst];
      const b = immText(ins.imm);
      if (op === 'cmp') {
        opt.flags = `sub(${a}, ${b})`;
        opt.lines.push(`flags = ${opt.flags}`);
        break;
      }
      const identity =
        ((op === 'add' || op === 'or' || op === 'sub' || op === 'xor') && ins.imm === 0) ||
        (op === 'and' && ins.imm === -1);
      if (identity) {
        opt.flags = `logic(${a})`;
        opt.lines.push(`flags = logic(${a})`);
        opt.lines.push(`skip identity write ${regName(ins.dst)}`);
        break;
      }
      const expr = op === 'add' ? `(${a} + ${b})`
        : op === 'sub' ? `(${a} - ${b})`
        : `${op}(${a}, ${b})`;
      assignReg(state, ins.dst, expr, opt);
      opt.flags = `${op}(${a}, ${b}, ${expr})`;
      opt.lines.push(`flags = ${opt.flags}`);
      break;
    }
    case 'cmp_r32_r32':
      opt.flags = `sub(${state.regs[ins.dst]}, ${state.regs[ins.src]})`;
      opt.lines.push(`flags = ${opt.flags}`);
      break;
    case 'cmp_r32_m32': {
      const rec = maybeInternEa(state, ins.mem, opt);
      opt.loads++;
      opt.flags = `sub(${state.regs[ins.dst]}, load32(${rec.wa}))`;
      opt.lines.push(`flags = ${opt.flags}`);
      break;
    }
    case 'cmp_m32_r32': {
      const rec = maybeInternEa(state, ins.mem, opt);
      opt.loads++;
      opt.flags = `sub(load32(${rec.wa}), ${state.regs[ins.src]})`;
      opt.lines.push(`flags = ${opt.flags}`);
      break;
    }
    case 'test_r32_r32':
      opt.flags = `logic(${state.regs[ins.dst]} & ${state.regs[ins.src]})`;
      opt.lines.push(`flags = ${opt.flags}`);
      break;
    case 'test_m32_r32': {
      const rec = maybeInternEa(state, ins.mem, opt);
      opt.loads++;
      opt.flags = `logic(load32(${rec.wa}) & ${state.regs[ins.src]})`;
      opt.lines.push(`flags = ${opt.flags}`);
      break;
    }
    case 'inc_r32':
    case 'dec_r32': {
      const a = state.regs[ins.reg];
      const expr = ins.kind === 'inc_r32' ? `(${a} + 1)` : `(${a} - 1)`;
      assignReg(state, ins.reg, expr, opt);
      opt.flags = `${ins.kind === 'inc_r32' ? 'inc' : 'dec'}(${a}, ${expr})`;
      opt.lines.push(`flags = ${opt.flags}`);
      break;
    }
    case 'shift_r32_i8': {
      const a = state.regs[ins.dst];
      const expr = `shift${ins.shift}(${a}, ${ins.imm})`;
      assignReg(state, ins.dst, expr, opt);
      opt.flags = `shift(${a}, ${expr})`;
      opt.lines.push(`flags = ${opt.flags}`);
      break;
    }
    case 'lea':
      assignReg(state, ins.dst, memText(ins.mem, state), opt);
      break;
    case 'pop_r32':
      assignReg(state, ins.reg, 'pop32()', opt);
      opt.lines.push('emit existing ESP update for pop');
      break;
    case 'push_r32':
      opt.lines.push(`emit existing push ${state.regs[ins.reg]}`);
      break;
    case 'jcc8':
    case 'jcc32':
      opt.branch = ins;
      opt.lines.push(`branch ${ins.text || `jcc${ins.cc}`} using ${opt.flags || 'current flags'}`);
      break;
    default:
      opt.lines.push(`emit existing handler for ${ins.kind}`);
      break;
  }
}

function printBlock(report, row, opts) {
  const addr = row.addr >>> 0;
  const insns = blockInstructions(report, addr, opts.blockInsns);
  if (!insns.length) {
    console.log(`\n${hex(addr)} count=${row.count || 0}: no decoded instructions`);
    return;
  }
  const analysis = analyzeBlock(insns, DEFAULT_OPT_REGS);
  const infos = insns.map(ins => accessInfo(ins, DEFAULT_OPT_REGS));
  const state = {
    regs: REGS.slice(),
    changed: new Set(),
    eaCache: new Map(),
    nextEa: 0,
    nextWa: 0,
    opt: null,
  };
  const opt = {
    lines: [],
    g2wCalls: 0,
    loads: 0,
    stores: 0,
    reusedEa: 0,
    partialWrites: 0,
    branch: null,
    flags: '',
  };
  const currentOps = [];
  for (const ins of insns) {
    for (const op of currentThreadedOps(ins)) currentOps.push(op);
    lowerInstruction(ins, state, opt);
  }

  console.log('');
  console.log(`${hex(addr)} count=${row.count || 0} pct=${row.pct || ''}`);
  console.log(`  instructions=${insns.length} currentDispatches~${currentOps.length} currentRegWrites=${analysis.candidateDefs} exitFlushes=${analysis.finalFlushes} savedWrites=${analysis.blockCompilerSavedWrites}`);
  console.log(`  currentG2W~${infos.filter((info, i) => insns[i].mem && (info.memoryRead || info.memoryWrite)).length} optimizedG2W~${opt.g2wCalls} eaReuses=${opt.reusedEa}`);

  console.log('  original:');
  for (const ins of insns) {
    console.log(`    ${hex(ins.va)} ${ins.text || ins.kind}`);
  }

  console.log('  current threaded-ish:');
  for (const op of currentOps) console.log(`    ${op}`);

  console.log('  toy optimized block:');
  for (const line of opt.lines) console.log(`    ${line}`);
  if (state.changed.size) {
    console.log('    exit flush:');
    for (const r of Array.from(state.changed).sort((a, b) => a - b)) {
      console.log(`      global.${regName(r)} = ${state.regs[r]}`);
    }
  } else {
    console.log('    exit flush: none');
  }

  if (opt.branch) {
    const flush = formatRegs(state.changed) || 'none';
    const flagExit = branchFlagExit(report, opt.branch);
    console.log(`    side exits: flush ${flush}, then fall=${hex(opt.branch.fall)} target=${hex(opt.branch.target)}`);
    if (flagExit) {
      console.log(`    flag exits: fall=${flagExit.fallState} target=${flagExit.targetState} ${flagExit.flagsDead ? 'skip flag global write' : 'flush/conserve flags'}`);
    }
  }
}

function profileRows(profile, addr, top) {
  if (addr) return [{ addr, count: 0, pct: 'manual' }];
  const hot = profile.handlerHistogram && profile.handlerHistogram.hotBlocks;
  if (!hot || !hot.top) throw new Error('profile has no hotBlocks.top');
  return hot.top.slice(0, top);
}

function main() {
  const profileFile = path.resolve(argValue('profile') || findLatestHotBlockProfile());
  const exeFile = path.resolve(argValue('exe') || DEFAULT_EXE);
  const profile = JSON.parse(fs.readFileSync(profileFile, 'utf8'));
  const report = scanFile(exeFile, { includeInstructions: true });
  const addrArg = argValue('addr');
  const addr = addrArg ? Number.parseInt(addrArg, 0) >>> 0 : 0;
  const opts = {
    top: intArg('top', 6),
    blockInsns: intArg('block-insns', 64),
  };

  console.log(`profile: ${profileFile}`);
  console.log(`exe:     ${exeFile}`);
  console.log(`mode:    ${addr ? `addr ${hex(addr)}` : `top ${opts.top} hot blocks`}`);
  if (hasFlag('note')) console.log('note:    toy output is not executable code');
  for (const row of profileRows(profile, addr, opts.top)) printBlock(report, row, opts);
}

if (require.main === module) main();
