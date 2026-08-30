#!/usr/bin/env node

'use strict';

// Pack a few demos into a <script> the report page can load.
//
//   node tools/toyvm/bundle-programs.js --dir=/tmp/demos --json=/tmp/shots.json
//
// The page runs off the filesystem, where `fetch` is refused, so a program's
// bytes have to arrive as JavaScript or not at all. Each demo becomes one entry
// of base64 per file in its directory -- the whole directory, because a DOS
// program's data sits next to it and that directory is the entire filesystem it
// gets.
//
// Which demos: the pickable ones are chosen by what the sweep measured, not by
// hand. Most pixels first, smallest directory as the tiebreak, one per
// directory so the slots are that many different demos rather than four
// productions with their menu programs. `--ids=` overrides the whole thing when
// the question is "does THIS one run in a page".
//
// Each demo is written to its own live/programs/<slug>.js. The page loads only
// the one whose Run button was pressed, so how many demos ship is a question
// about repo size and nothing else -- the visitor pays for one.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

function arg(name, fallback) {
  const hit = process.argv.slice(2).find(a => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

// Total bytes of a directory's regular files, and the files themselves.
function dirFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isFile()) continue;
    const full = path.join(dir, e.name);
    out.push({ name: e.name, size: fs.statSync(full).size, full });
  }
  return out;
}

function main() {
  const json = arg('json');
  const out = arg('out', path.join('docs', 'dos-corpus', 'live'));
  // 96 is above the number of one-per-directory candidates the corpus has, so
  // the real limit is --max-kb: every demo that drew pixels and whose whole
  // directory fits gets a Run button. Only the pressed demo is ever downloaded,
  // so the count costs the visitor nothing -- it costs repo bytes, and --max-kb
  // is where that is priced. Measured on the v17 sweep: 96KB gives 76 demos for
  // 3.7MB, 192KB gives 84 for 5.1MB, 400KB gives 96 for 9.5MB.
  const want = Number(arg('count', 96));
  const maxKb = Number(arg('max-kb', 192));
  const ids = arg('ids', '').split(',').map(s => s.trim()).filter(Boolean);
  if (!json) {
    console.error('usage: bundle-programs.js --json=SWEEP.json [--count=12] '
      + '[--max-kb=96] [--ids=NAME,NAME] [--out=DIR]');
    process.exit(2);
  }

  const sweep = JSON.parse(fs.readFileSync(json, 'utf8'));
  const rows = sweep.rows.filter(r => r.exe && fs.existsSync(r.exe));

  // One candidate per directory, and only demos that actually drew something --
  // a Run button on a blank screen is a bug report, not a demo.
  const byDir = new Map();
  for (const r of rows) {
    if (!ids.length && !((r.pixels || 0) > 0)) continue;
    const dir = path.dirname(r.exe);
    const files = dirFiles(dir);
    const bytes = files.reduce((n, f) => n + f.size, 0);
    const cand = { row: r, dir, files, bytes };
    const prev = byDir.get(dir);
    if (!prev || (r.pixels || 0) > (prev.row.pixels || 0)) byDir.set(dir, cand);
  }

  let picked;
  if (ids.length) {
    picked = ids.map((id) => {
      const hit = [...byDir.values()].find(c => c.row.name.toLowerCase() === id.toLowerCase());
      if (!hit) throw new Error(`no swept program named ${id}`);
      return hit;
    });
  } else {
    // One per NAME as well as one per directory. The page addresses a demo by
    // its executable's name and nothing else -- that is what the tile's
    // data-live holds -- so two directories that both ship an ASYLUM.EXE
    // collapse to one entry, and the tile for the loser silently runs the
    // winner's bytes. Sorted first, so the survivor is the one with more
    // pixels rather than whichever the directory walk reached last.
    const seen = new Set();
    picked = [...byDir.values()]
      .filter(c => c.bytes <= maxKb * 1024)
      .sort((a, b) => (b.row.pixels || 0) - (a.row.pixels || 0) || a.bytes - b.bytes)
      .filter((c) => {
        const key = c.row.name.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, want);
  }

  const programs = {};
  let total = 0;
  for (const c of picked) {
    const files = {};
    for (const f of c.files) {
      files[f.name.toLowerCase()] = fs.readFileSync(f.full).toString('base64');
      total += f.size;
    }
    programs[c.row.name] = {
      exe: c.row.name.toLowerCase(),
      dir: path.basename(c.dir),
      pixels: c.row.pixels || 0,
      mode: c.row.mode || 0,
      width: c.row.width || 320,
      height: c.row.height || 200,
      files,
    };
  }

  // ONE FILE PER PROGRAM, not one file for all of them. The page cannot fetch
  // from a file:// URL, so a program's bytes arrive as a <script> tag either
  // way -- but a single bundle means pressing Run on any one demo downloads
  // every demo, which is what capped this at twelve. Per-program scripts make
  // the cost proportional to what somebody actually presses, so the number of
  // runnable tiles can be most of the corpus instead of a token few.
  fs.mkdirSync(path.join(ROOT, out, 'programs'), { recursive: true });
  for (const f of fs.readdirSync(path.join(ROOT, out, 'programs'))) {
    if (f.endsWith('.js')) fs.unlinkSync(path.join(ROOT, out, 'programs', f));
  }
  const index = {};
  let jsBytes = 0;
  const exeOf = new Map(picked.map(c => [c.row.name, c.row.exe]));
  for (const [name, program] of Object.entries(programs)) {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    // A function replacement, not a string one: base64 has no `$` in it, but
    // the habit is what keeps the next payload that does from corrupting the
    // file.
    const js = '// GENERATED by tools/toyvm/bundle-programs.js -- do not edit.\n'
      + `// ${name}, as bytes, for the report page to run.\n`
      + '(self.ToyVMPrograms = self.ToyVMPrograms || {})[__N__] = __P__;\n'
        .replace('__N__', () => JSON.stringify(name))
        .replace('__P__', () => JSON.stringify(program));
    fs.writeFileSync(path.join(ROOT, out, 'programs', `${slug}.js`), js);
    index[exeOf.get(name)] = `programs/${slug}.js`;
    jsBytes += js.length;
  }
  // Keyed by the sweep's path to the executable, not by its name: the corpus
  // has two directories shipping an ASYLUM.EXE, and a name-keyed index marks
  // both tiles runnable while only one of them has bytes here. The path is what
  // distinguishes the two rows the report is drawing.
  //
  // The report generator has to know which tiles get a Run button before the
  // page is opened, and the page has to know which single script to load when
  // one is pressed.
  fs.writeFileSync(path.join(ROOT, out, 'programs-index.json'),
    `${JSON.stringify(index, null, 2)}\n`);
  // The old single bundle, if one is still lying about, is now dead weight that
  // the page no longer loads.
  const stale = path.join(ROOT, out, 'programs.js');
  if (fs.existsSync(stale)) fs.unlinkSync(stale);
  console.log(`${path.relative(ROOT, path.join(ROOT, out, 'programs'))}/: ${picked.length} programs, `
    + `${(total / 1024).toFixed(0)}KB of guest files, ${(jsBytes / 1024).toFixed(0)}KB of JS `
    + `(largest single load ${(Math.max(...Object.values(programs)
      .map(p => Object.values(p.files).reduce((n, b) => n + b.length, 0))) / 1024).toFixed(0)}KB)`);
  for (const c of picked) {
    console.log(`  ${c.row.name.padEnd(16)} ${String(c.row.pixels || 0).padStart(7)} px  `
      + `${c.files.length} file(s)  ${(c.bytes / 1024).toFixed(0)}KB  ${path.basename(c.dir)}`);
  }
}

main();
