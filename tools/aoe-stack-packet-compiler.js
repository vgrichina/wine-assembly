#!/usr/bin/env node
// Prototype a Wasm-friendly stack-packet lowering for hot AoE blocks.
//
// This is an offline compiler artifact. It does not change emulator runtime
// code and it does not generate Wasm. It takes decoded hot blocks, accepts a
// conservative clean 32-bit subset, and prints the packet a future static WAT
// handler could execute with values cached in locals.

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
  isBoundary,
  isControl,
  isJcc,
  pct,
} = require('./aoe-reg-liveness-estimate');

const ALU_NAMES = ['add', 'or', 'adc', 'sbb', 'and', 'sub', 'xor', 'cmp'];
const CC_NAMES = ['o', 'no', 'b', 'ae', 'z', 'nz', 'be', 'a', 's', 'ns', 'p', 'np', 'l', 'ge', 'le', 'g'];

function regName(reg) {
  return REGS[reg] || `r${reg}`;
}

function ccName(cc) {
  return CC_NAMES[cc & 15] || `cc${cc}`;
}

function aluName(ins) {
  return ins.aluName || ALU_NAMES[ins.alu] || ins.kind;
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

function memRawText(mem) {
  return mem ? `[${memText(mem, null)}]` : '[?]';
}

function regVersionKey(reg, state) {
  if (reg < 0) return 'none';
  return `${regName(reg)}@${state.regVersion[reg]}`;
}

function memFamilyKey(mem, state) {
  if (!mem) return '';
  return `${regVersionKey(mem.base, state)}|${regVersionKey(mem.index, state)}|${mem.scale}`;
}

function memExactKey(mem, state, width) {
  if (!mem) return '';
  return `${memFamilyKey(mem, state)}|${mem.disp || 0}|${width}`;
}

function memUsesEsp(mem) {
  return !!mem && (mem.base === 4 || mem.index === 4);
}

function addWeighted(map, key, weight) {
  map.set(key, (map.get(key) || 0) + weight);
}

function topMapEntries(map, limit) {
  return Array.from(map.entries()).sort((a, b) => b[1] - a[1]).slice(0, limit);
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
  if (ins.kind === 'alu_r32_i8' || ins.kind === 'alu_r32_i32' || ins.kind === 'alu_eax_i32' ||
      ins.kind === 'alu_m32_i8' || ins.kind === 'alu_m32_i32') {
    return ins.alu !== 2 && ins.alu !== 3;
  }
  if (ins.kind === 'shift_r32_i8' || ins.kind === 'shift_r32_1') return true;
  return false;
}

function flagReaderBeforeWrite(ins) {
  if (!ins) return false;
  if (isJcc(ins)) return true;
  if ((ins.kind === 'alu_r32_i8' || ins.kind === 'alu_r32_i32' || ins.kind === 'alu_eax_i32' ||
       ins.kind === 'alu_m32_i8' || ins.kind === 'alu_m32_i32') &&
      (ins.alu === 2 || ins.alu === 3)) {
    return true;
  }
  if ((ins.kind === 'alu_r32_r32' || ins.kind === 'alu_r32_m32' || ins.kind === 'alu_m32_r32') &&
      (ins.alu === 2 || ins.alu === 3)) {
    return true;
  }
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

function currentDispatchEstimate(insns) {
  let dispatches = 0;
  for (const ins of insns) {
    dispatches++;
    if (ins.mem && ins.mem.index >= 0) dispatches++;
  }
  return dispatches;
}

function flagNeedsByInstruction(insns) {
  const needs = new Array(insns.length).fill(false);
  const last = insns[insns.length - 1];
  let needFlags = !!last && !isJcc(last);

  for (let i = insns.length - 1; i >= 0; i--) {
    const ins = insns[i];
    if (isJcc(ins)) {
      needFlags = true;
      continue;
    }
    if (flagReaderBeforeWrite(ins)) needFlags = true;
    if (fullFlagWriter(ins)) {
      needs[i] = needFlags;
      needFlags = false;
    }
  }

  return needs;
}

function blockRows(profile, addr, top) {
  if (addr) {
    const hot = profile.handlerHistogram && profile.handlerHistogram.hotBlocks;
    const row = hot && hot.top && hot.top.find(entry => (entry.addr >>> 0) === (addr >>> 0));
    return row ? [{ ...row, pct: row.pct || 'manual' }] : [{ addr, count: 0, pct: 'manual' }];
  }
  const hot = profile.handlerHistogram && profile.handlerHistogram.hotBlocks;
  if (!hot || !hot.top || !hot.top.length) throw new Error('profile has no hotBlocks.top data');
  return hot.top.slice(0, top);
}

function supportedOrReason(ins, info, index, insns, opts) {
  if (!ins) return 'missing instruction';
  if (ins.kind === 'unknown') return 'unknown decode';
  if (isControl(ins) && !isJcc(ins)) return `non-Jcc control ${ins.kind}`;
  if (isJcc(ins) && index !== insns.length - 1) return 'non-tail Jcc';
  if (info.partialWrite) return `partial-width op ${ins.kind}`;
  if (info.flagsRead && !isJcc(ins)) return `flags-read op ${ins.kind}`;
  if (info.defs.has(4) || info.currentWrites.has(4)) return `ESP write ${ins.kind}`;
  if (!opts.includeEspMem && memUsesEsp(ins.mem)) return 'ESP memory needs stack model';

  switch (ins.kind) {
    case 'xor_zero':
    case 'xor_rr':
    case 'mov_r32_r32':
    case 'mov_r32_m32':
    case 'mov_eax_moffs32':
    case 'mov_m32_r32':
    case 'mov_moffs32_eax':
    case 'mov_r32_i32':
    case 'lea':
    case 'add_r32_rm32':
    case 'sub_r32_rm32':
    case 'add_rm32_r32':
    case 'sub_rm32_r32':
    case 'alu_r32_r32':
    case 'alu_r32_m32':
    case 'alu_m32_r32':
    case 'alu_r32_i8':
    case 'alu_r32_i32':
    case 'alu_eax_i32':
    case 'alu_m32_i8':
    case 'alu_m32_i32':
    case 'cmp_r32_r32':
    case 'cmp_r32_m32':
    case 'cmp_m32_r32':
    case 'test_r32_r32':
    case 'test_m32_r32':
    case 'inc_r32':
    case 'dec_r32':
    case 'shift_r32_i8':
    case 'shift_r32_1':
    case 'jcc8':
    case 'jcc32':
      return '';
    default:
      return `unsupported ${ins.kind}`;
  }
}

function compileBlock(report, row, opts) {
  const addr = row.addr >>> 0;
  const insns = blockInstructions(report, addr, opts.blockInsns);
  const infos = insns.map(ins => accessInfo(ins, DEFAULT_OPT_REGS));
  const analysis = analyzeBlock(insns, DEFAULT_OPT_REGS);
  const result = {
    addr,
    row,
    insns,
    status: 'compiled',
    bailoutReasons: [],
    packetOps: [],
    exitFlushes: new Set(),
    memGroups: new Map(),
    stats: {
      currentDispatches: currentDispatchEstimate(insns),
      packetOps: 0,
      currentRegWrites: analysis.candidateDefs,
      exitRegFlushes: analysis.finalFlushes,
      regWritesSaved: analysis.blockCompilerSavedWrites,
      currentFlagWrites: infos.filter(info => info.flagsWrite).length,
      flagFlushes: 0,
      flagWritesSkipped: 0,
      virtualFlagComputes: 0,
      deadVirtualFlagsSkipped: 0,
      g2wCalls: 0,
      exactEaReuses: 0,
      pageWindowGroups: 0,
      pageWindowAccesses: 0,
      pageWindowG2WSaves: 0,
      loads: 0,
      stores: 0,
      directBranches: 0,
      globalFlagBranches: 0,
    },
    flagExit: null,
    branch: null,
  };

  if (!insns.length) {
    result.status = 'bailout';
    result.bailoutReasons.push('no decoded instructions');
    return result;
  }

  for (let i = 0; i < insns.length; i++) {
    const reason = supportedOrReason(insns[i], infos[i], i, insns, opts);
    if (reason) result.bailoutReasons.push(`${hex(insns[i].va)} ${reason}`);
  }

  const last = insns[insns.length - 1];
  if (!isBoundary(last) && !opts.allowOpenBlock) {
    result.bailoutReasons.push('open block without terminal boundary');
  }

  if (result.bailoutReasons.length) {
    result.status = 'bailout';
    return result;
  }

  const flagNeeded = flagNeedsByInstruction(insns);
  const state = {
    regs: REGS.map(name => `in.${name}`),
    regVersion: new Array(REGS.length).fill(0),
    dirty: new Set(),
    exactEa: new Map(),
    flags: '',
    tempId: 0,
    eaId: 0,
    waId: 0,
  };

  const op = text => result.packetOps.push(text);
  const temp = prefix => `${prefix}${prefix === 'ea' ? state.eaId++ : prefix === 'wa' ? state.waId++ : state.tempId++}`;

  const pushValue = value => op(`push ${value}`);
  const binaryValue = (opName, a, b) => {
    const out = temp('t');
    pushValue(a);
    pushValue(b);
    op(`i32.${opName} -> ${out}`);
    return out;
  };
  const setFlags = (kind, a, b, value) => {
    const f = temp('f');
    if (b !== undefined) {
      pushValue(a);
      pushValue(b);
      op(`flags.${kind} -> ${f}${value ? ` value=${value}` : ''}`);
    } else {
      pushValue(a);
      op(`flags.${kind} -> ${f}`);
    }
    state.flags = f;
    return f;
  };
  const maybeSetFlags = (insIndex, kind, a, b, value) => {
    if (!flagNeeded[insIndex]) {
      state.flags = '';
      result.stats.deadVirtualFlagsSkipped++;
      op(`skip.dead-flags ${kind}`);
      return '';
    }
    result.stats.virtualFlagComputes++;
    return setFlags(kind, a, b, value);
  };
  const writeReg = (reg, value) => {
    state.regs[reg] = value;
    state.regVersion[reg]++;
    if (DEFAULT_OPT_REGS.has(reg)) state.dirty.add(reg);
    op(`set.v ${regName(reg)} <- ${value}`);
  };
  const emitEa = mem => {
    const exact = memExactKey(mem, state, 32);
    const existing = state.exactEa.get(exact);
    if (existing) {
      result.stats.exactEaReuses++;
      op(`reuse.wa ${existing.wa} ; ${memRawText(mem)}`);
      return existing.wa;
    }

    const family = memFamilyKey(mem, state);
    let group = result.memGroups.get(family);
    if (!group) {
      group = {
        key: family,
        shape: memRawText({ ...mem, disp: 0 }),
        accesses: 0,
        disps: new Set(),
        minDisp: mem.disp || 0,
        maxDisp: mem.disp || 0,
      };
      result.memGroups.set(family, group);
    }
    const disp = mem.disp || 0;
    group.accesses++;
    group.disps.add(disp);
    group.minDisp = Math.min(group.minDisp, disp);
    group.maxDisp = Math.max(group.maxDisp, disp);

    if (mem.base >= 0) pushValue(state.regs[mem.base]);
    else pushValue('0');
    if (mem.index >= 0) {
      pushValue(state.regs[mem.index]);
      if (mem.scale !== 1) {
        pushValue(String(mem.scale));
        op('i32.mul');
      }
      op('i32.add');
    }
    if (disp) {
      pushValue(immText(disp));
      op('i32.add');
    }
    const ea = temp('ea');
    const wa = temp('wa');
    op(`stack.top -> ${ea} ; ${memText(mem, state)}`);
    op(`g2w ${ea} -> ${wa}`);
    state.exactEa.set(exact, { ea, wa });
    result.stats.g2wCalls++;
    return wa;
  };
  const loadMem = (mem, width = 32) => {
    const wa = emitEa(mem);
    const out = temp('m');
    op(`load${width} ${wa} -> ${out}`);
    result.stats.loads++;
    return out;
  };
  const storeMem = (mem, value, width = 32) => {
    const wa = emitEa(mem);
    pushValue(value);
    op(`store${width} ${wa}`);
    result.stats.stores++;
    state.exactEa.clear();
  };
  const operandValue = ins => {
    if (ins.src >= 0) return state.regs[ins.src];
    if (ins.mem) return loadMem(ins.mem, 32);
    return '?';
  };
  const lowerAlu = (insIndex, opName, dstReg, a, b) => {
    if (opName === 'cmp') {
      maybeSetFlags(insIndex, 'sub32', a, b);
      return a;
    }
    const wasmOp = opName === 'add' ? 'add'
      : opName === 'sub' ? 'sub'
      : opName === 'or' ? 'or'
      : opName === 'and' ? 'and'
      : opName === 'xor' ? 'xor'
      : '';
    const out = wasmOp ? binaryValue(wasmOp, a, b) : binaryValue(`alu.${opName}`, a, b);
    writeReg(dstReg, out);
    maybeSetFlags(insIndex, opName === 'sub' ? 'sub32' : opName === 'add' ? 'add32' : 'logic32', a, b, out);
    return out;
  };

  for (let insIndex = 0; insIndex < insns.length; insIndex++) {
    const ins = insns[insIndex];
    switch (ins.kind) {
      case 'xor_zero':
        writeReg(ins.reg, '0');
        maybeSetFlags(insIndex, 'logic32', '0');
        break;
      case 'xor_rr': {
        const out = binaryValue('xor', state.regs[ins.dst], state.regs[ins.src]);
        writeReg(ins.dst, out);
        maybeSetFlags(insIndex, 'logic32', out);
        break;
      }
      case 'mov_r32_r32':
        if (ins.dst === ins.src) op(`skip.identity ${regName(ins.dst)}`);
        else writeReg(ins.dst, state.regs[ins.src]);
        break;
      case 'mov_r32_m32':
      case 'mov_eax_moffs32':
        writeReg(ins.dst, loadMem(ins.mem, 32));
        break;
      case 'mov_m32_r32':
      case 'mov_moffs32_eax':
        storeMem(ins.mem, state.regs[ins.src], 32);
        break;
      case 'mov_r32_i32':
        writeReg(ins.dst, hex(ins.imm, 0));
        break;
      case 'lea': {
        const ea = temp('ea');
        op(`lea ${memText(ins.mem, state)} -> ${ea}`);
        writeReg(ins.dst, ea);
        break;
      }
      case 'add_r32_rm32':
      case 'sub_r32_rm32':
      case 'alu_r32_r32':
      case 'alu_r32_m32':
        lowerAlu(insIndex, aluName(ins), ins.dst, state.regs[ins.dst], operandValue(ins));
        break;
      case 'add_rm32_r32':
      case 'sub_rm32_r32':
      case 'alu_m32_r32': {
        const opName = aluName(ins);
        if (ins.dst >= 0) {
          lowerAlu(insIndex, opName, ins.dst, state.regs[ins.dst], state.regs[ins.src]);
        } else {
          const old = loadMem(ins.mem, 32);
          if (opName === 'cmp') {
            maybeSetFlags(insIndex, 'sub32', old, state.regs[ins.src]);
          } else {
            const out = binaryValue(opName === 'add' ? 'add' : opName === 'sub' ? 'sub' : `alu.${opName}`, old, state.regs[ins.src]);
            maybeSetFlags(insIndex, opName === 'sub' ? 'sub32' : opName === 'add' ? 'add32' : 'logic32', old, state.regs[ins.src], out);
            storeMem(ins.mem, out, 32);
          }
        }
        break;
      }
      case 'alu_r32_i8':
      case 'alu_r32_i32':
      case 'alu_eax_i32':
        lowerAlu(insIndex, aluName(ins), ins.dst, state.regs[ins.dst], immText(ins.imm));
        break;
      case 'alu_m32_i8':
      case 'alu_m32_i32': {
        const opName = aluName(ins);
        const old = loadMem(ins.mem, 32);
        if (opName === 'cmp') {
          maybeSetFlags(insIndex, 'sub32', old, immText(ins.imm));
        } else {
          const out = binaryValue(opName === 'add' ? 'add' : opName === 'sub' ? 'sub' : `alu.${opName}`, old, immText(ins.imm));
          maybeSetFlags(insIndex, opName === 'sub' ? 'sub32' : opName === 'add' ? 'add32' : 'logic32', old, immText(ins.imm), out);
          storeMem(ins.mem, out, 32);
        }
        break;
      }
      case 'cmp_r32_r32':
        maybeSetFlags(insIndex, 'sub32', state.regs[ins.dst], state.regs[ins.src]);
        break;
      case 'cmp_r32_m32':
        maybeSetFlags(insIndex, 'sub32', state.regs[ins.dst], loadMem(ins.mem, 32));
        break;
      case 'cmp_m32_r32':
        maybeSetFlags(insIndex, 'sub32', loadMem(ins.mem, 32), state.regs[ins.src]);
        break;
      case 'test_r32_r32': {
        const out = binaryValue('and', state.regs[ins.dst], state.regs[ins.src]);
        maybeSetFlags(insIndex, 'logic32', out);
        break;
      }
      case 'test_m32_r32': {
        const out = binaryValue('and', loadMem(ins.mem, 32), state.regs[ins.src]);
        maybeSetFlags(insIndex, 'logic32', out);
        break;
      }
      case 'inc_r32':
      case 'dec_r32': {
        const a = state.regs[ins.reg];
        const out = binaryValue(ins.kind === 'inc_r32' ? 'add' : 'sub', a, '1');
        writeReg(ins.reg, out);
        maybeSetFlags(insIndex, ins.kind === 'inc_r32' ? 'inc32_preserve_cf' : 'dec32_preserve_cf', a, '1', out);
        break;
      }
      case 'shift_r32_i8':
      case 'shift_r32_1': {
        const a = state.regs[ins.dst];
        const amount = ins.kind === 'shift_r32_1' ? 1 : ins.imm;
        const out = temp('t');
        pushValue(a);
        pushValue(String(amount));
        op(`shift${ins.shift || ''} -> ${out}`);
        writeReg(ins.dst, out);
        maybeSetFlags(insIndex, 'shift32', a, String(amount), out);
        break;
      }
      case 'jcc8':
      case 'jcc32': {
        result.branch = ins;
        result.flagExit = branchFlagExit(report, ins);
        if (state.flags) {
          op(`jcc.${ccName(ins.cc)} ${state.flags} fall=${hex(ins.fall)} target=${hex(ins.target)}`);
          result.stats.directBranches++;
        } else {
          op(`jcc.${ccName(ins.cc)} global_flags fall=${hex(ins.fall)} target=${hex(ins.target)}`);
          result.stats.globalFlagBranches++;
        }
        break;
      }
      default:
        throw new Error(`internal unsupported instruction escaped bailout: ${ins.kind}`);
    }
  }

  result.exitFlushes = new Set(state.dirty);
  result.stats.exitRegFlushes = result.exitFlushes.size;
  result.stats.regWritesSaved = Math.max(0, result.stats.currentRegWrites - result.stats.exitRegFlushes);
  result.stats.flagFlushes = state.flags && !(result.flagExit && result.flagExit.flagsDead) ? 1 : 0;
  result.stats.flagWritesSkipped = Math.max(0, result.stats.currentFlagWrites - result.stats.flagFlushes);
  result.stats.packetOps = result.packetOps.length;

  for (const group of result.memGroups.values()) {
    const range = group.maxDisp - group.minDisp;
    if (group.accesses >= 2 && range >= 0 && range < opts.pageSize) {
      result.stats.pageWindowGroups++;
      result.stats.pageWindowAccesses += group.accesses;
      result.stats.pageWindowG2WSaves += group.accesses - 1;
    }
  }

  return result;
}

function summarize(compiled, profile, opts) {
  const hot = profile.handlerHistogram && profile.handlerHistogram.hotBlocks || {};
  const totalHandlers = profile.handlerHistogram && profile.handlerHistogram.totalHandlers || 0;
  const totals = {
    rows: compiled.length,
    compiledRows: 0,
    bailoutRows: 0,
    weight: 0,
    compiledWeight: 0,
    currentDispatches: 0,
    packetOps: 0,
    currentRegWrites: 0,
    regFlushes: 0,
    regWritesSaved: 0,
    currentFlagWrites: 0,
    flagFlushes: 0,
    flagWritesSkipped: 0,
    virtualFlagComputes: 0,
    deadVirtualFlagsSkipped: 0,
    g2wCalls: 0,
    exactEaReuses: 0,
    pageWindowG2WSaves: 0,
    loads: 0,
    stores: 0,
    directBranches: 0,
    bailouts: new Map(),
  };

  for (const block of compiled) {
    const weight = block.row.count || 0;
    totals.weight += weight;
    if (block.status !== 'compiled') {
      totals.bailoutRows++;
      for (const reason of block.bailoutReasons) {
        addWeighted(totals.bailouts, reason.replace(/^0x[0-9a-f]+ /, ''), weight || 1);
      }
      continue;
    }
    totals.compiledRows++;
    totals.compiledWeight += weight;
    for (const [key, value] of Object.entries(block.stats)) {
      if (Object.prototype.hasOwnProperty.call(totals, key)) totals[key] += value * (weight || 1);
    }
  }

  console.log('');
  console.log('Stack-packet compiler summary:');
  console.log(`  rows compiled:                ${totals.compiledRows}/${totals.rows}`);
  console.log(`  block-entry coverage:         ${Math.round(totals.compiledWeight)} / ${hot.totalBlocks || totals.weight} (${pct(totals.compiledWeight, hot.totalBlocks || totals.weight)})`);
  if (totalHandlers) console.log(`  coverage vs all handlers:     ${pct(totals.currentDispatches, totalHandlers)} current-dispatch estimate`);
  console.log(`  current dispatch estimate:    ${Math.round(totals.currentDispatches)}`);
  console.log(`  packet op estimate:           ${Math.round(totals.packetOps)}`);
  console.log(`  register writes saved:        ${Math.round(totals.regWritesSaved)} (${pct(totals.regWritesSaved, totals.currentRegWrites)} of compiled current reg writes)`);
  console.log(`  flag writes skipped:          ${Math.round(totals.flagWritesSkipped)} (${pct(totals.flagWritesSkipped, totals.currentFlagWrites)} of compiled flag writes)`);
  console.log(`  virtual flag ops skipped:     ${Math.round(totals.deadVirtualFlagsSkipped)}`);
  console.log(`  exact EA reuses:              ${Math.round(totals.exactEaReuses)}`);
  console.log(`  page-window g2w save est:     ${Math.round(totals.pageWindowG2WSaves)}`);
  console.log(`  loads/stores in packets:      ${Math.round(totals.loads)} / ${Math.round(totals.stores)}`);
  console.log(`  direct local branches:        ${Math.round(totals.directBranches)}`);

  if (totals.bailouts.size) {
    console.log('');
    console.log('Top bailout reasons by weighted block entries:');
    for (const [reason, weight] of topMapEntries(totals.bailouts, opts.topReasons)) {
      console.log(`  ${String(Math.round(weight)).padStart(10)}  ${reason}`);
    }
  }
}

function printBlock(block) {
  const count = block.row.count || 0;
  console.log('');
  console.log(`${hex(block.addr)} count=${count} pct=${block.row.pct || ''} status=${block.status}`);
  console.log('  original:');
  for (const ins of block.insns) console.log(`    ${hex(ins.va)} ${ins.text || ins.kind}`);

  if (block.status !== 'compiled') {
    console.log('  bailout:');
    for (const reason of block.bailoutReasons) console.log(`    ${reason}`);
    return;
  }

  console.log(`  estimates: dispatch=${block.stats.currentDispatches} packetOps=${block.stats.packetOps} regWrites=${block.stats.currentRegWrites}->${block.stats.exitRegFlushes} flagWrites=${block.stats.currentFlagWrites}->${block.stats.flagFlushes} virtualFlagSkips=${block.stats.deadVirtualFlagsSkipped} g2w=${block.stats.g2wCalls} exactEaReuse=${block.stats.exactEaReuses} pageG2WSave=${block.stats.pageWindowG2WSaves}`);
  console.log('  packet:');
  for (const line of block.packetOps) console.log(`    ${line}`);
  console.log(`  exit flush: ${formatRegs(block.exitFlushes) || 'none'}`);
  if (block.branch && block.flagExit) {
    console.log(`  flag exits: fall=${block.flagExit.fallState} target=${block.flagExit.targetState} ${block.flagExit.flagsDead ? 'skip flag global write' : 'flush flags if live'}`);
  }
  const groups = Array.from(block.memGroups.values())
    .filter(group => group.accesses >= 2)
    .sort((a, b) => b.accesses - a.accesses);
  if (groups.length) {
    console.log('  memory groups:');
    for (const group of groups.slice(0, 6)) {
      const disps = Array.from(group.disps).sort((a, b) => a - b).map(d => immText(d)).join(',');
      console.log(`    accesses=${group.accesses} range=${hex(group.maxDisp - group.minDisp, 0)} disps=${disps} key=${group.key}`);
    }
  }
}

function main() {
  const profileFile = path.resolve(argValue('profile') || findLatestHotBlockProfile());
  if (!profileFile) throw new Error('No AoE hot-block profile found in /private/tmp; run a profile with hotBlocks first');
  const exeFile = path.resolve(argValue('exe') || DEFAULT_EXE);
  const profile = JSON.parse(fs.readFileSync(profileFile, 'utf8'));
  const report = scanFile(exeFile, { includeInstructions: true });
  const addrArg = argValue('addr');
  const addr = addrArg ? Number.parseInt(addrArg, 0) >>> 0 : 0;
  const opts = {
    addr,
    top: intArg('top', 8),
    details: intArg('details', addr ? 1 : 6, 0),
    blockInsns: intArg('block-insns', 64),
    pageSize: intArg('page-size', 4096),
    topReasons: intArg('top-reasons', 8),
    includeEspMem: hasFlag('include-esp-mem'),
    allowOpenBlock: hasFlag('allow-open-block'),
  };

  const rows = blockRows(profile, addr, opts.top);
  const compiled = rows.map(row => compileBlock(report, row, opts));

  console.log(`profile: ${profileFile}`);
  console.log(`exe:     ${exeFile}`);
  console.log(`mode:    ${addr ? `addr ${hex(addr)}` : `top ${opts.top} hot blocks`}`);
  console.log(`target:  stack packet, ${opts.includeEspMem ? 'ESP memory allowed' : 'ESP memory excluded'}`);
  summarize(compiled, profile, opts);

  for (const block of compiled.slice(0, opts.details)) printBlock(block);
}

if (require.main === module) main();

module.exports = {
  compileBlock,
  currentDispatchEstimate,
  memFamilyKey,
};
