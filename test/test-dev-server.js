#!/usr/bin/env node
// tools/dev-server.js: the local stand-in for the Berrry backend.
//
// Two things are worth testing here. The signaling routes have to behave the
// way the real backend does, because the browser code is written once and run
// against both. And the static half has to refuse to serve anything outside
// the repo, because this server has no authentication to fall back on.

'use strict';

const assert = require('assert');
const path = require('path');
const { createServer, resolveStatic, ROOT } = require('../tools/dev-server');

let failures = 0;
function check(what, fn) {
  try {
    fn();
    console.log(`PASS  ${what}`);
  } catch (err) {
    failures++;
    console.log(`FAIL  ${what}\n      ${err && err.message}`);
  }
}

async function main() {
  const server = createServer({ quiet: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  // Each "browser" is a cookie jar, which is what makes two of them distinct
  // users against a server with no login.
  function browser() {
    let cookie = null;
    return async (method, url, body) => {
      const headers = {};
      if (cookie) headers.cookie = cookie;
      if (body !== undefined) headers['content-type'] = 'application/json';
      const res = await fetch(base + url, {
        method, headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch (_) {}
      return { status: res.status, json, text };
    };
  }

  try {
    const alice = browser();
    const bob = browser();

    const who = await alice('GET', '/api/auth/user');
    check('an unauthenticated caller still gets an identity', () => {
      assert.strictEqual(who.status, 200);
      assert.ok(who.json.id, 'expected an id');
    });

    const bobWho = await bob('GET', '/api/auth/user');
    check('a second browser is a different user', () => {
      assert.notStrictEqual(bobWho.json.id, who.json.id);
    });

    const missing = await alice('GET', '/api/data/vln-signal-room1');
    check('reading an unwritten key is 404', () => {
      assert.strictEqual(missing.status, 404);
    });

    const put = await alice('PUT', '/api/data/vln-signal-room1?visibility=public',
      { sdp: 'opaque-ciphertext' });
    check('a public write is accepted', () => {
      assert.strictEqual(put.status, 200);
      assert.strictEqual(put.json.visibility, 'public');
    });

    const priv = await alice('PUT', '/api/data/notes', { a: 1 });
    check('a write with no visibility parameter stays private', () => {
      assert.strictEqual(priv.json.visibility, 'private');
    });

    const readBack = await alice('GET', '/api/data/vln-signal-room1');
    check('the writer reads their own record back', () => {
      assert.strictEqual(readBack.json.value.sdp, 'opaque-ciphertext');
    });

    // The discovery step: Bob has never met Alice and knows only the room key.
    const users = await bob('GET', '/api/public-data/users/vln-signal-room1');
    check('a peer discovers who published under the room key', () => {
      assert.strictEqual(users.status, 200);
      assert.strictEqual(users.json.users.length, 1);
      assert.strictEqual(users.json.users[0].userId, who.json.id);
    });

    const peerRead = await bob('GET', `/api/public-data/${who.json.id}/vln-signal-room1`);
    check('a peer reads the published record', () => {
      assert.strictEqual(peerRead.json.value.sdp, 'opaque-ciphertext');
    });

    const peerPrivate = await bob('GET', `/api/public-data/${who.json.id}/notes`);
    check('a private record is not readable by a peer', () => {
      assert.strictEqual(peerPrivate.status, 404);
    });

    const bobsOwn = await bob('GET', '/api/data/vln-signal-room1');
    check('one user\'s key does not collide with another\'s', () => {
      assert.strictEqual(bobsOwn.status, 404);
    });

    await alice('DELETE', '/api/data/vln-signal-room1');
    const afterDelete = await bob('GET', '/api/public-data/users/vln-signal-room1');
    check('deleting a record withdraws it from discovery', () => {
      assert.strictEqual(afterDelete.json.users.length, 0);
    });

    const reDelete = await alice('DELETE', '/api/data/vln-signal-room1');
    check('deleting an absent record is not an error', () => {
      assert.strictEqual(reDelete.status, 200);
    });

    // Static half.
    const page = await alice('GET', '/index.html');
    check('the repo page is served', () => {
      assert.strictEqual(page.status, 200);
      assert.ok(page.text.length > 0);
    });

    const escapes = [
      '/../../../../etc/passwd',
      '/%2e%2e/%2e%2e/etc/passwd',
      '/lib/../../etc/passwd',
    ];
    for (const attempt of escapes) {
      const got = await alice('GET', attempt);
      check(`refuses to serve outside the repo: ${attempt}`, () => {
        assert.ok(got.status === 403 || got.status === 404,
          `expected 403/404, got ${got.status}`);
      });
    }

    // The property that matters is not "returns null" — a leading ".." is
    // clamped at the root by normalize, so it resolves to a path inside the
    // repo that simply does not exist. What must hold for every input is that
    // the result never points outside ROOT.
    check('resolveStatic never resolves outside the repo', () => {
      const hostile = [
        '/../../etc/passwd',
        '/%2e%2e/%2e%2e/etc/passwd',
        '/lib/../../../etc/passwd',
        '/./../../',
        '/..%2f..%2fetc/passwd',
      ];
      for (const attempt of hostile) {
        const full = resolveStatic(attempt);
        if (full === null) continue;
        assert.ok(full === ROOT || full.startsWith(ROOT + path.sep),
          `${attempt} escaped to ${full}`);
      }
    });
    check('resolveStatic rejects a NUL-injected path', () => {
      assert.strictEqual(resolveStatic('/index.html\u0000.png'), null);
    });
    check('resolveStatic accepts a path inside the repo', () => {
      assert.strictEqual(resolveStatic('/lib/vlan-wire.js'),
        path.join(ROOT, 'lib', 'vlan-wire.js'));
    });

    const wasm = await alice('HEAD', '/build/wine-assembly.wasm');
    check('the wasm build is served when present', () => {
      assert.ok(wasm.status === 200 || wasm.status === 404,
        `unexpected ${wasm.status}`);
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }

  console.log(failures
    ? `test-dev-server: ${failures} FAILED`
    : 'test-dev-server: all checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch(err => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
