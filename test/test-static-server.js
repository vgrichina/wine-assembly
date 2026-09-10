#!/usr/bin/env node

'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const {
  closeServer,
  mimeType,
  resolveStaticPath,
  startStaticServer,
} = require('./static-server');

function request(port, pathname, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        body: Buffer.concat(chunks).toString('utf8'),
        headers: response.headers,
        status: response.statusCode,
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

(async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-static-server-'));
  const root = path.join(parent, 'root');
  fs.mkdirSync(path.join(root, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(root, 'index.html'), '<h1>index</h1>');
  fs.writeFileSync(path.join(root, 'nested', 'hello world.js'), 'hello');
  fs.writeFileSync(path.join(parent, 'outside.txt'), 'secret');
  try {
    assert.strictEqual(mimeType('x.WASM'), 'application/wasm');
    assert.strictEqual(mimeType('x.unknown'), 'application/octet-stream');
    assert.strictEqual(mimeType('x.bin', { '.bin': 'test/custom' }), 'test/custom');

    assert.strictEqual((await resolveStaticPath(root, '/')).file,
      fs.realpathSync(path.join(root, 'index.html')));
    assert.strictEqual((await resolveStaticPath(root, '/nested/hello%20world.js')).status, 200);
    assert.strictEqual((await resolveStaticPath(root, '/missing')).status, 404);
    assert.strictEqual((await resolveStaticPath(root, '/nested')).status, 404);
    assert.strictEqual((await resolveStaticPath(root, '/..%2Foutside.txt')).status, 403);
    assert.strictEqual((await resolveStaticPath(root, '/bad%')).status, 400);
    assert.strictEqual((await resolveStaticPath(root, '/virtual', {
      rewritePath: pathname => pathname === '/virtual' ? '/index.html' : pathname,
    })).status, 200);

    try {
      fs.symlinkSync(path.join(parent, 'outside.txt'), path.join(root, 'outside-link'));
      assert.strictEqual((await resolveStaticPath(root, '/outside-link')).status, 403,
        'a symlink must not escape the served root');
    } catch (error) {
      if (!error || !['EPERM', 'EACCES'].includes(error.code)) throw error;
    }

    const server = await startStaticServer({ root, crossOriginIsolated: true });
    try {
      const port = server.address().port;
      const index = await request(port, '/');
      assert.strictEqual(index.status, 200);
      assert.strictEqual(index.body, '<h1>index</h1>');
      assert.match(index.headers['content-type'], /^text\/html/);
      assert.strictEqual(index.headers['cache-control'], 'no-store');
      assert.strictEqual(index.headers['cross-origin-opener-policy'], 'same-origin');
      assert.strictEqual(index.headers['cross-origin-embedder-policy'], 'require-corp');
      const head = await request(port, '/nested/hello%20world.js', 'HEAD');
      assert.strictEqual(head.status, 200);
      assert.strictEqual(head.body, '');
      assert.strictEqual(Number(head.headers['content-length']), 5);
      assert.strictEqual((await request(port, '/..%2Foutside.txt')).status, 403);
    } finally {
      await closeServer(server);
    }
    console.log('PASS  shared static test server is typed, no-store, isolated, and traversal-safe');
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
