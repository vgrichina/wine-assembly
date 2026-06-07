#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { disasmAt } = require('./disasm');

const ROOT = path.join(__dirname, '..');
const DEFAULT_EXE = path.join(ROOT, 'test/binaries/shareware/aoe/aoe_ex/Empires.exe');

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

function positionalArgs() {
  const out = [];
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg.startsWith('--')) {
      if (!arg.includes('=') && i + 1 < process.argv.length && !process.argv[i + 1].startsWith('--')) i++;
      continue;
    }
    out.push(arg);
  }
  return out;
}

function intArg(name, fallback) {
  const raw = argValue(name);
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function hex32(v) {
  return '0x' + ((v >>> 0).toString(16).padStart(8, '0'));
}

function readCString(buf, off, maxLen) {
  let s = '';
  const end = Math.min(buf.length, off + maxLen);
  for (let i = off; i < end && buf[i]; i++) s += String.fromCharCode(buf[i]);
  return s;
}

function readPe(file) {
  const buf = fs.readFileSync(file);
  const peOff = buf.readUInt32LE(0x3c);
  const numSections = buf.readUInt16LE(peOff + 6);
  const optOff = peOff + 24;
  const optSize = buf.readUInt16LE(peOff + 20);
  const imageBase = buf.readUInt32LE(optOff + 28);
  const sectOff = optOff + optSize;
  const sections = [];
  for (let i = 0; i < numSections; i++) {
    const s = sectOff + i * 40;
    const name = readCString(buf, s, 8);
    const vsize = buf.readUInt32LE(s + 8);
    const rva = buf.readUInt32LE(s + 12);
    const rawSize = buf.readUInt32LE(s + 16);
    const rawOff = buf.readUInt32LE(s + 20);
    sections.push({
      name,
      va: imageBase + rva,
      rva,
      vsize,
      rawSize,
      rawOff,
      span: Math.max(vsize, rawSize),
    });
  }
  return { file, buf, imageBase, sections };
}

function vaToOff(pe, va) {
  for (const s of pe.sections) {
    const size = s.span;
    if (va >= s.va && va < s.va + size) {
      return { off: va - s.va + s.rawOff, section: s };
    }
  }
  return null;
}

function findEntry(pe, va) {
  const loc = vaToOff(pe, va);
  if (!loc) return null;
  const { off, section } = loc;
  const floor = Math.max(section.rawOff, off - 0x4000);
  const b = pe.buf;
  for (let i = off; i >= floor; i--) {
    if (b[i] === 0x55 && b[i + 1] === 0x8b && b[i + 2] === 0xec) {
      return { entry: section.va + (i - section.rawOff), distance: off - i, reason: 'prologue' };
    }
    if (b[i] !== 0xcc && b[i] !== 0x90 && i - 2 >= section.rawOff) {
      const p1 = b[i - 1];
      const p2 = b[i - 2];
      if ((p1 === 0xcc && p2 === 0xcc) || (p1 === 0x90 && p2 === 0x90)) {
        return { entry: section.va + (i - section.rawOff), distance: off - i, reason: 'padding' };
      }
    }
    if (i - 1 >= section.rawOff && b[i - 1] === 0xc3) {
      return { entry: section.va + (i - section.rawOff), distance: off - i, reason: 'ret' };
    }
    if (i - 3 >= section.rawOff && b[i - 3] === 0xc2) {
      return { entry: section.va + (i - section.rawOff), distance: off - i, reason: 'ret imm16' };
    }
  }
  return null;
}

function readProfile(file) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const hist = data.handlerHistogram;
  if (!hist) throw new Error(`${file} has no handlerHistogram; rerun with HANDLER_HIST=1`);
  return { data, hist };
}

function findLatestProfile() {
  const dir = '/private/tmp';
  const files = fs.readdirSync(dir)
    .filter(name => name.endsWith('.json') && name.includes('aoe'))
    .map(name => path.join(dir, name))
    .map(file => ({ file, mtimeMs: fs.statSync(file).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const row of files) {
    try {
      const data = JSON.parse(fs.readFileSync(row.file, 'utf8'));
      const hist = data && data.handlerHistogram;
      if (hist && ((hist.totalHandlers || 0) > 0 || (hist.hotBlocks && (hist.hotBlocks.totalBlocks || 0) > 0))) {
        return row.file;
      }
    } catch (_) {}
  }
  return '';
}

function pct(n, total) {
  return total ? (n * 100 / total).toFixed(3) : '0.000';
}

function printRows(title, rows, formatRow, limit) {
  if (!rows || !rows.length || limit <= 0) return;
  console.log('');
  console.log(title);
  for (const row of rows.slice(0, limit)) console.log(formatRow(row));
}

function clusterHotBlocks(rows, distance) {
  const sorted = rows.slice().sort((a, b) => (a.addr >>> 0) - (b.addr >>> 0));
  const clusters = [];
  for (const row of sorted) {
    const last = clusters[clusters.length - 1];
    if (!last || row.addr - last.end > distance) {
      clusters.push({
        start: row.addr,
        end: row.addr,
        count: row.count,
        rows: [row],
      });
    } else {
      last.end = Math.max(last.end, row.addr);
      last.count += row.count;
      last.rows.push(row);
    }
  }
  clusters.sort((a, b) => b.count - a.count);
  return clusters;
}

function printHotBlock(pe, row, insns, beforeBytes) {
  const va = row.addr >>> 0;
  const start = Math.max(0, va - beforeBytes) >>> 0;
  const loc = vaToOff(pe, start);
  const exactLoc = vaToOff(pe, va);
  console.log('');
  console.log(`hot ${row.addrHex || hex32(va)} count=${row.count} pct=${row.pct} inCode=${row.inCode}`);
  if (!exactLoc) {
    console.log('  VA not in any PE section');
    return;
  }
  const entry = findEntry(pe, va);
  console.log(`  section=${exactLoc.section.name} entry=${entry ? hex32(entry.entry) + ' -' + entry.distance + ' ' + entry.reason : 'unknown'}`);
  if (!loc) {
    console.log('  nearby disassembly start is outside any PE section');
    return;
  }
  for (const line of disasmAt(pe.buf, loc.off, start, insns)) {
    const lineVa = parseInt(line.slice(0, 8), 16) >>> 0;
    const mark = lineVa === va ? '*' : ' ';
    console.log(`${mark} ${line}`);
  }
}

function main() {
  const pos = positionalArgs();
  const profileArg = argValue('profile') || pos[0] || findLatestProfile();
  if (!profileArg) throw new Error('No AoE handler histogram profile found; rerun with HANDLER_HIST=1');
  const profileFile = path.resolve(profileArg);
  const exeFile = path.resolve(argValue('exe') || pos[1] || DEFAULT_EXE);
  const top = intArg('top', 8);
  const disasmLimit = intArg('disasm', 3);
  const insns = intArg('insns', 18);
  const beforeBytes = intArg('before-bytes', 16);
  const clusterDistance = intArg('cluster-distance', 512);

  const { data, hist } = readProfile(profileFile);
  const pe = readPe(exeFile);
  console.log(`profile=${profileFile}`);
  console.log(`exe=${exeFile}`);
  console.log(`elapsedMs=${data.profile && data.profile.elapsedMs} totalHandlers=${hist.totalHandlers} totalPairs=${hist.totalPairs}`);
  if (hist.hotBlocks) {
    console.log(`hotBlocks total=${hist.hotBlocks.totalBlocks} occupied=${hist.hotBlocks.occupied}/${hist.hotBlocks.count} collisions=${hist.hotBlocks.collisions}`);
    console.log(`hotBlocks imageBase=${hist.hotBlocks.imageBaseHex} code=${hist.hotBlocks.codeStartHex}-${hist.hotBlocks.codeEndHex}`);
  }

  printRows('Top handlers', hist.topHandlers, r =>
    `${String(r.count).padStart(9)} ${String(r.pct).padStart(7)}% ${String(r.id).padStart(3)} ${r.name}`, top);

  printRows('Top handler pairs', hist.topPairs, r =>
    `${String(r.count).padStart(9)} ${String(r.pct).padStart(7)}% ${String(r.prev).padStart(3)} -> ${String(r.cur).padStart(3)}  ${r.prevName} -> ${r.curName}`, top);

  const hotTop = hist.hotBlocks && hist.hotBlocks.top ? hist.hotBlocks.top : [];
  printRows('Hot block clusters', clusterHotBlocks(hotTop, clusterDistance), c =>
    `${String(c.count).padStart(9)} ${String(pct(c.count, hist.hotBlocks.totalBlocks)).padStart(7)}% ${hex32(c.start)}-${hex32(c.end)} blocks=${c.rows.length}`, top);

  printRows('Top SIB consumers', hist.sibConsumers && hist.sibConsumers.top, r =>
    `${String(r.count).padStart(9)} ${String(r.pct).padStart(7)}% consumer=${String(r.consumer).padStart(3)} op=${r.opHex.padStart(5)} ${r.label}`, top);

  const branch = hist.branchOperands || {};
  for (const key of ['cmpJcc', 'testJcc', 'aluM32RoJcc']) {
    printRows(`Top ${key}`, branch[key] && branch[key].top, r =>
      `${String(r.count).padStart(9)} ${String(r.pct).padStart(7)}% ${r.label}`, Math.min(top, 6));
  }

  if (hotTop.length && disasmLimit > 0) {
    console.log('');
    console.log('Disassembly');
    for (const row of hotTop.slice(0, disasmLimit)) printHotBlock(pe, row, insns, beforeBytes);
  }
}

main();
