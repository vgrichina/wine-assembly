#!/usr/bin/env node

// A DDEML server asks its application before agreeing to a conversation.
//
//   node test/test-win16-dde-connect-callback.js
//
// A DDEML server is not a table of names. It is an application with a
// callback, and XTYP_CONNECT is the transaction where that application says
// yes or no. Accepting on the registered service name alone works right up
// until an app has a reason to refuse, and then the emulator has agreed to
// something the app did not.
//
// The callback is guest code, which is what makes this awkward: it cannot be
// run from the wire drain, because $vsock_pump is called from inside arbitrary
// API handlers and redirecting EIP there would return into the wrong frame. So
// the drain queues the question and the task's own message pump asks it — the
// one place a 16-bit task is between things and its stack is its own. The
// callback is entered with a far return onto a continuation slot, exactly as
// the modal message box parks, and that slot acts on the answer and then
// finishes the interrupted GetMessage with an idle message so the task's loop
// never notices the detour.
//
// Two real instances, separate memories, one loopback segment. Both load
// WINMINE.EXE so that real selectors and a real message loop exist — the point
// is to run the actual GetMessage path, not a stand-in for it. Minesweeper
// rather than Hearts on purpose: what this needs is a 16-bit task genuinely
// pumping messages, and Hearts needs CARDS.DLL staged before it will do
// anything but put up "Cannot find cards.dll" and end. Nothing here is about
// the app; the DDE state and the callback are installed directly.
//
// The server's callback is a hand-written stub whose answer this test chooses,
// which is the only way to see both the accept and the refuse without driving
// an application all the way to a live server.
//
//   accept:  b8 01 00   mov ax,1     ca 1c 00  retf 28
//   refuse:  31 c0      xor ax,ax    ca 1c 00  retf 28
//
// 28 is the DDEML callback's argument bytes: wType and wFmt as words, then
// hConv, hsz1, hsz2, hData, dwData1 and dwData2 as doublewords. Getting it
// wrong by two would leave the task's stack skewed for the rest of its life.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { LoopbackSegment } = require('../lib/vlan-wire');
const { compile, makeNode } = require('./vlan-node');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'test', 'binaries', 'win98-16bit', 'WINMINE.EXE');

const SERVICE = 'MSHearts';
const TOPIC = 'Hearts';
const STUB_OFF = 0xF000;          // past anything the module itself uses
const CODE_SEG = 1;
const SEL = (CODE_SEG << 3) | 7;  // a Win16 selector: index, table, ring

let passed = 0;
function check(name, cond, detail) {
  assert(cond, detail ? `${name} -- ${detail}` : name);
  passed++;
  console.log(`PASS  ${name}`);
}

function intern(node, text) {
  const ga = node.buf(Buffer.from(text + '\0', 'latin1'));
  const hsz = node.wat.test_dde_intern(ga) | 0;
  assert(hsz, `intern("${text}") failed`);
  return hsz;
}

// Load the real module so the instance has segments, a stack and a message
// loop, then run it far enough to be pumping.
function boot(node, bytes, batches) {
  const mem = new Uint8Array(node.memory.buffer);
  const staging = node.wat.get_staging();
  mem.fill(0, staging, staging + Math.max(bytes.length, 0x10000));
  mem.set(bytes, staging);
  const entry = node.wat.load_pe(bytes.length) | 0;
  assert(entry >= 0, `load_pe returned ${entry}`);
  for (let i = 0; i < batches; i++) node.wat.run(64);
}

// Write the callback stub into spare room in a code segment and aim the
// instance's callback at it.
function installCallback(node, accept) {
  const base = node.wat.win16_seg_base(CODE_SEG) >>> 0;
  assert(base, 'segment 1 has no base');
  const code = accept
    ? [0xb8, 0x01, 0x00, 0xca, 0x1c, 0x00]
    : [0x31, 0xc0, 0xca, 0x1c, 0x00];
  code.forEach((b, i) => node.wat.guest_write8(base + STUB_OFF + i, b));
  node.wat.test_dde_set_callback(1, ((SEL << 16) | STUB_OFF) >>> 0);
}

// Let the room settle, then give the server enough of its own message loop to
// notice the question and ask it.
function settle(a, b, pumpNode, batches = 200) {
  for (let i = 0; i < 4; i++) { a.pump(); b.pump(); }
  if (pumpNode) for (let i = 0; i < batches; i++) pumpNode.wat.run(64);
  for (let i = 0; i < 4; i++) { a.pump(); b.pump(); }
}

(async () => {
  if (!fs.existsSync(EXE)) { console.log('SKIP  WINMINE.EXE not found'); return; }
  const bytes = fs.readFileSync(EXE);
  const wasm = await compile();

  for (const accept of [true, false]) {
    const segment = new LoopbackSegment();
    const server = await makeNode(wasm, segment.attach(), '10.77.0.1');
    const client = await makeNode(wasm, segment.attach(), '10.77.0.2');
    boot(server, bytes, 400);
    boot(client, bytes, 50);

    server.wat.test_dde_instance(0, 1);
    client.wat.test_dde_instance(0, 1);
    server.wat.test_dde_register(1, intern(server, SERVICE));
    installCallback(server, accept);

    const conv = client.wat.test_dde_connect_begin(
      1, intern(client, SERVICE), intern(client, TOPIC)) | 0;
    assert(conv, 'the client took no conversation slot');

    // The drain must NOT answer on its own. Draining the wire without letting
    // the server pump leaves the question standing and the conversation only
    // offered -- if this ever reads "established" here, the callback has been
    // skipped and the emulator is agreeing on the app's behalf again.
    for (let i = 0; i < 4; i++) { server.pump(); client.pump(); }
    if (accept) {
      check('the drain offers the connection rather than accepting it',
        (server.wat.test_dde_ask_pending() | 0) === 1);
      check('and the conversation is only offered, not established',
        (server.wat.test_dde_conv_state(1) | 0) === 2);
      check('the client has not been answered yet',
        (client.wat.test_dde_connect_done() | 0) === 0);
    }

    settle(server, client, server);

    if (accept) {
      check('the application accepted and the conversation is established',
        (server.wat.test_dde_conv_state(1) | 0) === 1);
      check('the question was consumed', (server.wat.test_dde_ask_pending() | 0) === 0);
      check('the client got its conversation',
        (client.wat.test_dde_connect_done() | 0) === conv);
      // The detour must leave the server's own loop intact: it is still
      // running its message pump, not lost in a stub it never returned from.
      const before = server.wat.win16_api_count() | 0;
      for (let i = 0; i < 50; i++) server.wat.run(64);
      check('the server kept pumping after its callback ran',
        (server.wat.win16_api_count() | 0) > before);
    } else {
      // A refusal is silence. DdeConnect against a server that answers FALSE
      // times out, which is the same thing that happens with no server at all.
      check('a refused connection is not established',
        (server.wat.test_dde_conv_state(1) | 0) === 0);
      check('and the client is not told it succeeded',
        (client.wat.test_dde_connect_done() | 0) === 0);
      check('the refused question was still consumed',
        (server.wat.test_dde_ask_pending() | 0) === 0);
    }
  }

  // --- a transaction across the wire ---------------------------------------
  // XTYP_REQUEST is the same shape as XTYP_CONNECT and answered the same way,
  // except the application replies with data rather than with yes or no. Only
  // it knows what the item holds, so the request is queued by the drain, asked
  // from the pump, and the handle the callback returns is what goes back over
  // the wire. Hearts' first item is "Join".
  {
    const segment = new LoopbackSegment();
    const server = await makeNode(wasm, segment.attach(), '10.77.0.1');
    const client = await makeNode(wasm, segment.attach(), '10.77.0.2');
    boot(server, bytes, 400);
    boot(client, bytes, 50);
    server.wat.test_dde_instance(0, 1);
    client.wat.test_dde_instance(0, 1);
    server.wat.test_dde_register(1, intern(server, SERVICE));

    // The answer the server's application will give: real bytes in a real
    // data handle, which the stub returns for whatever it is asked.
    const payload = Buffer.from('JOINED', 'latin1');
    const ga = server.buf(payload);
    const handle = server.wat.test_dde_make_data(ga, payload.length) | 0;
    assert(handle, 'no data handle');
    // mov ax,<handle> / xor dx,dx / retf 28 -- non-zero, so it also accepts
    // the connect that has to happen first.
    const base = server.wat.win16_seg_base(CODE_SEG) >>> 0;
    [0xb8, handle & 0xff, (handle >> 8) & 0xff, 0x31, 0xd2, 0xca, 0x1c, 0x00]
      .forEach((b, i) => server.wat.guest_write8(base + STUB_OFF + i, b));
    server.wat.test_dde_set_callback(1, ((SEL << 16) | STUB_OFF) >>> 0);

    const conv = client.wat.test_dde_connect_begin(
      1, intern(client, SERVICE), intern(client, TOPIC)) | 0;
    settle(server, client, server);
    check('the transaction test got its conversation first',
      (client.wat.test_dde_connect_done() | 0) === conv);

    assert(client.wat.test_dde_xact_begin(conv, intern(client, 'Join')) | 0,
      'the request was not sent');
    check('a request is not answered before the server pumps',
      (client.wat.test_dde_xact_done() | 0) === 0);

    settle(server, client, server);
    const got = client.wat.test_dde_xact_done() | 0;
    check('the request came back with a data handle', got !== 0,
      'the server never answered XTYP_REQUEST');
    check(`the data crossed intact (${payload.length} bytes)`,
      (client.wat.test_dde_data_len(got) | 0) === payload.length);
    const text = Array.from({ length: payload.length },
      (_, i) => String.fromCharCode(client.wat.test_dde_data_byte(got, i) | 0)).join('');
    check(`and says what the application said ("${text}")`, text === 'JOINED');
  }

  // --- an advise loop -------------------------------------------------------
  // This is how Hearts distributes play: the dealer posts an advise after each
  // move rather than being polled. A client asks to be told about an item, the
  // server's application agrees, and from then on DdePostAdvise turns into a
  // question back to that same application -- "what does it say now?" -- whose
  // answer is pushed to the client without anyone waiting on it.
  {
    const segment = new LoopbackSegment();
    const server = await makeNode(wasm, segment.attach(), '10.77.0.1');
    const client = await makeNode(wasm, segment.attach(), '10.77.0.2');
    boot(server, bytes, 400);
    boot(client, bytes, 400);
    server.wat.test_dde_instance(0, 1);
    client.wat.test_dde_instance(0, 1);
    server.wat.test_dde_register(1, intern(server, SERVICE));

    const payload = Buffer.from('TRICK-2', 'latin1');
    const handle = server.wat.test_dde_make_data(
      server.buf(payload), payload.length) | 0;
    const srvBase = server.wat.win16_seg_base(CODE_SEG) >>> 0;
    [0xb8, handle & 0xff, (handle >> 8) & 0xff, 0x31, 0xd2, 0xca, 0x1c, 0x00]
      .forEach((b, i) => server.wat.guest_write8(srvBase + STUB_OFF + i, b));
    server.wat.test_dde_set_callback(1, ((SEL << 16) | STUB_OFF) >>> 0);

    // The client needs a callback too: an advise arrives as XTYP_ADVDATA with
    // nobody waiting, so it goes straight to the application.
    const cliBase = client.wat.win16_seg_base(CODE_SEG) >>> 0;
    [0xb8, 0x01, 0x00, 0x31, 0xd2, 0xca, 0x1c, 0x00]
      .forEach((b, i) => client.wat.guest_write8(cliBase + STUB_OFF + i, b));
    client.wat.test_dde_set_callback(1, ((SEL << 16) | STUB_OFF) >>> 0);

    const conv = client.wat.test_dde_connect_begin(
      1, intern(client, SERVICE), intern(client, TOPIC)) | 0;
    settle(server, client, server);
    assert((client.wat.test_dde_connect_done() | 0) === conv, 'no conversation');

    check('a server holds no advise loops until asked',
      (server.wat.test_dde_advise_count() | 0) === 0);
    assert(client.wat.test_dde_advstart(conv, intern(client, 'Table')) | 0,
      'the advise start was not sent');
    settle(server, client, server);
    check('the application agreed and the loop is open',
      (server.wat.test_dde_advise_count() | 0) === 1);
    // Asking twice must not open a second loop, or one update goes out twice.
    assert(client.wat.test_dde_advstart(conv, intern(client, 'Table')) | 0);
    settle(server, client, server);
    check('asking again does not open a second loop',
      (server.wat.test_dde_advise_count() | 0) === 1);

    check('nothing has been pushed yet',
      (client.wat.test_dde_last_advdata() | 0) === 0);
    server.wat.test_dde_post_advise(1, intern(server, TOPIC), 0);
    // The server asks its own application for the value, pushes it, and the
    // client hands it to its callback -- so both sides have to pump.
    for (let i = 0; i < 4; i++) { server.pump(); client.pump(); }
    for (let i = 0; i < 200; i++) server.wat.run(64);
    for (let i = 0; i < 4; i++) { server.pump(); client.pump(); }
    for (let i = 0; i < 200; i++) client.wat.run(64);

    const got = client.wat.test_dde_last_advdata() | 0;
    check('the advise reached the client application', got !== 0,
      'DdePostAdvise did not turn into a push');
    check(`the pushed data crossed intact (${payload.length} bytes)`,
      (client.wat.test_dde_data_len(got) | 0) === payload.length);
    const text = Array.from({ length: payload.length },
      (_, i) => String.fromCharCode(client.wat.test_dde_data_byte(got, i) | 0)).join('');
    check(`and says what the server application said ("${text}")`, text === 'TRICK-2');

    // A client that leaves is not owed updates, and a loop pointing at a dead
    // conversation would push into a handle that has since been reused.
    client.wat.test_dde_disconnect(conv);
    for (let i = 0; i < 4; i++) { server.pump(); client.pump(); }
    check('the loop goes when the conversation does',
      (server.wat.test_dde_advise_count() | 0) === 0);
  }

  // --- a connect that names nobody ------------------------------------------
  // A wildconnect asks "who is out there?" rather than for anyone in
  // particular, and the application is asked XTYP_WILDCONNECT rather than
  // XTYP_CONNECT: it is being asked what it will serve, not whether it will
  // serve this. Any instance with a service to offer is a candidate.
  {
    const segment = new LoopbackSegment();
    const server = await makeNode(wasm, segment.attach(), '10.77.0.1');
    const client = await makeNode(wasm, segment.attach(), '10.77.0.2');
    boot(server, bytes, 400);
    boot(client, bytes, 50);
    server.wat.test_dde_instance(0, 1);
    client.wat.test_dde_instance(0, 1);
    server.wat.test_dde_register(1, intern(server, SERVICE));
    installCallback(server, true);

    // An empty service name is what makes it wild.
    const conv = client.wat.test_dde_connect_begin(
      1, intern(client, ''), intern(client, TOPIC)) | 0;
    assert(conv, 'no conversation slot');
    settle(server, client, server);
    check('a wildconnect finds a server that never named itself to the client',
      (client.wat.test_dde_connect_done() | 0) === conv);

    // And a room with nothing registered still answers nobody, so "wild" does
    // not mean "anyone will do".
    const bare = await makeNode(wasm, segment.attach(), '10.77.0.3');
    boot(bare, bytes, 50);
    bare.wat.test_dde_instance(0, 1);
    installCallback(bare, true);
    const none = bare.wat.test_dde_connect_begin(
      1, intern(bare, ''), intern(bare, TOPIC)) | 0;
    for (let i = 0; i < 4; i++) { bare.pump(); client.pump(); }
    for (let i = 0; i < 200; i++) bare.wat.run(64);
    for (let i = 0; i < 4; i++) { bare.pump(); client.pump(); }
    check('a wildconnect is still not answered by an instance serving nothing',
      (bare.wat.test_dde_connect_done() | 0) === 0, `conv ${none}`);
  }

  console.log(`\n${passed} passed, 0 failed`);
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
