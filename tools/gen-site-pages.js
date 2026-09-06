#!/usr/bin/env node
// Render the repository's Markdown into static HTML pages for the live site,
// plus a sitemap.xml that lists them.
//
//   node tools/gen-site-pages.js            write story.html, apps/*.html, articles/*.html, docs/**/*.html, sitemap.xml
//   node tools/gen-site-pages.js --list     print what would be written, write nothing
//
// WHY THIS EXISTS: story.html used to fetch PROJECT_STORY.md and render it
// with marked in the browser, so the served HTML held a "Loading..." div and
// nothing else. Googlebot may execute that script; Bing, DuckDuckGo, link
// unfurlers and the LLM crawlers do not, and none of them saw a word of the
// story. The design docs and reverse-engineering notes under docs/ were not
// on the site at all -- tools/deploy-berrry.js only walks lib/ and src/.
//
// Every page gets a real <title>, a meta description taken from its first
// paragraph, canonical + Open Graph tags, and an Article JSON-LD block, so a
// search result and a chat-app link preview both have something to show.
//
// Output is generated, not source: story.html is committed so a local
// http.server has it, docs/**/*.html and sitemap.xml are gitignored and
// deploy-berrry.js regenerates all three right before it uploads.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { marked } = require('marked');

const ROOT = path.join(__dirname, '..');
const SITE = 'https://wine-assembly.berrry.app';
const SITE_NAME = 'Wine-Assembly';
const AUTHOR = 'Vladimir Grichina';
const REPO = 'https://github.com/vgrichina/wine-assembly';
const OG_IMAGE = `${SITE}/icons/og-image.png`;
// Pinned: a diagram that rendered under one mermaid parser should keep
// rendering, and a floating "latest" has broken flowchart syntax before.
const MERMAID_URL = 'https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.esm.min.mjs';

const STYLE = `
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body { background: #f5f2ea; color: #1a1a1a; line-height: 1.55; font-size: 16px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      -webkit-text-size-adjust: 100%; }
    .wrap { max-width: 760px; margin: 0 auto; padding: 24px 18px 64px; }
    nav.top { font-size: 13px; padding-bottom: 12px; border-bottom: 1px solid #d8d2c4; margin-bottom: 24px; }
    nav.top a { color: #0645ad; text-decoration: none; margin-right: 14px; }
    nav.top a:hover { text-decoration: underline; }
    h1, h2, h3, h4 { line-height: 1.25; margin: 1.6em 0 0.5em; }
    h1 { font-size: 1.9em; border-bottom: 2px solid #1a1a1a; padding-bottom: 6px; margin-top: 0.4em; }
    h2 { font-size: 1.45em; border-bottom: 1px solid #d8d2c4; padding-bottom: 4px; }
    h3 { font-size: 1.15em; }
    p, ul, ol { margin: 0.7em 0; }
    ul, ol { padding-left: 1.4em; }
    li { margin: 0.2em 0; }
    hr { border: 0; border-top: 1px solid #d8d2c4; margin: 2em 0; }
    a { color: #0645ad; }
    strong { color: #000; }
    blockquote { margin: 1em 0; padding: 0.2em 1em; border-left: 4px solid #d8d2c4; color: #444; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.9em;
      background: #ebe7dc; padding: 1px 4px; border-radius: 3px; }
    pre { background: #1e1e1e; color: #e6e6e6; padding: 12px 14px; border-radius: 6px;
      overflow-x: auto; font-size: 13px; line-height: 1.45; }
    pre code { background: none; padding: 0; color: inherit; font-size: inherit; }
    table { border-collapse: collapse; margin: 1em 0; font-size: 0.93em; display: block; overflow-x: auto; }
    th, td { border: 1px solid #d8d2c4; padding: 5px 9px; text-align: left; vertical-align: top; }
    th { background: #ebe7dc; }
    img { max-width: 100%; height: auto; }
    footer { margin-top: 48px; padding-top: 14px; border-top: 1px solid #d8d2c4; font-size: 13px; color: #555; }
    .docs-index li { margin: 0.35em 0; }
    .docs-index small { color: #666; display: block; }
    pre.mermaid { background: #fff; color: #222; border: 1px solid #d8d2c4; text-align: center; overflow-x: auto; padding: 10px 6px; }
    pre.mermaid svg { max-width: 100%; height: auto; }
    .app-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 14px; margin: 0.8em 0 1.6em; }
    .app-card { display: block; text-decoration: none; color: inherit; background: #fff; border: 1px solid #d8d2c4; border-radius: 6px; overflow: hidden; }
    .app-card:hover { border-color: #0645ad; }
    .app-card img { display: block; width: 100%; aspect-ratio: 4 / 3; object-fit: contain; background: #008080; }
    .app-shot { max-width: 100%; height: auto; }
    .app-card span { display: block; padding: 6px 9px; font-size: 14px; font-weight: 600; }
    .app-card small { display: block; padding: 0 9px 8px; font-size: 12px; color: #666; font-weight: 400; }
    .app-launch { display: inline-block; background: #008080; color: #fff !important; text-decoration: none; padding: 9px 16px; border-radius: 4px; font-weight: 600; margin: 0.4em 0 1em; }
    .app-launch:hover { background: #006666; }
    .app-shot { border: 1px solid #d8d2c4; }
`;

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function gitDate(rel, which) {
  try {
    const flag = which === 'first' ? '--reverse' : '';
    const out = execSync(`git log ${flag} --format=%cI -- "${rel}"`, { cwd: ROOT, encoding: 'utf-8' });
    const line = out.split('\n').find(Boolean);
    return line ? line.slice(0, 10) : null;
  } catch (_) { return null; }
}

// Title = first H1. Description: an explicit `<!-- description: ... -->`
// comment when the page has one (invisible on GitHub, so the .md stays the
// source), else the first real paragraph cut at a sentence end that fits a
// search snippet, else a word cut with an ellipsis. Markdown is stripped by
// rendering the paragraph and dropping the tags, so a description never
// carries a stray backtick, and entities are decoded so esc() at the tag
// does not double-escape an apostrophe.
const DESC_MAX = 158;
const unescapeHtml = s => s.replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n))
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
function extractMeta(md) {
  const lines = md.split('\n');
  let title = null;
  const explicit = md.match(/<!--\s*description:\s*([\s\S]*?)-->/);
  const paras = [];
  let cur = [];
  let inFence = false;
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (/^```/.test(line)) { inFence = !inFence; cur = []; continue; }
    if (inFence) continue;
    if (!title && /^# /.test(line)) { title = line.replace(/^# /, '').trim(); continue; }
    if (/^\s*$/.test(line) || /^(#|\||>|-|\*|\d+\.|---)/.test(line)) {
      if (cur.length) { paras.push(cur.join(' ')); cur = []; }
      continue;
    }
    cur.push(line.trim());
  }
  if (cur.length) paras.push(cur.join(' '));
  if (explicit) return { title: title || SITE_NAME, description: explicit[1].replace(/\s+/g, ' ').trim() };
  // A page that opens with a table or a list has no paragraph to quote;
  // the title is a better snippet than an empty attribute.
  if (!paras.length) return { title: title || SITE_NAME, description: `${title || SITE_NAME}: notes from the ${SITE_NAME} Windows 98 emulator.` };
  const first = paras.find(p => p.replace(/[*_`]/g, '').length > 40) || paras[0] || '';
  let text = unescapeHtml(marked.parseInline(first).replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
  if (text.length > DESC_MAX) {
    // Prefer ending on a whole sentence: the last ". " that still leaves a
    // description of useful length. Otherwise cut at a word.
    const head = text.slice(0, DESC_MAX);
    const end = head.lastIndexOf('. ');
    text = end >= 40 ? head.slice(0, end + 1) : text.slice(0, DESC_MAX - 3).replace(/\s+\S*$/, '') + '…';
  }
  return { title: title || SITE_NAME, description: text };
}

// Markdown links are resolved from the source document, not the generated
// page. Documents rendered by this generator get their public HTML route;
// repository-only Markdown stays useful by linking to its GitHub source
// instead of inventing a local .html URL that the deploy does not contain.
function markdownPublicUrl(sourceRel, href, hash) {
  const absolute = href.startsWith('/');
  const target = path.posix.normalize(absolute
    ? href.slice(1)
    : path.posix.join(path.posix.dirname(sourceRel), href));
  if (target === 'PROJECT_STORY.md') return `/story.html${hash || ''}`;
  if (target === 'articles/README.md') return `/articles/${hash || ''}`;
  if (target === 'docs/re-notes/README.md') return `/docs/re-notes/${hash || ''}`;
  if (/^articles\/[^/]+\.md$/.test(target) || /^docs\/(?:re-notes\/)?[^/]+\.md$/.test(target)) {
    return `/${target.replace(/\.md$/, '.html')}${hash || ''}`;
  }
  const githubPath = target.split('/').map(encodeURIComponent).join('/');
  return `${REPO}/blob/main/${githubPath}${hash || ''}`;
}

function rewriteMdLinks(html, sourceRel) {
  return html.replace(/href="([^"#]+\.md)(#[^"]*)?"/g,
    (match, href, hash) => `href="${markdownPublicUrl(sourceRel, href, hash)}"`);
}

function pageHtml({ md, title, description, urlPath, sourceRel, nav = NAV, dates, extraHead, ldExtra, ldMore = [], ogImage = OG_IMAGE, canonical }) {
  const url = `${SITE}/${urlPath}`;
  // A page that has been folded into another (articles/ and docs/ into
  // design/) keeps serving its old URL but declares the new one canonical,
  // so what search engines already indexed transfers instead of competing.
  const canonicalUrl = canonical ? `${SITE}/${canonical}` : url;
  let body = rewriteMdLinks(marked.parse(md, { gfm: true, breaks: false }), sourceRel);
  // ```mermaid fences: GitHub renders them in the .md; here they become
  // <pre class="mermaid"> and the page loads mermaid only when it has one.
  // marked's entity escaping is fine, mermaid reads the element's textContent.
  const hasMermaid = /<pre><code class="language-mermaid">/.test(body);
  body = body.replace(/<pre><code class="language-mermaid">([\s\S]*?)<\/code><\/pre>/g, '<pre class="mermaid">$1</pre>');
  const mermaidHead = hasMermaid
    ? `\n  <script type="module">import mermaid from "${MERMAID_URL}"; mermaid.initialize({ startOnLoad: true, theme: "neutral", securityLevel: "strict", flowchart: { htmlLabels: true, curve: "basis" } });</script>`
    : '';
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: title,
    description,
    url,
    image: ogImage,
    author: { '@type': 'Person', name: AUTHOR, url: REPO },
    publisher: { '@type': 'Organization', name: SITE_NAME, url: SITE },
    isPartOf: { '@type': 'WebSite', name: SITE_NAME, url: SITE },
    inLanguage: 'en',
  };
  if (dates.published) ld.datePublished = dates.published;
  if (dates.modified) ld.dateModified = dates.modified;
  if (ldExtra) Object.assign(ld, ldExtra);
  const fullTitle = title.includes(SITE_NAME) ? title : `${title} — ${SITE_NAME}`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(fullTitle)}</title>
  <meta name="description" content="${esc(description)}">
  <link rel="canonical" href="${canonicalUrl}">
  <meta property="og:type" content="article">
  <meta property="og:site_name" content="${SITE_NAME}">
  <meta property="og:title" content="${esc(fullTitle)}">
  <meta property="og:description" content="${esc(description)}">
  <meta property="og:url" content="${url}">
  <meta property="og:image" content="${ogImage}">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${esc(fullTitle)}">
  <meta name="twitter:description" content="${esc(description)}">
  <meta name="twitter:image" content="${ogImage}">
  <meta name="theme-color" content="#008080">
  <link rel="icon" href="${SITE}/icons/icon-192.png">
  <script type="application/ld+json">${JSON.stringify(ld)}</script>${ldMore.map(x => `\n  <script type="application/ld+json">${JSON.stringify(x)}</script>`).join('')}${extraHead || ''}${mermaidHead}
  <style>${STYLE}  </style>
</head>
<body>
  <div class="wrap">
    <nav class="top">${nav}</nav>
    <article>
${body}
    </article>
    <footer>
      <a href="${SITE}/">Run Windows 98 apps in your browser</a> ·
      <a href="${REPO}">Source on GitHub</a> ·
      <a href="${REPO}/blob/main/${esc(sourceRel)}">Edit this page</a>${dates.modified ? ` · Updated ${dates.modified}` : ''}
    </footer>
  </div>
</body>
</html>
`;
}

const NAV_HOME = `<a href="/">&larr; Run the emulator</a>`;
const NAV_STORY = `<a href="/story.html">The Story</a>`;
const NAV_REPO = `<a href="${REPO}">GitHub</a>`;
const NAV_APPS = `<a href="/apps/">Apps</a>`;
const NAV_DESIGN = `<a href="/design/">Design</a>`;
// One nav on every page, mirroring the Start menu in index.html: the two
// hubs (Apps, Design), the story, the repo. Five identical links everywhere
// concentrate internal links on the hubs instead of spreading them over
// per-page variants.
const NAV = [NAV_HOME, NAV_APPS, NAV_DESIGN, NAV_STORY, NAV_REPO].join(' ');

// Per-app pages, one for each production desktop icon and nothing else: a search for
// "space cadet pinball in browser" should land on a page that says what the
// program is, shows it running here and has one launch button. Candidates,
// SDK samples and demos stay in the ?debug dropdown without a page.
//
// Name and emoji come from DESKTOP_APPS; the group comes from the <optgroup>
// the id sits under in index.html's selector so the two never disagree; the
// prose comes from tools/site-app-blurbs.json; everything else (exe, format,
// DLLs, data files, command line) is read off the registry entry itself.
const APP_BLURBS_REL = 'tools/site-app-blurbs.json';
const APP_FAQ_REL = 'tools/site-app-faq.json';
const OG_DIR = 'screenshots/og';
const { ogCard } = require('./gen-og-images');
// The selector's groups are about where a binary came from; the pages group
// by what a visitor is looking for, so a few labels fold together.
const GROUP_LABELS = {
  'Other': 'Games and players',
  'Local Candidates': 'Games and players',
  'DirectX Shareware': 'Games and players',
  'Entertainment Pack 2 (16-bit)': 'Entertainment Pack',
};
const NO_GROUP = 'More games';

// Width/height straight from the PNG's IHDR, so the <img> attributes match
// the file: the captures are cropped to the window by tools/png-crop-desktop.js
// and are no longer all 640x480, and a wrong attribute pair makes the browser
// reserve the wrong box and reflow when the picture arrives.
function pngSize(file) {
  const b = Buffer.alloc(24);
  const fd = fs.openSync(file, 'r');
  fs.readSync(fd, b, 0, 24, 0);
  fs.closeSync(fd);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}
const sizeAttrs = s => s ? `width="${s.width}" height="${s.height}"` : '';

// The Questions section of an app page, and the FAQPage JSON-LD that mirrors
// it. Answers are built from facts the registry and the code already state
// (touch layout, LAN flag, exe format, localStorage-backed registry/INI
// persistence, the AudioContext resume on first input) plus the per-app
// controls line in tools/site-app-faq.json. Nothing here claims a feature the
// program has not been seen to use.
function appFaq(app, faq) {
  const qa = [];
  qa.push([`How do I play ${app.name} in my browser?`,
    `Open the ${app.name} page and click Launch. The program's files are fetched from this site and run inside the tab as WebAssembly; nothing is installed and nothing is uploaded.`]);
  qa.push([`What are the controls for ${app.name}?`,
    faq[app.id] || `${app.name} is played with the mouse and the same keyboard shortcuts as the original Windows 98 program; its menus list them.`]);
  qa.push([`Does ${app.name} work on a phone?`,
    app.touch
      ? `Yes. On a phone the desktop scales to the screen and ${app.name} gets on-screen controls for the keys it needs, plus a keyboard button for anything else.`
      : `It loads in mobile Safari and Chrome and the desktop scales to the screen, but ${app.name} was made for a mouse and a keyboard, so it plays best on a desktop browser. Taps act as clicks.`]);
  qa.push([`Are my scores and settings saved?`,
    `Whatever ${app.name} writes to the Windows registry or to its INI file is kept in this browser's local storage, so it is there next time on the same device and browser. Clearing site data removes it.`]);
  qa.push([`Does sound work?`,
    `Sound the program plays through the Windows wave and DirectSound APIs is routed to the browser's Web Audio. Browsers only allow audio after a click or a key press, so it starts with your first input.`]);
  if (app.lan) qa.push([`Can I play ${app.name} against someone else?`,
    `Yes, over the emulator's virtual LAN: two copies of the game on the same page share a network segment, so one can host and the other join as the original did on a 1990s LAN.`]);
  qa.push([`Is this the real ${app.name} or a remake?`,
    `It is the original ${app.format || 'Windows'} executable${app.exe ? ` (${app.exe})` : ''}, run instruction by instruction by an x86 interpreter written in WebAssembly Text. The emulator provides the Windows API underneath it, not a rewrite of the program.`]);
  return qa;
}
const faqLd = qa => ({
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: qa.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })),
});

// Snippet for an app page: the blurb, plus the "runs in your browser" line
// when a one-line blurb leaves room for it; a long blurb is cut at a
// sentence end rather than padded.
function appDescription(app) {
  const tail = ` Runs in your browser on ${SITE_NAME}, a Windows 98 emulator in WebAssembly.`;
  const base = app.blurb.length <= DESC_MAX ? app.blurb : extractMeta(app.blurb).description;
  return base.length + tail.length <= DESC_MAX ? base + tail : base;
}

function dropdownGroups() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf-8');
  const start = html.indexOf('id="app-select"');
  const end = html.indexOf('</select>', start);
  const map = new Map();
  if (start < 0 || end < 0) return map;
  let group = 'Win98 Accessories';
  const re = /<optgroup label="([^"]*)"|<option value="([^"]*)"/g;
  let m;
  while ((m = re.exec(html.slice(start, end)))) {
    if (m[1]) group = m[1];
    else map.set(m[2], GROUP_LABELS[group] || group);
  }
  return map;
}

function exeFormat(rel) {
  try {
    const fd = fs.openSync(path.join(ROOT, rel), 'r');
    const head = Buffer.alloc(0x40);
    fs.readSync(fd, head, 0, 0x40, 0);
    if (head[0] !== 0x4d || head[1] !== 0x5a) { fs.closeSync(fd); return null; }
    const off = head.readUInt32LE(0x3c);
    const sig = Buffer.alloc(2);
    fs.readSync(fd, sig, 0, 2, off);
    fs.closeSync(fd);
    if (sig[0] === 0x4e && sig[1] === 0x45) return '16-bit Windows (NE)';
    if (sig[0] === 0x50 && sig[1] === 0x45) return '32-bit Windows (PE)';
    return null;
  } catch (_) { return null; }
}

function loadDesktopApps() {
  const { APPS, DESKTOP_APPS, appFileUrl } = require(path.join(ROOT, 'lib', 'apps.js'));
  const blurbs = JSON.parse(fs.readFileSync(path.join(ROOT, APP_BLURBS_REL), 'utf-8'));
  const groups = dropdownGroups();
  const reDir = path.join(ROOT, 'docs', 're-notes');
  const reNotes = fs.existsSync(reDir)
    ? fs.readdirSync(reDir).filter(f => f.endsWith('.md') && f !== 'README.md')
        .map(f => ({ rel: `docs/re-notes/${f}`, md: fs.readFileSync(path.join(reDir, f), 'utf-8') }))
    : [];
  // `_skip` names desktop ids the pages leave out: not on the production
  // desktop yet, or no usable screenshot. The live site's lib/apps.js is the
  // reference for "production desktop", not this checkout's.
  const skip = new Set(blurbs._skip || []);
  return DESKTOP_APPS.filter(([id]) => !skip.has(id)).map(([id, name, emoji]) => {
    const app = APPS[id] || {};
    const exe = app.exe || '';
    const shot = `screenshots/apps/${id}.png`;
    const notes = reNotes
      .filter(n => n.md.includes('`' + id + '`') || n.md.includes(`--app=${id}`))
      .map(n => ({ rel: n.rel, title: extractMeta(n.md).title }));
    return {
      id, name, emoji,
      blurb: blurbs[id] || `${name}, one of the programs on the Wine-Assembly desktop.`,
      group: groups.get(id) || NO_GROUP,
      exe: exe ? path.posix.basename(exe) : null,
      format: exe ? exeFormat(exe) : null,
      dlls: (app.dlls || []).map(d => path.posix.basename(d)),
      files: (app.files || []).map(appFileUrl).filter(Boolean).length,
      args: app.args || '',
      lan: !!app.lan,
      touch: !!app.touchControls,
      shot: fs.existsSync(path.join(ROOT, shot)) ? shot : null,
      shotSize: fs.existsSync(path.join(ROOT, shot)) ? pngSize(path.join(ROOT, shot)) : null,
      notes,
    };
  });
}

const ARTICLE_FOR_FORMAT = {
  '16-bit Windows (NE)': ['/articles/running-16-bit-windows-apps-in-webassembly.html', 'how 16-bit Windows programs run here'],
  '32-bit Windows (PE)': ['/articles/loading-real-windows-dlls-in-the-browser.html', 'how the program and its DLLs are loaded'],
};

function appPageMd(app, siblings, qa) {
  const L = [];
  L.push(`# ${app.name} in your browser`);
  L.push('');
  L.push(`${app.blurb} ${app.name} runs in Wine-Assembly, a Windows 98 emulator written in WebAssembly Text, so it starts in the browser with nothing to install.`);
  L.push('');
  L.push(`<a class="app-launch" href="/?app=${app.id}">Launch ${app.name} &rarr;</a>`);
  L.push('');
  if (app.shot) {
    L.push(`<img class="app-shot" src="/${app.shot}" alt="${esc(app.name)} running in Wine-Assembly" ${sizeAttrs(app.shotSize)}>`);
    L.push('');
  }
  L.push('## About this program');
  L.push('');
  L.push('| Detail | |');
  L.push('|---|---|');
  if (app.exe) L.push(`| Executable | \`${app.exe}\` |`);
  if (app.format) L.push(`| Format | ${app.format} |`);
  L.push(`| Libraries loaded beside it | ${app.dlls.length ? app.dlls.map(d => '`' + d + '`').join(', ') : 'none; everything else is the emulator\'s own Win32 layer'} |`);
  if (app.files) L.push(`| Data files mounted | ${app.files} |`);
  if (app.args) L.push(`| Command line | \`${app.args.replace(/\|/g, '\\|')}\` |`);
  if (app.lan) L.push('| Network | plays over the emulator\'s virtual LAN |');
  if (app.touch) L.push('| Phones | on-screen controls in single-app mode |');
  L.push(`| Desktop group | ${app.group} |`);
  L.push('');
  L.push('## How it runs here');
  L.push('');
  const fmt = ARTICLE_FOR_FORMAT[app.format];
  L.push(`The x86 code is interpreted by [threaded code written in WebAssembly Text](/articles/x86-interpreter-in-webassembly-text.html); ` +
    `windows, controls, menus and dialogs are the emulator's own [Win32 layer](/articles/win32-api-in-webassembly.html), and every pixel is drawn by a [software GDI](/articles/software-gdi-in-webassembly.html) in the same module.` +
    (fmt ? ` See [${fmt[1]}](${fmt[0]}).` : ''));
  L.push('');
  if (app.notes.length) {
    L.push('Reverse-engineering notes for this program:');
    L.push('');
    for (const n of app.notes) L.push(`- [${n.title}](/${n.rel})`);
    L.push('');
  }
  L.push(`Something wrong? The emulator is open source; [report it on GitHub](${REPO}/issues) with the app name and what you clicked.`);
  L.push('');
  L.push('## Questions');
  L.push('');
  for (const [q, a] of qa) {
    L.push(`### ${q}`);
    L.push('');
    L.push(a);
    L.push('');
  }
  if (siblings.length) {
    L.push(`## Also under "${app.group}"`);
    L.push('');
    L.push(siblings.map(s => `[${s.name}](/apps/${s.id}.html)`).join(' · '));
    L.push('');
  }
  L.push(`[All programs on the desktop](/apps/) · [How Wine-Assembly was built](/story.html)`);
  L.push('');
  return L.join('\n');
}

function appsIndexMd(apps) {
  const byGroup = new Map();
  for (const a of apps) {
    if (!byGroup.has(a.group)) byGroup.set(a.group, []);
    byGroup.get(a.group).push(a);
  }
  const L = [];
  L.push('# Windows 98 programs you can run in your browser');
  L.push('');
  L.push(`Every icon on the Wine-Assembly desktop, with a page each: what the program is, a picture of it running here, and a link that starts it. ` +
    `They are real Windows 98 executables, not ports; the emulator underneath is an x86 interpreter and Win32 layer written in WebAssembly Text. ` +
    `Programs the site cannot redistribute (game demos, shareware installers, the DirectX SDK samples) are in the debug dropdown on the [main page](/?debug) instead.`);
  L.push('');
  for (const [group, list] of byGroup) {
    L.push(`## ${group}`);
    L.push('');
    L.push('<div class="app-grid">');
    for (const a of list) {
      const img = a.shot ? `<img src="/${a.shot}" alt="" loading="lazy" ${sizeAttrs(a.shotSize)}>` : '';
      const first = a.blurb.split(/(?<=\.)\s/)[0];
      L.push(`<a class="app-card" href="/apps/${a.id}.html">${img}<span>${esc(a.name)}</span><small>${esc(first)}</small></a>`);
    }
    L.push('</div>');
    L.push('');
  }
  return L.join('\n');
}

// articles/*.md: one standalone page per question ("how do lazy flags
// work", "how are real DLLs loaded"), written to be found by a search for
// that question rather than read top to bottom like the story. README.md
// there is the hand-kept index and becomes articles/index.html.
function listArticles() {
  const dir = path.join(ROOT, 'articles');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).sort()
    .filter(f => f.endsWith('.md') && f !== 'README.md')
    .map(f => ({ rel: `articles/${f}`, urlPath: `articles/${f.replace(/\.md$/, '.html')}` }));
}

function listDocs() {
  const out = [];
  const dirs = [['docs', ''], ['docs/re-notes', 're-notes/']];
  for (const [dir, prefix] of dirs) {
    const full = path.join(ROOT, dir);
    if (!fs.existsSync(full)) continue;
    for (const f of fs.readdirSync(full).sort()) {
      if (!f.endsWith('.md')) continue;
      const page = f === 'README.md' ? 'index.html' : f.replace(/\.md$/, '.html');
      out.push({ rel: `${dir}/${f}`, urlPath: `docs/${prefix}${page}` });
    }
  }
  return out;
}

function generatePages() {
  const pages = [];
  const urls = [{ loc: `${SITE}/`, priority: '1.0', changefreq: 'weekly' }];

  // The story.
  const storyMd = fs.readFileSync(path.join(ROOT, 'PROJECT_STORY.md'), 'utf-8');
  const storyMeta = extractMeta(storyMd);
  const storyDates = { published: gitDate('PROJECT_STORY.md', 'first'), modified: gitDate('PROJECT_STORY.md') };
  pages.push({
    name: 'story.html',
    content: pageHtml({
      md: storyMd,
      title: 'How Wine-Assembly was built: a Windows 98 emulator in raw WebAssembly',
      description: 'The history of Wine-Assembly, a Windows 98 emulator in WebAssembly: from the first x86 decoder to a browser running Pinball, Winamp, DirectX and Win16 apps.',
      urlPath: 'story.html', sourceRel: 'PROJECT_STORY.md',
      dates: storyDates,
    }),
  });
  urls.push({ loc: `${SITE}/story.html`, lastmod: storyDates.modified, priority: '0.8', changefreq: 'monthly' });

  // Articles.
  for (const a of listArticles()) {
    const md = fs.readFileSync(path.join(ROOT, a.rel), 'utf-8');
    const meta = extractMeta(md);
    const dates = { published: gitDate(a.rel, 'first'), modified: gitDate(a.rel) };
    pages.push({
      name: a.urlPath,
      content: pageHtml({
        md, title: meta.title, description: meta.description,
        urlPath: a.urlPath, sourceRel: a.rel,
        dates,
      }),
    });
    urls.push({ loc: `${SITE}/${a.urlPath}`, lastmod: dates.modified, priority: '0.8', changefreq: 'monthly' });
  }
  // Per-app pages for the desktop set.
  const apps = loadDesktopApps();
  const blurbDates = { published: gitDate(APP_BLURBS_REL, 'first'), modified: gitDate(APP_BLURBS_REL) };
  const faq = fs.existsSync(path.join(ROOT, APP_FAQ_REL)) ? JSON.parse(fs.readFileSync(path.join(ROOT, APP_FAQ_REL), 'utf-8')) : {};
  for (const app of apps) {
    const siblings = apps.filter(s => s.group === app.group && s.id !== app.id);
    const qa = appFaq(app, faq);
    const md = appPageMd(app, siblings, qa);
    // The app's own 1200x630 link-preview card, built from its screenshot.
    // Generated beside the pages (screenshots/og/ is not committed) and
    // uploaded by deploy-berrry.js with the other binary directories.
    let ogImage = OG_IMAGE;
    if (app.shot) {
      const card = `${OG_DIR}/${app.id}.png`;
      ogCard(path.join(ROOT, app.shot), path.join(ROOT, card));
      ogImage = `${SITE}/${card}`;
    }
    pages.push({
      name: `apps/${app.id}.html`,
      content: pageHtml({
        md,
        title: `${app.name} in your browser`,
        // The blurb is the description; the boilerplate sentence after it
        // in the page body only pads a snippet.
        description: appDescription(app),
        urlPath: `apps/${app.id}.html`, sourceRel: APP_BLURBS_REL,
        dates: blurbDates,
        ogImage,
        ldMore: [faqLd(qa)],
        ldExtra: {
          '@type': 'WebPage',
          about: { '@type': 'SoftwareApplication', name: app.name, operatingSystem: 'Windows 98', applicationCategory: app.group },
          ...(app.shot ? { image: [ogImage, `${SITE}/${app.shot}`] } : {}),
        },
      }),
    });
    urls.push({ loc: `${SITE}/apps/${app.id}.html`, lastmod: blurbDates.modified, priority: '0.7', changefreq: 'monthly' });
  }
  const appsIndex = appsIndexMd(apps);
  pages.push({
    name: 'apps/index.html',
    content: pageHtml({
      md: appsIndex,
      title: 'Windows 98 programs you can run in your browser',
      description: extractMeta(appsIndex).description,
      urlPath: 'apps/', sourceRel: APP_BLURBS_REL,
      dates: blurbDates,
    }),
  });
  urls.push({ loc: `${SITE}/apps/`, lastmod: blurbDates.modified, priority: '0.8', changefreq: 'monthly' });

  const articlesIndexRel = 'articles/README.md';
  if (fs.existsSync(path.join(ROOT, articlesIndexRel))) {
    const md = fs.readFileSync(path.join(ROOT, articlesIndexRel), 'utf-8');
    const meta = extractMeta(md);
    const dates = { published: gitDate(articlesIndexRel, 'first'), modified: gitDate(articlesIndexRel) };
    pages.push({
      name: 'articles/index.html',
      content: pageHtml({
        md, title: meta.title, description: meta.description,
        urlPath: 'articles/', sourceRel: articlesIndexRel,
        canonical: 'design/',
        dates,
      }).replace('class="wrap"', 'class="wrap docs-index"'),
    });
  }

  // Design docs and reverse-engineering notes.
  const docs = listDocs();
  const index = [];
  for (const d of docs) {
    const md = fs.readFileSync(path.join(ROOT, d.rel), 'utf-8');
    const meta = extractMeta(md);
    const dates = { published: gitDate(d.rel, 'first'), modified: gitDate(d.rel) };
    const isIndex = d.rel === 'docs/re-notes/README.md';
    const content = pageHtml({
      md, title: meta.title, description: meta.description,
      urlPath: d.urlPath, sourceRel: d.rel,
      dates,
    });
    pages.push({
      name: d.urlPath,
      content,
    });
    // README.html was the original public route. Berry updates do not delete
    // old files, so keep that URL current while making the directory index the
    // canonical page used by navigation and the sitemap.
    if (isIndex) {
      pages.push({
        name: 'docs/re-notes/README.html',
        content: pageHtml({
          md, title: meta.title, description: meta.description,
          urlPath: 'docs/re-notes/README.html', sourceRel: d.rel,
          canonical: 'docs/re-notes/', dates,
        }),
      });
    }
    urls.push({ loc: `${SITE}/${d.urlPath}`, lastmod: dates.modified, priority: isIndex ? '0.5' : '0.6', changefreq: 'monthly' });
    index.push({ ...d, ...meta, dates });
  }

  // The docs table of contents. Two sections so a reader looking for "how
  // does the emulator work" and one looking for "what did you find inside
  // Diablo" each land on the right list.
  const section = (heading, items) => `## ${heading}\n\n` + items.map(i =>
    `- [${i.title}](/${i.urlPath})${i.description ? `  \n  <small>${i.description}</small>` : ''}`).join('\n') + '\n\n';
  const design = index.filter(i => !i.rel.startsWith('docs/re-notes/'));
  const re = index.filter(i => i.rel.startsWith('docs/re-notes/') && i.rel !== 'docs/re-notes/README.md');
  const docsSections =
    section('Emulator design and performance', design) +
    section('Reverse-engineering notes, one per application', re);
  const docsIntro =
    `These pages are the working notes behind it — the memory map, ` +
    `the interpreter's dispatch and lazy-flag design, the software GDI rasterizer, the DirectX and Win16 layers, ` +
    `the performance ledger, and one file per game or application we have taken apart to make it run. ` +
    `They are rendered from the Markdown in [docs/](${REPO}/tree/main/docs) on GitHub.`;
  const today = new Date().toISOString().slice(0, 10);

  // design/index.html: the one "how it works" hub the Start menu and every
  // page nav point at. Articles first (the readable layer, each answering one
  // question), then the design docs and RE notes (the reference layer). The
  // older articles/ and docs/ indexes keep serving but declare this page
  // canonical, so nothing already indexed or linked breaks.
  const articlesBody = fs.existsSync(path.join(ROOT, articlesIndexRel))
    ? fs.readFileSync(path.join(ROOT, articlesIndexRel), 'utf-8').replace(/^[\s\S]*?(?=^## )/m, '').replace(/^## /gm, '### ')
    : '';
  const designMd = `# How Wine-Assembly works: articles, design docs and reverse-engineering notes\n\n` +
    `Wine-Assembly runs real Windows 98 programs in the browser: an x86 interpreter, a Win32 API layer, ` +
    `a software GDI, DirectX and a 16-bit loader, all written directly in WebAssembly Text. ` +
    `The articles below each answer one question about how that is built and are the place to start; ` +
    `the design docs and per-application reverse-engineering notes after them are the working record ` +
    `the articles are drawn from. [The story](/story.html) tells it in order.\n\n` +
    `## Articles\n\n` + articlesBody.trim() + `\n\n` +
    `## Design docs and reverse-engineering notes\n\n` + docsIntro + `\n\n` + docsSections.replace(/^## /gm, '### ');
  pages.push({
    name: 'design/index.html',
    content: pageHtml({
      md: designMd,
      title: 'How Wine-Assembly works: articles, design docs and reverse-engineering notes',
      description: 'How a Windows 98 emulator in WebAssembly Text works: articles on the x86 interpreter, lazy flags, DLLs, GDI, DirectX and Win16, plus design docs and RE notes.',
      urlPath: 'design/', sourceRel: 'articles/README.md',
      dates: { modified: today },
    }).replace('class="wrap"', 'class="wrap docs-index"'),
  });
  urls.push({ loc: `${SITE}/design/`, priority: '0.8', changefreq: 'weekly' });

  const indexMd = `# Wine-Assembly design docs and reverse-engineering notes\n\n` +
    `Wine-Assembly runs real Windows 98 executables in the browser: an x86 interpreter and a Win32 API layer ` +
    `written directly in WebAssembly Text. ` + docsIntro + `\n\n` + docsSections;
  pages.push({
    name: 'docs/index.html',
    content: pageHtml({
      md: indexMd,
      title: 'Wine-Assembly design docs and reverse-engineering notes',
      description: 'Design docs and reverse-engineering notes for a Windows 98 emulator in WebAssembly Text: memory map, x86 dispatch, lazy flags, software GDI, DirectX, Win16.',
      urlPath: 'docs/', sourceRel: 'docs',
      canonical: 'design/',
      dates: { modified: today },
    }).replace('class="wrap"', 'class="wrap docs-index"'),
  });

  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls.map(u => `  <url><loc>${u.loc}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}` +
      `<changefreq>${u.changefreq}</changefreq><priority>${u.priority}</priority></url>`).join('\n') +
    `\n</urlset>\n`;
  pages.push({ name: 'sitemap.xml', content: sitemap });
  return pages;
}

function writePages(pages) {
  for (const p of pages) {
    const full = path.join(ROOT, p.name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, p.content);
  }
}

module.exports = { generatePages, writePages, extractMeta, SITE };

if (require.main === module) {
  const pages = generatePages();
  if (process.argv.includes('--list')) {
    for (const p of pages) console.log(`${p.name}  (${p.content.length} bytes)`);
  } else {
    writePages(pages);
    console.log(`wrote ${pages.length} pages (story.html, apps/*.html, articles/*.html, docs/**/*.html, sitemap.xml) and ${OG_DIR}/*.png`);
  }
}
