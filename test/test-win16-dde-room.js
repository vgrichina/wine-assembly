#!/usr/bin/env node

// Two 16-bit DDEML instances in one room, over the virtual LAN wire.
//
//   node test/test-win16-dde-room.js
//
// Hearts is a network game and DDEML is how it talks: the dealer registers a
// service name and the other players connect to it. Everything up to that
// point already worked — string handles intern and compare, data handles hold
// their bytes, the dealer really does call DdeNameService — but DdeConnect had
// nobody to reach, because nothing carried a conversation between two emulator
// instances. It answered DMLERR_NO_CONV_ESTABLISHED, which is exactly right
// for a room of one and is what sends Hearts to its own table.
//
// This is the conversation half. Two instances, separate linear memories,
// separate DDE tables, separate room addresses, joined by the same loopback
// segment the Winsock tests use — the smallest thing that can prove a connect
// is answered by *another machine* rather than by a shortcut inside one.
//
// Two properties are worth stating because they are what made this possible
// at all:
//
//   1. The room is one queue with one reader. $vsock_pump owns it, and it used
//      to DISCARD any frame whose magic it did not know — so a DDE frame put
//      on the wire was eaten before DDEML ever saw it. The reader now hands
//      'DDE1' frames over instead. Leaving them queued would not do either:
//      nothing else drains, so the socket stream would stall behind them.
//   2. A connect cannot be answered inside the call. The peer is another
//      instance and only sees the request when *it* next drains. A Win16 API
//      is entered with its arguments still on the task's stack and nothing
//      popped until $win16_api_return, so DdeConnect parks by simply not
//      returning: the next pass re-enters it with the same arguments. That is
//      why it is written natively rather than bridged — across the Win16
//      bridge the frame it would park on belongs to a scratch stack about to
//      be discarded.

'use strict';

const assert = require('assert');
const { LoopbackSegment } = require('../lib/vlan-wire');
const { compile, makeNode } = require('./vlan-node');

const DEALER_IP = '10.77.0.1';
const PLAYER_IP = '10.77.0.2';

let passed = 0;
function check(name, cond, detail) {
  assert(cond, detail ? `${name} -- ${detail}` : name);
  passed++;
  console.log(`PASS  ${name}`);
}

// Intern a string into a node's DDE table and hand back the HSZ, the way
// DdeCreateStringHandle would.
function intern(node, text) {
  const ga = node.buf(Buffer.from(text + '\0', 'latin1'));
  const hsz = node.wat.test_dde_intern(ga) | 0;
  assert(hsz, `intern("${text}") failed`);
  return hsz;
}

// Let the room settle: each side drains what the other put on the wire.
// Two passes, because the answer is only emitted once the request has been
// seen — one pass would test nothing but the request.
function settle(...nodes) {
  for (let i = 0; i < 4; i++) for (const n of nodes) n.pump();
}

(async () => {
  const wasm = await compile();
  const segment = new LoopbackSegment();
  const dealer = await makeNode(wasm, segment.attach(), DEALER_IP);
  const player = await makeNode(wasm, segment.attach(), PLAYER_IP);

  // Both sides have a live DDEML instance; the dealer registers the service.
  // Instance ids are 1-based, as DdeInitialize hands them out.
  dealer.wat.test_dde_instance(0, 1);
  player.wat.test_dde_instance(0, 1);
  const service = 'Hearts';
  const topic = 'Game';
  dealer.wat.test_dde_register(1, intern(dealer, service));

  check('a fresh room holds no conversations',
    (dealer.wat.test_dde_conv_count() | 0) === 0 &&
    (player.wat.test_dde_conv_count() | 0) === 0);

  // --- the connect -------------------------------------------------------
  const conv = player.wat.test_dde_connect_begin(
    1, intern(player, service), intern(player, topic)) | 0;
  check('the player took a conversation slot for its pending connect', conv !== 0);
  check('nothing is established before the room has been drained',
    (player.wat.test_dde_connect_done() | 0) === 0);
  // The dealer has not seen anything yet either — the frame is still on the
  // wire. This is the property that makes it a real two-party exchange.
  check('the dealer has not answered a request it has not yet read',
    (dealer.wat.test_dde_conv_count() | 0) === 0);

  settle(dealer, player);

  check('the dealer opened a conversation for the connecting player',
    (dealer.wat.test_dde_conv_count() | 0) === 1);
  const established = player.wat.test_dde_connect_done() | 0;
  check('the player\'s connect was answered', established !== 0,
    'DdeConnect would still be parked here');
  check('the answer names the conversation the player opened',
    established === conv, `${established} vs ${conv}`);

  // Each side recorded who it is talking to, which is what a later
  // transaction is routed by.
  const ip2int = ip => ip.split('.').reduce((a, o) => ((a << 8) | (+o & 255)) >>> 0, 0) >>> 0;
  check('the player knows the dealer\'s address',
    (player.wat.test_dde_conv_peer(conv) >>> 0) === ip2int(DEALER_IP));
  check('the dealer knows the player\'s address',
    (dealer.wat.test_dde_conv_peer(1) >>> 0) === ip2int(PLAYER_IP));

  // --- a service nobody offers -------------------------------------------
  // The room must not answer for a name it has not registered. This is the
  // case that used to be the *only* case, and it still has to behave.
  const missing = player.wat.test_dde_connect_begin(
    1, intern(player, 'Solitaire'), intern(player, topic)) | 0;
  check('a connect to an unregistered service takes a slot', missing !== 0);
  settle(dealer, player);
  check('nobody answers for a service that is not registered',
    (player.wat.test_dde_connect_done() | 0) === 0,
    'the dealer answered for a name it never registered');
  check('and the dealer did not open a second conversation',
    (dealer.wat.test_dde_conv_count() | 0) === 1);
  player.wat.test_dde_disconnect(missing);

  // --- the NetDDE share path ---------------------------------------------
  // This is how Hearts actually connects, and it is why matching names alone
  // could never have joined two of them. A remote client does not name the
  // server's application: it connects to the NetDDE *agent* on the machine,
  // service `\\HOST\NDDE$`, and gives a DDE *share* as the topic — the
  // trailing `$` is the share marker. The agent resolves that share against
  // the machine's own share database, which is where "Hearts$ is served by
  // application MSHearts, topic Hearts" is written.
  //
  // Traced off the real binaries: the dealer registers ("MSHearts",
  // "Hearts") and the client asks for ("\\DEAL\NDDE$", "Hearts$").
  dealer.wat.test_dde_register(1, intern(dealer, 'MSHearts'));
  const remote = player.wat.test_dde_connect_begin(
    1, intern(player, '\\\\DEAL\\NDDE$'), intern(player, 'Hearts$')) | 0;
  check('a NetDDE agent connect takes a slot', remote !== 0);
  settle(dealer, player);
  check('the share resolved to the application actually serving it',
    (player.wat.test_dde_connect_done() | 0) === remote,
    'the dealer registered MSHearts and the client asked for \\\\DEAL\\NDDE$');
  player.wat.test_dde_disconnect(remote);
  settle(dealer, player);

  // A share the machine does not have is answered by nobody, which is what a
  // box without that entry in its database does.
  const noShare = player.wat.test_dde_connect_begin(
    1, intern(player, '\\\\DEAL\\NDDE$'), intern(player, 'Chess$')) | 0;
  settle(dealer, player);
  check('an unknown share is not answered',
    (player.wat.test_dde_connect_done() | 0) === 0);
  player.wat.test_dde_disconnect(noShare);
  settle(dealer, player);

  // Put the plain registration back for the disconnect check below.
  dealer.wat.test_dde_register(1, intern(dealer, service));
  const conv2 = player.wat.test_dde_connect_begin(
    1, intern(player, service), intern(player, topic)) | 0;
  settle(dealer, player);
  check('a plain application connect still works beside the share path',
    (player.wat.test_dde_connect_done() | 0) === conv2);
  player.wat.test_dde_disconnect(conv2);
  settle(dealer, player);

  // --- disconnect ---------------------------------------------------------
  // A conversation the other side still believes in is a server holding a
  // seat for a player who has gone, so the close has to cross the wire.
  player.wat.test_dde_disconnect(conv);
  check('the player dropped its conversation',
    (player.wat.test_dde_conv_count() | 0) === 0);
  settle(dealer, player);
  check('the dealer was told and released the seat',
    (dealer.wat.test_dde_conv_count() | 0) === 0);

  console.log(`\n${passed} passed, 0 failed`);
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
