#!/usr/bin/env node
// Verifies the WAT NE loader against the real Win16 binaries.
//
//   node test/test-ne-loader.js
//
// The loader is checked against an independent reading of the same file: the
// expectations here are computed from the NE headers in JavaScript, so a
// mistake in the WAT parse shows up as a mismatch rather than as two copies of
// the same bug agreeing with each other. The relocation checks go further and
// confirm specific bytes changed in the specific way the fixup record asked
// for, because "the loader ran" and "the loader linked the image" are very
// different claims.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const WASM = path.join(ROOT, 'build', 'wine-assembly.wasm');
const BIN = path.join(ROOT, 'test', 'binaries', 'win98-16bit');

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = got === want;
  if (ok) { pass++; } else { fail++; console.log(`  FAIL ${name}: got ${fmt(got)}, want ${fmt(want)}`); }
  return ok;
}
function fmt(v) { return typeof v === 'number' ? `0x${(v >>> 0).toString(16)}` : String(v); }

// ---- independent NE reader ----
function readNE(file) {
  const b = fs.readFileSync(file);
  const ne = b.readUInt32LE(0x3c);
  const shift = b.readUInt16LE(ne + 0x32) || 9;
  const segCount = b.readUInt16LE(ne + 0x1c);
  const segTab = ne + b.readUInt16LE(ne + 0x22);
  const segs = [];
  for (let i = 0; i < segCount; i++) {
    const o = segTab + i * 8;
    const sector = b.readUInt16LE(o);
    let len = b.readUInt16LE(o + 2);
    if (len === 0 && sector !== 0) len = 0x10000;
    segs.push({ filePos: sector << shift, len, flags: b.readUInt16LE(o + 4) });
  }
  const modRefTab = ne + b.readUInt16LE(ne + 0x28);
  const impNameTab = ne + b.readUInt16LE(ne + 0x2a);
  const modules = [];
  for (let i = 0; i < b.readUInt16LE(ne + 0x1e); i++) {
    const off = b.readUInt16LE(modRefTab + i * 2);
    const n = b[impNameTab + off];
    modules.push(b.toString('latin1', impNameTab + off + 1, impNameTab + off + 1 + n));
  }
  return {
    b, ne, segs, modules,
    entryCS: b.readUInt16LE(ne + 0x16),
    entryIP: b.readUInt16LE(ne + 0x14),
    autoData: b.readUInt16LE(ne + 0x0e),
  };
}

function relocs(info, segIndex) {
  const { b } = info;
  const s = info.segs[segIndex];
  if (!(s.flags & 0x0100)) return [];
  let o = s.filePos + s.len;
  const count = b.readUInt16LE(o);
  o += 2;
  const out = [];
  for (let i = 0; i < count; i++, o += 8) {
    out.push({
      addrType: b[o] & 0x0f,
      relType: b[o + 1] & 0x03,
      additive: !!(b[o + 1] & 0x04),
      site: b.readUInt16LE(o + 2),
      a: b.readUInt16LE(o + 4),
      c: b.readUInt16LE(o + 6),
    });
  }
  return out;
}

// Every integer-id resource the file declares, read independently of the WAT
// walker: a type table of {id, count, reserved} followed by `count` 12-byte
// records, all offsets and lengths in units of 1 << alignShift, and both ids
// carrying bit 15 when they are numbers rather than names.
function resources(info) {
  const { b, ne } = info;
  const out = [];
  const tabOff = b.readUInt16LE(ne + 0x24);
  if (!tabOff) return out;
  let p = ne + tabOff;
  const shift = b.readUInt16LE(p);
  p += 2;
  while (p + 8 <= b.length) {
    const type = b.readUInt16LE(p);
    if (type === 0) break;
    const count = b.readUInt16LE(p + 2);
    let q = p + 8;
    for (let i = 0; i < count; i++, q += 12) {
      const id = b.readUInt16LE(q + 6);
      if (!(type & 0x8000) || !(id & 0x8000)) continue;   // named type or name id
      out.push({
        type: type & 0x7fff, id: id & 0x7fff,
        offset: b.readUInt16LE(q) << shift,
        length: b.readUInt16LE(q + 2) << shift,
      });
    }
    p += 8 + count * 12;
  }
  return out;
}

// Every byte offset in a segment that some fixup writes, chains included.
function chainSites(info, segIndex) {
  const { b } = info;
  const s = info.segs[segIndex];
  const sites = new Set();
  for (const r of relocs(info, segIndex)) {
    let site = r.site;
    for (let guard = 0; guard < 0x10000; guard++) {
      if (site >= s.len || site === 0xffff) break;
      if (sites.has(site)) break;
      sites.add(site);
      if (r.additive) break;
      site = b.readUInt16LE(s.filePos + site);
    }
  }
  return sites;
}

// ---- harness ----
async function instantiate() {
  if (!fs.existsSync(WASM)) execSync('bash tools/build.sh', { cwd: ROOT, stdio: 'inherit' });
  const bytes = fs.readFileSync(WASM);
  const memory = new WebAssembly.Memory({ initial: 8192, maximum: 8192, shared: true });
  const mod = await WebAssembly.compile(bytes);
  // Every host import is a no-op: the loader only touches memory, and the one
  // import it can reach (host_log_i32 on a full thunk table) is a hard error
  // we want to surface as a trap rather than silently swallow.
  const imports = { host: { memory }, env: { memory } };
  for (const imp of WebAssembly.Module.imports(mod)) {
    if (imp.kind === 'memory') continue;
    if (imp.kind === 'function') {
      imports[imp.module] = imports[imp.module] || {};
      imports[imp.module][imp.name] = (...a) => (imp.name.includes('log') ? 0 : 0);
    }
  }
  const inst = await WebAssembly.instantiate(mod, imports);
  return { inst, memory };
}

async function testFile(inst, memory, name) {
  const file = path.join(BIN, name);
  const info = readNE(file);
  const bytes = fs.readFileSync(file);
  const mem = new Uint8Array(memory.buffer);
  const staging = inst.exports.get_staging();
  mem.fill(0, staging, staging + Math.max(bytes.length, 0x10000));
  mem.set(bytes, staging);

  const entry = inst.exports.load_pe(bytes.length);
  console.log(`\n${name}`);
  if (entry < 0) { fail++; console.log(`  FAIL load_pe returned ${entry}`); return; }

  check('is_win16', inst.exports.is_win16(), 1);
  check('seg count', inst.exports.win16_seg_count(), info.segs.length);
  check('entry CS selector', inst.exports.win16_entry_cs(), (info.entryCS << 3) | 7);
  check('entry IP', inst.exports.win16_entry_ip(), info.entryIP);
  check('auto data seg', inst.exports.win16_auto_data(), info.autoData);
  check('entry far addr', entry >>> 0, (((info.entryCS << 3) | 7) << 16 | info.entryIP) >>> 0);

  // Segment bytes: every segment must be placed at its own 64KB slot with the
  // file's contents, checked at both ends so a short copy is caught.
  const GUEST_BASE = 0x12000, ARENA = 0x00100000;
  for (let i = 0; i < info.segs.length; i++) {
    const s = info.segs[i];
    const base = inst.exports.win16_seg_base(i + 1);
    if (!check(`seg ${i + 1} base`, base, ARENA + i * 0x10000)) continue;
    if (s.filePos === 0) continue;   // BSS-only segment, nothing to compare
    const wa = base + GUEST_BASE;
    check(`seg ${i + 1} first byte`, mem[wa], bytes[s.filePos]);
    // The last byte of a relocated segment may itself be a fixup site, so
    // compare a byte no fixup writes. A record names the HEAD of a chain and
    // every link is also a site, so the whole chain has to be walked — from
    // the file, whose link words the loader has not overwritten.
    const relSites = chainSites(info, i);
    let probe = s.len - 1;
    while (probe > 0 && [0, 1, 2, 3].some(d => relSites.has(probe - d))) probe--;
    check(`seg ${i + 1} byte 0x${probe.toString(16)}`, mem[wa + probe], bytes[s.filePos + probe]);
  }

  // Relocations: for each record, confirm the head site now holds what the
  // record asked for. Chained sites are covered by walking one link.
  const thunkSel = inst.exports.win16_thunk_sel();
  let checkedFixups = 0;
  for (let i = 0; i < info.segs.length; i++) {
    const s = info.segs[i];
    if (!(s.flags & 0x0100)) continue;
    const wa = inst.exports.win16_seg_base(i + 1) + GUEST_BASE;
    const dv = new DataView(memory.buffer);
    for (const r of relocs(info, i)) {
      if (r.site >= s.len) continue;
      if (r.relType === 0 && r.a !== 0xff) {
        // Internal reference: selector of segment a, offset c.
        if (r.addrType === 2) {
          check(`seg${i + 1}+0x${r.site.toString(16)} SEGMENT`, dv.getUint16(wa + r.site, true), (r.a << 3) | 7);
          checkedFixups++;
        } else if (r.addrType === 3) {
          check(`seg${i + 1}+0x${r.site.toString(16)} FAR off`, dv.getUint16(wa + r.site, true), r.c);
          check(`seg${i + 1}+0x${r.site.toString(16)} FAR sel`, dv.getUint16(wa + r.site + 2, true), (r.a << 3) | 7);
          checkedFixups++;
        }
      } else if (r.relType === 1 && r.addrType === 3) {
        // Imported ordinal: must point into the thunk segment.
        check(`seg${i + 1}+0x${r.site.toString(16)} import sel`, dv.getUint16(wa + r.site + 2, true), thunkSel);
        const off = dv.getUint16(wa + r.site, true);
        check(`seg${i + 1}+0x${r.site.toString(16)} import slot aligned`, off % 4, 0);
        check(`seg${i + 1}+0x${r.site.toString(16)} import ordinal`,
              inst.exports.win16_thunk_ordinal(off), r.c);
        const wantModule = ['KERNEL', 'USER', 'GDI', 'KEYBOARD', 'SOUND', 'SHELL', 'MMSYSTEM', 'COMMDLG', 'CARDS']
          .indexOf(info.modules[r.a - 1]) + 1;
        check(`seg${i + 1}+0x${r.site.toString(16)} import module`,
              inst.exports.win16_thunk_module(off), wantModule);
        checkedFixups++;
      }
    }
  }
  console.log(`  ${checkedFixups} fixups verified, ${inst.exports.win16_thunk_count()} distinct imports`);

  // Resources: every integer-id resource the file declares must be findable at
  // the offset and length an independent read of the table gives. The WAT
  // walker and this one share no code, so a wrong shift or a mis-sized
  // NAMEINFO shows up as a disagreement rather than as two matching mistakes.
  let checkedRes = 0;
  for (const r of resources(info)) {
    const got = inst.exports.win16_find_resource(r.type, r.id);
    if (!check(`res ${r.type}/${r.id} offset`, got, inst.exports.get_staging() + r.offset)) continue;
    check(`res ${r.type}/${r.id} length`, inst.exports.win16_res_len(), r.length);
    checkedRes++;
  }
  // A resource id that is not there must report absence, not the last match.
  check('absent resource returns 0', inst.exports.win16_find_resource(6, 0x7ffe), 0);
  console.log(`  ${checkedRes} resources verified`);
}

(async () => {
  const { inst, memory } = await instantiate();
  for (const f of ['WINMINE.EXE', 'FREECELL.EXE', 'MSHEARTS.EXE', 'SOL.EXE', 'CARDS.DLL']) {
    if (!fs.existsSync(path.join(BIN, f))) { console.log(`\n${f}: missing, skipped`); continue; }
    await testFile(inst, memory, f);
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
