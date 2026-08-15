#!/usr/bin/env node
// lib/vlan-rtc.js — the parts that do not need a browser.
//
// The RTCPeerConnection handshake itself needs a browser, so joinRoom is not
// exercised here. Everything it depends on is: the room secret and the key
// derived from it, the sealed envelope that keeps a world-readable record
// opaque, the signaling client against a real dev server, and the wire
// contract against a stand-in channel.

'use strict';

const assert = require('assert');
const { createServer } = require('../tools/dev-server');
const rtc = require('../lib/vlan-rtc');

const { RtcWire, SignalingClient, newRoomSecret, roomKeyFor, _internals } = rtc;
const { sealed, opened, cryptoKeyFor } = _internals;

let failures = 0;
async function check(what, fn) {
  try {
    await fn();
    console.log(`PASS  ${what}`);
  } catch (err) {
    failures++;
    console.log(`FAIL  ${what}\n      ${err && err.message}`);
  }
}

// A stand-in for RTCDataChannel: enough surface for RtcWire, and observable.
class FakeChannel {
  constructor() {
    this.readyState = 'open';
    this.bufferedAmount = 0;
    this.sent = [];
    this.closed = false;
    this.binaryType = '';
  }
  send(bytes) {
    if (this.throwOnSend) throw new Error('channel is gone');
    this.sent.push(Uint8Array.from(bytes));
  }
  close() { this.closed = true; this.readyState = 'closed'; }
  // Test helper: pretend the far side sent something.
  arrive(bytes) { if (this.onmessage) this.onmessage({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }); }
}

function frame(n) {
  const b = new Uint8Array(28 + n);
  new DataView(b.buffer).setUint32(24, n, true);
  return b;
}

async function main() {
  const server = createServer({ quiet: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    // ---- room identity ------------------------------------------------
    await check('two room secrets differ', () => {
      assert.notStrictEqual(newRoomSecret(), newRoomSecret());
    });

    const secret = newRoomSecret();
    await check('the room key is stable for a secret', async () => {
      assert.strictEqual(await roomKeyFor(secret), await roomKeyFor(secret));
    });

    await check('the room key does not contain the secret', async () => {
      const key = await roomKeyFor(secret);
      assert.ok(!key.includes(secret),
        'the signaling key must not leak the secret that decrypts it');
    });

    await check('different secrets give different room keys', async () => {
      assert.notStrictEqual(await roomKeyFor(secret), await roomKeyFor(newRoomSecret()));
    });

    // ---- the sealed envelope -------------------------------------------
    const key = await cryptoKeyFor(secret);
    await check('a sealed record round-trips', async () => {
      const env = await sealed(key, { role: 'offer', sdp: 'v=0...' });
      const back = await opened(key, env);
      assert.strictEqual(back.role, 'offer');
      assert.strictEqual(back.sdp, 'v=0...');
    });

    await check('the sealed record does not carry its plaintext', async () => {
      const env = await sealed(key, { role: 'offer', sdp: 'CANARY-SDP-VALUE' });
      assert.ok(!JSON.stringify(env).includes('CANARY-SDP-VALUE'));
      assert.ok(!JSON.stringify(env).includes('offer'));
    });

    await check('the wrong secret cannot open it', async () => {
      const env = await sealed(key, { role: 'offer', sdp: 'v=0...' });
      const other = await cryptoKeyFor(newRoomSecret());
      assert.strictEqual(await opened(other, env), null);
    });

    await check('a tampered record is refused, not returned', async () => {
      const env = await sealed(key, { role: 'offer', sdp: 'v=0...' });
      const bad = Object.assign({}, env, { ct: env.ct.slice(0, -4) + 'AAAA' });
      assert.strictEqual(await opened(key, bad), null);
    });

    await check('a record that is not an envelope is refused', async () => {
      assert.strictEqual(await opened(key, null), null);
      assert.strictEqual(await opened(key, { nope: 1 }), null);
    });

    await check('two seals of the same value differ', async () => {
      const a = await sealed(key, { x: 1 });
      const b = await sealed(key, { x: 1 });
      assert.notStrictEqual(a.ct, b.ct, 'a repeated nonce would leak equality');
    });

    // ---- signaling against the real dev server --------------------------
    // Each client gets its own cookie jar, which is what makes them two users.
    function client() {
      const jar = { cookie: null };
      const c = new SignalingClient(base);
      const origFetch = globalThis.fetch;
      c._json = async (method, url, body) => {
        const headers = {};
        if (jar.cookie) headers.cookie = jar.cookie;
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        const res = await origFetch(base + url, {
          method, headers,
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const sc = res.headers.get('set-cookie');
        if (sc) jar.cookie = sc.split(';')[0];
        if (!res.ok) return null;
        return res.json();
      };
      return c;
    }

    const alice = client();
    const bob = client();
    const roomKey = await roomKeyFor(secret);

    await check('a peer publishes and the other discovers it', async () => {
      const me = await alice.whoami();
      const bobId = (await bob.whoami()).id;
      await alice.publish(roomKey, await sealed(key, { role: 'offer', sdp: 'A' }));
      const found = await bob.publishers(roomKey);
      const others = found.users.filter(u => u.userId !== bobId);
      assert.strictEqual(others.length, 1);
      assert.strictEqual(others[0].userId, me.id);
    });

    await check('the discovered record decrypts with the room secret', async () => {
      const me = await alice.whoami();
      const rec = await bob.read(me.id, roomKey);
      const msg = await opened(key, rec.value);
      assert.strictEqual(msg.sdp, 'A');
    });

    await check('someone without the secret sees only ciphertext', async () => {
      const me = await alice.whoami();
      const rec = await bob.read(me.id, roomKey);
      const outsider = await cryptoKeyFor('a-guess');
      assert.strictEqual(await opened(outsider, rec.value), null);
    });

    await check('withdrawing removes the peer from discovery', async () => {
      await alice.withdraw(roomKey);
      const found = await bob.publishers(roomKey);
      const me = await alice.whoami();
      assert.ok(!found.users.some(u => u.userId === me.id));
    });

    // ---- scopes: one network, then channels, then rooms -----------------
    const { scopeFor, signalKeyFor } = rtc;

    await check('the default scope is one shared network', () => {
      assert.strictEqual(scopeFor({}), 'net:default');
      assert.strictEqual(scopeFor(), 'net:default');
    });

    await check('a channel scope names the executable', () => {
      assert.strictEqual(scopeFor({ exe: 'lwwin.exe' }), 'net:default/exe:lwwin.exe');
    });

    await check('the same program from two paths is one channel', () => {
      assert.strictEqual(
        scopeFor({ exe: 'test/binaries/candidates/liquid-war/LW5/lwwin.exe' }),
        scopeFor({ exe: 'LWWIN.EXE' }));
    });

    await check('a room is a subdivision of a channel', () => {
      assert.strictEqual(scopeFor({ exe: 'lwwin.exe', room: 'r1' }),
        'net:default/exe:lwwin.exe/room:r1');
    });

    await check('two programs do not share a signaling key', async () => {
      assert.notStrictEqual(
        await signalKeyFor(scopeFor({ exe: 'lwwin.exe' })),
        await signalKeyFor(scopeFor({ exe: 'doom.exe' })));
    });

    await check('a scope with no secret still yields a usable key', async () => {
      const k = await signalKeyFor(scopeFor({ exe: 'lwwin.exe' }));
      assert.ok(k.startsWith('vln-signal-'));
      assert.ok(k.length > 12);
    });

    await check('a secret changes the key of the same scope', async () => {
      const scope = scopeFor({ exe: 'lwwin.exe' });
      assert.notStrictEqual(await signalKeyFor(scope), await signalKeyFor(scope, secret));
    });

    await check('the key of a shared network is computable by anyone', async () => {
      // Not a defect — it is the definition of an open network, and the
      // design doc records what it costs. Asserted so a later change that
      // makes it secret is a deliberate one.
      assert.strictEqual(await signalKeyFor(scopeFor({})), await signalKeyFor('net:default'));
    });

    // ---- the wire contract ----------------------------------------------
    await check('an inbound message becomes a peekable frame', () => {
      const ch = new FakeChannel();
      const wire = new RtcWire(ch);
      assert.strictEqual(wire.peek(), null);
      ch.arrive(frame(4));
      assert.strictEqual(wire.pending, 1);
      assert.strictEqual(wire.peek().length, 32);
      wire.commit();
      assert.strictEqual(wire.pending, 0);
    });

    await check('the channel is put in binary mode', () => {
      const ch = new FakeChannel();
      new RtcWire(ch);
      assert.strictEqual(ch.binaryType, 'arraybuffer');
    });

    await check('a frame sent reaches the channel', () => {
      const ch = new FakeChannel();
      const wire = new RtcWire(ch);
      assert.strictEqual(wire.send(frame(2)), true);
      assert.strictEqual(ch.sent.length, 1);
      assert.strictEqual(wire.sentFrames, 1);
    });

    await check('a full channel refuses rather than buffering without bound', () => {
      const ch = new FakeChannel();
      const wire = new RtcWire(ch);
      ch.bufferedAmount = 4 << 20;
      assert.strictEqual(wire.send(frame(2)), false);
      assert.strictEqual(ch.sent.length, 0);
    });

    await check('a closed channel refuses to send', () => {
      const ch = new FakeChannel();
      const wire = new RtcWire(ch);
      ch.readyState = 'closed';
      assert.strictEqual(wire.send(frame(2)), false);
    });

    await check('a throwing channel refuses rather than propagating', () => {
      const ch = new FakeChannel();
      const wire = new RtcWire(ch);
      ch.throwOnSend = true;
      assert.strictEqual(wire.send(frame(2)), false);
    });

    await check('a non-frame message is ignored, not delivered', () => {
      const ch = new FakeChannel();
      const wire = new RtcWire(ch);
      if (ch.onmessage) ch.onmessage({ data: 'hello' });
      assert.strictEqual(wire.pending, 0);
    });

    await check('closing the wire closes the channel', () => {
      const ch = new FakeChannel();
      const wire = new RtcWire(ch);
      wire.close();
      assert.strictEqual(ch.closed, true);
      assert.strictEqual(wire.send(frame(1)), false);
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }

  console.log(failures
    ? `test-vlan-rtc: ${failures} FAILED`
    : 'test-vlan-rtc: all checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch(err => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
