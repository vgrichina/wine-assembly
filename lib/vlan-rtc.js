// Virtual LAN over WebRTC — docs/virtual-lan-party.md
//
// lib/vlan-wire.js defines what a wire owes the emulator: send, peek, commit.
// LoopbackWire satisfies it inside one process and ProcessWire across two on
// one machine. This is the third: two browsers, two people, one room.
//
// Nothing in WAT changes to support it. The guest still sees a room address
// and a byte stream; the frame is the contract, and this file only moves
// frames between machines.
//
// Two parts live here:
//
//   RtcWire     a Wire whose transport is an RTCDataChannel
//   joinRoom()  the introduction: what each side publishes, and where
//
// The DataChannel is configured ordered and fully reliable. That is not the
// obvious choice for a game — an action game would normally want unreliable
// delivery so a late packet is dropped rather than delaying the ones behind
// it. It is the right choice here because what travels is a TCP byte stream
// the guest believes is TCP: dropping or reordering a byte is not a dropped
// frame of animation, it is a corrupted protocol stream. The reliability the
// guest assumes has to come from somewhere, and the DataChannel provides it
// for free.

(function (root, factory) {
  const wire = (typeof require === 'function')
    ? require('./vlan-wire')
    : root.VlanWire;
  const mod = factory(wire);
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.VlanRtc = mod;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (VlanWire) {
  'use strict';

  const { Wire } = VlanWire;

  // How long to wait for the other side to show up before giving up. A person
  // opening a second browser takes a few seconds; a person who was never
  // coming takes forever, and the caller needs to be able to say so.
  const DEFAULT_JOIN_TIMEOUT_MS = 60000;
  const POLL_INTERVAL_MS = 1000;

  // Public STUN only. There is no TURN here, which means two peers behind
  // symmetric NATs will fail to connect and there is nothing this file can do
  // about it — relaying someone else's game traffic needs a server somebody
  // pays for. joinRoom reports that case as a distinct failure rather than a
  // generic timeout, so the UI can say something true about it.
  const DEFAULT_ICE = [{ urls: 'stun:stun.l.google.com:19302' }];

  class RtcWire extends Wire {
    constructor(channel) {
      super();
      this.channel = channel;
      this.closed = false;
      channel.binaryType = 'arraybuffer';
      channel.onmessage = (ev) => {
        const data = ev.data;
        // A peer that sends something that is not a frame is not a peer we
        // can talk to; ignoring it keeps a malformed sender from stopping
        // the guest, which has no way to report it.
        if (data instanceof ArrayBuffer) this.deliver(new Uint8Array(data));
        else if (ArrayBuffer.isView(data)) this.deliver(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      };
      channel.onclose = () => { this.closed = true; };
      channel.onerror = () => { this.closed = true; };
    }

    send(bytes) {
      if (this.closed || this.channel.readyState !== 'open') return false;
      // Backpressure is real here in a way it is not on a loopback: the
      // channel buffers, and a guest that outruns the link would grow that
      // buffer without bound. Refusing the frame makes the guest's own send
      // block, which is exactly what a real socket would do.
      if (this.channel.bufferedAmount > 1 << 20) return false;
      try {
        this.channel.send(bytes);
      } catch (_) {
        return false;
      }
      this.sentFrames++;
      return true;
    }

    close() {
      this.closed = true;
      try { this.channel.close(); } catch (_) {}
    }
  }

  // ---- room secrets -----------------------------------------------------
  //
  // A published signaling record is world-readable. Anyone who can guess the
  // room key can read what is under it, and on the real backend they do not
  // even have to guess — the discovery route lists every publisher. So the
  // secret that protects a room travels in the URL fragment, which browsers
  // do not send to servers, and everything published is encrypted under it.
  //
  // The room key is derived from the secret by hashing, so publishing under
  // it does not reveal the secret that decrypts it.

  const enc = new TextEncoder();
  const dec = new TextDecoder();

  function b64url(bytes) {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function unb64url(text) {
    const s = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  function newRoomSecret() {
    return b64url(crypto.getRandomValues(new Uint8Array(16)));
  }

  // A scope names the segment two peers are trying to share. All three tiers
  // in docs/virtual-lan-party.md are the same string with more of it filled
  // in, so nothing downstream branches on which tier is in use:
  //
  //   scopeFor({})                        one network, everyone signed in
  //   scopeFor({exe: 'lwwin.exe'})        a per-program channel
  //   scopeFor({exe: 'lwwin.exe', room})  a named room inside that channel
  //
  // The executable is folded to lower case and stripped of any directory,
  // because the same program launched from two paths is still the same game.
  function scopeFor(opts) {
    const o = opts || {};
    const parts = ['net:' + (o.network || 'default')];
    if (o.exe) parts.push('exe:' + String(o.exe).replace(/^.*[\\/]/, '').toLowerCase());
    if (o.room) parts.push('room:' + o.room);
    return parts.join('/');
  }

  // The key a scope publishes under. A secret, when there is one, is folded in
  // before hashing, so a room's key cannot be computed by someone who knows
  // only which channel it is in — and the key still does not reveal the secret
  // that decrypts what is published under it.
  async function signalKeyFor(scope, secret) {
    const material = secret ? `${scope}#${secret}` : scope;
    const digest = await crypto.subtle.digest('SHA-256', enc.encode('vln-scope:' + material));
    return 'vln-signal-' + b64url(new Uint8Array(digest)).slice(0, 22);
  }

  // Back-compat spelling for a secret-only room with no channel above it.
  function roomKeyFor(secret) {
    return signalKeyFor(scopeFor({}), secret);
  }

  async function cryptoKeyFor(secret) {
    const material = await crypto.subtle.importKey(
      'raw', enc.encode(secret), 'HKDF', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('vln-signal'), info: enc.encode('sdp') },
      material,
      { name: 'AES-GCM', length: 256 },
      false, ['encrypt', 'decrypt']);
  }

  async function sealed(key, obj) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj)));
    return { iv: b64url(iv), ct: b64url(new Uint8Array(ct)) };
  }

  async function opened(key, envelope) {
    if (!envelope || !envelope.iv || !envelope.ct) return null;
    try {
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: unb64url(envelope.iv) }, key, unb64url(envelope.ct));
      return JSON.parse(dec.decode(plain));
    } catch (_) {
      // Someone else's room, or a stale record from a previous secret. Not an
      // error: the caller is polling a shared key and other rooms may use it.
      return null;
    }
  }

  // ---- signaling client -------------------------------------------------

  class SignalingClient {
    constructor(base) { this.base = base || ''; }

    async _json(method, url, body) {
      const res = await fetch(this.base + url, {
        method,
        credentials: 'include',
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (res.status === 401) {
        throw Object.assign(new Error('not signed in'), { needsLogin: true });
      }
      if (!res.ok) return null;
      return res.json();
    }

    whoami() { return this._json('GET', '/api/auth/user'); }
    publish(key, value) { return this._json('PUT', `/api/data/${encodeURIComponent(key)}?visibility=public`, value); }
    withdraw(key) { return this._json('DELETE', `/api/data/${encodeURIComponent(key)}`); }
    publishers(key) { return this._json('GET', `/api/public-data/users/${encodeURIComponent(key)}`); }
    read(userId, key) {
      return this._json('GET', `/api/public-data/${encodeURIComponent(userId)}/${encodeURIComponent(key)}`);
    }
  }

  // ---- the introduction -------------------------------------------------

  // Gather ICE candidates to completion before publishing, rather than
  // trickling them through the signaling store. Trickle would connect faster,
  // but it needs a message channel that can push; this store is polled, so
  // each trickled candidate would cost a round of polling by both sides. One
  // complete description in each direction is two writes and two reads.
  function gathered(pc) {
    return new Promise(resolve => {
      if (pc.iceGatheringState === 'complete') return resolve();
      const check = () => {
        if (pc.iceGatheringState === 'complete') {
          pc.removeEventListener('icegatheringstatechange', check);
          resolve();
        }
      };
      pc.addEventListener('icegatheringstatechange', check);
      // Some candidates never resolve (a TURN server that is not there), and
      // the ones already gathered are usually enough. Publish rather than
      // wait forever.
      setTimeout(() => {
        pc.removeEventListener('icegatheringstatechange', check);
        resolve();
      }, 5000);
    });
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function connected(pc, channel, timeoutMs) {
    return new Promise((resolve, reject) => {
      const done = (fn, arg) => {
        clearTimeout(timer);
        pc.removeEventListener('connectionstatechange', onState);
        fn(arg);
      };
      const timer = setTimeout(() => done(reject, Object.assign(
        new Error('the connection could not be established'),
        // Both sides published and read each other, so the introduction
        // worked and the direct path did not. That is the NAT case, and it
        // needs a relay this project does not run.
        { needsRelay: true })), timeoutMs);
      const onState = () => {
        if (pc.connectionState === 'failed') {
          done(reject, Object.assign(new Error('the connection failed'), { needsRelay: true }));
        }
      };
      pc.addEventListener('connectionstatechange', onState);
      if (channel.readyState === 'open') return done(resolve);
      channel.onopen = () => done(resolve);
    });
  }

  // Join a room and return a wire once the far side is there.
  //
  // Both browsers run this same call with the same secret. Which one offers
  // and which one answers is decided by who published first, so neither side
  // has to be told it is the host: the first to arrive waits, the second
  // answers what it finds.
  async function joinRoom(options) {
    const opts = options || {};
    const signaling = opts.signaling || new SignalingClient(opts.apiBase || '');
    const timeoutMs = opts.timeoutMs || DEFAULT_JOIN_TIMEOUT_MS;
    const iceServers = opts.iceServers || DEFAULT_ICE;
    const onStatus = opts.onStatus || (() => {});
    const deadline = Date.now() + timeoutMs;

    // A secret is what a *room* has. A network open to everyone signed in has
    // none, and that is the first tier being shipped, so its absence is the
    // normal case rather than an error. What changes without one is only
    // whether the published description is encrypted — and it must not
    // pretend to be. See "What one shared network gives up" in the design doc:
    // an unencrypted offer exposes this peer's addresses to every signed-in
    // user, which is the accepted cost of having no matchmaking step.
    const secret = opts.secret || null;
    const scope = opts.scope || scopeFor(opts);
    const key = await signalKeyFor(scope, secret);
    const crypt = secret ? await cryptoKeyFor(secret) : null;
    const wrap = msg => (crypt ? sealed(crypt, msg) : Promise.resolve(msg));
    // Without a secret every reader is entitled, so a record is taken at face
    // value — but only if it looks like one of ours, since a shared key is a
    // shared namespace and anything at all may be published under it.
    const unwrap = value => (crypt
      ? opened(crypt, value)
      : Promise.resolve(value && typeof value.sdp === 'string' && typeof value.role === 'string'
        ? value : null));
    const me = await signaling.whoami();
    const myId = me && me.id;
    if (!myId) throw new Error('joinRoom: the signaling service did not identify us');

    // Who else is already here? Anyone but us.
    const others = async () => {
      const list = await signaling.publishers(key);
      return ((list && list.users) || []).filter(u => u.userId !== myId);
    };

    const pc = new RTCPeerConnection({ iceServers });
    let cleanupKey = key;
    const cleanup = () => { signaling.withdraw(cleanupKey).catch(() => {}); };

    try {
      const waiting = await others();

      if (waiting.length === 0) {
        // First in: offer, publish, and wait to be answered.
        onStatus('waiting for someone to join');
        const channel = pc.createDataChannel('vln', { ordered: true });
        const wire = new RtcWire(channel);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await gathered(pc);
        await signaling.publish(key, await wrap({
          role: 'offer', sdp: pc.localDescription.sdp, at: Date.now(),
        }));

        let answered = false;
        while (!answered && Date.now() < deadline) {
          for (const peer of await others()) {
            const rec = await signaling.read(peer.userId, key);
            const msg = rec && await unwrap(rec.value);
            if (msg && msg.role === 'answer') {
              await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
              answered = true;
              break;
            }
          }
          if (!answered) await sleep(POLL_INTERVAL_MS);
        }
        if (!answered) throw new Error('nobody joined the room');

        onStatus('connecting');
        await connected(pc, channel, Math.max(5000, deadline - Date.now()));
        cleanup();
        return { wire, pc, roomKey: key, scope, encrypted: !!crypt, role: 'offer' };
      }

      // Someone is already here: read their offer and answer it.
      onStatus('joining');
      let offerMsg = null;
      while (!offerMsg && Date.now() < deadline) {
        for (const peer of await others()) {
          const rec = await signaling.read(peer.userId, key);
          const msg = rec && await unwrap(rec.value);
          if (msg && msg.role === 'offer') { offerMsg = msg; break; }
        }
        if (!offerMsg) await sleep(POLL_INTERVAL_MS);
      }
      if (!offerMsg) throw new Error('the room had no offer to answer');

      const incoming = new Promise(resolve => { pc.ondatachannel = ev => resolve(ev.channel); });
      await pc.setRemoteDescription({ type: 'offer', sdp: offerMsg.sdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await gathered(pc);
      await signaling.publish(key, await wrap({
        role: 'answer', sdp: pc.localDescription.sdp, at: Date.now(),
      }));

      onStatus('connecting');
      const channel = await incoming;
      const wire = new RtcWire(channel);
      await connected(pc, channel, Math.max(5000, deadline - Date.now()));
      cleanup();
      return { wire, pc, roomKey: key, scope, encrypted: !!crypt, role: 'answer' };
    } catch (err) {
      cleanup();
      try { pc.close(); } catch (_) {}
      throw err;
    }
  }

  return {
    RtcWire, SignalingClient, joinRoom,
    newRoomSecret, roomKeyFor, scopeFor, signalKeyFor,
    DEFAULT_ICE, DEFAULT_JOIN_TIMEOUT_MS,
    _internals: { sealed, opened, cryptoKeyFor, b64url, unb64url },
  };
}));
