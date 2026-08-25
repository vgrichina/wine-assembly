#!/usr/bin/env node

'use strict';

// Fetch a corpus of small DOS demos/intros from the Hornet archive mirror.
//
//   node tools/toyvm/fetch-demos.js --out=/tmp/demos --max=40
//   node tools/toyvm/fetch-demos.js --out=/tmp/demos --dirs=1993/a,1994/b --max-kb=80
//
// The toy VM's benchmark needs real 16-bit code, and a demo is the ideal shape:
// one self-contained EXE that spends essentially all of its time in a tight
// inner loop over VGA memory. Small archives are preferred because a large one
// is usually a multi-file production with music modules and external data,
// which the toy DOS layer has no interest in modelling.
//
// This only downloads and unpacks. Whether a given binary actually runs is
// bench-dos.js's problem, and the ones that do not are the coverage work list.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = 'https://ftp.scene.org/pub/mirrors/hornet/demos';

function arg(name, fallback) {
  const hit = process.argv.slice(2).find(a => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

function get(url) {
  return execFileSync('curl', ['-sS', '-m', '60', '-L', url], { maxBuffer: 1 << 28 });
}

// The listing is lighttpd's, one row per file: a size cell then the anchor.
function listDir(url) {
  const html = get(url).toString('latin1');
  const out = [];
  const re = /<td class="s">([\d.]+)([KMG])<\/td>[\s\S]{0,200}?<a href="([^"]+\.zip)"/gi;
  const alt = /<a href="([^"]+\.zip)">[\s\S]{0,200}?<td class="s">([\d.]+)([KMG])/gi;
  let m;
  while ((m = re.exec(html))) out.push({ name: m[3], kb: toKb(m[1], m[2]) });
  if (!out.length) while ((m = alt.exec(html))) out.push({ name: m[1], kb: toKb(m[2], m[3]) });
  return out;
}
const toKb = (n, unit) => Number(n) * ({ K: 1, M: 1024, G: 1024 * 1024 })[unit.toUpperCase()];

function main() {
  const out = arg('out');
  if (!out) { console.log('usage: node tools/toyvm/fetch-demos.js --out=DIR [--dirs=] [--max=] [--max-kb=]'); process.exit(2); }
  const dirs = arg('dirs', '1993/a,1993/b,1993/c,1994/a,1994/b,1995/a').split(',');
  const max = Number(arg('max', 30));
  const maxKb = Number(arg('max-kb', 60));
  const minKb = Number(arg('min-kb', 3));
  fs.mkdirSync(out, { recursive: true });

  let got = 0;
  for (const d of dirs) {
    if (got >= max) break;
    let entries;
    try { entries = listDir(`${ROOT}/${d}/`); }
    catch (e) { console.log(`${d}: listing failed -- ${e.message.split('\n')[0]}`); continue; }
    const picks = entries.filter(e => e.kb >= minKb && e.kb <= maxKb);
    console.log(`${d}: ${entries.length} archives, ${picks.length} within ${minKb}-${maxKb}K`);
    for (const p of picks) {
      if (got >= max) break;
      const stem = `${d.replace('/', '-')}-${p.name.replace(/\.zip$/i, '')}`;
      const dest = path.join(out, stem);
      if (fs.existsSync(dest)) { got++; continue; }
      try {
        const zip = path.join(out, `${stem}.zip`);
        fs.writeFileSync(zip, get(`${ROOT}/${d}/${p.name}`));
        fs.mkdirSync(dest, { recursive: true });
        // -j flattens, -o overwrites, -qq silent. A password-protected or
        // broken archive just leaves an empty directory, which the bench skips.
        execFileSync('unzip', ['-jqqo', zip, '-d', dest], { stdio: 'ignore' });
        fs.unlinkSync(zip);
        const exes = fs.readdirSync(dest).filter(f => /\.(exe|com)$/i.test(f));
        console.log(`  ${stem}  ${p.kb}K  -> ${exes.length} executable(s): ${exes.join(', ')}`);
        got++;
      } catch (e) {
        console.log(`  ${stem}  FAILED ${e.message.split('\n')[0]}`);
      }
    }
  }
  console.log(`\n${got} archive(s) in ${out}`);
}

main();
