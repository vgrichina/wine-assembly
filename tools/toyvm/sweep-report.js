#!/usr/bin/env node

'use strict';

// Build the DOS-corpus sweep report as a page that lives in this repository.
//
//   node tools/toyvm/shot-sweep.js --dir=/tmp/demos --out=/tmp/shots --json=/tmp/shots.json
//   node tools/toyvm/sweep-report.js --json=/tmp/shots.json --out=docs/dos-corpus
//
// The sweep itself writes to a scratch directory, which is correct -- 199
// screenshots of a corpus that is refetched on demand are not repository
// content. The *report* is: it is the record of what the toy VM can run, and
// the one artifact of this work anybody reads. It was hosted off-site once and
// a machine reboot took the sources with it, so it is generated here instead,
// beside the code it describes, from data the sweep already produced.
//
// Screenshots are copied in as files rather than inlined as data URIs. A data
// URI page is one 3MB blob that rewrites itself completely on every rebuild;
// separate PNGs let git store one object per program and show which pictures
// actually changed between two runs of the VM. `.gitignore` has a blanket
// `*.png`, so the output directory needs its own negation to be committable.
//
// The prose is NOT generated. `sections.html` next to the output is spliced in
// verbatim at __PROSE__ if it exists, so findings are written by hand and only
// the numbers, the tiles and the tables come from the sweep.

const fs = require('fs');
const path = require('path');

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

// The demos whose bytes ship with the page, so their tiles get a Run button.
// Written by tools/toyvm/bundle-programs.js; absent is fine, and the page is
// then exactly what it was before -- screenshots.
function liveIndex(out) {
  const f = path.join(out, 'live', 'programs-index.json');
  try {
    return new Set(JSON.parse(fs.readFileSync(f, 'utf8')));
  } catch {
    return new Set();
  }
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
  return `<figure class="${k}" data-what="${esc(what.replace(/<\/?b>/g, ''))}"`
    + ` data-geom="${esc(geom)}"`
    + (live && live.has(r.name) ? ` data-live="${esc(r.name)}"` : '')
    + (r.screen ? ` data-screen="${esc(r.screen)}"` : '')
    + (r.stuckAt ? ` data-stuck="${esc(r.stuckAt)}"` : '')
    + `><button class="open" type="button" title="${esc(r.name)} - full size">`
    + `<img loading="lazy" src="shots/${esc(file)}" alt="${esc(alt)}"></button>`
    + (k === 'text' ? '<span class="mx">text</span>' : '')
    + `<figcaption><span class="fn" title="${esc(r.name)}">${esc(r.name)}</span>`
    + `<span class="fp">${what}</span></figcaption></figure>`;
}

function main() {
  const json = arg('json');
  const out = arg('out', path.join(__dirname, '..', '..', 'docs', 'dos-corpus'));
  if (!json) {
    console.error('usage: sweep-report.js --json=SWEEP.json [--out=docs/dos-corpus]');
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
  const stats = [
    ['programs swept', total, 'every executable the fetch unpacked, one child process each'],
    ['drew graphics', n.vga, 'wrote pixels to a VGA mode'],
    ['drew text', n.text, 'filled the console grid instead'],
    ['nothing to show', n.blank + failed.length,
      `${n.blank} drew nothing, ${failed.length} never finished -- the work list`],
  ];

  const live = liveIndex(out);
  const proseFile = path.join(out, 'sections.html');
  const prose = fs.existsSync(proseFile) ? fs.readFileSync(proseFile, 'utf8') : '';

  // The blanks, with whatever the run last knew about them. This is the table
  // that gets shorter; it is worth having it generated rather than retyped.
  const blanks = rows.filter((r) => kind(r) === 'blank');
  // The two named stops come first, because they are the two that mean
  // something specific. "32-bit protected-mode code" is the declared blocker of
  // this whole harness -- the guest reached a code segment with the D bit set,
  // which is a second decoder and a 32-bit EIP through the block cache, and the
  // run refuses rather than decoding 32-bit code as 16-bit. "CS names no GDT
  // descriptor" is the honest version of a derail: a real CPU would have
  // faulted, so something earlier loaded a selector we got wrong.
  const state = (r) => (!r.png ? `never finished (${r.failed || 'no capture'})`
    : r.blockedOn32 ? `32-bit protected-mode code at ${r.blockedOn32}`
      : r.badSelector ? `CS names no GDT descriptor at ${r.badSelector}`
        : r.stuckAt ? `stuck at ${r.stuckAt}`
          : r.blockedOnKey ? 'waiting for a key' : 'ran out of budget');
  const blankRows = [...blanks, ...failed]
    .map((r) => `<tr><td class="l">${esc(r.name)}</td>`
      + `<td class="l">${esc(state(r))}</td>`
      + `<td>${r.dispatched ? r.dispatched.toLocaleString() : '&mdash;'}</td></tr>`).join('\n');

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>The DOS corpus, one screenshot each</title>
<style>
/* One visual world: a CRT in a dark room. No web fonts -- this page is opened
   off the filesystem as often as off a server, and a font that only arrives
   over the network is a font that is usually missing. */
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
header { padding: 54px 0 28px; border-bottom: 1px solid var(--rule); }
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
table { border-collapse: collapse; width: 100%; font-family: var(--mono); font-size: 13px; }
th, td { padding: 8px 12px; text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; border-bottom: 1px solid var(--rule); }
th { color: var(--faint); font-weight: 500; text-transform: uppercase; font-size: 11px; letter-spacing: .07em; }
td.l, th.l { text-align: left; }
tbody tr:last-child td { border-bottom: 0; }
.shots { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 14px; margin: 24px 0 0; }
figure { margin: 0; background: var(--panel); border: 1px solid var(--rule); padding: 8px; position: relative; }
figure.blank { opacity: .5; }
figure .mx {
  position: absolute; top: 12px; right: 12px; font-family: var(--mono); font-size: 9px;
  letter-spacing: .08em; text-transform: uppercase; border: 1px solid var(--cyan);
  color: var(--cyan); padding: 1px 4px; background: rgba(8,7,13,.75);
}
button.open { display: block; width: 100%; padding: 0; border: 0; background: #000; cursor: zoom-in; }
button.open:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
figure img { display: block; width: 100%; image-rendering: pixelated; }
figcaption { display: flex; justify-content: space-between; gap: 8px; align-items: baseline; margin-top: 7px; font-family: var(--mono); font-size: 11px; }
.fn { color: var(--dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fp { color: var(--faint); white-space: nowrap; }
.fp b { color: var(--ink); font-weight: 600; }
dialog {
  border: 1px solid var(--rule); background: var(--panel); color: var(--ink);
  padding: 0; max-width: min(96vw, 1100px); max-height: 94vh;
}
dialog::backdrop { background: rgba(2,2,6,.86); }
dialog img, dialog canvas { display: block; max-width: 100%; max-height: 72vh; margin: 0 auto; background: #000; image-rendering: pixelated; }
/* The guest's own resolution is the backing store and CSS does the scaling, so
   a 320x200 demo stays a 320x200 demo instead of a blurred one. */
dialog canvas { width: 100%; height: auto; outline: none; }
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
.run-note.live { color: var(--cyan); }
.dlg-bar { display: flex; justify-content: space-between; gap: 14px; padding: 10px 14px; font-family: var(--mono); font-size: 12px; border-bottom: 1px solid var(--rule); }
.dlg-bar .r { color: var(--faint); }
.dlg-screen { margin: 0; padding: 12px 14px; border-top: 1px solid var(--rule); font-family: var(--mono); font-size: 11px; line-height: 1.3; color: var(--dim); white-space: pre; overflow: auto; max-height: 18vh; }
footer { margin-top: 60px; padding-top: 22px; border-top: 1px solid var(--rule); color: var(--faint); font-family: var(--mono); font-size: 12px; }
@media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
</style>
</head>
<body>
<div class="wrap">

<header>
  <p class="eyebrow">tools/toyvm - dos corpus sweep</p>
  <h1>${total} DOS demos,<br>one screenshot <span class="b">each</span></h1>
  <p class="lede">Every program in the corpus is run headless in the toy VM and
  photographed off whichever surface it actually drew on -- the VGA planes or
  the text console. <strong>${n.vga + n.text} of ${total}</strong> put something
  on screen. The ${n.blank} that drew nothing are on the page too, marked,
  because a blank tile is the work list.</p>
  <div class="stats">
${stats.map(([k, v, d]) => `    <div class="stat"><p class="k">${k}</p>`
    + `<p class="v">${v}</p><p class="d">${d}</p></div>`).join('\n')}
  </div>
</header>

${prose}

<section>
  <h2>The whole corpus</h2>
  <p class="sub">graphics first, then text, then the blanks - click any tile for full size</p>
  <div class="shots">
${rows.map((r) => tile(r, files.get(r), live)).join('\n')}
  </div>
</section>

<section>
  <h2>What is still blank</h2>
  <p class="sub">${blanks.length + failed.length} programs, and where each one stopped${
  blanks.filter((r) => r.blockedOn32).length
    ? ` &mdash; ${blanks.filter((r) => r.blockedOn32).length} of them reached 32-bit `
      + 'protected-mode code, which this decoder does not read and does not guess at'
    : ''}</p>
  <div class="scroll"><table>
    <thead><tr><th class="l">program</th><th class="l">last known state</th><th>dispatches</th></tr></thead>
    <tbody>
${blankRows}
    </tbody>
  </table></div>
</section>

<footer>Generated by <span class="m">tools/toyvm/sweep-report.js</span> from
<span class="m">${esc(path.basename(json))}</span>. Corpus:
<span class="m">${esc(sweep.dir || '')}</span>, fetched by
<span class="m">tools/toyvm/fetch-demos.js</span>.</footer>

</div>

<dialog id="lb">
  <div class="dlg-bar"><span id="lb-name"></span><span class="r" id="lb-meta"></span></div>
  <div class="dlg-stage">
    <img id="lb-img" alt="">
    <canvas id="lb-canvas" width="320" height="200" hidden tabindex="0"
      aria-label="live emulator output"></canvas>
    <button type="button" id="lb-play" hidden
      title="run this demo here"><span class="tri"></span>Run it</button>
    <p class="run-note" id="lb-status" hidden></p>
  </div>
  <pre class="dlg-screen" id="lb-screen" hidden></pre>
</dialog>

<script>
// The lightbox is where a text capture becomes readable: at tile size the
// CP437 strike is a texture, and the screen it drew is usually the finding.
(function () {
  var dlg = document.getElementById('lb');
  var img = document.getElementById('lb-img');
  var name = document.getElementById('lb-name');
  var meta = document.getElementById('lb-meta');
  var screen = document.getElementById('lb-screen');
  document.addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('button.open') : null;
    if (!btn) return;
    var fig = btn.closest('figure');
    var src = btn.querySelector('img');
    img.src = src.getAttribute('src');
    img.alt = src.getAttribute('alt') || '';
    name.textContent = fig.querySelector('.fn').textContent;
    var bits = [fig.dataset.geom, fig.dataset.what];
    if (fig.dataset.stuck) bits.push('stuck at ' + fig.dataset.stuck);
    meta.textContent = bits.filter(Boolean).join('  -  ');
    if (fig.dataset.screen) { screen.textContent = fig.dataset.screen; screen.hidden = false; }
    else { screen.textContent = ''; screen.hidden = true; }
    showLive(fig.dataset.live || null);
    dlg.showModal();
  });
  dlg.addEventListener('click', function (e) { if (e.target === dlg) dlg.close(); });
  dlg.addEventListener('close', function () { stopLive(); });

  // --- the live half -------------------------------------------------------
  // Some of these demos ship with the page as bytes, and those tiles get a Run
  // button: the same emulator that took the screenshot, in this tab, driven a
  // few milliseconds per animation frame so the page stays responsive.
  //
  // The VM is half a megabyte of script and most visitors are here to look at
  // screenshots, so none of it loads until someone presses Run. From a file://
  // URL that has to be a <script> tag -- fetch, modules and workers are all
  // refused there -- which is also why the emulator runs on this thread.
  var playBtn = document.getElementById('lb-play');
  var statusEl = document.getElementById('lb-status');
  var canvas = document.getElementById('lb-canvas');
  var current = null, run = null, loading = null;

  function showLive(name) {
    stopLive();
    current = name;
    playBtn.hidden = !name;
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
    canvas.hidden = true;
    img.hidden = false;
    if (current) { playBtn.hidden = false; playBtn.disabled = false; }
    say('', false);
  }

  // One <script> tag, resolved when it has run. Sequential rather than
  // parallel: programs.js is data the bundle's loader never touches, but the
  // order costs nothing next to the emulator's own startup.
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
    if (loading) return loading;
    loading = script('live/toyvm-bundle.js')
      .then(function () { return script('live/programs.js'); });
    return loading;
  }

  playBtn.addEventListener('click', function () {
    if (!current || run) return;
    playBtn.disabled = true;
    say('loading the emulator...');
    loadVm().then(function () {
      var program = self.ToyVMPrograms && self.ToyVMPrograms[current];
      if (!program) throw new Error(current + ' was not packed with the page');
      // base64 in, bytes out: the shim's fs reads from exactly this map.
      var files = {};
      Object.keys(program.files).forEach(function (n) {
        var bin = atob(program.files[n]);
        var b = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
        files[n] = b;
      });
      var LiveRun = self.ToyVM.require('tools/toyvm/live.js').LiveRun;
      run = new LiveRun({
        canvas: canvas,
        exe: program.exe,
        files: files,
        onStatus: function (s) {
          if (s.state === 'running') say('running - click the screen, then type', true);
          else if (s.state === 'exited') say('the program exited');
          else if (s.state === 'waiting') say('waiting for a key - click the screen and press one');
        },
      });
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
  });

  // Keys go to the guest only while the canvas has focus, so the dialog's own
  // Escape-to-close keeps working everywhere else on the page.
  canvas.addEventListener('keydown', function (e) {
    if (!run) return;
    e.preventDefault();
    e.stopPropagation();
    run.key(e);
  });
})();
</script>
</body>
</html>
`;

  fs.writeFileSync(path.join(out, 'index.html'), html);
  console.log(`${path.join(out, 'index.html')}: ${rows.length} tiles `
    + `(${n.vga} graphics, ${n.text} text, ${n.blank} blank), `
    + `${(html.length / 1024).toFixed(0)}KB of HTML + ${files.size} PNGs`);
}

main();
