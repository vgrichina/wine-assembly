// Virtual LAN over WebRTC — docs/virtual-lan-party.md
//
// lib/vlan-wire.js defines what a wire owes the emulator: send, peek, commit.
// LoopbackWire satisfies it inside one process and ProcessWire across two on
// one machine. This is the third: two browsers, two people, one segment.
//
// Nothing in WAT changes to support it. The guest still sees a room address
// and a byte stream; the frame is the contract, and this file only moves
// frames between machines.
//
// Three parts live here:
//
//   RtcWire       a Wire whose transport is an RTCDataChannel
//   joinNetwork   presence: who is here, at what address
//   connect       the introduction, addressed to exactly one peer
//
// The DataChannel is configured ordered and fully reliable. That is not the
// obvious choice for a game — an action game would normally want unreliable
// delivery so a late packet is dropped rather than delaying the ones behind
// it. It is the right choice here because what travels is a TCP byte stream
// the guest believes is TCP: dropping or reordering a byte is not a dropped
// frame of animation, it is a corrupted protocol stream. The reliability the
// guest assumes has to come from somewhere, and the DataChannel provides it
// for free.
//
// ---- what is public, and what is not ------------------------------------
//
// Presence is public: everyone signed in can see who else is on the segment,
// under what name, at what address. That is the point of a shared network —
// it is the part that replaces matchmaking.
//
// Addresses are not. A WebRTC offer carries ICE candidates, which carry the
// publisher's LAN and public IP, so publishing an offer to the whole network
// would hand every signed-in user a list of everyone's home addresses whether
// or not they ever play together. Instead each peer advertises an ephemeral
// public key in its presence record, and an offer is encrypted to the one
// peer it is meant for and left in that peer's inbox. The store stays
// world-readable; the SDP in it is readable by exactly one person.

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

  const DEFAULT_JOIN_TIMEOUT_MS = 60000;
  const POLL_INTERVAL_MS = 1000;

  // A presence record is a claim with an expiry, not a registration. Nobody
  // reliably says goodbye — browsers get closed, laptops get shut — so a peer
  // counts as present only while its record is fresh, and it keeps the record
  // fresh by republishing. Everything else here (who is listed, which
  // addresses are taken) follows from that one rule.
  //
  // The freshness clock is the store's own `updatedAt`, never a timestamp in
  // the record body. A peer cannot forge it in either direction: it cannot
  // backdate to look like it arrived first, and — more importantly — it
  // cannot post-date to stay listed after it has gone.
  const PRESENCE_TTL_MS = 45000;
  const PRESENCE_REFRESH_MS = 15000;

  // Public STUN only. There is no TURN here, which means two peers behind
  // symmetric NATs will fail to connect and there is nothing this file can do
  // about it — relaying someone else's game traffic needs a server somebody
  // pays for. connect() reports that case as a distinct failure rather than a
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

  // ---- encoding ---------------------------------------------------------

  const enc = new TextEncoder();
  const dec = new TextDecoder();

  function b64url(bytes) {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function unb64url(text) {
    const s = atob(String(text).replace(/-/g, '+').replace(/_/g, '/'));
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  function newRoomSecret() {
    return b64url(crypto.getRandomValues(new Uint8Array(16)));
  }

  // ---- scopes -----------------------------------------------------------
  //
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

  async function hashedKey(prefix, material) {
    const digest = await crypto.subtle.digest('SHA-256', enc.encode(prefix + material));
    return b64url(new Uint8Array(digest)).slice(0, 22);
  }

  // Where presence for a scope is published. A secret, when there is one,
  // is folded in before hashing, so a room's key cannot be computed by
  // someone who knows only which channel it is in.
  async function signalKeyFor(scope, secret) {
    return 'vln-signal-' + await hashedKey('vln-scope:', secret ? `${scope}#${secret}` : scope);
  }

  function roomKeyFor(secret) {
    return signalKeyFor(scopeFor({}), secret);
  }

  // Where offers *for a given peer* are left. Deriving it from the recipient
  // means a peer polls one key to find everything addressed to it, without
  // anyone having to write to a record they do not own.
  async function inboxKeyFor(scope, userId, secret) {
    const material = (secret ? `${scope}#${secret}` : scope) + '|inbox:' + userId;
    return 'vln-inbox-' + await hashedKey('vln-inbox:', material);
  }

  // ---- addresses --------------------------------------------------------
  //
  // Addresses are claimed, not assigned: there is no server to hand them out,
  // only the presence list saying which ones are currently spoken for. Pick a
  // free one at random, publish the claim, then look again — random choice
  // makes collisions rare, and re-reading catches the ones that happen anyway.
  //
  // 10.77.0.0/16, with .0 and .255 skipped in the last octet so an address
  // never looks like a network or broadcast address to code that checks.

  const ADDR_PREFIX = [10, 77];

  function formatAddress(v) {
    return `${(v >>> 24) & 255}.${(v >>> 16) & 255}.${(v >>> 8) & 255}.${v & 255}`;
  }

  function randomAddress() {
    const bytes = crypto.getRandomValues(new Uint8Array(2));
    const host = 2 + (bytes[1] % 253);          // 2..254
    return `${ADDR_PREFIX[0]}.${ADDR_PREFIX[1]}.${bytes[0]}.${host}`;
  }

  // Who yields when two peers pick the same address. Deliberately not "who
  // was first": the store's timestamp is rewritten by every heartbeat, so
  // arrival order stops being recoverable after fifteen seconds, and a
  // timestamp in the record body would be a client clock and therefore a lie
  // waiting to happen.
  //
  // Comparing user ids instead needs no clock and no history. Both peers see
  // the same two ids and reach the same conclusion without exchanging
  // anything, and exactly one of them moves. It is arbitrary, not fair — but
  // fairness is not the requirement; agreement is.
  function claimLoses(mine, theirs) {
    if (!mine || !theirs || !mine.address || mine.address !== theirs.address) return false;
    return theirs.userId < mine.userId;
  }

  function pickAddress(taken) {
    const used = new Set(taken);
    for (let tries = 0; tries < 64; tries++) {
      const candidate = randomAddress();
      if (!used.has(candidate)) return candidate;
    }
    // 64 random misses against a /16 means the segment is not merely busy,
    // it is implausible — far more likely something is republishing junk.
    // Say so rather than hand back a duplicate.
    throw new Error('vlan: no free address on the segment');
  }

  // ---- identity and directed encryption ---------------------------------
  //
  // The keypair is ephemeral and per session. It is not an identity — the
  // signaling service already says who each user is — it exists so that an
  // offer can be encrypted to one recipient. A fresh pair each session means
  // yesterday's published records cannot be decrypted today.

  async function newIdentity() {
    const pair = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey']);
    const raw = await crypto.subtle.exportKey('raw', pair.publicKey);
    return { keyPair: pair, publicKey: b64url(new Uint8Array(raw)) };
  }

  async function sharedKeyWith(identity, theirPublicKey) {
    const theirs = await crypto.subtle.importKey(
      'raw', unb64url(theirPublicKey), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    return crypto.subtle.deriveKey(
      { name: 'ECDH', public: theirs },
      identity.keyPair.privateKey,
      { name: 'AES-GCM', length: 256 },
      false, ['encrypt', 'decrypt']);
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
      // Not for us, or stale, or tampered with. All three are the same thing
      // from here: a record we cannot use. A shared key is a shared namespace
      // and anything at all may appear under it.
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

  // ---- connection establishment -----------------------------------------

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
  const now = () => Date.now();

  function established(pc, channel, timeoutMs) {
    return new Promise((resolve, reject) => {
      const finish = (fn, arg) => {
        clearTimeout(timer);
        pc.removeEventListener('connectionstatechange', onState);
        fn(arg);
      };
      const timer = setTimeout(() => finish(reject, Object.assign(
        new Error('the connection could not be established'),
        // Both sides exchanged descriptions, so the introduction worked and
        // the direct path did not. That is the NAT case, and it needs a relay
        // this project does not run.
        { needsRelay: true })), timeoutMs);
      const onState = () => {
        if (pc.connectionState === 'failed') {
          finish(reject, Object.assign(new Error('the connection failed'), { needsRelay: true }));
        }
      };
      pc.addEventListener('connectionstatechange', onState);
      if (channel.readyState === 'open') return finish(resolve);
      channel.onopen = () => finish(resolve);
    });
  }

  // ---- the network ------------------------------------------------------

  class Network {
    constructor(config) {
      Object.assign(this, config);
      this._timer = null;
      this._left = false;
    }

    // Everyone whose presence record is still fresh, us excluded. A stale
    // record is not deleted — nobody is around to delete it — so freshness is
    // decided here on every read.
    async peers() {
      const list = await this.signaling.publishers(this.presenceKey);
      const users = ((list && list.users) || []).filter(u => u.userId !== this.userId);
      const out = [];
      for (const u of users) {
        const rec = await this.signaling.read(u.userId, this.presenceKey);
        const value = rec && rec.value;
        if (!value || typeof value.publicKey !== 'string') continue;
        // A record with no server timestamp is one we cannot age out, so it
        // is not one we are willing to treat as present.
        const stampedAt = Date.parse(rec.updatedAt || '');
        if (!Number.isFinite(stampedAt)) continue;
        if (now() - stampedAt > PRESENCE_TTL_MS) continue;
        out.push({
          userId: u.userId,
          name: String(value.name || u.name || 'player'),
          address: value.address,
          publicKey: value.publicKey,
          status: value.status || 'available',
          updatedAt: stampedAt,
        });
      }
      return out;
    }

    // What a peer publishes about itself: who it is, where to reach it on the
    // segment, and the key to encrypt an offer to it. No timestamp — the
    // store supplies that, and a second one in here would only be a second
    // thing to disagree.
    _record() {
      return {
        name: this.name,
        address: this.address,
        publicKey: this.identity.publicKey,
        status: this.status,
      };
    }

    async _announce() {
      await this.signaling.publish(this.presenceKey, this._record());
    }

    // Republishing is what keeps this peer visible; stopping is how it
    // disappears. The interval is unref'd where that exists so a forgotten
    // network cannot hold a Node process open.
    _startHeartbeat() {
      if (this._timer) return;
      this._timer = setInterval(() => {
        if (this._left) return;
        this._announce().catch(() => {});
      }, PRESENCE_REFRESH_MS);
      if (this._timer && typeof this._timer.unref === 'function') this._timer.unref();
    }

    async setStatus(status) {
      this.status = status;
      await this._announce();
    }

    // Open a connection to one peer. The offer is encrypted to that peer's
    // advertised key and left in that peer's inbox, so no one else on the
    // segment learns this machine's addresses.
    async connect(peerId, options) {
      const opts = options || {};
      const timeoutMs = opts.timeoutMs || DEFAULT_JOIN_TIMEOUT_MS;
      const deadline = now() + timeoutMs;
      const onStatus = opts.onStatus || this.onStatus;

      const peer = (await this.peers()).find(p => p.userId === peerId);
      if (!peer) throw new Error('vlan: that peer is no longer on the segment');

      const key = await sharedKeyWith(this.identity, peer.publicKey);
      const theirInbox = await inboxKeyFor(this.scope, peer.userId, this.secret);
      const myInbox = await inboxKeyFor(this.scope, this.userId, this.secret);

      const pc = new RTCPeerConnection({ iceServers: this.iceServers });
      try {
        onStatus('offering');
        const channel = pc.createDataChannel('vln', { ordered: true });
        const wire = new RtcWire(channel);
        await pc.setLocalDescription(await pc.createOffer());
        await gathered(pc);
        await this.signaling.publish(theirInbox, Object.assign(
          { from: this.userId, publicKey: this.identity.publicKey },
          await sealed(key, { role: 'offer', sdp: pc.localDescription.sdp, at: now() })));

        onStatus('waiting for an answer');
        let answered = false;
        while (!answered && now() < deadline) {
          const msg = await this._readInbox(myInbox, peer, key, 'answer');
          if (msg) {
            await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
            answered = true;
            break;
          }
          await sleep(POLL_INTERVAL_MS);
        }
        if (!answered) throw new Error('vlan: the peer did not answer');

        onStatus('connecting');
        await established(pc, channel, Math.max(5000, deadline - now()));
        this.signaling.withdraw(theirInbox).catch(() => {});
        return { wire, pc, peer };
      } catch (err) {
        try { pc.close(); } catch (_) {}
        this.signaling.withdraw(theirInbox).catch(() => {});
        throw err;
      }
    }

    // Read one message of the expected role out of an inbox. A record is only
    // considered if its author is who it claims to be *and* the key it was
    // sealed with is the one that author advertised — otherwise a third party
    // could drop a record in and have it treated as coming from the peer.
    async _readInbox(inboxKey, expectFrom, key, role) {
      const list = await this.signaling.publishers(inboxKey);
      for (const u of ((list && list.users) || [])) {
        if (expectFrom && u.userId !== expectFrom.userId) continue;
        const rec = await this.signaling.read(u.userId, inboxKey);
        const value = rec && rec.value;
        if (!value || value.from !== u.userId) continue;
        if (expectFrom && value.publicKey !== expectFrom.publicKey) continue;
        const msg = await opened(key, value);
        if (msg && msg.role === role) return Object.assign({}, msg, { from: u.userId });
      }
      return null;
    }

    // Wait for someone to offer us a connection and accept it. The caller
    // decides whether it wants to be connectable at all — this is only ever
    // running while it is called.
    async accept(options) {
      const opts = options || {};
      const timeoutMs = opts.timeoutMs || DEFAULT_JOIN_TIMEOUT_MS;
      const deadline = now() + timeoutMs;
      const onStatus = opts.onStatus || this.onStatus;
      const myInbox = await inboxKeyFor(this.scope, this.userId, this.secret);

      while (now() < deadline) {
        if (this._left) throw new Error('vlan: left the segment');
        const known = await this.peers();
        for (const peer of known) {
          const key = await sharedKeyWith(this.identity, peer.publicKey);
          const offer = await this._readInbox(myInbox, peer, key, 'offer');
          if (!offer) continue;

          onStatus('answering');
          const pc = new RTCPeerConnection({ iceServers: this.iceServers });
          try {
            const incoming = new Promise(resolve => { pc.ondatachannel = ev => resolve(ev.channel); });
            await pc.setRemoteDescription({ type: 'offer', sdp: offer.sdp });
            await pc.setLocalDescription(await pc.createAnswer());
            await gathered(pc);
            const theirInbox = await inboxKeyFor(this.scope, peer.userId, this.secret);
            await this.signaling.publish(theirInbox, Object.assign(
              { from: this.userId, publicKey: this.identity.publicKey },
              await sealed(key, { role: 'answer', sdp: pc.localDescription.sdp, at: now() })));

            onStatus('connecting');
            const channel = await incoming;
            const wire = new RtcWire(channel);
            await established(pc, channel, Math.max(5000, deadline - now()));
            this.signaling.withdraw(myInbox).catch(() => {});
            return { wire, pc, peer };
          } catch (err) {
            try { pc.close(); } catch (_) {}
            throw err;
          }
        }
        await sleep(POLL_INTERVAL_MS);
      }
      throw new Error('vlan: nobody tried to connect');
    }

    async leave() {
      this._left = true;
      if (this._timer) { clearInterval(this._timer); this._timer = null; }
      const myInbox = await inboxKeyFor(this.scope, this.userId, this.secret);
      await Promise.all([
        this.signaling.withdraw(this.presenceKey).catch(() => {}),
        this.signaling.withdraw(myInbox).catch(() => {}),
      ]);
    }
  }

  // Join a segment: claim an address, announce presence, and return a handle
  // that can list peers and connect to them. Joining does not connect to
  // anyone — that is the whole point of separating the two.
  async function joinNetwork(options) {
    const opts = options || {};
    const signaling = opts.signaling || new SignalingClient(opts.apiBase || '');
    const scope = opts.scope || scopeFor(opts);
    const secret = opts.secret || null;
    const onStatus = opts.onStatus || (() => {});

    const me = await signaling.whoami();
    if (!me || !me.id) throw new Error('vlan: the signaling service did not identify us');

    const presenceKey = await signalKeyFor(scope, secret);
    const identity = await newIdentity();

    const net = new Network({
      signaling, scope, secret, presenceKey, identity,
      userId: me.id,
      name: opts.name || me.name || 'player',
      status: opts.status || 'available',
      iceServers: opts.iceServers || DEFAULT_ICE,
      onStatus,
    });

    // Claim an address nobody currently holds, then check again: two peers
    // can choose at the same moment and neither sees the other's claim yet.
    const seen = await net.peers();
    net.address = opts.address || pickAddress(seen.map(p => p.address).filter(Boolean));
    await net._announce();

    if (!opts.address) {
      const after = await net.peers();
      const mine = { address: net.address, userId: net.userId };
      if (after.some(p => claimLoses(mine, p))) {
        onStatus('address taken, choosing another');
        net.address = pickAddress(after.map(p => p.address).filter(Boolean));
        await net._announce();
      }
    }

    net._startHeartbeat();
    return net;
  }

  // Two peers, one segment, no UI: join, then take whichever role is
  // available — offer if someone is already here, otherwise wait to be
  // offered to. This is the shape the CLI gate and the tests want; a real
  // lobby calls joinNetwork and lets a person choose.
  async function joinRoom(options) {
    const opts = options || {};
    const net = await joinNetwork(opts);
    const timeoutMs = opts.timeoutMs || DEFAULT_JOIN_TIMEOUT_MS;
    try {
      const peers = await net.peers();
      const link = peers.length
        ? await net.connect(peers[0].userId, { timeoutMs })
        : await net.accept({ timeoutMs });
      return Object.assign({ network: net, scope: net.scope, address: net.address }, link);
    } catch (err) {
      await net.leave().catch(() => {});
      throw err;
    }
  }

  return {
    RtcWire, SignalingClient, Network,
    joinNetwork, joinRoom,
    newRoomSecret, roomKeyFor, scopeFor, signalKeyFor, inboxKeyFor,
    randomAddress, pickAddress, formatAddress, claimLoses,
    DEFAULT_ICE, DEFAULT_JOIN_TIMEOUT_MS, PRESENCE_TTL_MS, PRESENCE_REFRESH_MS,
    _internals: { sealed, opened, cryptoKeyFor, newIdentity, sharedKeyWith, b64url, unb64url },
  };
}));
