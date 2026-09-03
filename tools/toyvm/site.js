#!/usr/bin/env node

'use strict';

// Build the toyvm mini-site into docs/dos-corpus from the sweep JSON.
//
//   node tools/toyvm/shot-sweep.js --dir=/tmp/demos --out=/tmp/shots --json=/tmp/shots.json
//   node tools/toyvm/bundle-browser.js --out=docs/dos-corpus/live
//   node tools/toyvm/bundle-programs.js --json=/tmp/shots.json
//   node tools/toyvm/site.js --json=/tmp/shots.json [--out=docs/dos-corpus]
//
// Five pages sharing one stylesheet and one script:
//
//   index.html       what the emulator is and how it works, with a few
//                    runnable tiles
//   demos.html       the whole corpus, one screenshot each, every tile runnable
//   benchmarks.html  the dispatch shells, the JIT tiers, the twenty-program
//                    table read out of docs/toyvm-bench-20.md at build time
//   notes.html       the findings, in the order they were made
//   docs.html        the design documents, linked
//
// The prose is NOT generated. docs/dos-corpus/prose/*.html are written by hand
// and spliced in; only the numbers, the tiles, the tables and the chrome come
// from here. Screenshots are copied in as files rather than inlined, so git
// stores one object per program and shows which pictures changed between two
// runs of the VM. `.gitignore` has a blanket `*.png`, so the output directory
// carries its own negation.
//
// Every tile is runnable: bundle-programs.js packs the corpus one script per
// production under live/programs/, and the tile carries the path to its own
// bytes, so pressing Run loads one production and nothing else.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const REPO = 'https://github.com/vgrichina/wine-assembly';

function arg(name, fallback) {
  const hit = process.argv.slice(2).find(a => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// A row drew something if either surface has content. Both are counted: a text
// demo that fills the console is not a lesser result than a mode 13h one, and
// treating a 0-pixel text screen as blank is exactly the mistake that made an
// earlier sweep report 159 identical black rectangles.
const drew = (r) => (r.pixels || 0) > 0 || (r.cells || 0) > 0;
const kind = (r) => (!drew(r) ? 'blank' : ((r.pixels || 0) > 0 ? 'vga' : 'text'));

// exe path -> { src, exe, args }, written by bundle-programs.js. Absent is
// fine: the pages are then exactly what they were before -- screenshots.
function liveIndex(out) {
  const f = path.join(out, 'live', 'programs-index.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (Array.isArray(parsed)) return new Map();
    return new Map(Object.entries(parsed)
      .map(([k, v]) => [k, typeof v === 'string' ? { src: v, exe: path.basename(k).toLowerCase(), args: '' } : v]));
  } catch {
    return new Map();
  }
}

const slugOf = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// What to call this release when asking pouet about it. The corpus keeps one
// directory per production, named `YYYY-x-slug` by the fetcher, and the slug
// is the release -- the EXE inside is often an abbreviation of it or just
// INTRO.EXE, which finds nothing. A search rather than a permalink because
// nothing here carries a pouet id, and a link that guessed one would point at
// the wrong production rather than at no production.
function prodOf(r) {
  const dir = path.basename(path.dirname(r.exe || ''));
  const m = /^(\d{4})-[a-z0-9]+-(.*)$/.exec(dir);
  return {
    year: m ? m[1] : '',
    prod: (m ? m[2] : dir).replace(/[_-]+/g, ' ').trim(),
  };
}

// The sound census of a row, as the page states it. Three answers: the run
// made a sound (`sound`, with the chips it came through), the program asked
// for a card and nothing came out (`quiet` -- the work list, the way a blank
// tile is), or it never touched one (`silent`). A row taken on the machine
// without a card is silent by construction and is filed as `quiet` when the
// program had probed for one, since that is what the no-card retry means.
function soundOf(r) {
  const a = r.audio;
  const chips = a && a.sources && a.sources.length ? a.sources.join('+') : '';
  if (a && a.peak > 0.01) {
    return {
      state: 'sound', chips,
      line: `sound: ${chips || 'yes'}, peak ${a.peak.toFixed(2)}`
        + (a.first !== null && a.first !== undefined ? ` from ${a.first}s` : ''),
    };
  }
  if (r.soundProbed || r.sound === 'none' || chips) {
    return {
      state: 'quiet', chips,
      line: r.sound === 'none' ? 'quiet: photographed without a sound card'
        : `quiet: asked for a card${chips ? ` (${chips})` : ''}, nothing came out`,
    };
  }
  return { state: 'silent', chips: '', line: a ? 'silent: never touched a sound card' : '' };
}

function tile(r, file, live) {
  const what = (r.pixels || 0) > 0 ? `<b>${r.pixels.toLocaleString()}</b> px`
    : ((r.cells || 0) > 0 ? `<b>${r.cells}</b> cells` : 'blank');
  const k = kind(r);
  // The screen text is what a text tile's caption actually wants: at tile size
  // the glyphs are unreadable, and the first line is usually the whole finding
  // ("HIMEM.SYS NEEDED !!!").
  const first = (r.screen || '').split('\n').map((s) => s.trim()).filter(Boolean)[0] || '';
  const alt = k === 'text'
    ? `${r.name}: DOS text screen${first ? `, reading "${first.slice(0, 90)}"` : ''}`
    : `${r.name}: mode ${(r.mode || 0).toString(16)}h graphics frame`;
  const geom = k === 'text' ? '80x25 text'
    : `mode ${(r.mode || 0).toString(16)}h - ${r.width}x${r.height}`
      + `${r.planar ? ` planar ${r.bpp}bpp` : ''}`;
  const { year, prod } = prodOf(r);
  const l = live && live.get(r.exe);
  const snd = soundOf(r);
  // One id per ROW, directory and name: two directories ship an ASYLUM.EXE
  // and the name alone cannot pick one. It is the tile's #fragment -- the
  // caption links to it, opening the tile writes it to the URL, and loading
  // the page with it opens the tile -- and the live id is the same string.
  const id = slugOf(path.basename(path.dirname(r.exe)) + '-' + r.name);
  return `<figure id="${esc(id)}" class="${k}" data-kind="${k}" data-what="${esc(what.replace(/<\/?b>/g, ''))}"`
    + ` data-geom="${esc(geom)}"`
    + (prod ? ` data-prod="${esc(prod)}"` : '')
    + (year ? ` data-year="${year}"` : '')
    // The sound census: whether the rendered run made a sound, and through
    // which chip, so the filter bar can ask for the ones that did.
    + ` data-sound="${snd.state}"`
    + (snd.line ? ` data-sound-line="${esc(snd.line)}"` : '')
    // The tile carries the path to its own bytes, so pressing Run loads one
    // production instead of all of them -- there is no page-wide manifest to
    // keep in step with the tiles. The id is unique per ROW: two directories
    // ship an ASYLUM.EXE and the name alone cannot pick one.
    + (l ? ` data-live="${esc(r.name)}" data-live-id="${esc(id)}"`
      + ` data-live-src="live/${esc(l.src)}" data-live-exe="${esc(l.exe)}"`
      + (l.args ? ` data-live-args="${esc(l.args)}"` : '')
      + (l.env ? ` data-live-env="${esc(l.env)}"` : '')
      + (l.sound ? ` data-live-sound="${esc(l.sound)}"` : '') : '')
    + (r.screen ? ` data-screen="${esc(r.screen)}"` : '')
    + (r.stuckAt ? ` data-stuck="${esc(r.stuckAt)}"` : '')
    + `><button class="open" type="button" title="${esc(r.name)} - full size">`
    + `<img loading="lazy" src="shots/${esc(file)}" alt="${esc(alt)}"></button>`
    + (k === 'text' ? '<span class="mx">text</span>' : '')
    + (l ? '<span class="runnable">&#9654; run</span>' : '')
    + (snd.state === 'sound' ? `<span class="snd" title="${esc(snd.line)}">&#9835; ${esc(snd.chips)}</span>` : '')
    + `<figcaption><a class="fn" href="#${esc(id)}" title="${esc(r.name)} - link to this demo">${esc(r.name)}</a>`
    + `<span class="fp">${what}</span></figcaption></figure>`;
}

// --- the twenty-program table, read out of the benchmark document -----------
// Section 6 of docs/toyvm-bench-20.md is a fenced, space-aligned table; the
// page shows it as HTML so it can be read on a phone. Parsed at build time so
// the site cannot quote a number the document no longer has.
function benchTable(md) {
  if (!md) return '';
  const lines = md.split('\n');
  const at = lines.findIndex((l) => /^## 6\./.test(l));
  if (at < 0) return '';
  const open = lines.findIndex((l, i) => i > at && l.startsWith('```'));
  const close = lines.findIndex((l, i) => i > open && l.startsWith('```'));
  if (open < 0 || close < 0) return '';
  const rows = lines.slice(open + 1, close).map((l) => l.trim()).filter(Boolean)
    .map((l) => l.split(/\s+/));
  const head = rows.shift();
  const cell = (v, i) => `<td class="${i === 0 || i === head.length - 1 ? 'l' : ''}">${esc(v)}</td>`;
  return `<div class="scroll"><table>
    <thead><tr>${head.map((h, i) => `<th class="${i === 0 || i === head.length - 1 ? 'l' : ''}">${esc(h)}</th>`).join('')}</tr></thead>
    <tbody>
${rows.map((r) => `      <tr>${r.map(cell).join('')}</tr>`).join('\n')}
    </tbody>
  </table></div>`;
}

// --- the design documents -----------------------------------------------------
// Title from the file's first heading; the one-line gloss is written here,
// because a document's own first paragraph is rarely its summary.
const DOC_GLOSS = {
  'toyvm-dispatch-shootout.md': 'four dispatch shells on real 16-bit programs; why replicated tail calls win and the giant switch does not',
  'toyvm-superinstructions.md': 'fusing instruction pairs in threaded code, and what the census said was worth fusing',
  'toyvm-lazy-flags.md': 'computing flags on demand instead of after every ALU op, measured',
  'toyvm-dead-flags.md': 'the flag writes nothing reads, found at decode time',
  'toyvm-decoder-in-wasm.md': 'moving the x86 decoder from JS into the module',
  'toyvm-reg-specialization.md': 'pinning the register a handler reaches for instead of a jump table into the register file',
  'toyvm-spin-loops.md': 'the wait loops that were most of the dispatches, and turning them inside one handler',
  'toyvm-stream-loops.md': 'REP MOVS/STOS as memory.copy, and which other loops are worth folding',
  'toyvm-trace-blocks.md': 'compiling through a conditional branch',
  'toyvm-trace-jit.md': 'pricing a trace JIT before building one: the tiers and what each removes',
  'toyvm-bench-20.md': 'every optimization on the same twenty programs, one evening, one scale',
};
const DOC_ORDER = Object.keys(DOC_GLOSS);

function docList() {
  const items = [];
  for (const f of DOC_ORDER) {
    const full = path.join(ROOT, 'docs', f);
    if (!fs.existsSync(full)) continue;
    const first = fs.readFileSync(full, 'utf8').split('\n').find((l) => l.startsWith('# ')) || f;
    items.push(`<li><a href="${REPO}/blob/main/docs/${f}">${esc(first.replace(/^# /, ''))}</a>`
      + `<span class="gloss">${esc(DOC_GLOSS[f])}</span><span class="m">docs/${f}</span></li>`);
  }
  return items.join('\n');
}

// --- the page shell -------------------------------------------------------------
const NAV = [
  ['index.html', 'About'], ['demos.html', 'Demos'], ['benchmarks.html', 'Benchmarks'],
  ['notes.html', 'Notes'], ['docs.html', 'Docs'],
];

function page({ file, title, eyebrow, h1, lede, body, stats = '', footer }) {
  const nav = NAV.map(([href, label]) => `<a href="${href}"${href === file ? ' aria-current="page"' : ''}>${label}</a>`).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<link rel="stylesheet" href="site.css">
</head>
<body>
<div class="wrap">

<nav class="top"><a class="brand" href="index.html">toyvm</a><span class="links">${nav}</span>
  <a class="ext" href="${REPO}/tree/main/tools/toyvm">source &#8599;</a></nav>

<header>
  <p class="eyebrow">${eyebrow}</p>
  <h1>${h1}</h1>
  <p class="lede">${lede}</p>
${stats}
</header>

${body}

<footer>${footer}</footer>

</div>

<dialog id="lb">
  <div class="dlg-box" id="lb-box">
  <div class="dlg-bar"><a id="lb-name" href="#" title="link to this demo"></a>
    <a class="r pouet" id="lb-pouet" target="_blank" rel="noopener noreferrer" hidden>pouet &#8599;</a>
    <span class="r" id="lb-meta"></span>
    <span class="r ctl" id="lb-ctl">
      <label title="how fast the emulated machine is; changing it restarts the demo">cpu
        <select id="lb-cpu">
          <option value="5">386 &middot; 5 MIPS</option>
          <option value="10" selected>486 &middot; 10 MIPS</option>
          <option value="25">Pentium &middot; 25 MIPS</option>
          <option value="0">unpaced &middot; flat out</option>
        </select></label>
      <button type="button" id="lb-sound" class="tog" aria-pressed="true"
        title="sound on/off">sound</button>
      <button type="button" id="lb-auto" class="tog" aria-pressed="true"
        title="answer the demo's setup menus automatically (Sound Blaster, then AdLib, else silent); off, they wait for your keyboard">auto menus</button>
      <button type="button" id="lb-fs" class="tog" title="full screen (Esc leaves)">&#x26F6; full</button>
      <button type="button" id="lb-close" class="tog" title="close">&#x2715;</button>
    </span></div>
  <div class="dlg-stage">
    <img id="lb-img" alt="">
    <canvas id="lb-canvas" width="320" height="200" hidden tabindex="0"
      aria-label="live emulator output"></canvas>
    <button type="button" id="lb-play" hidden
      title="run this demo here"><span class="tri"></span>Run it</button>
    <p class="run-note" id="lb-status" hidden></p>
  </div>
  <pre class="dlg-screen" id="lb-screen" hidden></pre>
  </div>
</dialog>

<script src="site.js"></script>
</body>
</html>
`;
}

const CSS = `/* One visual world: a CRT in a dark room. No web fonts -- these pages are
   opened off the filesystem as often as off a server, and a font that only
   arrives over the network is a font that is usually missing. */
:root {
  --ground: #08070d; --panel: #12111c; --panel-2: #191826; --rule: #282539;
  --ink: #dcd9e8; --dim: #8b87a3; --faint: #5d5a71;
  --accent: #ff3fc5; --cyan: #3fe0d0; --amber: #f0a63c;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  --sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 0 20px 90px; background: var(--ground); color: var(--ink);
  font: 15px/1.6 var(--sans); -webkit-font-smoothing: antialiased;
}
.wrap { max-width: 1180px; margin: 0 auto; }
a { color: var(--cyan); }
nav.top {
  display: flex; align-items: center; gap: 18px; padding: 16px 0; border-bottom: 1px solid var(--rule);
  font-family: var(--mono); font-size: 12px; letter-spacing: .06em; text-transform: uppercase;
}
nav.top .brand { color: var(--accent); text-decoration: none; font-weight: 700; font-size: 14px; letter-spacing: .12em; }
nav.top .links { display: flex; gap: 4px; flex-wrap: wrap; }
nav.top .links a { color: var(--dim); text-decoration: none; padding: 5px 10px; border: 1px solid transparent; }
nav.top .links a:hover, nav.top .links a:focus-visible { color: var(--ink); border-color: var(--rule); }
nav.top .links a[aria-current="page"] { color: var(--cyan); border-color: var(--cyan); }
nav.top .ext { margin-left: auto; color: var(--faint); text-decoration: none; }
nav.top .ext:hover { color: var(--ink); }
header { padding: 46px 0 28px; border-bottom: 1px solid var(--rule); }
.eyebrow {
  font-family: var(--mono); font-size: 11px; letter-spacing: .14em;
  color: var(--accent); text-transform: uppercase; margin: 0 0 16px;
}
h1 { font-size: clamp(26px, 5vw, 40px); line-height: 1.15; margin: 0 0 18px; text-wrap: balance; }
h1 .b { color: var(--cyan); }
.lede { max-width: 66ch; color: var(--dim); font-size: 16.5px; margin: 0; }
.lede strong { color: var(--ink); font-weight: 600; }
h2 {
  font-family: var(--mono); font-size: 15px; letter-spacing: .05em;
  color: var(--cyan); text-transform: uppercase; margin: 0 0 6px;
}
h3 { font-size: 17px; margin: 26px 0 8px; }
section { padding: 44px 0 0; }
.sub { color: var(--faint); font-size: 13px; margin: 0 0 20px; font-family: var(--mono); }
p { max-width: 68ch; }
p.note { color: var(--dim); }
.m { font-family: var(--mono); font-size: .92em; color: var(--amber); }
.stats {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
  gap: 14px; margin: 32px 0 0;
}
.stat { background: var(--panel); border: 1px solid var(--rule); border-left: 3px solid var(--accent); padding: 18px 20px; }
.stat:nth-child(2) { border-left-color: var(--cyan); }
.stat:nth-child(3) { border-left-color: var(--amber); }
.stat:nth-child(4) { border-left-color: var(--faint); }
.stat .k { font-family: var(--mono); font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--faint); margin: 0 0 8px; }
.stat .v { font-family: var(--mono); font-weight: 600; font-size: 30px; line-height: 1; font-variant-numeric: tabular-nums; }
.stat .d { font-size: 13px; color: var(--dim); margin-top: 8px; line-height: 1.45; }
.scroll { overflow-x: auto; margin: 20px 0 0; border: 1px solid var(--rule); background: var(--panel); }
pre.fig {
  margin: 0; padding: 16px 18px; font-family: var(--mono); font-size: 12px;
  line-height: 1.55; color: var(--dim); white-space: pre; tab-size: 2;
}
pre.fig b { color: var(--cyan); font-weight: 600; }
pre.fig i { color: var(--amber); font-style: normal; }
pre.fig u { color: var(--accent); text-decoration: none; }
pre.fig s { color: var(--faint); text-decoration: none; }
.figcap { font-family: var(--mono); font-size: 11px; color: var(--faint); margin: 7px 0 0; letter-spacing: .04em; }
table { border-collapse: collapse; width: 100%; font-family: var(--mono); font-size: 13px; }
th, td { padding: 8px 12px; text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; border-bottom: 1px solid var(--rule); }
th { color: var(--faint); font-weight: 500; text-transform: uppercase; font-size: 11px; letter-spacing: .07em; }
td.l, th.l { text-align: left; }
tbody tr:last-child td { border-bottom: 0; }
/* The gallery toolbar: a filter is a claim about the corpus ("show me what
   drew nothing"), so the count beside it updates with the selection. */
.bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 22px 0 0; font-family: var(--mono); font-size: 12px; }
.bar button {
  font: inherit; letter-spacing: .06em; text-transform: uppercase; color: var(--dim);
  background: var(--panel); border: 1px solid var(--rule); padding: 6px 12px; cursor: pointer;
}
.bar button[aria-pressed="true"] { color: var(--cyan); border-color: var(--cyan); }
.bar input {
  font: inherit; color: var(--ink); background: var(--panel); border: 1px solid var(--rule);
  padding: 6px 10px; min-width: 200px;
}
.bar input:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.bar .count { color: var(--faint); margin-left: auto; }
.shots { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 14px; margin: 24px 0 0; }
figure { margin: 0; background: var(--panel); border: 1px solid var(--rule); padding: 8px; position: relative; }
figure.blank { opacity: .5; }
figure[hidden] { display: none; }
figure .mx {
  position: absolute; top: 12px; right: 12px; font-family: var(--mono); font-size: 9px;
  letter-spacing: .08em; text-transform: uppercase; border: 1px solid var(--cyan);
  color: var(--cyan); padding: 1px 4px; background: rgba(8,7,13,.75);
}
/* A tile that made a sound says so, and through which chip: the note is the
   sound census of the run the screenshot came from, not a promise about the
   Run button. */
figure .snd {
  position: absolute; bottom: 34px; right: 12px; font-family: var(--mono); font-size: 9px;
  letter-spacing: .08em; text-transform: uppercase; border: 1px solid var(--accent);
  color: var(--accent); padding: 1px 4px; background: rgba(8,7,13,.75);
}
.bar .sep { width: 1px; height: 18px; background: var(--rule); margin: 0 4px; }
/* A runnable tile has to say so on the tile. The Run button lives inside the
   lightbox, so without this the only way to find out which screenshots will
   actually start is to open them one at a time. */
figure .runnable {
  position: absolute; bottom: 34px; left: 12px; font-family: var(--mono); font-size: 9px;
  letter-spacing: .08em; text-transform: uppercase; border: 1px solid var(--accent);
  color: var(--accent); padding: 1px 5px; background: rgba(8,7,13,.8); pointer-events: none;
}
figure:hover .runnable, figure:focus-within .runnable { background: var(--accent); color: var(--ground); }
button.open { display: block; width: 100%; padding: 0; border: 0; background: #000; cursor: zoom-in; }
button.open:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
/* Every mode in this corpus was shown on a 4:3 monitor: 320x200, 640x200,
   640x350 and the 80x25 text page all fill the same glass with non-square
   pixels. Shown at the raw pixel grid a mode 13h demo is 16:10 and everything
   in it is squashed, so the picture is stretched to 4:3 the way the CRT did. */
figure img { display: block; width: 100%; aspect-ratio: 4 / 3; image-rendering: pixelated; }
figcaption { display: flex; justify-content: space-between; gap: 8px; align-items: baseline; margin-top: 7px; font-family: var(--mono); font-size: 11px; }
.fn { color: var(--dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-decoration: none; }
a.fn:hover, a.fn:focus-visible { color: var(--cyan); text-decoration: underline; }
#lb-name { color: inherit; text-decoration: none; }
#lb-name:hover, #lb-name:focus-visible { color: var(--cyan); text-decoration: underline; }
.fp { color: var(--faint); white-space: nowrap; }
.fp b { color: var(--ink); font-weight: 600; }
/* The reading list. */
ul.docs { list-style: none; padding: 0; margin: 20px 0 0; border: 1px solid var(--rule); background: var(--panel); }
ul.docs li { padding: 14px 18px; border-bottom: 1px solid var(--rule); display: grid; gap: 3px; }
ul.docs li:last-child { border-bottom: 0; }
ul.docs a { font-weight: 600; text-decoration: none; }
ul.docs a:hover { text-decoration: underline; }
ul.docs .gloss { color: var(--dim); font-size: 14px; }
ul.docs .m { font-size: 11px; color: var(--faint); }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 14px; margin: 22px 0 0; }
.card { background: var(--panel); border: 1px solid var(--rule); padding: 18px 20px; }
.card h3 { margin: 0 0 6px; font-size: 15px; }
.card h3 a { text-decoration: none; }
.card p { margin: 0; color: var(--dim); font-size: 14px; }
dialog {
  border: 1px solid var(--rule); background: var(--panel); color: var(--ink);
  padding: 0; width: min(96vw, 1600px); max-width: 96vw; max-height: 94vh;
}
dialog::backdrop { background: rgba(2,2,6,.86); }
/* 4:3 here too, sized from the width unless the height would exceed the
   viewport, in which case the width follows the height -- a fixed
   width:100% with a max-height would squash the picture instead. */
dialog img, dialog canvas {
  display: block; width: min(100%, calc(80vh * 4 / 3)); aspect-ratio: 4 / 3; height: auto;
  margin: 0 auto; background: #000; image-rendering: pixelated;
}
/* The UA stylesheet gives [hidden] display:none at the lowest possible
   specificity, and the rule above outranks it -- so the screenshot stayed on
   screen underneath the live canvas the whole time a demo was running. */
dialog img[hidden], dialog canvas[hidden] { display: none; }
/* The guest's own resolution is the backing store and CSS does the scaling, so
   a 320x200 demo stays a 320x200 demo instead of a blurred one. */
dialog canvas { outline: none; }
dialog canvas:focus-visible { outline: 2px solid var(--cyan); outline-offset: -2px; }
/* The Run control sits ON the screenshot, because what it replaces is the
   screenshot: press it and the same frame becomes a live one in place. */
.dlg-stage { background: #000; position: relative; line-height: 0; }
#lb-play {
  position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
  display: flex; align-items: center; gap: 10px;
  font: 600 13px/1 var(--mono); letter-spacing: .06em; text-transform: uppercase;
  color: var(--ink); background: rgba(8, 7, 13, .72); border: 1px solid var(--cyan);
  padding: 14px 22px; cursor: pointer; backdrop-filter: blur(3px);
  transition: background .12s, color .12s;
}
#lb-play:hover, #lb-play:focus-visible { background: var(--cyan); color: var(--ground); }
#lb-play:hover .tri, #lb-play:focus-visible .tri { border-left-color: var(--ground); }
#lb-play[disabled] { border-color: var(--rule); color: var(--faint); cursor: default; background: rgba(8,7,13,.8); }
#lb-play[disabled]:hover { background: rgba(8,7,13,.8); color: var(--faint); }
#lb-play[hidden] { display: none; }
.tri {
  width: 0; height: 0; border: 7px solid transparent;
  border-left: 12px solid var(--cyan); margin-right: -2px;
}
#lb-play[disabled] .tri { border-left-color: var(--faint); }
/* While it runs, the only chrome over the picture is one line at the bottom. */
.run-note {
  position: absolute; left: 0; right: 0; bottom: 0; margin: 0; padding: 7px 12px;
  font: 11px/1.4 var(--mono); color: var(--dim);
  background: linear-gradient(rgba(8,7,13,0), rgba(8,7,13,.88) 40%);
  text-align: center; pointer-events: none;
}
.run-note[hidden] { display: none; }
.run-note.live { color: var(--cyan); }
/* The controls: cpu speed, sound, full screen. Same bar as the name, same
   type, and each one is a real control rather than an icon to guess at. */
.ctl { display: inline-flex; align-items: center; gap: 8px; margin-left: 12px; }
.ctl label { font: 11px/1 var(--mono); color: var(--dim); letter-spacing: .06em; text-transform: uppercase; }
.ctl select {
  font: 11px/1.2 var(--mono); color: var(--ink); background: var(--ground);
  border: 1px solid var(--rule); padding: 3px 4px; margin-left: 4px;
}
.tog {
  font: 600 11px/1 var(--mono); letter-spacing: .06em; text-transform: uppercase;
  color: var(--dim); background: transparent; border: 1px solid var(--rule);
  padding: 5px 8px; cursor: pointer;
}
.tog:hover, .tog:focus-visible { color: var(--ink); border-color: var(--cyan); outline: none; }
.tog[aria-pressed="true"] { color: var(--cyan); border-color: var(--cyan); }
#lb-close { display: none; }
/* Full screen: the picture and nothing else. Two ways in -- the Fullscreen
   API where a browser has it, and the .fs class where it does not (iOS
   Safari has no element fullscreen at all), which makes the modal dialog
   itself the whole viewport. The bar becomes an overlay that hides itself
   until the pointer moves or the screen is tapped. */
dialog:fullscreen, dialog.fs {
  width: 100vw; max-width: 100vw; height: 100vh; height: 100dvh; max-height: 100dvh;
  border: 0; margin: 0; padding: 0; background: #000; display: flex; flex-direction: column;
}
/* The box inside the dialog is what the Fullscreen API is asked for: Chrome
   refuses a <dialog> itself, and a full-screen root paints over the modal.
   Sized to fill either way, so the layout below does not care which. */
dialog.fs .dlg-box, .dlg-box:fullscreen {
  flex: 1; display: flex; flex-direction: column; min-height: 0;
  width: 100%; height: 100%; background: #000; position: relative;
}
dialog:fullscreen .dlg-stage, dialog.fs .dlg-stage {
  flex: 1; display: flex; align-items: center; justify-content: center; min-height: 0;
}
dialog:fullscreen img, dialog:fullscreen canvas, dialog.fs img, dialog.fs canvas {
  width: min(100vw, calc(100vh * 4 / 3)); width: min(100vw, calc(100dvh * 4 / 3));
  max-height: 100vh; max-height: 100dvh; margin: 0;
}
dialog:fullscreen .dlg-screen, dialog.fs .dlg-screen { display: none; }
dialog:fullscreen .dlg-bar, dialog.fs .dlg-bar {
  position: absolute; left: 0; right: 0; top: 0; z-index: 2;
  background: rgba(8,7,13,.85); transition: opacity .3s; padding-top: max(8px, env(safe-area-inset-top));
}
dialog:fullscreen.idle .dlg-bar, dialog.fs.idle .dlg-bar { opacity: 0; pointer-events: none; }
dialog:fullscreen #lb-close, dialog.fs #lb-close { display: inline-block; }
/* The status line hides with the bar: in full screen the picture is the
   whole point, and both come back on a pointer move or a tap. */
dialog:fullscreen .run-note, dialog.fs .run-note {
  padding-bottom: max(7px, env(safe-area-inset-bottom)); transition: opacity .3s;
}
dialog:fullscreen.idle .run-note, dialog.fs.idle .run-note { opacity: 0; }
@media (max-width: 640px) {
  /* Two rows: the name and the link, then the controls edge to edge. */
  .dlg-bar { flex-wrap: wrap; gap: 8px 12px; padding: 8px 10px; }
  .dlg-bar #lb-meta { display: none; }
  .ctl { flex-basis: 100%; margin-left: 0; gap: 6px; justify-content: space-between; }
  .ctl label { font-size: 0; flex: 1; }
  .ctl select { width: 100%; margin: 0; padding: 6px 4px; }
  .tog { padding: 7px 8px; }
}
.dlg-bar { display: flex; justify-content: space-between; gap: 14px; padding: 10px 14px; font-family: var(--mono); font-size: 12px; border-bottom: 1px solid var(--rule); }
.dlg-bar .r { color: var(--faint); }
.dlg-bar .pouet { margin-left: auto; color: var(--cyan); text-decoration: none; border-bottom: 1px solid transparent; }
.dlg-bar .pouet:hover, .dlg-bar .pouet:focus-visible { border-bottom-color: var(--cyan); }
.dlg-bar .pouet[hidden] { display: none; }
.dlg-screen { margin: 0; padding: 12px 14px; border-top: 1px solid var(--rule); font-family: var(--mono); font-size: 11px; line-height: 1.3; color: var(--dim); white-space: pre; overflow: auto; max-height: 18vh; }
.dlg-screen[hidden] { display: none; }
footer { margin-top: 60px; padding-top: 22px; border-top: 1px solid var(--rule); color: var(--faint); font-family: var(--mono); font-size: 12px; }
@media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
`;

const JS = `// GENERATED by tools/toyvm/site.js -- do not edit.
//
// The lightbox is where a text capture becomes readable: at tile size the
// CP437 strike is a texture, and the screen it drew is usually the finding.
// The same dialog is also where a screenshot becomes a running program.
(function () {
  var dlg = document.getElementById('lb');
  if (!dlg) return;
  var img = document.getElementById('lb-img');
  var name = document.getElementById('lb-name');
  var meta = document.getElementById('lb-meta');
  var screen = document.getElementById('lb-screen');
  var pouet = document.getElementById('lb-pouet');
  // Every tile has a #fragment: opening one writes it to the URL (replace,
  // not push, so Back leaves the page rather than stepping through tiles),
  // closing clears it, and arriving with one -- a shared link, or the
  // caption's own anchor -- opens that tile. fromHash says the URL is
  // already right and must not be rewritten.
  var openId = null;
  function setHash(id) {
    if (!history.replaceState) return;
    var url = location.pathname + location.search + (id ? '#' + id : '');
    if (location.hash !== (id ? '#' + id : '')) history.replaceState(null, '', url);
  }
  function openFigure(fig, fromHash) {
    var btn = fig.querySelector('button.open');
    var src = btn.querySelector('img');
    img.src = src.getAttribute('src');
    img.alt = src.getAttribute('alt') || '';
    name.textContent = fig.querySelector('.fn').textContent;
    name.href = '#' + fig.id;
    openId = fig.id;
    if (!fromHash) setHash(fig.id);
    var bits = [fig.dataset.geom, fig.dataset.what];
    if (fig.dataset.stuck) bits.push('stuck at ' + fig.dataset.stuck);
    if (fig.dataset.soundLine) bits.push(fig.dataset.soundLine);
    meta.textContent = bits.filter(Boolean).join('  -  ');
    if (fig.dataset.prod) {
      pouet.href = 'https://www.pouet.net/search.php?type=prod&what='
        + encodeURIComponent(fig.dataset.prod);
      pouet.title = 'look up "' + fig.dataset.prod + '" on pouet.net';
      pouet.hidden = false;
    } else { pouet.hidden = true; }
    if (fig.dataset.screen) { screen.textContent = fig.dataset.screen; screen.hidden = false; }
    else { screen.textContent = ''; screen.hidden = true; }
    showLive(fig.dataset.live ? {
      name: fig.dataset.live, src: fig.dataset.liveSrc, exe: fig.dataset.liveExe,
      args: fig.dataset.liveArgs || '',
      env: fig.dataset.liveEnv || '', card: fig.dataset.liveSound || 'full',
    } : null);
    if (!dlg.open) dlg.showModal();
  }
  document.addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('button.open') : null;
    if (!btn) return;
    openFigure(btn.closest('figure'), false);
  });
  // The caption anchor and the dialog's own name link are plain #links, so
  // the URL changes first and the tile opens from the hash. A hash that names
  // no tile (or nothing) is left alone.
  function openFromHash() {
    var id = decodeURIComponent(location.hash.replace(/^#/, ''));
    if (!id || id === openId) return;
    var fig = document.getElementById(id);
    if (!fig || fig.tagName !== 'FIGURE') return;
    // Not close-and-reopen: the dialog's close event is delivered later and
    // would clear the hash this tile was just opened from. showLive stops a
    // running program before the new tile takes the stage.
    openFigure(fig, true);
    fig.scrollIntoView({ block: 'center' });
  }
  window.addEventListener('hashchange', openFromHash);
  dlg.addEventListener('click', function (e) { if (e.target === dlg) dlg.close(); });
  dlg.addEventListener('close', function () { stopLive(); openId = null; setHash(''); });
  if (location.hash) openFromHash();

  // --- the live half -------------------------------------------------------
  // Every demo ships with the site as bytes, and its tile gets a Run button:
  // the same emulator that took the screenshot, in this tab, driven a few
  // milliseconds per animation frame so the page stays responsive.
  //
  // The VM is half a megabyte of script and most visitors are here to look at
  // screenshots, so none of it loads until someone presses Run. From a file://
  // URL that has to be a <script> tag -- fetch, modules and workers are all
  // refused there -- which is also why the emulator runs on this thread.
  var playBtn = document.getElementById('lb-play');
  var statusEl = document.getElementById('lb-status');
  var canvas = document.getElementById('lb-canvas');
  var current = null, run = null, loading = null;
  var fetched = {};
  var runState = '', statusTimer = null;

  // " - sound: 48000Hz running, 312 pulls, sb 40 irqs, fm 120 notes" or
  // what is wrong with it. Nothing when sound is off.
  function soundLine() {
    if (!run || !prefs.sound) return prefs.sound ? '' : ' - sound off';
    var a = run.audioStats();
    if (!a) return ' - sound: no audio context';
    var src = [];
    if (a.sb) src.push('sb ' + a.sb + ' irqs');
    if (a.opl) src.push('fm ' + a.opl + ' notes');
    if (a.speaker) src.push('speaker ' + a.speaker + ' writes');
    if (a.gus) src.push('gus ' + a.gus + ' notes');
    return ' - sound: ' + a.rate + 'Hz ' + a.state + ', ' + a.pulls + ' pulls'
      + (a.underruns ? ', ' + a.underruns + ' gaps' : '')
      + (src.length ? ', ' + src.join(', ') : ', nothing played yet');
  }

  function showLive(what) {
    stopLive();
    current = what;
    playBtn.hidden = !what;
    playBtn.disabled = false;
    say('', false);
  }

  function say(text, live) {
    statusEl.textContent = text;
    statusEl.hidden = !text;
    statusEl.className = 'run-note' + (live ? ' live' : '');
  }

  // Back to the screenshot. The button comes back with it, because the two are
  // one control: the picture is either the frame we took or the one running.
  function stopLive() {
    if (run) { run.stop(); run = null; self.liveRun = null; }
    if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
    runState = '';
    canvas.hidden = true;
    img.hidden = false;
    if (current) { playBtn.hidden = false; playBtn.disabled = false; }
    say('', false);
  }

  // One <script> tag, resolved when it has run. This is how the bytes arrive
  // from a file:// URL, where fetch is refused.
  function script(src) {
    return new Promise(function (ok, fail) {
      var el = document.createElement('script');
      el.src = src;
      el.onload = function () { ok(); };
      el.onerror = function () { fail(new Error(src + ' did not load')); };
      document.head.appendChild(el);
    });
  }

  function loadVm() {
    if (!loading) loading = script('live/toyvm-bundle.js');
    return loading;
  }

  // Only the production that was pressed. Every demo in one script would mean
  // each visitor downloads the whole corpus to watch one of them.
  function loadProgram() {
    if (!current.src) return Promise.reject(new Error(current.name + ' has no bytes with the page'));
    if (!fetched[current.src]) fetched[current.src] = script(current.src);
    return fetched[current.src];
  }

  function b64(s) {
    var bin = atob(s);
    var b = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
    return b;
  }

  // --- the controls --------------------------------------------------------
  // CPU speed, sound and full screen. The first two are remembered per
  // browser, because a visitor who turned the sound off meant it for the next
  // demo too.
  var cpuSel = document.getElementById('lb-cpu');
  var soundBtn = document.getElementById('lb-sound');
  var fsBtn = document.getElementById('lb-fs');
  var closeBtn = document.getElementById('lb-close');
  var autoBtn = document.getElementById('lb-auto');
  var prefs = { cpu: '10', sound: true, auto: true };
  try {
    var saved = JSON.parse(localStorage.getItem('toyvm-live') || '{}');
    if (saved.cpu !== undefined) prefs.cpu = String(saved.cpu);
    if (saved.sound !== undefined) prefs.sound = !!saved.sound;
    if (saved.auto !== undefined) prefs.auto = !!saved.auto;
  } catch (e) { /* no storage: defaults */ }
  cpuSel.value = prefs.cpu;
  if (cpuSel.value !== prefs.cpu) { prefs.cpu = '10'; cpuSel.value = '10'; }
  function savePrefs() {
    try { localStorage.setItem('toyvm-live', JSON.stringify(prefs)); } catch (e) { /* fine */ }
  }
  function showSound() { soundBtn.setAttribute('aria-pressed', prefs.sound ? 'true' : 'false'); }
  function showAuto() { autoBtn.setAttribute('aria-pressed', prefs.auto ? 'true' : 'false'); }
  showSound();
  showAuto();

  // The menu answerer, on or off, live: the machine reads the flag at every
  // blocking read, so turning it off leaves the next menu to the visitor's
  // keyboard and turning it on answers a menu that is already waiting.
  autoBtn.addEventListener('click', function () {
    prefs.auto = !prefs.auto;
    savePrefs();
    showAuto();
    if (run) run.machine.autoKey = prefs.auto;
  });

  // The audio context has to be born inside a click -- every browser refuses
  // one made anywhere else -- so it is made here, once, and handed to each
  // run. Resumed on every gesture that reaches these controls, which is what
  // an iPhone wants before it will let a page make a sound.
  var audioCtx = null;
  function wakeAudio() {
    var AC = self.AudioContext || self.webkitAudioContext;
    if (!AC) return null;
    if (!audioCtx) { try { audioCtx = new AC(); } catch (e) { return null; } }
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  }

  soundBtn.addEventListener('click', function () {
    prefs.sound = !prefs.sound;
    savePrefs();
    showSound();
    if (prefs.sound) wakeAudio();
    if (run) run.setSound(prefs.sound);
  });

  // A different machine is a different run: the guest clocks are set when the
  // machine is built, so the demo starts over on the new one.
  cpuSel.addEventListener('change', function () {
    prefs.cpu = cpuSel.value;
    savePrefs();
    if (run) { stopLive(); startLive(); }
  });

  // Full screen. The Fullscreen API where there is one; the .fs class where
  // there is not (iOS Safari), which is the same layout without the browser's
  // help -- the modal already covers the page, so all that is left to hide is
  // our own bar. Esc leaves both, since Esc closes the dialog.
  // The element the browser has in real full screen, prefixed or not.
  function realFs() { return document.fullscreenElement || document.webkitFullscreenElement || null; }
  function inFs() { return !!realFs() || dlg.classList.contains('fs'); }
  function leaveFs() {
    if (realFs()) {
      var exit = document.exitFullscreen || document.webkitExitFullscreen;
      try { var p = exit.call(document); if (p && p.catch) p.catch(function () {}); } catch (e) { /* not in */ }
    }
    dlg.classList.remove('fs', 'idle');
    fsBtn.setAttribute('aria-pressed', 'false');
    clearTimeout(idleTimer);
  }
  // The .fs layout goes on first, whatever the browser does: on a desktop
  // the Fullscreen API then takes the page over the whole display, and the
  // layout is the same one either way; where the request is refused or the
  // API is missing (iOS Safari has no element fullscreen at all) the layout
  // alone is the full screen. The request is made on the BOX inside the
  // dialog, not the dialog: Chrome refuses a <dialog> outright ("Dialog
  // elements are invalid"), and a full-screen root paints the page over the
  // modal (measured: the demo showed through the cards). Safari's prefixed
  // request returns nothing rather than a promise, so success is read from
  // the change event, not from the return value.
  function enterFs() {
    fsBtn.setAttribute('aria-pressed', 'true');
    dlg.classList.add('fs');
    var box = document.getElementById('lb-box');
    var req = box.requestFullscreen || box.webkitRequestFullscreen;
    if (req) {
      try {
        var p = req.call(box, { navigationUI: 'hide' });
        if (p && p.catch) p.catch(function () {});
      } catch (e) { /* the layout is the full screen */ }
    }
    restartIdle();
    if (canvas && !canvas.hidden) canvas.focus();
  }
  fsBtn.addEventListener('click', function () { if (inFs()) leaveFs(); else enterFs(); });
  closeBtn.addEventListener('click', function () { dlg.close(); });
  // Leaving real full screen by Esc or the browser's own control: the
  // layout goes with it.
  function fsChanged() {
    if (!realFs()) { dlg.classList.remove('fs', 'idle'); fsBtn.setAttribute('aria-pressed', 'false'); }
  }
  document.addEventListener('fullscreenchange', fsChanged);
  document.addEventListener('webkitfullscreenchange', fsChanged);
  // The bar hides itself in full screen after a moment without input.
  var idleTimer = 0;
  function restartIdle() {
    dlg.classList.remove('idle');
    clearTimeout(idleTimer);
    if (inFs()) idleTimer = setTimeout(function () { dlg.classList.add('idle'); }, 2500);
  }
  dlg.addEventListener('pointermove', function () { if (inFs()) restartIdle(); });
  dlg.addEventListener('close', function () { leaveFs(); });

  // A tap on the screen: focus for the keyboard where there is one, and
  // Enter for a program waiting on a key where there is not. In full screen a
  // tap also brings the bar back.
  canvas.addEventListener('pointerdown', function () {
    canvas.focus();
    if (inFs()) restartIdle();
  });
  canvas.addEventListener('touchend', function (e) {
    if (!run) return;
    e.preventDefault();
    run.tap();
  }, { passive: false });

  function startLive() {
    if (!current || run) return;
    playBtn.disabled = true;
    var ctx = prefs.sound ? wakeAudio() : null;
    say('loading the emulator...');
    loadVm().then(loadProgram).then(function () {
      var key = current.src.split('/').pop().replace(/\\.js$/, '');
      var program = self.ToyVMPrograms && self.ToyVMPrograms[key];
      if (!program) throw new Error(current.name + ' was not packed with the page');
      // base64 in, bytes out, mounted as the bundle's disk: DOS opens a data
      // file by name through the shim's fs, and the shim reads from exactly
      // this map. A previous page handed the bytes to LiveRun and never
      // mounted them, so every demo with a data file beside it opened nothing.
      var ToyVM = self.ToyVM;
      ToyVM.unmountAll();
      var files = {};
      Object.keys(program.files).forEach(function (n) {
        files[n] = b64(program.files[n]);
        ToyVM.mount(n, files[n]);
      });
      var LiveRun = ToyVM.require('tools/toyvm/live.js').LiveRun;
      var mips = Number(prefs.cpu) || 0;
      run = new LiveRun({
        canvas: canvas,
        exe: current.exe,
        args: current.args,
        files: files,
        // What the sweep found this program needed: a ULTRASND= variable for
        // one that asks for a Gravis card, or no sound card for one that
        // only draws without one. The tile is a screenshot taken that way.
        env: current.env ? current.env.split(';') : [],
        card: current.card,
        // The same menu answerer the sweep ran with. The tile above this canvas
        // is a screenshot taken WITH it, so without it the page promises a
        // picture and then sits on "waiting for a key". It only answers when
        // the guest is blocked and nothing real is queued, so a visitor who
        // types still drives -- and the "auto menus" button turns it off for
        // a visitor who wants the menus themselves.
        autoKey: prefs.auto,
        // The machine's speed, and whether wall time paces it. "unpaced" keeps
        // the 486's clocks and simply never waits.
        mips: mips || 10,
        paced: mips > 0,
        // Sound, through the context made in the click. With it off the menu
        // answerer takes the silent option, as the sweep did.
        audioContext: ctx,
        sound: prefs.sound,
        soundPref: prefs.sound && current.card !== 'none' ? 'sb' : 'silent',
        onStatus: function (s) {
          runState = s.state;
          if (s.state === 'running') say('running - click the screen, then type' + soundLine(), true);
          else if (s.state === 'exited') say('the program exited');
          else if (s.state === 'waiting') say('waiting for a key - click or tap the screen and press one');
        },
      });
      // The sound path, in the status line, refreshed once a second while the
      // program runs: which sources have played and whether the browser is
      // actually pulling buffers. A count of pulls that stays at zero is a
      // context that never started -- that is what "silent" looks like from
      // inside, and it is a different fix from a demo that never touched the
      // card.
      statusTimer = setInterval(function () {
        if (run && runState === 'running') say('running - click the screen, then type' + soundLine(), true);
      }, 1000);
      // Reachable from the console, on purpose: liveRun.session.dispatched is
      // the only way to tell a demo that is drawing nothing yet from one that
      // is not running at all, and both look like a black rectangle.
      self.liveRun = run;
      // The screenshot steps aside and the button goes with it: from here the
      // picture IS the program, and closing the lightbox is how you stop it.
      img.hidden = true;
      canvas.hidden = false;
      playBtn.hidden = true;
      return run.start().then(function () { canvas.focus(); });
    }).catch(function (e) {
      playBtn.disabled = false;
      say(String((e && e.message) || e));
    });
  }
  playBtn.addEventListener('click', startLive);

  // Keys go to the guest only while the canvas has focus, so the dialog's own
  // Escape-to-close keeps working everywhere else on the page.
  canvas.addEventListener('keydown', function (e) {
    if (!run) return;
    e.preventDefault();
    e.stopPropagation();
    run.key(e);
  });
})();

// --- the gallery filter --------------------------------------------------------
// Only on pages that have one. A filter is a claim about the corpus, so the
// count next to it says how many tiles the claim covers.
(function () {
  var bar = document.getElementById('filter');
  if (!bar) return;
  var grid = document.getElementById('grid');
  var count = document.getElementById('filter-count');
  var q = document.getElementById('filter-q');
  // Two independent groups: what the tile shows (kind) and whether the run
  // made a sound. A tile has to pass both, so "graphics" + "sound" is the
  // list of demos that draw and play.
  var kindSel = 'all', soundSel = 'any';
  function apply() {
    var text = (q.value || '').trim().toLowerCase();
    var shown = 0;
    Array.prototype.forEach.call(grid.querySelectorAll('figure'), function (f) {
      var ok = (kindSel === 'all' || f.dataset.kind === kindSel)
        && (soundSel === 'any' || (f.dataset.sound || 'silent') === soundSel)
        && (!text || (f.querySelector('.fn').textContent + ' ' + (f.dataset.prod || '')
          + ' ' + (f.dataset.year || '') + ' ' + (f.dataset.screen || '')).toLowerCase().indexOf(text) >= 0);
      f.hidden = !ok;
      if (ok) shown++;
    });
    count.textContent = shown + ' of ' + grid.querySelectorAll('figure').length;
  }
  bar.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('button[data-kind], button[data-sound]') : null;
    if (!b) return;
    var group = b.dataset.kind !== undefined ? 'kind' : 'sound';
    if (group === 'kind') kindSel = b.dataset.kind; else soundSel = b.dataset.sound;
    Array.prototype.forEach.call(bar.querySelectorAll('button[data-' + group + ']'), function (x) {
      x.setAttribute('aria-pressed', x === b ? 'true' : 'false');
    });
    apply();
  });
  q.addEventListener('input', apply);
  apply();
})();
`;

function main() {
  const json = arg('json');
  const out = path.resolve(ROOT, arg('out', path.join('docs', 'dos-corpus')));
  const benchMd = arg('bench', path.join(ROOT, 'docs', 'toyvm-bench-20.md'));
  if (!json) {
    console.error('usage: site.js --json=SWEEP.json [--out=docs/dos-corpus] [--bench=docs/toyvm-bench-20.md]');
    process.exit(2);
  }
  const sweep = JSON.parse(fs.readFileSync(json, 'utf8'));
  const shots = path.join(out, 'shots');
  fs.mkdirSync(shots, { recursive: true });

  // Graphics first, then text, each by how much is on the surface; the blanks
  // last, so the tail of the grid is the honest part.
  const rank = { vga: 3, text: 2, blank: 0 };
  const rows = sweep.rows.filter((r) => r.png && fs.existsSync(r.png));
  // A run that never came back has no picture to show and is not a blank
  // screen: it is a program the harness could not finish photographing. Those
  // rows get no tile, but they belong in the table -- dropping them would make
  // the corpus look smaller than it is and hide the slowest failures.
  const failed = sweep.rows.filter((r) => !r.png);
  rows.sort((a, b) => rank[kind(b)] - rank[kind(a)]
    || (b.pixels || 0) - (a.pixels || 0) || (b.cells || 0) - (a.cells || 0)
    || (a.name < b.name ? -1 : 1));

  // A stale shot from a program that has since been dropped from the corpus
  // would sit in the directory forever, so the copy is a replace.
  for (const f of fs.readdirSync(shots)) fs.unlinkSync(path.join(shots, f));
  const files = new Map();
  for (const r of rows) {
    const file = path.basename(r.png);
    files.set(r, file);
    fs.copyFileSync(r.png, path.join(shots, file));
  }

  const n = { vga: 0, text: 0, blank: 0 };
  for (const r of rows) n[kind(r)]++;
  const total = rows.length + failed.length;
  const live = liveIndex(out);
  const runnable = rows.filter((r) => live.has(r.exe)).length;
  // The sound census over the tiles, and which chips carried it: the "made a
  // sound" stat reads "12 gus, 30 sb, 41 fm, 9 speaker" so a reader can see
  // what the corpus actually plays through.
  const snd = { sound: 0, quiet: 0, silent: 0, chips: '' };
  const byChip = {};
  for (const r of rows) {
    const s = soundOf(r);
    snd[s.state]++;
    if (s.state === 'sound') for (const c of (r.audio.sources || [])) byChip[c] = (byChip[c] || 0) + 1;
  }
  snd.chips = Object.entries(byChip).sort((a, b) => b[1] - a[1]).map(([c, k]) => `${k} ${c}`).join(', ')
    || 'no chip drove any of them';
  const prods = new Set(rows.map((r) => path.dirname(r.exe || ''))).size;

  const statsHtml = (list) => `  <div class="stats">
${list.map(([k, v, d]) => `    <div class="stat"><p class="k">${k}</p>`
    + `<p class="v">${v}</p><p class="d">${d}</p></div>`).join('\n')}
  </div>`;

  const prose = (name) => {
    const f = path.join(out, 'prose', name);
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
  };
  const stamp = `Generated by <span class="m">tools/toyvm/site.js</span> from
<span class="m">${esc(path.basename(json))}</span>. Corpus:
<span class="m">${esc(sweep.dir || '')}</span>, fetched by
<span class="m">tools/toyvm/fetch-demos.js</span>. Source:
<a href="${REPO}/tree/main/tools/toyvm">${REPO.replace('https://', '')}/tools/toyvm</a>.`;

  // --- index.html --------------------------------------------------------------
  // A handful of the runnable graphics tiles, one per production, most pixels
  // first: the front page should show the machine doing the thing.
  const seenProd = new Set();
  const featured = rows.filter((r) => kind(r) === 'vga' && live.has(r.exe)).filter((r) => {
    const d = path.dirname(r.exe);
    if (seenProd.has(d)) return false;
    seenProd.add(d);
    return true;
  }).slice(0, 8);
  const about = prose('about.html')
    .replace(/__TOTAL__/g, String(total))
    .replace(/__DREW__/g, String(n.vga + n.text))
    .replace(/__RUNNABLE__/g, String(runnable))
    .replace(/__FEATURED__/g, () => featured.map((r) => tile(r, files.get(r), live)).join('\n    '));
  fs.writeFileSync(path.join(out, 'index.html'), page({
    file: 'index.html',
    title: 'toyvm - a DOS machine in WebAssembly',
    eyebrow: 'tools/toyvm - a 16-bit PC in WebAssembly',
    h1: `A DOS machine, generated as wasm,<br>that runs <span class="b">${total} demos</span> in this tab`,
    lede: `A threaded-code x86 interpreter with a trace JIT above it and a VGA, a
  keyboard and DOS around it, built to measure dispatch strategies on real
  programs and grown into a machine that runs them. <strong>${n.vga + n.text} of
  ${total}</strong> demoscene productions from 1993&ndash;1995 draw a screen; every
  one of them has a Run button on the <a href="demos.html">demos</a> page.`,
    stats: statsHtml([
      ['programs', total, `${prods} productions, fetched and unpacked by the harness`],
      ['draw a screen', n.vga + n.text, `${n.vga} in a VGA mode, ${n.text} on the text console`],
      ['runnable here', runnable, 'ship as bytes with the site; press Run on any tile'],
      ['dispatch shells', 4, 'plus three JIT tiers, all measured on these programs'],
    ]),
    body: about,
    footer: stamp,
  }));

  // --- demos.html --------------------------------------------------------------
  // The blanks, with whatever the run last knew about them. This is the table
  // that gets shorter; it is worth having it generated rather than retyped.
  const blanks = rows.filter((r) => kind(r) === 'blank');
  const state = (r) => (!r.png ? `never finished (${r.failed || 'no capture'})`
    : r.blockedOn32 ? `32-bit protected-mode code at ${r.blockedOn32}`
      : r.badSelector ? `CS names no GDT descriptor at ${r.badSelector}`
        : r.stuckAt ? `stuck at ${r.stuckAt}`
          : r.blockedOnKey ? 'waiting for a key' : 'ran out of budget');
  const blankRows = [...blanks, ...failed]
    .map((r) => `<tr><td class="l">${esc(r.name)}</td>`
      + `<td class="l">${esc(state(r))}</td>`
      + `<td>${r.dispatched ? r.dispatched.toLocaleString() : '&mdash;'}</td></tr>`).join('\n');
  const pm32 = blanks.filter((r) => r.blockedOn32).length;
  fs.writeFileSync(path.join(out, 'demos.html'), page({
    file: 'demos.html',
    title: 'toyvm - the DOS corpus, one screenshot each',
    eyebrow: 'tools/toyvm - dos corpus sweep',
    h1: `${total} DOS demos,<br>one screenshot <span class="b">each</span></h1>`.replace('</h1>', ''),
    lede: `Every program in the corpus is run headless in the toy VM and
  photographed off whichever surface it actually drew on -- the VGA planes or
  the text console. <strong>${n.vga + n.text} of ${total}</strong> put something
  on screen. The ${n.blank} that drew nothing are on the page too, marked,
  because a blank tile is the work list. Click a tile for full size; press
  <strong>Run it</strong> to start that program here, with your keyboard.`,
    stats: statsHtml([
      ['programs swept', total, 'every executable the fetch unpacked, one child process each'],
      ['drew graphics', n.vga, 'wrote pixels to a VGA mode'],
      ['drew text', n.text, 'filled the console grid instead'],
      ['made a sound', snd.sound,
        `${snd.chips} -- ${snd.quiet} asked for a card and stayed quiet, ${snd.silent} never asked`],
      ['nothing to show', n.blank + failed.length,
        `${n.blank} drew nothing, ${failed.length} never finished -- the work list`],
    ]),
    body: `<section>
  <h2>The whole corpus</h2>
  <p class="sub">graphics first, then text, then the blanks - ${runnable} of ${rows.length} tiles run in the page, ${snd.sound} made a sound</p>
  <div class="bar" id="filter">
    <button type="button" data-kind="all" aria-pressed="true">all</button>
    <button type="button" data-kind="vga" aria-pressed="false">graphics</button>
    <button type="button" data-kind="text" aria-pressed="false">text</button>
    <button type="button" data-kind="blank" aria-pressed="false">blank</button>
    <span class="sep" aria-hidden="true"></span>
    <button type="button" data-sound="any" aria-pressed="true">any sound</button>
    <button type="button" data-sound="sound" aria-pressed="false" title="the run made a sound">&#9835; sound</button>
    <button type="button" data-sound="quiet" aria-pressed="false" title="asked for a sound card, nothing came out">quiet</button>
    <button type="button" data-sound="silent" aria-pressed="false" title="never touched a sound card">silent</button>
    <input type="search" id="filter-q" placeholder="name, production, year, or screen text" aria-label="filter tiles">
    <span class="count" id="filter-count"></span>
  </div>
  <div class="shots" id="grid">
${rows.map((r) => tile(r, files.get(r), live)).join('\n')}
  </div>
</section>

<section>
  <h2>What is still blank</h2>
  <p class="sub">${blanks.length + failed.length} programs, and where each one stopped${
  pm32 ? ` &mdash; ${pm32} of them reached 32-bit protected-mode code, which this decoder does not read and does not guess at` : ''}</p>
  <div class="scroll"><table>
    <thead><tr><th class="l">program</th><th class="l">last known state</th><th>dispatches</th></tr></thead>
    <tbody>
${blankRows}
    </tbody>
  </table></div>
</section>`,
    footer: stamp,
  }));

  // --- benchmarks.html ---------------------------------------------------------
  const md = fs.existsSync(benchMd) ? fs.readFileSync(benchMd, 'utf8') : '';
  const table = benchTable(md);
  fs.writeFileSync(path.join(out, 'benchmarks.html'), page({
    file: 'benchmarks.html',
    title: 'toyvm - benchmarks',
    eyebrow: 'tools/toyvm - measured on the corpus',
    h1: 'Seven ways to run<br>the same <span class="b">x86</span>',
    lede: `Four dispatch shells, a stack of interpreter passes and three JIT tiers,
  every one of them measured on the demos in the gallery rather than on a
  synthetic loop -- because a synthetic loop is perfectly predicted by any
  scheme, which is the one property real programs do not have.`,
    body: `${prose('benchmarks.html')}
${table ? `<section>
  <h2>All three backends on one scale</h2>
  <p class="sub">twenty programs, every column a whole-program percentage against the shipped interpreter</p>
  <p>Read across a row before reading down a column. <span class="m">ns</span>
  is the shipped shell's cost per dispatch; <span class="m">repl</span> the
  replicated-tail shell; the <span class="m">no…</span> columns are the run
  <em>without</em> that pass, so a negative number is what the pass is worth.
  <span class="m">mshare/t03x/mceil</span> are the micro-op hot-trace share, its
  tier-3 ratio and the whole-program ceiling that implies;
  <span class="m">jshare/gate/jceil/+hb/jcpu</span> are the region JIT's share,
  gate ratio, ceiling, handback delta and measured CPU change. A
  <span class="m">-</span> is a measurement the tool could not take on that
  program, and the verdict says why. The full method, the raw outputs and the
  outliers are in <a href="${REPO}/blob/main/docs/toyvm-bench-20.md">docs/toyvm-bench-20.md</a>.</p>
  ${table}
</section>` : ''}
<section>
  <h2>Further reading</h2>
  <p class="sub">the measurements, one page each</p>
  <div class="cards">
    <div class="card"><h3><a href="../toyvm-core10/index.html">Nine traces, four tiers</a></h3>
      <p>The trace JIT priced tier by tier on the hot loops of the core set: what each pass removes and what it is worth.</p></div>
    <div class="card"><h3><a href="${REPO}/blob/main/docs/toyvm-dispatch-shootout.md">The dispatch shootout</a></h3>
      <p>The four shells on ten real programs, three independent sweeps, and why the microbenchmark got the switch wrong.</p></div>
    <div class="card"><h3><a href="docs.html">Every design document</a></h3>
      <p>Superinstructions, lazy and dead flags, the decoder in wasm, spin loops, stream loops, the trace JIT.</p></div>
  </div>
</section>`,
    footer: stamp,
  }));

  // --- notes.html --------------------------------------------------------------
  fs.writeFileSync(path.join(out, 'notes.html'), page({
    file: 'notes.html',
    title: 'toyvm - notes from the corpus',
    eyebrow: 'tools/toyvm - what the demos taught the machine',
    h1: 'They were asking for DOS,<br>not for a <span class="b">CPU</span>',
    lede: `The record of what stopped each program and what was built to get it
  past that, in the order it happened. Not one blocker has been an instruction:
  every one was a driver, a file, a paragraph of memory or a keystroke the
  machine did not yet provide. Figures here are the same captures as the tiles
  in the <a href="demos.html">gallery</a>, and they run.`,
    body: prose('notes.html'),
    footer: stamp,
  }));

  // --- docs.html ---------------------------------------------------------------
  fs.writeFileSync(path.join(out, 'docs.html'), page({
    file: 'docs.html',
    title: 'toyvm - design documents',
    eyebrow: 'tools/toyvm - reading list',
    h1: 'The design documents,<br>in the order to <span class="b">read</span> them',
    lede: `Each one is a measurement with a question in front of it. They live in
  the repository beside the code they describe; these are links to them there.`,
    body: `<section>
  <h2>Documents</h2>
  <p class="sub">docs/toyvm-*.md on GitHub</p>
  <ul class="docs">
${docList()}
  </ul>
</section>
<section>
  <h2>The code</h2>
  <p class="sub">where each part of the machine lives</p>
  <div class="cards">
    <div class="card"><h3><a href="${REPO}/blob/main/tools/toyvm/emit.js">emit.js</a></h3><p>The generator: every handler once, emitted behind whichever dispatch shell is asked for.</p></div>
    <div class="card"><h3><a href="${REPO}/blob/main/tools/toyvm/decode.js">decode.js</a></h3><p>x86 bytes into arena words, with the fusion and spin-loop passes.</p></div>
    <div class="card"><h3><a href="${REPO}/blob/main/tools/toyvm/dos.js">dos.js</a></h3><p>The machine: DOS, BIOS, XMS, EMS, the VGA, the keyboard, the menu reader.</p></div>
    <div class="card"><h3><a href="${REPO}/blob/main/tools/toyvm/trace-jit.js">trace-jit.js</a></h3><p>The tiers: stitching, constant propagation, register-file folding, dead flags.</p></div>
    <div class="card"><h3><a href="${REPO}/blob/main/tools/toyvm/region-jit.js">region-jit.js</a></h3><p>Installing a compiled region into the running program, and the gate that prices it.</p></div>
    <div class="card"><h3><a href="${REPO}/blob/main/tools/toyvm/live.js">live.js</a></h3><p>The page-side driver behind every Run button here.</p></div>
    <div class="card"><h3><a href="${REPO}/blob/main/tools/toyvm/shot-sweep.js">shot-sweep.js</a></h3><p>The headless sweep that photographs the corpus and writes the JSON this site is built from.</p></div>
    <div class="card"><h3><a href="${REPO}/blob/main/tools/toyvm/site.js">site.js</a></h3><p>This site, generated.</p></div>
  </div>
</section>`,
    footer: stamp,
  }));

  fs.writeFileSync(path.join(out, 'site.css'), CSS);
  fs.writeFileSync(path.join(out, 'site.js'), JS);
  // The single-page report this replaced spliced its prose from here; a copy
  // left behind would be a second, stale source of the same text.
  const oldProse = path.join(out, 'sections.html');
  if (fs.existsSync(oldProse)) fs.unlinkSync(oldProse);

  console.log(`${path.relative(ROOT, out)}/: index, demos, benchmarks, notes, docs; `
    + `${rows.length} tiles (${n.vga} graphics, ${n.text} text, ${n.blank} blank), `
    + `${runnable} runnable, ${files.size} PNGs`);
}

main();
