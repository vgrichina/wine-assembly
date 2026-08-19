// Worker half of threads-probe.html. Receives a shared memory and a compiled
// module from the page and reports what it could actually do with them.
//
// The point is to test THIS project's pipeline, not a textbook one: the module
// may be the prebuilt artifact or one produced at load time by our own
// WAT->WASM compiler (lib/compile-wat.js), and it imports 174 host functions
// plus the memory. Those imports are stubbed here — instantiation succeeding is
// the signal, since it proves the module crossed a postMessage boundary and
// linked against memory created on the other thread.

self.onmessage = async (event) => {
  const msg = event.data || {};
  const reply = r => self.postMessage(Object.assign({ id: msg.id }, r));

  try {
    if (msg.kind === 'atomics') {
      // Prove the memory is genuinely shared: bump a counter the page is
      // watching, then wait for the page to bump one back. thread-manager.js
      // synchronises exactly this way (Atomics from JS, not wasm atomics), so
      // this is the representative test rather than a synthetic one.
      const view = new Int32Array(msg.memory.buffer, msg.offset, 4);
      for (let i = 0; i < 1000; i++) Atomics.add(view, 0, 1);
      Atomics.store(view, 1, 0xBEEF);
      Atomics.notify(view, 1);
      const waited = Atomics.wait(view, 2, 0, 3000);
      return reply({ ok: true, detail: `counter=${Atomics.load(view, 0)} wait=${waited}` });
    }

    if (msg.kind === 'instantiate') {
      const module = msg.module;
      const imports = {};
      let stubbed = 0;
      for (const imp of WebAssembly.Module.imports(module)) {
        imports[imp.module] = imports[imp.module] || {};
        if (imp.kind === 'memory') {
          imports[imp.module][imp.name] = msg.memory;
        } else if (imp.kind === 'function') {
          imports[imp.module][imp.name] = () => 0;
          stubbed++;
        } else if (imp.kind === 'global') {
          imports[imp.module][imp.name] = 0;
        }
      }
      const t0 = performance.now();
      const instance = await WebAssembly.instantiate(module, imports);
      const ms = performance.now() - t0;
      const exports = Object.keys(instance.exports || {});
      // Touch the memory through the instance so linkage is proven, not assumed.
      let readBack = null;
      if (typeof instance.exports.get_image_base === 'function') {
        readBack = instance.exports.get_image_base() >>> 0;
      }
      return reply({
        ok: true,
        detail: `instantiated in ${ms.toFixed(0)}ms, ${stubbed} host fns stubbed, `
          + `${exports.length} exports`
          + (readBack === null ? '' : `, get_image_base()=0x${readBack.toString(16)}`),
      });
    }

    if (msg.kind === 'paint') {
      // The end-to-end case: a module our own compiler produced, instantiated
      // here against memory from the other thread, rendering into that memory,
      // blitted onto an OffscreenCanvas the page transferred to us. If this
      // works, phase 1's rendering path works.
      const { module, memory, canvas, base, width, height, tid, frames } = msg;
      const instance = await WebAssembly.instantiate(module, { host: { memory } });
      const paint = instance.exports.paint;
      if (typeof paint !== 'function') throw new Error('module has no paint export');

      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('OffscreenCanvas has no 2d context in this worker');
      const image = ctx.createImageData(width, height);
      const pixels = new Uint8Array(memory.buffer, base, width * height * 4);

      let painted = 0, blitMs = 0, paintMs = 0;
      for (let f = 0; f < frames; f++) {
        const t0 = performance.now();
        painted += paint(base, width, height, tid, f * 3) | 0;
        const t1 = performance.now();
        // Copy out of shared memory: putImageData will not accept a view backed
        // by a SharedArrayBuffer, which is exactly the constraint the real GDI
        // path lives with too (it decodes into a reused ImageData).
        image.data.set(pixels);
        ctx.putImageData(image, 0, 0);
        blitMs += performance.now() - t1;
        paintMs += t1 - t0;
        // Yield so the page can observe intermediate frames rather than one
        // batch at the end — this is a visible demo, not just an assertion.
        await new Promise(r => setTimeout(r, 16));
      }
      return reply({
        ok: true,
        detail: `${frames} frames: wasm paint ${paintMs.toFixed(0)}ms total, `
          + `blit ${blitMs.toFixed(0)}ms total (${(blitMs / frames).toFixed(2)}ms/frame), `
          + `${painted} px written`,
      });
    }

    if (msg.kind === 'paint-loop') {
      // Paint continuously for a fixed wall-clock window, so the page can
      // measure its own responsiveness while this runs. `repeats` scales the
      // work per frame: one 320x240 fill is far cheaper than a guest slice, and
      // the comparison is only meaningful at a comparable load.
      const { module, memory, canvas, base, width, height, tid, ms, repeats } = msg;
      const instance = await WebAssembly.instantiate(module, { host: { memory } });
      const paint = instance.exports.paint;
      const ctx = canvas ? canvas.getContext('2d') : null;
      const image = ctx ? ctx.createImageData(width, height) : null;
      const pixels = new Uint8Array(memory.buffer, base, width * height * 4);
      const deadline = performance.now() + ms;
      let frames = 0, work = 0;
      while (performance.now() < deadline) {
        const t0 = performance.now();
        for (let i = 0; i < repeats; i++) paint(base, width, height, tid, frames * 3 + i);
        if (ctx) { image.data.set(pixels); ctx.putImageData(image, 0, 0); }
        work += performance.now() - t0;
        frames++;
        await new Promise(r => setTimeout(r, 0));
      }
      return reply({ ok: true, frames, workMs: work, detail: `${frames} frames, ${work.toFixed(0)}ms busy` });
    }

    reply({ ok: false, detail: `unknown kind ${msg.kind}` });
  } catch (err) {
    reply({ ok: false, detail: String(err && err.message || err) });
  }
};
