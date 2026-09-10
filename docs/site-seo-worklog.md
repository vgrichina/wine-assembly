# Site and SEO work: what is built, how it is generated, what is left
<!-- description: The public site of Wine-Assembly: how the app, article, design and story pages are generated, what was done to make them findable, and the open list. -->

The live site is https://wine-assembly.berrry.app. Everything below `index.html` (the desktop) is static HTML written by one script, so this page is both the map of that machinery and the running worklog. Pick it up from **Remaining** when continuing.

## How the pages are made

`node tools/gen-site-pages.js` writes every page (about 160) and `sitemap.xml`. The generated files are gitignored except `story.html`; `tools/deploy-berrry.js --update` regenerates and uploads them, so a deploy is the publish step and nothing needs committing besides the sources below.

| Output | Source | Notes |
|---|---|---|
| `apps/<id>.html`, `apps/index.html` | `lib/apps.js` desktop set, `tools/site-app-blurbs.json` (blurb per app, `_skip` list), `tools/site-app-faq.json` (`controls` per app, `_sound` per app) | Screenshot from `screenshots/apps/<id>.png`; OG card built into `screenshots/og/` by `tools/gen-og-images.js` |
| `articles/<slug>.html` | `articles/*.md`, order from `articles/README.md` | Description from the `<!-- description: ... -->` comment under the H1; mermaid fences become `<pre class="mermaid">` and the page loads mermaid only when it has one |
| `design/index.html` | `articles/README.md` body + the `docs/` and `docs/re-notes/` listings | The one hub in the nav; `/articles/` and `/docs/` still serve but declare it canonical |
| `docs/**/*.html` | `docs/**/*.md` | Listed automatically; this file is one of them |
| `story.html` | `docs/story.md` | Committed, unlike the rest |
| `sitemap.xml` | all of the above | `lastmod` from git history |

Rules the generator enforces, so new content follows them for free:

- **Descriptions** are at most 158 characters. Write the comment under the H1; the fallback cuts the first paragraph at a sentence end and is worse. `desc-lengths` style checks are one grep away: `grep -o 'name="description" content="[^"]*"' <page>`.
- **One nav**: Home, Apps, Design, The Story, GitHub. Do not add a page to it; link from the hub instead.
- **Diagrams** must be `TD`/`TB` flowcharts or sequence diagrams; a wide `LR` chain scales down to unreadable in the 710px column.
- **Screenshots** are cropped to the window by `tools/png-crop-desktop.js` inside `tools/screenshot-registry.sh` (`SHOT_CROP=0` opts out). An OG card is a 1200x630 teal card around the shot.
- **App pages** carry `SoftwareApplication` and `FAQPage` JSON-LD. The FAQ answers are built from facts (touch layout, exe format, localStorage persistence, the audio host) plus the per-app strings in `tools/site-app-faq.json`. Only write an answer that was measured; "not verified" is a valid answer.

## What was done (2026-09-04 to 2026-09-09)

- Meta tags, Open Graph, JSON-LD, sitemap, robots, canonical links on every page.
- README gallery and the story page.
- 12 articles, each with at least one mermaid diagram, plus three comparison articles (vs v86, vs Boxedwine, vs DOSBox and js-dos) written from this side with the other project's docs named as the reference.
- 35 per-app pages with window-focused screenshots, per-app OG cards, an About table, a How it runs section, RE-notes links, siblings under the same group, and a Questions section.
- Sound answers per app from a measured sweep (static imports + `--trace-api` on the audio APIs + a read of `lib/host-audio.js`). That sweep found and fixed two emulator gaps: `PlaySoundA` accepted file and memory sounds silently (now real, and a new `PlaySound` stops the previous one; `test/test-playsound-forms.js`), and Bricks shipped without its WAV files (recovered from the author's site through the Wayback Machine, see `test/binaries/SOURCES.md`).
- Nav collapsed to five entries; the Design hub replaced separate article and doc indexes.
- Hand-written descriptions on every article and hub page.
- The desktop's intro text moved from an off-screen header into a draggable Win98-styled Read Me window that opens on a first visit, with a desktop icon and a Start menu entry (`index.html`, `#readme-window`).
- Articles in README order with a dateline and a Previous/Next pager; a Start here list of five pages at the top of the hub.

## Remaining

Ranked by search value per hour. The first two need a machine that is not running other sweeps; the rest are the site owner's.

1. **"What works" badges on `/apps/`**: sound, phone controls, saved state, one small badge each per card, from a repeatable sweep rather than a hand list. The sound sweep is the template. Feed the same facts into `featureList` on the app pages' JSON-LD.
2. **Short clips per app with `VideoObject` JSON-LD**: 3 to 5 seconds each, recorded headful (headless frame timing is not real), served beside the OG cards. Hold until the apps whose input paths are still rough would not record a still frame.
3. **Deploy and submit**: build green, `node tools/deploy-berrry.js --update`, then `/sitemap.xml` to Google Search Console and Bing Webmaster Tools, a Rich Results test on one `apps/` URL (expect `SoftwareApplication` and `FAQPage`), and a link-preview check on the same URL for the OG card.
4. **Outreach**: the comparison pages are the hook for Hacker News and the emulation subreddits. Wait for the deploy so the first visitors see the finished pages.

Skipped on purpose: crawlable launch links (the apps index already links every app page, each carrying the launch link), re-shooting the demoscene entries, Core Web Vitals work, cross-links into the toy VM mini-site.

## Verifying a change

- `node tools/gen-site-pages.js` and read the last line (page count).
- Description lengths: any page over 158 characters is a bug; check the pages you touched.
- Mermaid: open the page in a browser or run a puppeteer render and count `svg` elements against `pre.mermaid` blocks; a parse error renders an error box, not nothing.
- App pages: `grep -c FAQPage apps/<id>.html` should be 1; the Questions section should have six or seven `h3`s.
- The Read Me window: a first visit to `/` shows it, OK hides it and a reload keeps it hidden, `/?app=sol` never shows it, it drags by the title bar and stops at the desktop edge.
