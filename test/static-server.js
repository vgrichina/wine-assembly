'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');

const DEFAULT_MIME_TYPES = Object.freeze({
  '.bin': 'application/octet-stream',
  '.css': 'text/css; charset=utf-8',
  '.cue': 'text/plain; charset=utf-8',
  '.dll': 'application/octet-stream',
  '.exe': 'application/octet-stream',
  '.fon': 'application/octet-stream',
  '.gif': 'image/gif',
  '.htm': 'text/html; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.iso': 'application/octet-stream',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mid': 'audio/midi',
  '.midi': 'audio/midi',
  '.mp3': 'audio/mpeg',
  '.png': 'image/png',
  '.ppm': 'image/x-portable-pixmap',
  '.rar': 'application/vnd.rar',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.wat': 'text/plain; charset=utf-8',
  '.wav': 'audio/wav',
  '.x': 'application/octet-stream',
  '.zip': 'application/zip',
});

function insideRoot(root, candidate) {
  return candidate === root || candidate.startsWith(root + path.sep);
}

function mimeType(file, overrides = {}) {
  const ext = path.extname(file).toLowerCase();
  return overrides[ext] || DEFAULT_MIME_TYPES[ext] || 'application/octet-stream';
}

async function resolveStaticPath(root, rawUrl, options = {}) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(rawUrl || '/', 'http://127.0.0.1').pathname);
  } catch (_) {
    return { status: 400, message: 'bad url' };
  }
  if (pathname === '/') pathname = '/' + (options.index || 'index.html');
  if (options.rewritePath) pathname = options.rewritePath(pathname);
  if (typeof pathname !== 'string' || !pathname.startsWith('/')) {
    return { status: 400, message: 'bad path' };
  }

  const rootReal = fs.realpathSync(root);
  const candidate = path.resolve(rootReal, '.' + pathname);
  if (!insideRoot(rootReal, candidate)) return { status: 403, message: 'forbidden' };

  let real;
  let stat;
  try {
    real = await fs.promises.realpath(candidate);
    if (!insideRoot(rootReal, real)) return { status: 403, message: 'forbidden' };
    stat = await fs.promises.stat(real);
  } catch (error) {
    const missing = error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
    return { status: missing ? 404 : 500, message: missing ? 'not found' : 'read error' };
  }
  if (!stat.isFile()) return { status: 404, message: 'not found' };
  return { file: real, pathname, stat, status: 200 };
}

function createStaticHandler(options = {}) {
  if (!options.root) throw new TypeError('static server requires a root directory');
  const root = fs.realpathSync(options.root);
  return async function staticHandler(request, response) {
    try {
      if (options.handleRequest) {
        const handled = await options.handleRequest(request, response);
        if (handled || response.writableEnded) return;
      }
      const resolved = await resolveStaticPath(root, request.url, options);
      if (resolved.status !== 200) {
        response.writeHead(resolved.status);
        response.end(resolved.message);
        return;
      }
      const headers = {
        'Content-Type': options.mimeType
          ? options.mimeType(resolved.file)
          : mimeType(resolved.file, options.mimeTypes),
        'Content-Length': resolved.stat.size,
      };
      if (options.cacheControl !== false) {
        headers['Cache-Control'] = options.cacheControl || 'no-store';
      }
      if (options.crossOriginIsolated) {
        headers['Cross-Origin-Opener-Policy'] = 'same-origin';
        headers['Cross-Origin-Embedder-Policy'] = 'require-corp';
      }
      Object.assign(headers, typeof options.headers === 'function'
        ? options.headers(request, resolved) : (options.headers || {}));
      response.writeHead(200, headers);
      if (request.method === 'HEAD') {
        response.end();
        return;
      }
      const stream = fs.createReadStream(resolved.file);
      stream.on('error', () => response.destroy());
      stream.pipe(response);
    } catch (error) {
      if (response.headersSent) response.destroy(error);
      else {
        response.writeHead(500);
        response.end('server error');
      }
    }
  };
}

function startStaticServer(options = {}) {
  const handler = createStaticHandler(options);
  const server = http.createServer((request, response) => {
    handler(request, response);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port || 0, options.host || '127.0.0.1', () => resolve(server));
  });
}

function closeServer(server) {
  if (!server || !server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close(error => (error ? reject(error) : resolve()));
  });
}

module.exports = {
  DEFAULT_MIME_TYPES,
  closeServer,
  createStaticHandler,
  insideRoot,
  mimeType,
  resolveStaticPath,
  startStaticServer,
};
