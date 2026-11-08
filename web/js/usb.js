// WebUSB transport: keeps several bulk reads in flight, re-sends the config header,
// and splits the byte stream into frames on the magic preamble.

import { EP_IN, EP_OUT, FRAME_BYTES, MAGIC, PID, VID } from "./protocol.js";

// A frame (221,696 bytes) is an exact multiple of the 512-byte packet size, so a read only
// completes when its buffer is full. Small reads keep frames from arriving in pairs.
const READ_SIZE = 65536;
const IN_FLIGHT = 4;
const CONFIG_INTERVAL_MS = 50;

export const USB_FILTER = { vendorId: VID, productId: PID };

export class ThermAppUsb {
  /**
   * @param {USBDevice} device  already permitted (requestDevice on the page, getDevices in a worker)
   * @param {(frame: ArrayBuffer) => void} onFrame
   */
  constructor(device, onFrame) {
    this.device = device;
    this.onFrame = onFrame;
    this.config = new Uint16Array(32);
    this.running = false;
    this.stats = { frames: 0, dropped: 0, bytes: 0 };
    this._buf = new Uint8Array(FRAME_BYTES * 4);
    this._len = 0;
  }

  setConfig(words) {
    this.config.set(words);
  }

  setConfigWord(index, value) {
    this.config[index] = value;
  }

  async open() {
    const d = this.device;
    if (!d.opened) await d.open();
    if (d.configuration === null) await d.selectConfiguration(1);
    await d.claimInterface(0);
  }

  /** Runs until stop() or a USB error; resolves when the read loop ends. */
  async run() {
    this.running = true;
    await this.device.transferOut(EP_OUT, this.config);
    const pending = [];
    for (let i = 0; i < IN_FLIGHT; i++) pending.push(this.device.transferIn(EP_IN, READ_SIZE));
    let lastCfg = 0;
    try {
      while (this.running) {
        const r = await pending.shift();
        if (this.running) pending.push(this.device.transferIn(EP_IN, READ_SIZE));
        if (r.status === "ok" && r.data.byteLength) {
          this.stats.bytes += r.data.byteLength;
          this._append(r.data);
          this._extract();
        } else if (r.status === "stall") {
          await this.device.clearHalt("in", EP_IN);
        }
        const now = performance.now();
        if (now - lastCfg > CONFIG_INTERVAL_MS) {
          lastCfg = now;
          await this.device.transferOut(EP_OUT, this.config);
        }
      }
    } finally {
      this.running = false;
      await Promise.allSettled(pending);
    }
  }

  async stop() {
    this.running = false;
  }

  async close() {
    this.running = false;
    try {
      const idle = Uint16Array.from(this.config);
      idle[4] = 1;
      await this.device.transferOut(EP_OUT, idle);
    } catch { /* device may already be gone */ }
    try { await this.device.releaseInterface(0); } catch { /* ignore */ }
    try { await this.device.close(); } catch { /* ignore */ }
  }

  _append(view) {
    const n = view.byteLength;
    if (this._len + n > this._buf.length) {
      const bigger = new Uint8Array((this._len + n) * 2);
      bigger.set(this._buf.subarray(0, this._len));
      this._buf = bigger;
    }
    this._buf.set(new Uint8Array(view.buffer, view.byteOffset, n), this._len);
    this._len += n;
  }

  _consume(n) {
    this._buf.copyWithin(0, n, this._len);
    this._len -= n;
  }

  _findMagic(from = 0, to = this._len) {
    const b = this._buf, end = Math.min(to, this._len) - MAGIC.length;
    outer: for (let i = from; i <= end; i++) {
      if (b[i] !== 0xa5) continue;
      for (let k = 1; k < MAGIC.length; k++) if (b[i + k] !== MAGIC[k]) continue outer;
      return i;
    }
    return -1;
  }

  _extract() {
    for (;;) {
      const start = this._findMagic();
      if (start < 0) {
        if (this._len > MAGIC.length) this._consume(this._len - MAGIC.length);
        return;
      }
      if (start > 0) this._consume(start);
      if (this._len < FRAME_BYTES) return;
      // Pixels are 12-bit, so the magic can't occur inside a frame. Finding one means this
      // frame was cut short. Below 25 fps, padding (not the next magic) can follow a frame.
      const next = this._findMagic(MAGIC.length, FRAME_BYTES);
      if (next >= 0) {
        this.stats.dropped++;
        this._consume(next);
        continue;
      }
      const frame = this._buf.slice(0, FRAME_BYTES).buffer;
      this._consume(FRAME_BYTES);
      this.stats.frames++;
      this.onFrame(frame);
    }
  }
}
