"use strict";

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

window.startReferenceVm = function startReferenceVm(config) {
  if (window.emulator) {
    throw new Error("reference VM is already running");
  }

  return new Promise((resolve, reject) => {
    window.referenceSerialText = "";
    const emulator = window.emulator = new V86({
      wasm_path: "/runtime/v86.wasm",
      memory_size: config.memorySize,
      vga_memory_size: config.vgaMemorySize,
      screen_container: document.getElementById("screen_container"),
      bios: { url: config.biosUrl },
      vga_bios: { url: config.vgaBiosUrl },
      hda: config.hda,
      initial_state: config.stateUrl ? { url: config.stateUrl } : undefined,
      mac_address_translation: true,
      autostart: true,
    });

    const fail = error => reject(new Error(String(error && error.message || error)));
    window.addEventListener("error", event => fail(event.error || event.message), { once: true });
    emulator.add_listener("serial0-output-byte", value => {
      window.referenceSerialText += typeof value === "number" ? String.fromCharCode(value) : String(value);
    });
    emulator.add_listener("emulator-loaded", () => {
      const canvas = document.querySelector("#screen_container canvas");
      resolve({ width: canvas.width, height: canvas.height });
    });
  });
};

window.referenceVm = {
  async insertCd(url) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`CD fetch failed: ${response.status} ${response.statusText}`);
    }
    await window.emulator.set_cdrom({ buffer: await response.arrayBuffer() });
  },

  async run(command) {
    // Ctrl+Esc opens Start without the browser intercepting the chord.
    await window.emulator.keyboard_send_scancodes([0x1D, 0x01, 0x81, 0x9D], 20);
    await sleep(350);
    await window.emulator.keyboard_send_text("r", 20);
    await sleep(500);
    await window.emulator.keyboard_send_text(command, 20);
    await window.emulator.keyboard_send_scancodes([0x1C, 0x9C], 20);
  },

  screen() {
    const canvas = document.querySelector("#screen_container canvas");
    return {
      width: canvas.width,
      height: canvas.height,
      display: getComputedStyle(canvas).display,
      running: window.emulator.is_running(),
    };
  },

  serial() {
    return window.referenceSerialText || "";
  },
};
