// The lobby: who else is on this channel, and connecting to one of them.
//
// This is the only piece of the virtual LAN a person actually sees. It sits
// between clicking a game and the game starting: join the channel, look at who
// is there, pick someone, and hand the resulting wire to the emulator before
// it boots.
//
// It owns no protocol of its own. Everything here is lib/vlan-rtc.js —
// presence to see people, an invite to agree to connect, and a wire at the
// end of it.
//
// ---- who offers and who answers -----------------------------------------
//
// The obvious design is "whoever clicks, offers". It breaks the moment two
// people click each other at the same time: both send an offer, neither is
// listening for one, and both sit waiting. That is WebRTC glare, and polite
// retries only make it a slower deadlock.
//
// Instead, clicking is only a statement of intent, published in the presence
// record. Once either side sees an invite involving the pair, the roles are
// decided by comparing user ids — lower offers, higher answers. Both sides
// compute the same answer from the same two ids without exchanging anything,
// so it does not matter who clicked, or whether both did.

(function (root, factory) {
  const rtc = (typeof require === 'function') ? require('./vlan-rtc') : root.VlanRtc;
  const mod = factory(rtc);
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.VlanLobby = mod;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (VlanRtc) {
  'use strict';

  const POLL_MS = 2000;
  const INVITE_PREFIX = 'inviting:';

  // Decide what this peer should do about the pair (me, them). Exported
  // because it is the whole coordination rule and deserves a test that does
  // not need a browser.
  //
  // Returns 'offer', 'answer', or null when there is no invite between us.
  function roleFor(myId, peer) {
    const theyInvitedMe = peer.status === INVITE_PREFIX + myId;
    const iInvitedThem = peer.invitedByMe === true;
    if (!theyInvitedMe && !iInvitedThem) return null;
    // Ids are opaque strings from the signaling service; both sides see the
    // same two and order them the same way.
    return myId < peer.userId ? 'offer' : 'answer';
  }

  const styles = `
.vln-lobby{position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;
  align-items:center;justify-content:center;z-index:9999;font:13px system-ui,sans-serif}
.vln-panel{background:#c0c0c0;border:2px outset #fff;min-width:420px;max-width:520px;
  box-shadow:4px 4px 12px rgba(0,0,0,.4)}
.vln-title{background:linear-gradient(90deg,#000080,#1084d0);color:#fff;font-weight:700;
  padding:4px 8px;display:flex;justify-content:space-between;align-items:center}
.vln-body{padding:12px}
.vln-me{background:#fff;border:1px inset #808080;padding:8px;margin-bottom:10px}
.vln-addr{font-family:ui-monospace,monospace;font-size:16px;font-weight:700}
.vln-list{background:#fff;border:1px inset #808080;min-height:120px;max-height:220px;
  overflow-y:auto;margin-bottom:10px}
.vln-peer{padding:6px 8px;display:flex;justify-content:space-between;align-items:center;
  border-bottom:1px solid #e0e0e0}
.vln-peer:last-child{border-bottom:none}
.vln-peer b{font-weight:700}
.vln-peer code{font-family:ui-monospace,monospace;color:#444}
.vln-empty{padding:16px;text-align:center;color:#666}
.vln-actions{display:flex;gap:8px;justify-content:flex-end}
.vln-lobby button{font:inherit;padding:4px 12px;background:#c0c0c0;border:2px outset #fff;
  cursor:pointer}
.vln-lobby button:active{border-style:inset}
.vln-lobby button:disabled{color:#808080;cursor:default}
.vln-status{padding:6px 0;color:#000080;min-height:1.2em}
.vln-warn{font-size:11px;color:#600;margin-top:8px}
`;

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // Show the lobby and resolve once there is something to play with:
  //
  //   { wire, address, peer }   connected to someone
  //   { local: true }           play both sides in this tab (opts.localPlay)
  //   { solo: true }            the person chose to play alone
  //   null                      the person cancelled the launch
  //
  // `local` is not a lesser version of a connection — for a game that needs
  // two players it is the only way to see the thing work without a second
  // person, and it needs no account. The caller supplies the segment; this
  // file only reports the choice.
  //
  // The caller is responsible for `joinVlan(wire, address)` before init().
  async function showLobby(options) {
    const opts = options || {};
    const doc = opts.document || document;

    if (!doc.getElementById('vln-lobby-styles')) {
      const s = el('style');
      s.id = 'vln-lobby-styles';
      s.textContent = styles;
      doc.head.appendChild(s);
    }

    const overlay = el('div', 'vln-lobby');
    const panel = el('div', 'vln-panel');
    const title = el('div', 'vln-title');
    title.appendChild(el('span', null, `LAN — ${opts.label || opts.exe || 'game'}`));
    const body = el('div', 'vln-body');
    const me = el('div', 'vln-me');
    const list = el('div', 'vln-list');
    const status = el('div', 'vln-status');
    const actions = el('div', 'vln-actions');
    const localBtn = opts.localPlay ? el('button', null, 'Both players here') : null;
    const soloBtn = el('button', null, 'Play solo');
    const cancelBtn = el('button', null, 'Cancel');
    if (localBtn) actions.appendChild(localBtn);
    actions.appendChild(soloBtn);
    actions.appendChild(cancelBtn);
    body.appendChild(me);
    body.appendChild(list);
    body.appendChild(status);
    body.appendChild(actions);
    panel.appendChild(title);
    panel.appendChild(body);
    overlay.appendChild(panel);
    doc.body.appendChild(overlay);

    const say = (text) => { status.textContent = text; };
    const close = () => { overlay.remove(); };

    let net = null;
    let stopped = false;
    let invited = null;      // userId this person clicked
    let busy = false;        // a connection attempt is in flight

    const finish = async (result) => {
      stopped = true;
      close();
      if (net && !(result && result.wire)) await net.leave().catch(() => {});
      return result;
    };

    // The buttons answer from the first frame, before the channel is joined.
    // Wiring them only afterwards left a window -- however long the signaling
    // round trip takes, and longer still when it is going to fail -- where the
    // panel showed three buttons and none of them did anything. Someone who
    // just wants to play alone should never have to wait out a network call.
    let answerEarly = null;
    const early = new Promise(resolve => { answerEarly = resolve; });
    if (localBtn) localBtn.onclick = () => { close(); answerEarly({ local: true }); };
    soloBtn.onclick = () => { close(); answerEarly({ solo: true }); };
    cancelBtn.onclick = () => { close(); answerEarly(null); };

    say('joining the channel…');
    const joining = VlanRtc.joinNetwork({
      exe: opts.exe,
      name: opts.name,
      apiBase: opts.apiBase || '',
      signaling: opts.signaling,
      onStatus: (text) => { if (!stopped) say(text); },
    }).then(joined => ({ net: joined }), error => ({ error }));

    const first = await Promise.race([joining, early.then(answer => ({ answer }))]);
    if ('answer' in first) {
      stopped = true;
      // The join is still in flight and will finish into nothing. Leave the
      // channel when it lands so this tab does not sit in the presence list
      // as a player who is not there.
      joining.then(r => { if (r.net) r.net.leave().catch(() => {}); });
      return first.answer;
    }
    net = first.net;
    if (first.error) {
      const err = first.error;
      if (err && err.needsLogin) {
        say('sign in to play over the LAN');
        // Not a failure of the game — offer the solo path rather than
        // stranding someone behind a login they may not want.
        me.textContent = 'LAN play needs an account. You can still play solo.';
      } else {
        say('could not join: ' + (err && err.message ? err.message : err));
      }
      // The buttons are already wired to `early`; there is nothing else this
      // panel can offer once the channel is out of reach.
      return early;
    }

    me.innerHTML = '';
    me.appendChild(el('div', null, 'You are on the segment at'));
    me.appendChild(el('div', 'vln-addr', net.address));
    const hint = el('div', 'vln-warn', opts.hint
      || 'If you host the server, the other player types this address into '
      + 'the game’s Net game screen.');
    me.appendChild(hint);

    return new Promise((resolve) => {
      if (localBtn) localBtn.onclick = () => finish({ local: true }).then(resolve);
      soloBtn.onclick = () => finish({ solo: true }).then(resolve);
      cancelBtn.onclick = () => finish(null).then(resolve);

      // Rebuilding the list every poll would replace the very button someone
      // is reaching for, twice a second. Only redraw when something a person
      // can see has actually changed.
      let lastSignature = null;
      const render = (peers) => {
        const signature = JSON.stringify(peers.map(p =>
          [p.userId, p.name, p.address, p.status]).concat([[invited, busy]]));
        if (signature === lastSignature) return;
        lastSignature = signature;
        list.innerHTML = '';
        if (!peers.length) {
          list.appendChild(el('div', 'vln-empty',
            'Nobody else here yet. Leave this open — anyone who launches the '
            + 'same game will appear.'));
          return;
        }
        for (const p of peers) {
          const row = el('div', 'vln-peer');
          const who = el('span');
          who.appendChild(el('b', null, p.name));
          who.appendChild(doc.createTextNode(' '));
          who.appendChild(el('code', null, p.address || '?'));
          row.appendChild(who);
          const btn = el('button', null,
            p.userId === invited ? 'inviting…'
              : p.status === INVITE_PREFIX + net.userId ? 'accept'
                : 'connect');
          btn.disabled = busy;
          btn.onclick = async () => {
            invited = p.userId;
            busy = false;   // let the next tick pick the role up
            say(`inviting ${p.name}…`);
            await net.setStatus(INVITE_PREFIX + p.userId).catch(() => {});
          };
          row.appendChild(btn);
          list.appendChild(row);
        }
      };

      const tick = async () => {
        if (stopped) return;
        try {
          const peers = await net.peers();
          for (const p of peers) p.invitedByMe = (p.userId === invited);
          render(peers);

          if (!busy) {
            const target = peers.find(p => roleFor(net.userId, p));
            if (target) {
              busy = true;
              const role = roleFor(net.userId, target);
              say(role === 'offer'
                ? `connecting to ${target.name}…`
                : `${target.name} is connecting…`);
              try {
                const link = role === 'offer'
                  ? await net.connect(target.userId, { timeoutMs: 30000 })
                  : await net.accept({ timeoutMs: 30000 });
                await net.setStatus('playing').catch(() => {});
                stopped = true;
                close();
                resolve({ wire: link.wire, address: net.address, peer: link.peer, network: net });
                return;
              } catch (err) {
                busy = false;
                invited = null;
                await net.setStatus('available').catch(() => {});
                say(err && err.needsRelay
                  ? 'could not connect directly — one of you is behind a NAT '
                    + 'that needs a relay this site does not run'
                  : 'connection failed: ' + (err && err.message ? err.message : err));
              }
            }
          }
        } catch (err) {
          say('lobby error: ' + (err && err.message ? err.message : err));
        }
        if (!stopped) setTimeout(tick, POLL_MS);
      };

      tick();
    });
  }

  return { showLobby, roleFor, INVITE_PREFIX };
}));
