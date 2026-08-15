// Virtual LAN wire — docs/virtual-lan-party.md
//
// The room switch lives in WAT. This file is only the segment the frames
// travel on: it never reads a port, tracks a connection, or decides a
// route. A wire has exactly three obligations:
//
//   send(bytes)  accept an outbound frame, or refuse it when full
//   peek()       show the next inbound frame without consuming it
//   commit()     consume the frame that was just shown
//
// Peek and commit are separate because a frame whose destination ring is
// full has to stay queued. A byte stream may not drop or reorder anything,
// so the guest reader draining its buffer is what lets the wire advance.
//
// Two wires ship here. LoopbackWire connects instances inside one process
// (unit tests, and later two WASM instances in one browser tab).
// ProcessWire connects an emulator process to a hub over Node's child IPC,
// which is how the two-process Liquid War gate runs. Slice 4 adds a third
// that carries the same frames over a WebRTC DataChannel; nothing in WAT
// changes when it does, because the frame is the contract.

const MAX_QUEUE_FRAMES = 512;

// The header is fixed-width, so the wire can describe what it is carrying
// without knowing what any of it means. Both the trace in host-imports.js and
// the arrival hook below print through this, so a frame reads the same way
// wherever it is observed.
const VLN_TYPES = { 1: 'SYN', 2: 'SYNACK', 3: 'DATA', 4: 'FIN', 5: 'RST' };
const ip4 = (v) => `${(v >>> 24) & 255}.${(v >>> 16) & 255}.${(v >>> 8) & 255}.${v & 255}`;

function describeFrame(bytes) {
  if (!bytes || bytes.length < 28) return `malformed ${bytes ? bytes.length : 0}B`;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = dv.getUint32(4, true);
  const len = dv.getUint32(24, true);
  return `${VLN_TYPES[type] || `type${type}`} `
    + `${ip4(dv.getUint32(8, true))}:${dv.getUint32(12, true)} `
    + `-> ${ip4(dv.getUint32(16, true))}:${dv.getUint32(20, true)}`
    + (len ? ` len=${len}` : '');
}

class Wire {
  constructor() {
    this.inbox = [];
    this.sentFrames = 0;
    this.recvFrames = 0;
    this.droppedFrames = 0;
  }

  // Called by the transport when a frame arrives for this endpoint.
  deliver(bytes) {
    if (this.inbox.length >= MAX_QUEUE_FRAMES) {
      // Refusing here would silently lose a stream byte. The queue bound is
      // generous relative to the receive rings that drain it, so reaching it
      // means something upstream is not reading; say so rather than hide it.
      this.droppedFrames++;
      throw new Error(`vlan-wire: inbox overflow (${MAX_QUEUE_FRAMES} frames undelivered)`);
    }
    this.inbox.push(bytes);
    this.recvFrames++;
    // Arrival and observation are different events, and confusing them costs
    // hours: a frame sitting unread in this inbox looks exactly like a frame
    // that was never sent, because the only other trace point is the guest's
    // peek. This hook is what tells the two apart.
    if (this.onDeliver) this.onDeliver(bytes);
  }

  peek() { return this.inbox.length ? this.inbox[0] : null; }
  commit() { this.inbox.shift(); }
  get pending() { return this.inbox.length; }

  // Subclasses implement transmission. Return false to apply backpressure.
  send(_bytes) { throw new Error('vlan-wire: send not implemented'); }
}

// Every endpoint on one loopback segment sees every frame except its own,
// which is what makes the WAT side responsible for address filtering.
class LoopbackSegment {
  constructor() { this.endpoints = []; }

  attach() {
    const wire = new LoopbackWire(this);
    this.endpoints.push(wire);
    return wire;
  }

  broadcast(from, bytes) {
    for (const ep of this.endpoints) {
      if (ep === from) continue;
      ep.deliver(bytes);
    }
    return true;
  }
}

class LoopbackWire extends Wire {
  constructor(segment) { super(); this.segment = segment; }
  send(bytes) {
    this.sentFrames++;
    return this.segment.broadcast(this, bytes);
  }
}

// One emulator process talking to a hub over child-process IPC. Frames
// arrive asynchronously, so they land in the inbox and the guest sees them
// the next time it drains the wire.
class ProcessWire extends Wire {
  constructor(channel) {
    super();
    this.channel = channel;
    channel.on('message', (msg) => {
      if (!msg || msg.t !== 'vln') return;
      this.deliver(Uint8Array.from(Buffer.from(msg.d, 'base64')));
    });
  }

  send(bytes) {
    if (!this.channel.connected) return false;
    this.sentFrames++;
    return this.channel.send({ t: 'vln', d: Buffer.from(bytes).toString('base64') }) !== false;
  }
}

// The hub is the segment itself when the endpoints are separate processes:
// it repeats each frame to every other member and holds no state of its own.
class ProcessHub {
  constructor() { this.members = []; }

  add(child) {
    this.members.push(child);
    child.on('message', (msg) => {
      if (!msg || msg.t !== 'vln') return;
      for (const other of this.members) {
        if (other === child) continue;
        if (other.connected) other.send(msg);
      }
    });
  }
}

// ProcessWire and ProcessHub are Node-only (they speak child-process IPC) but
// they cost nothing to name here; the browser uses LoopbackSegment for two
// instances in one page and lib/vlan-rtc.js for two people in two browsers.
const _exports = {
  Wire, LoopbackSegment, LoopbackWire, ProcessWire, ProcessHub,
  MAX_QUEUE_FRAMES, describeFrame,
};
if (typeof module !== 'undefined' && module.exports) {
  module.exports = _exports;
} else if (typeof window !== 'undefined') {
  window.VlanWire = _exports;
}
