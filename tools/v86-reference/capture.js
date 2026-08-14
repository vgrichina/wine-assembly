#!/usr/bin/env node
"use strict";

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");

const { generate, toDosFilename } = require("./iso9660");

const REPO_ROOT = path.resolve(__dirname, "../..");
const CACHE_ROOT = path.join(REPO_ROOT, ".cache/v86-reference");
const DEFAULT_MANIFEST = path.join(__dirname, "apps.json");
const WIN98_DISK_SIZE = 300 * 1024 * 1024;
const WIN98_CHUNK_SIZE = 256 * 1024;
const ONLINE = {
  bios: "https://raw.githubusercontent.com/copy/v86/f3d4472a9c934b9ad78a311f5849ba711a296d23/bios/seabios.bin",
  vgaBios: "https://raw.githubusercontent.com/copy/v86/f3d4472a9c934b9ad78a311f5849ba711a296d23/bios/vgabios.bin",
  disk: "https://i.copy.sh/windows98/.img",
  state: "https://i.copy.sh/windows98_state-v2.bin.zst",
};

function usage() {
  console.log(`Usage: node tools/v86-reference/capture.js [options]

Options:
  --app ID             App from apps.json (default: geometry-probe)
  --manifest PATH      Alternate app manifest (default: tools/v86-reference/apps.json)
  --output PATH        VGA screenshot path
  --metadata PATH      Capture metadata path
  --online             Load BIOS, Win98 disk chunks, and state from documented URLs
  --bios PATH          Local SeaBIOS image
  --vgabios PATH       Local VGA BIOS image
  --disk PATH          Local full Win98 hard disk image
  --state PATH         Local Win98 v86 state (.bin or .bin.zst)
  --browser PATH       Chrome/Chromium executable (or set CHROME_BIN)
  --no-state           Boot the disk instead of restoring a state
  --wait-ms N          Override app settle time
  --boot-timeout-ms N  VM initialization timeout (default: 180000)
  --headed             Show the Chromium window
  --list               List configured apps
  --help               Show this help`);
}

function parseArgs(argv) {
  const options = {
    app: "geometry-probe",
    online: false,
    noState: false,
    headed: false,
    bootTimeoutMs: 180000,
  };
  const valueOptions = new Map([
    ["--app", "app"],
    ["--manifest", "manifest"],
    ["--output", "output"],
    ["--metadata", "metadata"],
    ["--bios", "bios"],
    ["--vgabios", "vgaBios"],
    ["--disk", "disk"],
    ["--state", "state"],
    ["--browser", "browser"],
    ["--wait-ms", "waitMs"],
    ["--boot-timeout-ms", "bootTimeoutMs"],
  ]);
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (valueOptions.has(argument)) {
      if (++index >= argv.length) throw new Error(`${argument} requires a value`);
      options[valueOptions.get(argument)] = argv[index];
    } else if (argument === "--online") {
      options.online = true;
    } else if (argument === "--no-state") {
      options.noState = true;
    } else if (argument === "--headed") {
      options.headed = true;
    } else if (argument === "--list") {
      options.list = true;
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else {
      throw new Error(`unknown option: ${argument}`);
    }
  }
  options.waitMs = options.waitMs === undefined ? undefined : positiveInteger(options.waitMs, "--wait-ms");
  options.bootTimeoutMs = positiveInteger(options.bootTimeoutMs, "--boot-timeout-ms");
  return options;
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${name} must be a positive integer`);
  return number;
}

function resolveRepoPath(value) {
  return path.resolve(REPO_ROOT, value);
}

function requireFile(filename, description) {
  if (!fs.existsSync(filename) || !fs.statSync(filename).isFile()) {
    throw new Error(`${description} not found: ${filename}`);
  }
  return filename;
}

function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function sha256File(filename) {
  return sha256(fs.readFileSync(filename));
}

function buildProbe(entry) {
  const source = resolveRepoPath(entry.probeSource);
  const output = path.join(CACHE_ROOT, `${entry.id}.exe`);
  fs.mkdirSync(CACHE_ROOT, { recursive: true });
  if (fs.existsSync(output) && fs.statSync(output).mtimeMs >= fs.statSync(source).mtimeMs) return output;

  const zigEnvResult = childProcess.spawnSync("zig", ["env"], { encoding: "utf8" });
  if (zigEnvResult.error) throw zigEnvResult.error;
  if (zigEnvResult.status !== 0) throw new Error(`zig env failed: ${zigEnvResult.stderr}`);
  const zigEnv = JSON.parse(zigEnvResult.stdout);
  const windowsHeaders = path.join(zigEnv.lib_dir, "libc/include/any-windows-any");
  const result = childProcess.spawnSync("zig", [
    "cc",
    "-target", "x86-windows-gnu",
    "-fno-stack-protector",
    "-nostdlib",
    "-isystem", windowsHeaders,
    source,
    "-Wl,--entry,WinMainCRTStartup",
    "-Wl,--subsystem,windows",
    "-Wl,--major-os-version,4",
    "-Wl,--minor-os-version,0",
    "-Wl,--major-subsystem-version,4",
    "-Wl,--minor-subsystem-version,0",
    "-lkernel32",
    "-luser32",
    "-lgdi32",
    "-o", output,
  ], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      ZIG_LOCAL_CACHE_DIR: path.join(CACHE_ROOT, "zig-local"),
      ZIG_GLOBAL_CACHE_DIR: path.join(CACHE_ROOT, "zig-global"),
    },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`probe build failed (${result.status})\n${result.stdout}${result.stderr}`);
  }
  return output;
}

function preparePayload(entry) {
  const specifications = [];
  if (entry.probeSource) {
    specifications.push({ path: buildProbe(entry), name: entry.probeName || "PROBE.EXE" });
  }
  specifications.push(...entry.files);

  const usedNames = new Set();
  const files = specifications.map(specification => {
    const descriptor = typeof specification === "string"
      ? { path: specification, name: path.basename(specification) }
      : specification;
    const filename = requireFile(resolveRepoPath(descriptor.path), "payload file");
    const guestName = toDosFilename(descriptor.name || path.basename(filename));
    if (usedNames.has(guestName)) throw new Error(`duplicate ISO name ${guestName}`);
    usedNames.add(guestName);
    const contents = fs.readFileSync(filename);
    return { name: guestName, contents, source: filename, sha256: sha256(contents) };
  });
  return {
    iso: generate(files),
    files: files.map(({ name, source, sha256: hash }) => ({ name, source, sha256: hash })),
  };
}

function localOrOnline(options, key, fallbackName) {
  if (options[key]) return { type: "local", value: requireFile(path.resolve(options[key]), key) };
  const cached = path.join(CACHE_ROOT, fallbackName);
  if (fs.existsSync(cached)) return { type: "local", value: cached };
  if (options.online) return { type: "remote", value: ONLINE[key] };
  throw new Error(`missing ${key}; pass --${key.toLowerCase()}, use ${cached}, or select --online`);
}

function createServer(routes, proxyPrefixes) {
  const server = http.createServer((request, response) => {
    try {
      const pathname = new URL(request.url, "http://127.0.0.1").pathname;
      const route = routes.get(pathname);
      if (!route) {
        const proxy = proxyPrefixes.find(candidate => pathname.startsWith(candidate.local));
        if (proxy) {
          const suffix = pathname.slice(proxy.local.length);
          serveProxy(request, response, new URL(suffix, proxy.remote));
          return;
        }
        response.writeHead(404, { "Content-Type": "text/plain" });
        response.end("not found\n");
        return;
      }
      serveRoute(request, response, route);
    } catch (error) {
      response.writeHead(500, { "Content-Type": "text/plain" });
      response.end(`${error.stack || error}\n`);
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function serveProxy(request, response, url) {
  const transport = url.protocol === "https:" ? https : http;
  const headers = {
    "User-Agent": "wine-assembly-v86-reference/1",
  };
  if (request.headers.range) headers.Range = request.headers.range;
  const upstream = transport.request(url, { method: request.method, headers }, upstreamResponse => {
    const forwarded = {};
    for (const name of ["accept-ranges", "content-length", "content-range", "content-type", "etag", "last-modified"]) {
      if (upstreamResponse.headers[name] !== undefined) forwarded[name] = upstreamResponse.headers[name];
    }
    response.writeHead(upstreamResponse.statusCode, forwarded);
    upstreamResponse.pipe(response);
  });
  upstream.on("error", error => {
    if (!response.headersSent) response.writeHead(502, { "Content-Type": "text/plain" });
    response.end(`${error.message}\n`);
  });
  upstream.end();
}

function serveRoute(request, response, route) {
  const size = route.buffer ? route.buffer.length : fs.statSync(route.path).size;
  const range = parseRange(request.headers.range, size);
  const start = range ? range.start : 0;
  const end = range ? range.end : size - 1;
  const headers = {
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
    "Content-Length": Math.max(0, end - start + 1),
    "Content-Type": route.type || "application/octet-stream",
  };
  if (range) headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
  response.writeHead(range ? 206 : 200, headers);
  if (request.method === "HEAD") return response.end();
  if (route.buffer) return response.end(route.buffer.subarray(start, end + 1));
  fs.createReadStream(route.path, { start, end }).pipe(response);
}

function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d+)-(\d*)$/.exec(header);
  if (!match) throw new Error(`unsupported range: ${header}`);
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : size - 1;
  if (start < 0 || end < start || end >= size) throw new Error(`invalid range: ${header}`);
  return { start, end };
}

function addFileRoute(routes, url, filename, type) {
  routes.set(url, { path: requireFile(filename, url), type });
  return url;
}

function withTimeout(promise, milliseconds, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds} ms`)), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

function findBrowser(explicit) {
  const candidates = [
    explicit,
    process.env.CHROME_BIN,
    process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : null,
    process.platform === "linux" ? "/usr/bin/google-chrome" : null,
    process.platform === "linux" ? "/usr/bin/chromium" : null,
    process.platform === "linux" ? "/usr/bin/chromium-browser" : null,
  ].filter(Boolean);
  return candidates.find(filename => fs.existsSync(filename));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const manifestPath = options.manifest ? path.resolve(options.manifest) : DEFAULT_MANIFEST;
  const apps = JSON.parse(fs.readFileSync(
    requireFile(manifestPath, "app manifest"), "utf8")).apps;
  if (options.help) return usage();
  if (options.list) {
    for (const [id, app] of Object.entries(apps)) {
      console.log(`${id.padEnd(20)} ${app.skip ? "[skip] " : "       "}${app.title}`);
    }
    return;
  }

  const entry = apps[options.app];
  if (!entry) throw new Error(`unknown app ${options.app}; use --list`);
  if (entry.skip) throw new Error(`${options.app} is excluded from this profile: ${entry.skip}`);
  entry.id = options.app;
  const output = path.resolve(options.output || path.join(
    REPO_ROOT,
    `screenshots/v86-reference/generated/${options.app}.png`
  ));
  const metadataPath = path.resolve(options.metadata || output.replace(/\.png$/i, ".json"));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.mkdirSync(path.dirname(metadataPath), { recursive: true });

  const runtimeRoot = path.join(REPO_ROOT, "node_modules/v86/build");
  const routes = new Map();
  const proxyPrefixes = [];
  addFileRoute(routes, "/", path.join(__dirname, "harness.html"), "text/html; charset=utf-8");
  addFileRoute(routes, "/harness.js", path.join(__dirname, "harness.js"), "text/javascript; charset=utf-8");
  addFileRoute(routes, "/runtime/libv86.js", path.join(runtimeRoot, "libv86.js"), "text/javascript; charset=utf-8");
  addFileRoute(routes, "/runtime/v86.wasm", path.join(runtimeRoot, "v86.wasm"), "application/wasm");
  routes.set("/favicon.ico", { buffer: Buffer.alloc(0), type: "image/x-icon" });

  const runtimePackage = require(path.join(REPO_ROOT, "node_modules/v86/package.json"));
  if (runtimePackage.version !== "0.5.432+gf3d4472") {
    throw new Error(`expected v86 0.5.432+gf3d4472, found ${runtimePackage.version}`);
  }

  const bios = localOrOnline(options, "bios", "seabios.bin");
  const vgaBios = localOrOnline(options, "vgaBios", "vgabios.bin");
  const disk = options.disk
    ? { type: "local", value: requireFile(path.resolve(options.disk), "disk") }
    : (fs.existsSync(path.join(CACHE_ROOT, "windows98.img"))
      ? { type: "local", value: path.join(CACHE_ROOT, "windows98.img") }
      : (options.online ? { type: "remote", value: ONLINE.disk } : null));
  if (!disk) throw new Error("missing disk; pass --disk, cache windows98.img, or select --online");
  const state = options.noState ? null : localOrOnline(options, "state", "windows98_state-v2.bin.zst");
  const payload = preparePayload(entry);
  routes.set("/payload.iso", { buffer: payload.iso, type: "application/x-iso9660-image" });

  const sourceUrl = (asset, local, remote) => {
    if (asset.type === "local") return addFileRoute(routes, local, asset.value);
    proxyPrefixes.push({ local, remote });
    return local;
  };

  const vmConfig = {
    memorySize: 128 * 1024 * 1024,
    vgaMemorySize: 8 * 1024 * 1024,
    biosUrl: sourceUrl(bios, "/asset/seabios.bin", bios.value),
    vgaBiosUrl: sourceUrl(vgaBios, "/asset/vgabios.bin", vgaBios.value),
    hda: disk.type === "remote" ? {
      url: "/remote/windows98/.img",
      size: WIN98_DISK_SIZE,
      async: true,
      use_parts: true,
      fixed_chunk_size: WIN98_CHUNK_SIZE,
    } : {
      url: addFileRoute(routes, "/asset/windows98.img", disk.value),
      size: fs.statSync(disk.value).size,
      async: true,
    },
    stateUrl: state
      ? sourceUrl(state, "/asset/windows98_state-v2.bin.zst", state.value)
      : null,
  };
  if (disk.type === "remote") {
    proxyPrefixes.push({ local: "/remote/windows98/", remote: "https://i.copy.sh/windows98/" });
  }

  const server = await createServer(routes, proxyPrefixes);
  const port = server.address().port;
  let browser;
  try {
    const puppeteer = require("puppeteer");
    const executablePath = findBrowser(options.browser);
    browser = await puppeteer.launch({
      headless: !options.headed,
      ...(executablePath ? { executablePath } : {}),
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--autoplay-policy=no-user-gesture-required"],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 640, height: 480, deviceScaleFactor: 1 });
    page.on("console", message => console.log(`[browser:${message.type()}] ${message.text()}`));
    page.on("pageerror", error => console.error(`[browser:error] ${error.message}`));
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "load", timeout: 30000 });
    console.log(`Starting Windows 98 reference VM for ${options.app}`);
    await withTimeout(page.evaluate(config => window.startReferenceVm(config), vmConfig), options.bootTimeoutMs, "VM initialization");
    await page.waitForFunction(() => {
      const canvas = document.querySelector("#screen_container canvas");
      return canvas && canvas.width === 640 && canvas.height === 480 && getComputedStyle(canvas).display !== "none";
    }, { timeout: options.bootTimeoutMs });
    await page.evaluate(() => window.referenceVm.insertCd("/payload.iso"));
    await new Promise(resolve => setTimeout(resolve, 1000));
    await page.evaluate(command => window.referenceVm.run(command), entry.launch);
    for (const action of entry.postLaunch || []) {
      await new Promise(resolve => setTimeout(resolve, action.waitMs || 0));
      if (action.scancodes) {
        await page.evaluate(scancodes => window.emulator.keyboard_send_scancodes(scancodes, 20), action.scancodes);
      }
    }
    const waitMs = options.waitMs === undefined ? (entry.waitMs || 8000) : options.waitMs;
    await new Promise(resolve => setTimeout(resolve, waitMs));

    const screen = await page.evaluate(() => window.referenceVm.screen());
    const canvas = await page.$("#screen_container canvas");
    await canvas.screenshot({ path: output });
    const screenshotHash = sha256File(output);
    const metadata = {
      schemaVersion: 1,
      capturedAt: new Date().toISOString(),
      app: { id: options.app, title: entry.title, launch: entry.launch },
      display: screen,
      output: path.relative(REPO_ROOT, output),
      screenshotSha256: screenshotHash,
      v86: {
        package: "v86@0.5.432",
        embeddedVersion: runtimePackage.version,
        upstreamCommit: "f3d4472a9c934b9ad78a311f5849ba711a296d23",
      },
      sources: {
        bios: bios.value,
        vgaBios: vgaBios.value,
        disk: disk.value,
        state: state && state.value,
      },
      payload: payload.files.map(file => ({
        name: file.name,
        source: path.relative(REPO_ROOT, file.source),
        sha256: file.sha256,
      })),
    };
    fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
    console.log(`Screenshot: ${output}`);
    console.log(`Metadata:   ${metadataPath}`);
    console.log(`SHA-256:    ${screenshotHash}`);
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
