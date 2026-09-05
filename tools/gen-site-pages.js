#!/usr/bin/env node
// Render the repository's Markdown into static HTML pages for the live site,
// plus a sitemap.xml that lists them.
//
//   node tools/gen-site-pages.js            write story.html, articles/*.html, docs/**/*.html, sitemap.xml
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

// Title = first H1; description = first real paragraph, trimmed to what a
// search snippet shows. Markdown is stripped by rendering the paragraph and
// dropping the tags, so a description never carries a stray backtick.
function extractMeta(md) {
  const lines = md.split('\n');
  let title = null;
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
  const first = paras.find(p => p.replace(/[*_`]/g, '').length > 40) || paras[0] || '';
  let text = marked.parseInline(first).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  if (text.length > 158) text = text.slice(0, 155).replace(/\s+\S*$/, '') + '…';
  return { title: title || SITE_NAME, description: text };
}

// Relative .md links inside the rendered pages point at the .html twin we
// generate; everything else (src/, lib/, http) is left alone.
function rewriteMdLinks(html) {
  return html.replace(/href="([^"#:]+)\.md(#[^"]*)?"/g, (m, p, hash) => `href="${p}.html${hash || ''}"`);
}

function pageHtml({ md, title, description, urlPath, sourceRel, nav, dates, extraHead }) {
  const url = `${SITE}/${urlPath}`;
  const body = rewriteMdLinks(marked.parse(md, { gfm: true, breaks: false }));
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: title,
    description,
    url,
    image: OG_IMAGE,
    author: { '@type': 'Person', name: AUTHOR, url: REPO },
    publisher: { '@type': 'Organization', name: SITE_NAME, url: SITE },
    isPartOf: { '@type': 'WebSite', name: SITE_NAME, url: SITE },
    inLanguage: 'en',
  };
  if (dates.published) ld.datePublished = dates.published;
  if (dates.modified) ld.dateModified = dates.modified;
  const fullTitle = title.includes(SITE_NAME) ? title : `${title} — ${SITE_NAME}`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(fullTitle)}</title>
  <meta name="description" content="${esc(description)}">
  <link rel="canonical" href="${url}">
  <meta property="og:type" content="article">
  <meta property="og:site_name" content="${SITE_NAME}">
  <meta property="og:title" content="${esc(fullTitle)}">
  <meta property="og:description" content="${esc(description)}">
  <meta property="og:url" content="${url}">
  <meta property="og:image" content="${OG_IMAGE}">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${esc(fullTitle)}">
  <meta name="twitter:description" content="${esc(description)}">
  <meta name="twitter:image" content="${OG_IMAGE}">
  <meta name="theme-color" content="#008080">
  <link rel="icon" href="${SITE}/icons/icon-192.png">
  <script type="application/ld+json">${JSON.stringify(ld)}</script>${extraHead || ''}
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
const NAV_DOCS = `<a href="/docs/">Design docs &amp; RE notes</a>`;
const NAV_REPO = `<a href="${REPO}">GitHub</a>`;
const NAV_ARTICLES = `<a href="/articles/">Articles</a>`;

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
      out.push({ rel: `${dir}/${f}`, urlPath: `docs/${prefix}${f.replace(/\.md$/, '.html')}` });
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
      description: 'The history of Wine-Assembly, an x86 Windows 98 emulator written directly in WebAssembly Text: from the first instruction decoder to a browser that runs Notepad, Pinball, Winamp, DirectX games and 16-bit Windows apps.',
      urlPath: 'story.html', sourceRel: 'PROJECT_STORY.md',
      nav: [NAV_HOME, NAV_ARTICLES, NAV_DOCS, NAV_REPO].join(' '),
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
        nav: [NAV_HOME, NAV_ARTICLES, NAV_STORY, NAV_DOCS, NAV_REPO].join(' '),
        dates,
      }),
    });
    urls.push({ loc: `${SITE}/${a.urlPath}`, lastmod: dates.modified, priority: '0.8', changefreq: 'monthly' });
  }
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
        nav: [NAV_HOME, NAV_STORY, NAV_DOCS, NAV_REPO].join(' '),
        dates,
      }).replace('class="wrap"', 'class="wrap docs-index"'),
    });
    urls.push({ loc: `${SITE}/articles/`, lastmod: dates.modified, priority: '0.8', changefreq: 'monthly' });
  }

  // Design docs and reverse-engineering notes.
  const docs = listDocs();
  const index = [];
  for (const d of docs) {
    const md = fs.readFileSync(path.join(ROOT, d.rel), 'utf-8');
    const meta = extractMeta(md);
    const dates = { published: gitDate(d.rel, 'first'), modified: gitDate(d.rel) };
    const isIndex = d.rel === 'docs/re-notes/README.md';
    pages.push({
      name: d.urlPath,
      content: pageHtml({
        md, title: meta.title, description: meta.description,
        urlPath: d.urlPath, sourceRel: d.rel,
        nav: [NAV_HOME, NAV_ARTICLES, NAV_STORY, NAV_DOCS, NAV_REPO].join(' '),
        dates,
      }),
    });
    urls.push({ loc: `${SITE}/${d.urlPath}`, lastmod: dates.modified, priority: isIndex ? '0.5' : '0.6', changefreq: 'monthly' });
    index.push({ ...d, ...meta, dates });
  }

  // docs/index.html: the crawlable table of contents. Two sections so a
  // reader looking for "how does the emulator work" and one looking for
  // "what did you find inside Diablo" each land on the right list.
  const section = (heading, items) => `## ${heading}\n\n` + items.map(i =>
    `- [${i.title}](/${i.urlPath})${i.description ? `  \n  <small>${i.description}</small>` : ''}`).join('\n') + '\n\n';
  const design = index.filter(i => !i.rel.startsWith('docs/re-notes/'));
  const re = index.filter(i => i.rel.startsWith('docs/re-notes/') && i.rel !== 'docs/re-notes/README.md');
  const indexMd = `# Wine-Assembly design docs and reverse-engineering notes\n\n` +
    `Wine-Assembly runs real Windows 98 executables in the browser: an x86 interpreter and a Win32 API layer ` +
    `written directly in WebAssembly Text. These pages are the working notes behind it — the memory map, ` +
    `the interpreter's dispatch and lazy-flag design, the software GDI rasterizer, the DirectX and Win16 layers, ` +
    `the performance ledger, and one file per game or application we have taken apart to make it run. ` +
    `They are rendered from the Markdown in [docs/](${REPO}/tree/main/docs) on GitHub.\n\n` +
    section('Emulator design and performance', design) +
    section('Reverse-engineering notes, one per application', re);
  pages.push({
    name: 'docs/index.html',
    content: pageHtml({
      md: indexMd,
      title: 'Wine-Assembly design docs and reverse-engineering notes',
      description: 'How a Windows 98 emulator written in WebAssembly Text works: memory map, threaded-code x86 dispatch, lazy flags, software GDI, DirectX, Win16, and per-game reverse-engineering notes.',
      urlPath: 'docs/', sourceRel: 'docs',
      nav: [NAV_HOME, NAV_ARTICLES, NAV_STORY, NAV_REPO].join(' '),
      dates: { modified: new Date().toISOString().slice(0, 10) },
    }).replace('class="wrap"', 'class="wrap docs-index"'),
  });
  urls.push({ loc: `${SITE}/docs/`, priority: '0.7', changefreq: 'weekly' });

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
    console.log(`wrote ${pages.length} pages (story.html, articles/*.html, docs/**/*.html, sitemap.xml)`);
  }
}
