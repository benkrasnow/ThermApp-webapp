// Stills and video. Files go into a folder the user picks once (File System Access API,
// remembered in IndexedDB), or are downloaded where that API isn't available (e.g. Android).

import { HEIGHT, WIDTH } from "./protocol.js";

// ---- output folder ----

const DB = "thermapp-files";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore("handles");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idb(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction("handles", mode);
    const req = fn(t.objectStore("handles"));
    t.oncomplete = () => resolve(req.result);
    t.onerror = () => reject(t.error);
  });
}

export const canPickFolder = "showDirectoryPicker" in window;

export class OutputFolder {
  constructor() {
    this.handle = null;
  }

  get name() {
    return this.handle ? this.handle.name : null;
  }

  async restore() {
    if (!canPickFolder) return;
    try {
      this.handle = (await idb("readonly", (s) => s.get("output"))) || null;
    } catch {
      this.handle = null;
    }
  }

  async pick() {
    this.handle = await window.showDirectoryPicker({ id: "thermapp-output", mode: "readwrite", startIn: "pictures" });
    await idb("readwrite", (s) => s.put(this.handle, "output"));
  }

  /** Ensure write permission (needs a user gesture the first time after a reload). */
  async ready() {
    if (!this.handle) return false;
    const opts = { mode: "readwrite" };
    if ((await this.handle.queryPermission(opts)) === "granted") return true;
    return (await this.handle.requestPermission(opts)) === "granted";
  }

  async writeFile(name, blob) {
    if (await this.ready()) {
      const fh = await this.handle.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      await w.write(blob);
      await w.close();
    } else {
      download(name, blob);
    }
  }

  async createWritable(name) {
    if (!(await this.ready())) return null;
    const fh = await this.handle.getFileHandle(name, { create: true });
    return fh.createWritable();
  }
}

function download(name, blob) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

export function timestamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// ---- stills ----

/**
 * Single-channel 32-bit float TIFF (opens in ImageJ/Fiji, Python, MATLAB) with a JSON
 * ImageDescription holding the frame header and display settings.
 */
export function floatTiff(img, description) {
  const desc = new TextEncoder().encode(description + "\0");
  const tags = [
    [256, 3, 1, WIDTH],          // ImageWidth
    [257, 3, 1, HEIGHT],         // ImageLength
    [258, 3, 1, 32],             // BitsPerSample
    [259, 3, 1, 1],              // Compression: none
    [262, 3, 1, 1],              // Photometric: min-is-black
    [270, 2, desc.length, 0],    // ImageDescription (offset patched below)
    [273, 4, 1, 0],              // StripOffsets (patched below)
    [277, 3, 1, 1],              // SamplesPerPixel
    [278, 3, 1, HEIGHT],         // RowsPerStrip
    [279, 4, 1, img.byteLength], // StripByteCounts
    [339, 3, 1, 3],              // SampleFormat: IEEE float
  ];
  const ifdSize = 2 + tags.length * 12 + 4;
  const descOffset = 8 + ifdSize;
  const dataOffset = (descOffset + desc.length + 3) & ~3;
  const buf = new ArrayBuffer(dataOffset + img.byteLength);
  const dv = new DataView(buf);
  dv.setUint16(0, 0x4949, true); // "II" little-endian
  dv.setUint16(2, 42, true);
  dv.setUint32(4, 8, true);
  dv.setUint16(8, tags.length, true);
  tags.forEach(([tag, type, count, value], i) => {
    const o = 10 + i * 12;
    if (tag === 270) value = descOffset;
    if (tag === 273) value = dataOffset;
    dv.setUint16(o, tag, true);
    dv.setUint16(o + 2, type, true);
    dv.setUint32(o + 4, count, true);
    if (type === 3) dv.setUint16(o + 8, value, true);
    else dv.setUint32(o + 8, value, true);
  });
  dv.setUint32(10 + tags.length * 12, 0, true); // no next IFD
  new Uint8Array(buf, descOffset, desc.length).set(desc);
  new Float32Array(buf, dataOffset, img.length).set(img);
  return new Blob([buf], { type: "image/tiff" });
}

/**
 * Save a still: the displayed view as PNG, plus optionally the processed float data (TIFF)
 * and the untouched USB frame (.raw).
 */
export async function saveStill(folder, canvas, frame, meta, opts) {
  const base = `thermapp_${timestamp()}`;
  const png = await new Promise((r) => canvas.toBlob(r, "image/png"));
  await folder.writeFile(base + ".png", png);
  if (opts.tiff) await folder.writeFile(base + ".tif", floatTiff(frame.image, JSON.stringify(meta)));
  if (opts.raw) await folder.writeFile(base + ".raw", new Blob([frame.raw]));
  return base;
}

// ---- video ----

// Measured in Chrome/Edge (web/test/video-quality.html): every H.264 path from MediaRecorder
// shifts colours (about +15 green, +6 red, on 0–255), which caps fidelity near 27 dB at any
// bitrate. VP9 is colour-accurate (about 47 dB on a static frame, 35–40 dB on noisy video), and
// fits in an MP4 container that Edge, Chrome, Firefox, VLC and Windows Media Player play.
export const VIDEO_FORMATS = {
  "mp4-vp9": { label: "MP4 (VP9), best quality", types: ["video/mp4;codecs=vp9"], ext: "mp4" },
  "mp4-h264": { label: "MP4 (H.264), most compatible, colours shift", types: ["video/mp4;codecs=avc1.640028", "video/mp4"], ext: "mp4" },
  "webm-vp9": { label: "WebM (VP9)", types: ["video/webm;codecs=vp9", "video/webm"], ext: "webm" },
};

// Requested bits per output pixel per frame. VP9 stays well under the request on thermal
// video (roughly half), so these are ceilings. 3× output at 26 fps is 25.9 Mpixel/s.
export const VIDEO_QUALITY = {
  standard: { label: "Standard", bpp: 0.4 },  // ~10 Mbps requested at 3×
  high: { label: "High", bpp: 1.15 },         // ~30 Mbps at 3×, ~53 at 4×
  maximum: { label: "Maximum", bpp: 2.3 },    // ~60 Mbps at 3×
};

/** First supported format, starting with the preferred one. */
export function videoFormat(preferred = "mp4-vp9") {
  if (!window.MediaRecorder) return null;
  const order = [preferred, ...Object.keys(VIDEO_FORMATS).filter((k) => k !== preferred)];
  for (const key of order) {
    const f = VIDEO_FORMATS[key];
    const type = f && f.types.find((t) => MediaRecorder.isTypeSupported(t));
    if (type) return { key, type, ext: f.ext, label: f.label };
  }
  return null;
}

/**
 * Records the display canvas. Streams to a file in the output folder when possible.
 *
 * Frames are pushed explicitly (captureStream(0) + requestFrame after each draw), so the video
 * holds exactly one frame per drawn camera frame, with its real timing. A rate-limited
 * captureStream(25) samples on its own timer and measurably dropped one frame in 26 at the
 * sensor's 25.98 fps (web/test/video-frames.html).
 */
export class VideoRecorder {
  constructor(canvas, folder) {
    this.canvas = canvas;
    this.folder = folder;
    this.recorder = null;
    this.started = 0;
    this.fps = 25;
    this.format = "mp4-vp9";
    this.quality = "high";
    this.streamed = false;
  }

  /** Requested bitrate for the current canvas size, frame rate and quality. */
  bitrate() {
    const bpp = (VIDEO_QUALITY[this.quality] || VIDEO_QUALITY.high).bpp;
    return Math.round(this.canvas.width * this.canvas.height * Math.min(this.fps, 26) * bpp);
  }

  get active() {
    return !!this.recorder;
  }

  elapsed() {
    const s = Math.floor((performance.now() - this.started) / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }

  async start() {
    const fmt = videoFormat(this.format);
    if (!fmt) throw new Error("This browser cannot record video from a canvas.");
    const name = `thermapp_${timestamp()}.${fmt.ext}`;
    const writable = await this.folder.createWritable(name);
    this.streamed = !!writable; // false: chunks are held in memory until Stop, then downloaded
    const chunks = [];
    let writes = Promise.resolve();
    const stream = this.canvas.captureStream(0);
    this.track = stream.getVideoTracks()[0];
    const rec = new MediaRecorder(stream, { mimeType: fmt.type, videoBitsPerSecond: this.bitrate() });
    this.bytes = 0;
    this.frames = 0;
    rec.ondataavailable = (e) => {
      if (!e.data.size) return;
      this.bytes += e.data.size;
      if (writable) writes = writes.then(() => writable.write(e.data));
      else chunks.push(e.data);
    };
    this.done = new Promise((resolve) => {
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        if (writable) {
          await writes;
          await writable.close();
        } else {
          download(name, new Blob(chunks, { type: fmt.type }));
        }
        resolve(name);
      };
    });
    rec.start(1000);
    this.recorder = rec;
    this.started = performance.now();
    return name;
  }

  /** Call right after drawing each frame into the canvas. */
  pushFrame() {
    if (!this.recorder) return;
    this.track.requestFrame();
    this.frames++;
  }

  async stop() {
    if (!this.recorder) return null;
    const rec = this.recorder;
    this.recorder = null;
    rec.stop();
    return this.done;
  }
}
