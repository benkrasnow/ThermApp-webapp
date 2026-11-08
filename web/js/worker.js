// Camera worker: owns the USB device, runs NUC / bad pixels / VGSK / temporal filter on
// every frame, and posts processed float frames to the page. The page acks each frame it
// draws. While it is busy, the newest frame waits and replaces any older waiting one, so
// latency stays at most one frame and a frame is only skipped if drawing can't keep up.

import { calibrationMaps, checkCalibration } from "./calibration.js";
import { applyNuc, copyRaw, DarkFrameAccumulator, fillBadPixels, subtractOffset, TemporalFilter, VgskController } from "./processing.js";
import { configFrom11bin, DEFAULT_CONFIG, framePixels, HEADER_BYTES, MAX_FPS, parseHeader, PIXELS, W_FRAME_RATE, W_VGSK } from "./protocol.js";
import { ThermAppUsb, USB_FILTER } from "./usb.js";

let usb = null;
let cal = null;      // { info, maps, isBad }
let vgsk = new VgskController(1300, 1580, 0.25);
const temporal = new TemporalFilter();
const settings = { nuc: true, badPixels: true, dark: true, frameRate: MAX_FPS };
let darkOffset = null; // Float32Array zero-mean offset map, in NUC units
let darkCapture = null; // DarkFrameAccumulator while capturing
let pageReady = true;
let waiting = null;    // newest processed frame not yet sent: [message, transfer]
let skipped = 0;       // frames replaced while waiting for the page
let announcedSerial = 0;
let lastStatsPost = 0;
// Rates over a sliding window: frames received, and the sensor's own counter (word 26).
const RATE_WINDOW_MS = 2000;
let arrivals = [];     // [time, unwrapped counter]
let lastCounter = -1, counterBase = 0;
let missed = 0;        // frames the sensor made but we never received (only at full rate)

// T_fpa jitters by a count or two per frame, and the NUC multiplies it by ~17 per count, so
// the raw value makes the whole frame flicker. It's a physical temperature that changes
// slowly, so smooth it over ~1 s (measured: frame flicker 0.038 → 0.013 °C).
const TFPA_ALPHA = 0.04;
let tfpaSmooth = null;

const post = (msg, transfer) => self.postMessage(msg, transfer || []);

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    switch (msg.type) {
      case "connect": await connect(); break;
      case "disconnect": await disconnect("Disconnected"); break;
      case "calibration": setCalibration(msg.files); break;
      case "settings": applySettings(msg.settings); break;
      case "ack":
        pageReady = true;
        if (waiting) sendFrame();
        break;
      case "dark": darkOffset = msg.offset || null; temporal.reset(); break;
      case "dark-capture": startDarkCapture(msg.frames); break;
      case "dark-cancel": darkCapture = null; break;
    }
  } catch (err) {
    post({ type: "error", name: err && err.name, message: String(err && err.message || err) });
  }
};

async function connect() {
  if (usb) return;
  const devices = await navigator.usb.getDevices();
  const device = devices.find((d) => d.vendorId === USB_FILTER.vendorId && d.productId === USB_FILTER.productId);
  if (!device) throw new Error("Camera not permitted yet. Click Connect and choose the Therm-App.");
  usb = new ThermAppUsb(device, onFrame);
  const config = cal ? configFrom11bin(cal.files["11.bin"]) : DEFAULT_CONFIG.slice();
  config[W_VGSK] = vgsk.value;
  config[W_FRAME_RATE] = settings.frameRate;
  usb.setConfig(config);
  try {
    await usb.open();
  } catch (err) {
    // Leave no half-open state behind, or later Connect attempts would be ignored.
    const u = usb;
    usb = null;
    try { await u.device.close(); } catch { /* wasn't open */ }
    throw err;
  }
  announcedSerial = 0;
  pageReady = true;
  waiting = null;
  skipped = missed = 0;
  tfpaSmooth = null;
  resetRates();
  temporal.reset();
  post({ type: "status", state: "connected" });
  usb.run()
    .then(() => disconnect("Disconnected"))
    .catch((err) => disconnect("Camera connection lost: " + (err && err.message || err)));
}

async function disconnect(reason) {
  if (!usb) return;
  const u = usb;
  usb = null;
  await u.close();
  post({ type: "status", state: "disconnected", message: reason });
}

function setCalibration(files) {
  if (!files) {
    cal = null;
    return;
  }
  const info = checkCalibration(files);
  const maps = calibrationMaps(files);
  const isBad = new Uint8Array(PIXELS);
  for (const i of maps.badPixels) isBad[i] = 1;
  cal = { files, info, maps, isBad };
  const auto = vgsk.auto;
  vgsk = new VgskController(info.vgskMin, info.vgskMax, info.adrTarget, vgsk.value);
  vgsk.auto = auto;
  if (usb) {
    const config = configFrom11bin(files["11.bin"]);
    config[W_VGSK] = vgsk.value;
    config[W_FRAME_RATE] = settings.frameRate;
    usb.setConfig(config);
  }
  temporal.reset();
}

function startDarkCapture(frames) {
  if (!usb) throw new Error("Connect the camera first.");
  if (!cal || !settings.nuc) throw new Error("Dark frames need the factory correction (NUC) on and calibration loaded.");
  darkCapture = new DarkFrameAccumulator(frames, cal.isBad);
}

function applySettings(s) {
  if ("dark" in s) { settings.dark = s.dark; temporal.reset(); }
  if ("nuc" in s) { settings.nuc = s.nuc; temporal.reset(); }
  if ("badPixels" in s) settings.badPixels = s.badPixels;
  if ("temporal" in s) temporal.strength = s.temporal;
  if ("frameRate" in s) {
    settings.frameRate = Math.max(1, Math.min(MAX_FPS, Math.round(s.frameRate)));
    if (usb) usb.setConfigWord(W_FRAME_RATE, settings.frameRate);
    resetRates();
  }
  if ("vgskAuto" in s) vgsk.auto = s.vgskAuto;
  if ("vgskManual" in s && !vgsk.auto) {
    vgsk.value = Math.max(vgsk.min, Math.min(vgsk.max, Math.round(s.vgskManual)));
  }
}

function onFrame(raw) {
  const header = parseHeader(raw);
  const pixels = framePixels(raw);
  if (header.serial !== announcedSerial) {
    announcedSerial = header.serial;
    post({ type: "serial", serial: header.serial, header });
  }

  const v = vgsk.update(new Uint16Array(raw, 0, HEADER_BYTES / 2 + PIXELS));
  if (usb) usb.setConfigWord(W_VGSK, v);

  const now = performance.now();
  trackRates(now, header.counter);
  if (now - lastStatsPost > 500) {
    lastStatsPost = now;
    post({ type: "stats", stats: { ...usb.stats, skipped, missed, ...rates() } });
  }

  if (tfpaSmooth === null || Math.abs(header.tfpa - tfpaSmooth) > 50) tfpaSmooth = header.tfpa;
  else tfpaSmooth += TFPA_ALPHA * (header.tfpa - tfpaSmooth);

  const calibrated = !!cal && settings.nuc;
  const image = new Float32Array(PIXELS);
  if (calibrated) applyNuc(pixels, tfpaSmooth, header.vgsk, cal.maps, image);
  else copyRaw(pixels, image);
  if (cal && (settings.badPixels || darkCapture)) fillBadPixels(image, cal.maps.badPixels, cal.isBad);

  if (darkCapture) {
    if (!calibrated) {
      darkCapture = null;
      post({ type: "dark-error", message: "Capture stopped: the factory correction was turned off." });
    } else {
      darkCapture.add(image, header);
      post({ type: "dark-progress", count: darkCapture.count, total: darkCapture.total });
      if (darkCapture.done) {
        const { offset, stats } = darkCapture.finish();
        const first = darkCapture.first;
        darkCapture = null;
        darkOffset = offset; // start using it at once; the page stores it
        temporal.reset();
        post({ type: "dark-result", offset, stats, header: first, last: header });
      }
    }
  }

  if (calibrated && darkOffset && settings.dark) subtractOffset(image, darkOffset);
  temporal.apply(image);

  if (waiting) skipped++;
  waiting = [{
    type: "frame",
    header,
    calibrated,
    image,
    raw,
    vgsk: { value: vgsk.value, auto: vgsk.auto, min: vgsk.min, max: vgsk.max, mean: vgsk.lastBin * 16, target: vgsk.target },
  }, [image.buffer, raw]];
  if (pageReady) sendFrame();
}

function resetRates() {
  arrivals = [];
  lastCounter = -1;
}

function trackRates(now, counter) {
  if (lastCounter >= 0) {
    const gap = (counter - lastCounter + 65536) & 0xffff;
    if (gap > 1 && gap < 1000 && settings.frameRate >= MAX_FPS) missed += gap - 1;
    counterBase += gap;
  } else {
    counterBase = 0;
  }
  lastCounter = counter;
  arrivals.push([now, counterBase]);
  while (arrivals.length > 2 && now - arrivals[0][0] > RATE_WINDOW_MS) arrivals.shift();
}

/** Delivered and sensor frame rates over the window (counting, not averaging 1/dt). */
function rates() {
  if (arrivals.length < 3) return { deliveredFps: 0, sensorFps: 0 };
  const [t0, c0] = arrivals[0], [t1, c1] = arrivals[arrivals.length - 1];
  const secs = (t1 - t0) / 1000;
  return { deliveredFps: (arrivals.length - 1) / secs, sensorFps: (c1 - c0) / secs };
}

function sendFrame() {
  const [msg, transfer] = waiting;
  waiting = null;
  pageReady = false;
  post(msg, transfer);
}
