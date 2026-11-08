// Page controller: UI, settings, calibration lookup, and the bridge to the camera worker.

import { calibrationStore, checkCalibration, darkStore, fetchCalibration, filesFromFileList } from "./calibration.js";
import { canPickFolder, OutputFolder, saveStill, VIDEO_FORMATS, VideoRecorder, videoFormat } from "./capture.js";
import { PALETTES } from "./palettes.js";
import { HEIGHT, WIDTH } from "./protocol.js";
import { USB_FILTER } from "./usb.js";
import { estimateNoise } from "./enhance.js";
import { Agc, extremes, makeUnits, Renderer, spotValue } from "./view.js";

const $ = (id) => document.getElementById(id);

// ---- settings (persisted per browser) ----

// manualLo/manualHi are image values (hundredths of °C when corrected), independent of the display unit.
const DEFAULTS = {
  palette: 3, mirror: false, flip: false, nuc: true, badPixels: true, temporal: 0, unit: "C",
  rangeMode: "auto", ignore: 1, smoothing: 0.2, manualLo: 1500, manualHi: 3000,
  spot: true, extremes: false, colorbar: true, vgskAuto: true, vgskManual: 1520,
  saveTiff: true, saveRaw: false, spotX: WIDTH >> 1, spotY: HEIGHT >> 1,
  dark: true, darkFrames: 32, frameRate: 25,
  enhance: true, outScale: 3, interp: "lanczos", denoise: 1.5, detail: 2.0,
  videoFormat: "mp4-vp9", videoQuality: "high",
};
const settings = { ...DEFAULTS, ...loadSettings() };
if (settings.rangeMode !== "manual") settings.rangeMode = "auto";

// Manual range sliders span this many degrees Celsius (converted for °F).
const SLIDER_C = [-20, 150];
const MIN_GAP = 20; // image units between min and max (0.2 °C)

function loadSettings() {
  try { return JSON.parse(localStorage.getItem("thermapp-settings") || "{}"); } catch { return {}; }
}
function saveSettings() {
  try { localStorage.setItem("thermapp-settings", JSON.stringify(settings)); } catch { /* private mode */ }
}

// ---- state ----

const canvas = $("view");
const renderer = new Renderer(canvas);
const agc = new Agc();
const folder = new OutputFolder();
const recorder = new VideoRecorder(canvas, folder);
const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });

let connected = false;
let serial = 0;
let calibrationSource = null; // "stored" | "local" | null
let darkRecord = null;        // stored dark frame for the connected camera
let darkCapturing = false;
let needUsbPermission = false; // set after "Access denied": the next Connect goes through the device picker
let activeLimit = null;        // touch: selected colour-bar limit, "hi" | "lo" | null
let suppressSpotClick = false; // a label tap or a swipe shouldn't also move the spot
let lastFrame = null;         // { header, image, raw, calibrated, vgsk }
let units = makeUnits(settings.unit, true);
let fps = 0, lastReadout = 0;
let drawTimes = [];
let noise = 0, frameNo = 0; // smoothed noise σ (image units) for the denoise threshold
let stats = { frames: 0, dropped: 0 };

// ---- worker messages ----

worker.onmessage = (e) => {
  const m = e.data;
  switch (m.type) {
    case "status":
      connected = m.state === "connected";
      setStatus(connected ? "wait" : "off", connected ? "Starting stream…" : (m.message || "Not connected"));
      $("btn-connect").hidden = connected;
      $("btn-disconnect").hidden = !connected;
      $("btn-snap").disabled = $("btn-rec").disabled = !connected;
      syncRail();
      updateWakeLock();
      if (!connected) {
        $("placeholder").hidden = false;
        if (recorder.active) toggleRecording();
        serial = 0;
        darkCapturing = false;
        updateCalibrationUi();
        updateDarkUi();
      }
      break;
    case "serial":
      serial = m.serial;
      setStatus("on", `Connected · camera ${serial}`);
      $("ro-serial").textContent = `serial ${serial}`;
      loadCalibrationFor(serial).then(() => loadDarkFor(serial));
      break;
    case "dark-progress":
      $("btn-dark").textContent = `Capturing ${m.count}/${m.total}…`;
      break;
    case "dark-result":
      onDarkResult(m);
      break;
    case "dark-error":
      darkCapturing = false;
      updateDarkUi();
      flash(m.message);
      break;
    case "frame":
      onFrame(m);
      break;
    case "stats":
      stats = m.stats;
      break;
    case "error":
      if (m.name === "SecurityError" || /access denied/i.test(m.message)) {
        needUsbPermission = true;
        setStatus("err", "Android hasn't given this app access to the camera. Tap Connect and choose USB2.0. If an old Therm-App app opens whenever you plug the camera in, clear its default first: Settings → Apps → that app → Open by default → Clear.");
      } else {
        setStatus("err", m.message);
      }
      break;
  }
};

function sendSettings(s) {
  worker.postMessage({ type: "settings", settings: s });
}

// ---- connection ----

async function connect() {
  if (!("usb" in navigator)) {
    setStatus("err", "No WebUSB in this browser. Use Chrome or Edge.");
    return;
  }
  try {
    const permitted = await navigator.usb.getDevices();
    // Android forgets its own USB permission whenever the camera is re-plugged, even though the
    // page still lists the device as permitted. Only Chrome's device picker (which needs a tap)
    // asks Android again, so after an "Access denied" go through the picker.
    if (!permitted.some(isThermApp) || needUsbPermission) {
      await navigator.usb.requestDevice({ filters: [USB_FILTER] });
      needUsbPermission = false;
    }
    setStatus("wait", "Connecting…");
    worker.postMessage({ type: "connect" });
  } catch (err) {
    if (err.name !== "NotFoundError") setStatus("err", err.message);
  }
}

const isThermApp = (d) => d.vendorId === USB_FILTER.vendorId && d.productId === USB_FILTER.productId;

if ("usb" in navigator) {
  navigator.usb.addEventListener("connect", (e) => { if (isThermApp(e.device) && !connected) connect(); });
  navigator.usb.getDevices().then((ds) => { if (ds.some(isThermApp)) connect(); });
}

function setStatus(kind, text) {
  const el = $("status");
  el.className = "status " + kind;
  el.querySelector("span").textContent = text;
}

// ---- calibration ----

async function loadCalibrationFor(sn) {
  let files = null;
  calibrationSource = null;
  try {
    const stored = await calibrationStore.get(sn);
    if (stored) {
      files = stored.files;
      calibrationSource = "stored";
    }
  } catch { /* IndexedDB unavailable */ }
  if (!files) {
    // When the page is served from the project folder, pick up calibration/<serial>/ directly.
    files = await fetchCalibration(new URL(`../../calibration/${sn}/`, import.meta.url).href).catch(() => null);
    if (files) {
      calibrationSource = "local";
      calibrationStore.put(sn, files).catch(() => {});
    }
  }
  if (files) {
    try {
      checkCalibration(files);
      worker.postMessage({ type: "calibration", files });
    } catch (err) {
      calibrationSource = null;
      showBanner(`Calibration for camera ${sn} is invalid: ${err.message}`);
    }
  }
  updateCalibrationUi();
}

async function importCalibration(fileList) {
  try {
    const files = await filesFromFileList(fileList);
    checkCalibration(files);
    const folderName = (fileList[0].webkitRelativePath || "").split("/")[0];
    const target = serial || (/^\d+$/.test(folderName) ? Number(folderName) : 0);
    if (!target) throw new Error("Connect the camera first, or name the folder after its serial number.");
    if (serial && /^\d+$/.test(folderName) && Number(folderName) !== serial &&
        !confirm(`This folder is named ${folderName}, but the connected camera is ${serial}. Use it for camera ${serial} anyway?`)) return;
    await calibrationStore.put(target, files);
    if (target === serial) await loadCalibrationFor(serial);
    else updateCalibrationUi();
    flash(`Calibration imported for camera ${target}.`);
  } catch (err) {
    alert("Could not import calibration: " + err.message);
  }
}

async function updateCalibrationUi() {
  const st = $("cal-status");
  if (!serial) st.textContent = "No camera connected.";
  else if (calibrationSource) {
    const where = ["localhost", "127.0.0.1"].includes(location.hostname) ? "the project folder" : "the website";
    st.textContent = `Camera ${serial}: factory calibration loaded${calibrationSource === "local" ? ` from ${where} (now saved in this browser)` : ""}.`;
  }
  else st.textContent = `Camera ${serial}: no calibration found. The image is uncorrected.`;

  if (serial && !calibrationSource) {
    showBanner(`No factory calibration for camera ${serial}, so the image is uncorrected. ` +
      `<button class="small" id="banner-import">Import calibration folder…</button>`);
    $("banner-import").onclick = () => $("file-import").click();
  } else {
    hideBanner();
  }

  const list = $("cal-list");
  list.innerHTML = "";
  let serials = [];
  try { serials = await calibrationStore.serials(); } catch { /* ignore */ }
  for (const sn of serials) {
    const li = document.createElement("li");
    li.innerHTML = `<span>📁 ${sn}${sn === serial ? " <span class='dim'>(connected)</span>" : ""}</span>`;
    const del = document.createElement("button");
    del.className = "small";
    del.textContent = "Remove";
    del.onclick = async () => {
      if (!confirm(`Remove stored calibration for camera ${sn} from this browser?`)) return;
      await calibrationStore.remove(sn);
      if (sn === serial) {
        worker.postMessage({ type: "calibration", files: null });
        calibrationSource = null;
      }
      updateCalibrationUi();
    };
    li.append(del);
    list.append(li);
  }
}

// ---- dark frame ----

async function loadDarkFor(sn) {
  darkRecord = null;
  try { darkRecord = (await darkStore.get(sn)) || null; } catch { /* IndexedDB unavailable */ }
  worker.postMessage({ type: "dark", offset: darkRecord ? darkRecord.offset : null });
  updateDarkUi();
}

function captureDark() {
  if (!connected || darkCapturing) return;
  if (!calibrationSource || !settings.nuc) {
    flash("Dark frames need the factory calibration loaded and the factory correction on.");
    return;
  }
  darkCapturing = true;
  updateDarkUi();
  worker.postMessage({ type: "dark-capture", frames: settings.darkFrames });
}

async function onDarkResult(m) {
  darkCapturing = false;
  darkRecord = {
    serial, offset: m.offset, stats: m.stats, tfpa: m.header.tfpa, vgsk: m.header.vgsk,
    captured: new Date().toISOString(),
  };
  try { await darkStore.put(darkRecord); } catch { flash("Dark frame applied, but could not be saved in this browser."); }
  if (!settings.dark) $("opt-dark").click();
  updateDarkUi();
  const u = makeUnits(settings.unit, true);
  flash(`Dark frame captured: removed ±${(u.toDisplay(m.stats.std) - u.toDisplay(0)).toFixed(2)}${u.suffix} RMS non-uniformity.`);
}

async function clearDark() {
  if (!serial || !darkRecord) return;
  try { await darkStore.remove(serial); } catch { /* ignore */ }
  darkRecord = null;
  worker.postMessage({ type: "dark", offset: null });
  updateDarkUi();
}

function updateDarkUi() {
  const btn = $("btn-dark");
  btn.disabled = !connected || darkCapturing || !calibrationSource;
  if (!darkCapturing) btn.textContent = darkRecord ? "Recapture dark frame" : "Capture dark frame";
  $("opt-dark").disabled = !darkRecord;
  $("btn-dark-clear").hidden = !darkRecord;
  const st = $("dark-status");
  if (!serial) st.textContent = "Connect the camera to capture or load a dark frame.";
  else if (!darkRecord) st.textContent = "No dark frame for this camera.";
  else {
    // Offsets are differences, so convert spans without the °F +32 offset.
    const u = makeUnits(settings.unit, true), span = (v) => (u.toDisplay(v) - u.toDisplay(0)).toFixed(2) + u.suffix;
    const s = darkRecord.stats;
    st.textContent = `Captured ${age(darkRecord.captured)} from ${s.frames} frames. ` +
      `Corrects ±${span(s.std)} RMS (range ${span(s.min)} to +${span(s.max)}).` +
      (settings.dark ? "" : " Currently off.");
  }
}

function age(iso) {
  const min = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h ago`;
  return new Date(iso).toLocaleDateString();
}

function showBanner(html) {
  const b = $("banner");
  b.innerHTML = html;
  b.hidden = false;
}
function hideBanner() {
  $("banner").hidden = true;
}

// ---- frames ----

function onFrame(m) {
  lastFrame = m;
  $("placeholder").hidden = true;
  // Displayed rate: frames drawn over the last 2 s. (Averaging 1/dt reads high when arrivals jitter.)
  const now = performance.now();
  drawTimes.push(now);
  while (drawTimes.length > 2 && now - drawTimes[0] > 2000) drawTimes.shift();
  fps = drawTimes.length > 2 ? (drawTimes.length - 1) * 1000 / (now - drawTimes[0]) : 0;

  if (m.calibrated !== units.calibrated) {
    units = makeUnits(settings.unit, m.calibrated);
    agc.reset();
    syncRangeUi();
  }

  agc.update(m.image);
  let lo = agc.lo, hi = agc.hi;
  if (settings.rangeMode === "manual") {
    lo = settings.manualLo;
    hi = Math.max(settings.manualHi, lo + 1);
  }
  const spot = { x: settings.spotX, y: settings.spotY, value: spotValue(m.image, settings.spotX, settings.spotY) };
  const ext = renderer.overlays.extremes ? extremes(m.image) : null;
  if (frameNo++ % 4 === 0) {
    const n = estimateNoise(m.image, WIDTH, HEIGHT);
    noise = noise ? noise + 0.3 * (n - noise) : n;
  }
  renderer.draw(m.image, lo, hi, {
    unitScale: m.calibrated ? 0.01 : 1,
    noise,
    fmt: units.fmt,
    spot: renderer.overlays.spot ? spot : null,
    extremes: ext,
  });
  recorder.pushFrame();
  if (activeLimit) positionLimitHighlight();
  worker.postMessage({ type: "ack" });

  if (now - lastReadout > 250) {
    lastReadout = now;
    $("ro-fps").textContent = `${fps.toFixed(1)} fps` +
      (stats.sensorFps ? ` · received ${stats.deliveredFps.toFixed(1)} · sensor ${stats.sensorFps.toFixed(2)}` : "");
    $("ro-spot").textContent = `spot ${units.fmt(spot.value)}${m.calibrated ? "" : " (raw counts)"}`;
    $("ro-range").textContent = `range ${units.fmt(lo)} – ${units.fmt(hi)}`;
    $("ro-vgsk").textContent = `VGSK ${m.header.vgsk}${m.vgsk.auto ? "" : " (manual)"}`;
    $("ro-tfpa").textContent = `Tfpa ${m.header.tfpa}`;
    $("ro-dropped").textContent = `lost ${stats.dropped + (stats.missed || 0)} · skipped ${stats.skipped || 0}`;
    $("enh-noise").textContent = m.calibrated ? `±${(units.toDisplay(noise) - units.toDisplay(0)).toFixed(2)}${units.suffix}` : `±${noise.toFixed(1)} counts`;
    $("vgsk-mean").textContent = Math.round(m.vgsk.mean);
    $("vgsk-target").textContent = Math.round(m.vgsk.target);
    if (m.vgsk.auto) {
      $("vgsk-manual").value = m.vgsk.value;
      $("vgsk-manual-v").textContent = m.vgsk.value;
    }
  }
}

/** Image values of a frame converted for saving: °C when corrected, raw counts otherwise. */
function saveableImage(frame) {
  if (!frame.calibrated) return frame.image;
  const out = new Float32Array(frame.image.length);
  for (let i = 0; i < out.length; i++) out[i] = frame.image[i] / 100;
  return out;
}

// ---- capture ----

async function snapshot() {
  if (!lastFrame) return;
  try {
    const manual = settings.rangeMode === "manual";
    const scale = lastFrame.calibrated ? 0.01 : 1;
    const meta = {
      app: "Therm-App Web", serial, header: lastFrame.header, calibrated: lastFrame.calibrated,
      units: lastFrame.calibrated ? "degC" : "raw ADC counts",
      range: [(manual ? settings.manualLo : agc.lo) * scale, (manual ? settings.manualHi : agc.hi) * scale],
      rangeMode: settings.rangeMode, displayUnit: units.suffix || "counts",
      spot: { x: settings.spotX, y: settings.spotY, value: spotValue(lastFrame.image, settings.spotX, settings.spotY) * scale },
      palette: PALETTES[settings.palette].name, mirror: settings.mirror, flip: settings.flip,
      darkFrame: darkRecord && settings.dark && lastFrame.calibrated ? { captured: darkRecord.captured, frames: darkRecord.stats.frames } : null,
      display: { scale: renderer.enhance.scale, interp: renderer.enhance.interp, enhanced: renderer.enhance.on && renderer.canEnhance,
        denoise: renderer.enhance.denoise, detail: renderer.enhance.detail, note: "PNG only; TIFF temperatures are unenhanced" },
      time: new Date().toISOString(),
    };
    const frame = { ...lastFrame, image: saveableImage(lastFrame) };
    const name = await saveStill(folder, canvas, frame, meta, { tiff: settings.saveTiff, raw: settings.saveRaw });
    flash(`Saved ${name}`);
  } catch (err) {
    flash("Snapshot failed: " + err.message);
  }
}

// Recording time, size and dropped frames, shown over the video in HTML so it is never recorded.
// "Dropped" counts camera frames that never reached the canvas since recording started:
// lost on USB, or skipped because the page was still drawing.
let recBadgeTimer = 0;
let recDropBase = 0;
const framesNotDrawn = () => stats.dropped + (stats.missed || 0) + (stats.skipped || 0);
const recDropped = () => Math.max(0, framesNotDrawn() - recDropBase);

function updateRecBadge() {
  const dropped = recDropped();
  $("rec-badge").querySelector("span").textContent =
    `REC ${recorder.elapsed()} · ${(recorder.bytes / 1e6).toFixed(0)} MB` + (dropped ? ` · ${dropped} dropped` : "");
  $("rec-badge").classList.toggle("warn", dropped > 0);
}

async function toggleRecording() {
  try {
    if (recorder.active) {
      clearInterval(recBadgeTimer);
      $("rec-badge").hidden = true;
      const frames = recorder.frames, dropped = recDropped();
      const name = await recorder.stop();
      $("btn-rec").classList.remove("recording");
      $("btn-rec").textContent = "⏺ Record";
      syncRail();
      updateWakeLock();
      const pct = (100 * dropped / Math.max(1, frames + dropped)).toFixed(1);
      flash(`Saved ${name}: ${frames} frames` + (dropped ? `, ${dropped} camera frames dropped (${pct}%). Try a lower resolution or Standard quality.` : ", none dropped."));
    } else {
      const name = await recorder.start();
      recDropBase = framesNotDrawn();
      updateRecBadge();
      $("rec-badge").hidden = false;
      recBadgeTimer = setInterval(updateRecBadge, 500);
      $("btn-rec").classList.add("recording");
      $("btn-rec").textContent = "⏹ Stop";
      syncRail();
      updateWakeLock();
      flash(recorder.streamed ? `Recording to ${folder.name}/${name}`
        : `Recording ${name} in memory. For long recordings, choose a Save folder so video streams to disk.`);
    }
  } catch (err) {
    flash("Recording failed: " + err.message);
  }
}

let flashTimer = 0;
function flash(text) {
  $("capture-msg").textContent = text;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { $("capture-msg").textContent = ""; }, 5000);
}

// ---- controls ----

function buildPalettes() {
  const box = $("palettes");
  PALETTES.forEach((p, i) => {
    const b = document.createElement("button");
    b.style.background = `linear-gradient(90deg, ${p.stops.map(([s, c]) => `${c} ${(s / 256 * 100).toFixed(1)}%`).join(", ")})`;
    b.innerHTML = `<span>${p.name}</span>`;
    b.title = p.name;
    b.onclick = () => setPalette(i);
    box.append(b);
  });
}

function setPalette(i) {
  settings.palette = (i + PALETTES.length) % PALETTES.length;
  renderer.setPalette(PALETTES[settings.palette].stops);
  [...$("palettes").children].forEach((b, k) => b.classList.toggle("active", k === settings.palette));
  syncRail();
  saveSettings();
}

function setRangeMode(mode) {
  // Entering manual starts from the current auto range, so it behaves like a lock until adjusted.
  if (mode === "manual" && settings.rangeMode !== "manual" && agc.lo !== null) {
    settings.manualLo = agc.lo;
    settings.manualHi = agc.hi;
  }
  settings.rangeMode = agc.mode = mode;
  if (mode === "auto") {
    agc.reset();
    if (activeLimit) setActiveLimit(null);
  }
  $("auto-range").hidden = mode !== "auto";
  $("manual-range").hidden = mode !== "manual";
  [...$("range-mode").children].forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
  syncRangeUi();
  syncRail();
  saveSettings();
}

function setUnit(unit) {
  settings.unit = unit;
  units = makeUnits(unit, units.calibrated);
  [...$("units").children].forEach((b) => b.classList.toggle("active", b.dataset.unit === unit));
  syncRangeUi();
  updateDarkUi();
  saveSettings();
}

/** Put the manual min/max (stored in image units) onto the sliders and boxes in display units. */
function syncRangeUi() {
  const [cLo, cHi] = units.calibrated ? SLIDER_C.map((c) => c * 100) : [0, 4095 * 4];
  const lo = units.toDisplay(cLo), hi = units.toDisplay(cHi);
  const dp = units.step < 1 ? 1 : 0;
  for (const [key, id] of [["manualLo", "rng-lo"], ["manualHi", "rng-hi"]]) {
    const v = units.toDisplay(settings[key]).toFixed(dp);
    Object.assign($(id), { min: lo, max: hi, step: units.step, value: v });
    Object.assign($(id + "-n"), { step: units.step, value: v });
  }
  document.querySelectorAll("#manual-range .unit").forEach((el) => (el.textContent = units.suffix));
}

/** A min or max slider/box changed (value in display units). Keeps min below max. */
function setManualLimit(which, displayValue) {
  if (!Number.isFinite(displayValue)) return;
  const v = units.fromDisplay(displayValue);
  if (which === "lo") {
    settings.manualLo = v;
    if (settings.manualHi < v + MIN_GAP) settings.manualHi = v + MIN_GAP;
  } else {
    settings.manualHi = v;
    if (settings.manualLo > v - MIN_GAP) settings.manualLo = v - MIN_GAP;
  }
  syncRangeUi();
  saveSettings();
}

function bindCheck(id, key, apply) {
  const el = $(id);
  el.checked = settings[key];
  el.onchange = () => {
    settings[key] = el.checked;
    apply(el.checked);
    saveSettings();
  };
  apply(settings[key]);
}

function bindRange(id, key, format, apply) {
  const el = $(id), out = $(id + "-v");
  el.value = settings[key];
  const show = () => { if (out) out.textContent = format(Number(el.value)); };
  el.oninput = () => {
    settings[key] = Number(el.value);
    show();
    apply(settings[key]);
    saveSettings();
  };
  show();
  apply(settings[key]);
}

function initControls() {
  buildPalettes();
  setPalette(settings.palette);
  [...$("units").children].forEach((b) => (b.onclick = () => setUnit(b.dataset.unit)));
  setUnit(settings.unit);
  [...$("range-mode").children].forEach((b) => (b.onclick = () => setRangeMode(b.dataset.mode)));
  setRangeMode(settings.rangeMode);

  bindRange("agc-ignore", "ignore", (v) => v.toFixed(1) + "%", (v) => (agc.ignore = v / 100));
  bindRange("agc-smooth", "smoothing", (v) => v.toFixed(2), (v) => (agc.smoothing = v));
  for (const which of ["lo", "hi"]) {
    $(`rng-${which}`).oninput = (e) => setManualLimit(which, Number(e.target.value));
    $(`rng-${which}-n`).onchange = (e) => setManualLimit(which, Number(e.target.value));
    // Mouse wheel nudges by one step (0.1°), or ten with Shift.
    for (const el of [$(`rng-${which}`), $(`rng-${which}-n`)]) {
      el.addEventListener("wheel", (e) => {
        e.preventDefault();
        const dir = (e.deltaY || e.deltaX) < 0 ? 1 : -1;
        const current = units.toDisplay(settings[which === "lo" ? "manualLo" : "manualHi"]);
        setManualLimit(which, current + dir * units.step * (e.shiftKey ? 10 : 1));
      }, { passive: false });
    }
  }

  bindCheck("opt-mirror", "mirror", (v) => (renderer.mirror = v));
  bindCheck("opt-flip", "flip", (v) => (renderer.flip = v));
  bindCheck("opt-nuc", "nuc", (v) => { sendSettings({ nuc: v }); agc.reset(); });
  bindCheck("opt-badpix", "badPixels", (v) => sendSettings({ badPixels: v }));
  bindRange("opt-temporal", "temporal", (v) => (v ? v.toFixed(2) : "off"), (v) => sendSettings({ temporal: v }));

  $("opt-fps").value = String(settings.frameRate);
  $("opt-fps").onchange = (e) => {
    settings.frameRate = Number(e.target.value);
    recorder.fps = settings.frameRate;
    sendSettings({ frameRate: settings.frameRate });
    drawTimes = [];
    saveSettings();
  };
  recorder.fps = settings.frameRate;

  bindCheck("enh-on", "enhance", (v) => (renderer.enhance.on = v));
  bindRange("enh-denoise", "denoise", (v) => (v ? v.toFixed(1) + "σ" : "off"), (v) => (renderer.enhance.denoise = v));
  bindRange("enh-detail", "detail", (v) => (v > 1 ? v.toFixed(1) + "×" : "off"), (v) => (renderer.enhance.detail = v));
  $("enh-interp").value = settings.interp;
  $("enh-interp").onchange = (e) => { settings.interp = renderer.enhance.interp = e.target.value; saveSettings(); };
  renderer.enhance.interp = settings.interp;
  const setScale = (s) => {
    settings.outScale = renderer.enhance.scale = s;
    [...$("enh-scale").children].forEach((b) => b.classList.toggle("active", Number(b.dataset.scale) === s));
    saveSettings();
  };
  [...$("enh-scale").children].forEach((b) => (b.onclick = () => {
    if (recorder.active) { flash("Stop recording before changing resolution."); return; }
    setScale(Number(b.dataset.scale));
  }));
  setScale(settings.outScale);
  if (!renderer.gl) {
    $("enh-note").textContent = "This browser has no WebGL2, so enhancement and resolution options are unavailable.";
    for (const id of ["enh-on", "enh-interp", "enh-denoise", "enh-detail"]) $(id).disabled = true;
  } else if (!renderer.canEnhance) {
    $("enh-note").textContent = "This GPU can't render float textures, so only resolution and interpolation are available.";
    for (const id of ["enh-on", "enh-denoise", "enh-detail"]) $(id).disabled = true;
  }

  bindCheck("opt-dark", "dark", (v) => { sendSettings({ dark: v }); updateDarkUi(); });
  $("dark-frames").value = String(settings.darkFrames);
  $("dark-frames").onchange = (e) => { settings.darkFrames = Number(e.target.value); saveSettings(); };
  $("btn-dark").onclick = captureDark;
  $("btn-dark-clear").onclick = () => { if (confirm("Delete the stored dark frame for this camera?")) clearDark(); };
  setInterval(() => { if (darkRecord) updateDarkUi(); }, 30000);

  bindCheck("ov-spot", "spot", (v) => (renderer.overlays.spot = v));
  bindCheck("ov-extremes", "extremes", (v) => (renderer.overlays.extremes = v));
  bindCheck("ov-colorbar", "colorbar", (v) => (renderer.overlays.colorbar = v));

  bindCheck("vgsk-auto", "vgskAuto", (v) => {
    $("vgsk-manual").disabled = v;
    sendSettings(v ? { vgskAuto: true } : { vgskAuto: false, vgskManual: settings.vgskManual });
  });
  bindRange("vgsk-manual", "vgskManual", String, (v) => { if (!settings.vgskAuto) sendSettings({ vgskManual: v }); });

  bindCheck("cap-tiff", "saveTiff", () => {});
  bindCheck("cap-raw", "saveRaw", () => {});
  // Video format and quality. Only formats this browser can record are listed.
  const fmtSel = $("vid-format");
  for (const [key, f] of Object.entries(VIDEO_FORMATS)) {
    if (window.MediaRecorder && f.types.some((t) => MediaRecorder.isTypeSupported(t))) fmtSel.add(new Option(f.label, key));
  }
  const showVideoInfo = () => {
    const vf = videoFormat(settings.videoFormat);
    const s = renderer.gl ? settings.outScale : 3, w = WIDTH * s, h = HEIGHT * s;
    const mbps = (w * h * Math.min(settings.frameRate, 26) * ({ standard: 0.4, high: 1.15, maximum: 2.3 }[settings.videoQuality]) / 1e6).toFixed(0);
    $("video-fmt").textContent = vf ? `${vf.ext.toUpperCase()} at ${w}×${h}, up to ${mbps} Mbps` : "not supported in this browser";
  };
  if (![...fmtSel.options].some((o) => o.value === settings.videoFormat) && fmtSel.options.length) settings.videoFormat = fmtSel.options[0].value;
  fmtSel.value = recorder.format = settings.videoFormat;
  $("vid-quality").value = recorder.quality = settings.videoQuality;
  fmtSel.onchange = () => { settings.videoFormat = recorder.format = fmtSel.value; saveSettings(); showVideoInfo(); };
  $("vid-quality").onchange = (e) => { settings.videoQuality = recorder.quality = e.target.value; saveSettings(); showVideoInfo(); };
  for (const b of $("enh-scale").children) b.addEventListener("click", () => setTimeout(showVideoInfo, 0));
  $("opt-fps").addEventListener("change", showVideoInfo);
  showVideoInfo();

  if (!canPickFolder) $("btn-folder").hidden = true;
  folder.restore().then(() => { if (folder.name) $("folder-name").textContent = folder.name; });
  $("btn-folder").onclick = async () => {
    try {
      await folder.pick();
      $("folder-name").textContent = folder.name;
    } catch (err) {
      if (err.name !== "AbortError") flash(err.message);
    }
  };

  $("btn-connect").onclick = connect;
  $("btn-disconnect").onclick = () => worker.postMessage({ type: "disconnect" });
  $("btn-snap").onclick = snapshot;
  $("btn-rec").onclick = toggleRecording;
  $("btn-import").onclick = () => $("file-import").click();
  $("btn-import-files").onclick = () => $("file-import-files").click();
  for (const id of ["file-import", "file-import-files"]) {
    $(id).onchange = (e) => {
      // Copy first: input.files is live, and clearing the input empties it while the
      // (async) import is still reading the files.
      const files = [...e.target.files];
      e.target.value = "";
      if (files.length) importCalibration(files);
    };
  }

  canvas.addEventListener("click", (e) => {
    if (suppressSpotClick) { suppressSpotClick = false; return; }
    const r = canvas.getBoundingClientRect();
    const [x, y] = renderer.canvasToSensor((e.clientX - r.left) * canvas.width / r.width, (e.clientY - r.top) * canvas.height / r.height);
    settings.spotX = x;
    settings.spotY = y;
    saveSettings();
  });
  canvas.addEventListener("dblclick", () => {
    settings.spotX = WIDTH >> 1;
    settings.spotY = HEIGHT >> 1;
    saveSettings();
  });

  document.addEventListener("keydown", (e) => {
    if (e.target.closest("input, textarea, select") || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === " ") { e.preventDefault(); if (connected) snapshot(); }
    else if (k === "r") { if (connected) toggleRecording(); }
    else if (k === "p") setPalette(settings.palette + (e.shiftKey ? -1 : 1));
    else if (k === "m") $("opt-mirror").click();
    else if (k === "f") $("opt-flip").click();
    else if (k === "a") setRangeMode(settings.rangeMode === "auto" ? "manual" : "auto");
    else if (k === "e") $("enh-on").click();
  });

  // Push the persisted image settings to the worker before the first connection.
  sendSettings({ nuc: settings.nuc, badPixels: settings.badPixels, temporal: settings.temporal,
    vgskAuto: settings.vgskAuto, vgskManual: settings.vgskManual, frameRate: settings.frameRate });
  updateCalibrationUi();
}

// ---- touch UI: layout switch, tabs, control rail, steppers, wake lock, full screen ----

const touchQuery = matchMedia("(pointer: coarse) and (hover: none)");
const uiOverride = new URLSearchParams(location.search).get("ui"); // "touch" | "desktop" for testing
const isTouch = () => (uiOverride ? uiOverride === "touch" : touchQuery.matches);

function applyUiMode() {
  document.documentElement.classList.toggle("touch", isTouch());
  if (!isTouch()) document.documentElement.classList.remove("drawer-open");
  updateWakeLock();
}

const isLandscape = () => matchMedia("(orientation: landscape)").matches;

function buildTabs() {
  const tabs = $("tabs"), sections = [...$("panel").querySelectorAll(":scope > details")];
  const show = (i) => {
    settings.tab = i;
    sections.forEach((d, k) => {
      d.classList.toggle("tab-hidden", k !== i);
      if (k === i) d.open = true;
    });
    [...tabs.children].forEach((b, k) => b.classList.toggle("active", k === i));
    saveSettings();
  };
  sections.forEach((d, i) => {
    const b = document.createElement("button");
    b.textContent = d.querySelector("summary").textContent.trim();
    b.setAttribute("role", "tab");
    b.onclick = () => show(i);
    tabs.append(b);
  });
  show(Math.min(settings.tab || 0, sections.length - 1));
}

function syncRail() {
  const c = $("t-connect");
  c.textContent = connected ? "Disconnect" : "Connect";
  c.classList.toggle("primary", !connected);
  $("t-snap").disabled = $("t-rec").disabled = !connected;
  $("t-rec").classList.toggle("recording", recorder.active);
  $("t-rec").setAttribute("aria-label", recorder.active ? "Stop recording" : "Record");
  $("t-range").textContent = settings.rangeMode === "manual" ? "Man" : "Auto";
  const p = PALETTES[settings.palette];
  $("t-palette").querySelector(".t-swatch").style.background =
    `linear-gradient(135deg, ${p.stops.map(([s, col]) => `${col} ${(s / 256 * 100).toFixed(0)}%`).join(", ")})`;
  $("t-palette").title = p.name;
}

function toggleDrawer(open = !document.documentElement.classList.contains("drawer-open")) {
  document.documentElement.classList.toggle("drawer-open", open);
}

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen({ navigationUI: "hide" });
  } catch (err) {
    flash("Full screen isn't available here.");
  }
}

// Keep the screen on while the camera is connected on touch devices, and while recording anywhere.
let wakeLock = null;
async function updateWakeLock() {
  const want = connected && (isTouch() || recorder.active) && document.visibilityState === "visible";
  try {
    if (want && !wakeLock && "wakeLock" in navigator) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    } else if (!want && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch { /* denied, e.g. battery saver */ }
}
document.addEventListener("visibilitychange", updateWakeLock);

// − / + steppers for the manual range: one step per tap, repeating while held.
function initSteppers() {
  for (const b of document.querySelectorAll(".step")) {
    let timer = 0;
    const step = () => {
      const which = b.dataset.which, dir = Number(b.dataset.dir);
      setManualLimit(which, units.toDisplay(settings[which === "lo" ? "manualLo" : "manualHi"]) + dir * units.step);
    };
    const stop = () => { clearTimeout(timer); timer = 0; };
    b.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      step();
      const repeat = (delay) => { timer = setTimeout(() => { step(); repeat(70); }, delay); };
      repeat(400);
    });
    for (const ev of ["pointerup", "pointerleave", "pointercancel"]) b.addEventListener(ev, stop);
    b.addEventListener("contextmenu", (e) => e.preventDefault());
  }
}

// Colour-bar limits by touch: tap the max or min label to select it (switching to manual),
// then swipe up/down anywhere on the image to change it. Auto clears the selection.
const SWIPE_SLOP = 6;          // CSS px before a touch counts as a swipe

function canvasPoint(e) {
  const r = canvas.getBoundingClientRect();
  return { x: (e.clientX - r.left) * canvas.width / r.width, y: (e.clientY - r.top) * canvas.height / r.height, scale: canvas.width / r.width };
}

/** Which colour-bar label (if any) is under a canvas point; targets padded to ≥ 48 CSS px. */
function limitAt(p) {
  const rects = renderer.colorbarRects;
  if (!rects) return null;
  const pad = 24 * p.scale;
  for (const which of ["hi", "lo"]) {
    const b = rects[which], cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    if (Math.abs(p.x - cx) <= Math.max(b.w / 2, pad) + pad / 2 && Math.abs(p.y - cy) <= Math.max(b.h / 2, pad)) return which;
  }
  return null;
}

function setActiveLimit(which) {
  activeLimit = which;
  if (which && settings.rangeMode !== "manual") setRangeMode("manual");
  canvas.style.touchAction = which ? "none" : ""; // stop swipes scrolling the page in portrait
  positionLimitHighlight();
}

/** Keep the HTML highlight over the selected label (called after each draw). */
function positionLimitHighlight() {
  const hl = $("limit-hl"), rects = renderer.colorbarRects;
  if (!activeLimit || !rects || !isTouch()) { hl.hidden = true; return; }
  const b = rects[activeLimit], cr = canvas.getBoundingClientRect(), vr = $("viewer").getBoundingClientRect();
  const k = cr.width / canvas.width, pad = 4;
  Object.assign(hl.style, {
    left: `${cr.left - vr.left + b.x * k - pad}px`, top: `${cr.top - vr.top + b.y * k - pad}px`,
    width: `${b.w * k + 2 * pad}px`, height: `${b.h * k + 2 * pad}px`,
  });
  hl.hidden = false;
}

function initLimitGestures() {
  let swipe = null; // { id, startY, startValue, moved }
  canvas.addEventListener("pointerdown", (e) => {
    if (!isTouch()) return;
    const hit = limitAt(canvasPoint(e));
    if (hit) {
      setActiveLimit(activeLimit === hit ? null : hit);
      suppressSpotClick = true;
      return;
    }
    if (!activeLimit) return;
    const key = activeLimit === "hi" ? "manualHi" : "manualLo";
    // Sensitivity fixed for the whole swipe: the full image height changes the limit by the span at the start.
    const span = units.toDisplay(settings.manualHi) - units.toDisplay(settings.manualLo);
    const perPx = Math.max(units.step / 10, span / canvas.getBoundingClientRect().height);
    swipe = { id: e.pointerId, startY: e.clientY, startValue: units.toDisplay(settings[key]), perPx, moved: false };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!swipe || e.pointerId !== swipe.id) return;
    const dy = swipe.startY - e.clientY; // up = positive = warmer
    if (!swipe.moved && Math.abs(dy) < SWIPE_SLOP) return;
    swipe.moved = true;
    const v = Math.round((swipe.startValue + dy * swipe.perPx) / units.step) * units.step;
    setManualLimit(activeLimit, v);
  });
  const end = (e) => {
    if (!swipe || e.pointerId !== swipe.id) return;
    if (swipe.moved) suppressSpotClick = true;
    swipe = null;
  };
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);
  addEventListener("resize", positionLimitHighlight);
}

function initTouchUi() {
  buildTabs();
  initSteppers();
  initLimitGestures();
  $("t-connect").onclick = () => (connected ? worker.postMessage({ type: "disconnect" }) : connect());
  $("t-snap").onclick = snapshot;
  $("t-rec").onclick = toggleRecording;
  $("t-palette").onclick = () => setPalette(settings.palette + 1);
  $("t-range").onclick = () => setRangeMode(settings.rangeMode === "auto" ? "manual" : "auto");
  $("t-settings").onclick = () => (isLandscape() ? toggleDrawer() : $("panel").scrollIntoView({ behavior: "smooth" }));
  $("scrim").onclick = () => toggleDrawer(false);
  $("t-full").onclick = toggleFullscreen;
  if (!document.fullscreenEnabled) $("t-full").hidden = true;
  touchQuery.addEventListener("change", applyUiMode);
  applyUiMode();
  syncRail();
}

// ---- installable app (PWA): service worker for offline use, install button, persistent storage ----

let installPrompt = null;
const isInstalled = () => matchMedia("(display-mode: standalone), (display-mode: fullscreen)").matches;

/** The header's Install button: only when the browser offers installation and we're not already the installed app. */
function updateInstallButton() {
  $("btn-install").hidden = !installPrompt || isInstalled();
}

async function initApp() {
  // Listen first: Chrome may announce installability before the awaits below finish.
  addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    installPrompt = e;
    updateInstallButton();
  });
  addEventListener("appinstalled", () => {
    installPrompt = null;
    flash("Installed. Start it from the home-screen icon.");
    updateInstallButton();
  });
  $("btn-install").onclick = async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = null;
    updateInstallButton();
  };
  matchMedia("(display-mode: standalone)").addEventListener("change", updateInstallButton);
  updateInstallButton();

  // Ask the browser not to evict the cached app or the stored calibration and dark frames.
  try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch { /* ignore */ }
  if ("serviceWorker" in navigator) {
    try {
      await navigator.serviceWorker.register("sw.js");
    } catch (err) {
      console.warn("Service worker registration failed:", err);
    }
  }
}

initControls();
initTouchUi();
initApp();
