// Page-side rendering: automatic gain/level (AGC), palette mapping, orientation and overlays.

import { GlPipeline, INTERP } from "./enhance.js";
import { HEIGHT, PIXELS, WIDTH } from "./protocol.js";

// Detail energy (RMS, in multiples of the frame noise σ) at which the detail boost is half applied.
const DETAIL_GATE = 1.0;

/** Build a 256-entry RGB lookup table from palette stops [[pos 0-256, "#RRGGBB"], ...]. */
export function paletteLut(stops) {
  const lut = new Uint8Array(256 * 3);
  const pts = stops.map(([s, hex]) => [s * 255 / 256, parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)]);
  for (let i = 0; i < 256; i++) {
    let k = 0;
    while (k < pts.length - 2 && pts[k + 1][0] < i) k++;
    const [x0, ...c0] = pts[k], [x1, ...c1] = pts[k + 1];
    const t = x1 > x0 ? Math.min(1, Math.max(0, (i - x0) / (x1 - x0))) : 0;
    for (let c = 0; c < 3; c++) lut[3 * i + c] = Math.round(c0[c] + t * (c1[c] - c0[c]));
  }
  return lut;
}

/**
 * Maps image values to 0-255. Modes:
 *   auto   - percentile limits, smoothed over time
 *   lock   - keeps the limits from the moment it was locked
 *   manual - user-set low/high
 */
export class Agc {
  constructor() {
    this.mode = "auto";
    this.ignore = 0.01;     // fraction clipped at each end in auto mode
    this.smoothing = 0.2;   // 0..1 per-frame approach rate
    this.minSpan = 20;      // counts; stops noise being stretched across the full palette
    this.lo = null;
    this.hi = null;
  }

  reset() {
    this.lo = this.hi = null;
  }

  update(img) {
    if (this.mode !== "auto" && this.lo !== null) return;
    const [lo, hi0] = percentiles(img, this.ignore);
    const hi = Math.max(hi0, lo + this.minSpan);
    if (this.lo === null) {
      this.lo = lo;
      this.hi = hi;
    } else {
      this.lo += this.smoothing * (lo - this.lo);
      this.hi += this.smoothing * (hi - this.hi);
    }
  }
}

/** Low/high percentiles of a sparse sample of the image (border excluded), via a histogram. */
export function percentiles(img, frac) {
  let min = Infinity, max = -Infinity;
  for (let y = 4; y < HEIGHT - 4; y += 2) {
    for (let x = 4; x < WIDTH - 4; x += 2) {
      const v = img[y * WIDTH + x];
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  if (!(max > min)) return [min, min + 1];
  const BINS = 2048, hist = new Uint32Array(BINS), scale = (BINS - 1) / (max - min);
  let n = 0;
  for (let y = 4; y < HEIGHT - 4; y += 2) {
    for (let x = 4; x < WIDTH - 4; x += 2) {
      hist[((img[y * WIDTH + x] - min) * scale) | 0]++;
      n++;
    }
  }
  const loCount = n * frac, hiCount = n * (1 - frac);
  let acc = 0, lo = min, hi = max, foundLo = false;
  for (let b = 0; b < BINS; b++) {
    acc += hist[b];
    if (!foundLo && acc > loCount) { lo = min + b / scale; foundLo = true; }
    if (acc >= hiCount) { hi = min + (b + 1) / scale; break; }
  }
  return [lo, hi];
}

/** Min and max of the whole image (border excluded), with positions. */
export function extremes(img) {
  let min = Infinity, max = -Infinity, iMin = 0, iMax = 0;
  for (let y = 2; y < HEIGHT - 2; y++) {
    for (let x = 2; x < WIDTH - 2; x++) {
      const i = y * WIDTH + x, v = img[i];
      if (v < min) { min = v; iMin = i; }
      if (v > max) { max = v; iMax = i; }
    }
  }
  return { min, max, minAt: [iMin % WIDTH, (iMin / WIDTH) | 0], maxAt: [iMax % WIDTH, (iMax / WIDTH) | 0] };
}

/** Mean of a (2r+1)^2 box around sensor coordinate (x, y). */
export function spotValue(img, x, y, r = 1) {
  let sum = 0, n = 0;
  for (let yy = Math.max(0, y - r); yy <= Math.min(HEIGHT - 1, y + r); yy++) {
    for (let xx = Math.max(0, x - r); xx <= Math.min(WIDTH - 1, x + r); xx++) {
      sum += img[yy * WIDTH + xx];
      n++;
    }
  }
  return sum / n;
}

/**
 * Draws processed frames into a display canvas: palette, mirror/flip, overlays.
 * Sensor-sized pixels go through a small offscreen canvas and are scaled up with smoothing.
 */
export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.small = new OffscreenCanvas(WIDTH, HEIGHT);
    this.smallCtx = this.small.getContext("2d");
    this.imageData = this.smallCtx.createImageData(WIDTH, HEIGHT);
    this.lut = null;
    this.mirror = false;
    this.flip = false;
    this.overlays = { spot: true, extremes: false, colorbar: true };
    // Display enhancement (GPU). Strength is in multiples of the measured noise; gain 1 = off.
    this.gl = GlPipeline.create(WIDTH, HEIGHT);
    this.enhance = { on: true, scale: 3, interp: "lanczos", denoise: 1.5, detail: 2.0 };
  }

  get canEnhance() {
    return !!(this.gl && this.gl.canFilter);
  }

  setPalette(stops) {
    this.lut = paletteLut(stops);
    if (this.gl) this.gl.setPalette(this.lut);
  }

  /** Output size follows the upsampling factor (2D fallback keeps 3×). */
  _sizeCanvas() {
    const s = this.gl ? this.enhance.scale : 3;
    if (this.canvas.width !== WIDTH * s) {
      this.canvas.width = WIDTH * s;
      this.canvas.height = HEIGHT * s;
    }
  }

  /** Map a canvas pixel to sensor coordinates (undoing mirror/flip). */
  canvasToSensor(cx, cy) {
    let x = Math.floor(cx / this.canvas.width * WIDTH);
    let y = Math.floor(cy / this.canvas.height * HEIGHT);
    if (this.mirror) x = WIDTH - 1 - x;
    if (this.flip) y = HEIGHT - 1 - y;
    return [Math.max(0, Math.min(WIDTH - 1, x)), Math.max(0, Math.min(HEIGHT - 1, y))];
  }

  sensorToCanvas(x, y) {
    if (this.mirror) x = WIDTH - 1 - x;
    if (this.flip) y = HEIGHT - 1 - y;
    return [(x + 0.5) * this.canvas.width / WIDTH, (y + 0.5) * this.canvas.height / HEIGHT];
  }

  /**
   * @param info.unitScale  image units → °C (0.01) or 1 for raw counts
   * @param info.noise      estimated noise σ in image units (for the denoise threshold)
   */
  draw(img, lo, hi, info) {
    this._sizeCanvas();
    if (this.gl) {
      const e = this.enhance, k = info.unitScale || 1;
      const sigma = Math.max(info.noise || 0, 1e-3) * k;
      const span = (hi - lo) * k;
      this.gl.render(img, {
        outW: this.canvas.width, outH: this.canvas.height, lo, hi, unitScale: k,
        interp: INTERP[e.interp] ?? INTERP.lanczos, mirror: this.mirror, flip: this.flip,
        // Denoise: pixels within ~strength·σ of their 5×5 neighbourhood are smoothed; bigger steps are kept.
        denoise: { on: e.on && e.denoise > 0, radius: 2, eps: (e.denoise * sigma) ** 2 },
        // Detail: structure smaller than ~12% of the display span, over a 13×13 area, is boosted.
        // Gated so areas whose local detail is near the noise floor aren't amplified.
        detail: { on: e.on && e.detail !== 1, radius: 6, eps: (0.12 * span) ** 2, gain: e.detail, noiseVar: (DETAIL_GATE * sigma) ** 2 },
      });
      this.ctx.drawImage(this.gl.canvas, 0, 0);
      this._overlays(lo, hi, info);
      return;
    }
    const d = this.imageData.data, lut = this.lut, scale = 255 / (hi - lo);
    for (let i = 0; i < PIXELS; i++) {
      let g = (img[i] - lo) * scale;
      g = g < 0 ? 0 : g > 255 ? 255 : g | 0;
      const o = 4 * i, k = 3 * g;
      d[o] = lut[k]; d[o + 1] = lut[k + 1]; d[o + 2] = lut[k + 2]; d[o + 3] = 255;
    }
    this.smallCtx.putImageData(this.imageData, 0, 0);

    const { ctx, canvas } = this;
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.setTransform(this.mirror ? -1 : 1, 0, 0, this.flip ? -1 : 1, this.mirror ? canvas.width : 0, this.flip ? canvas.height : 0);
    ctx.drawImage(this.small, 0, 0, canvas.width, canvas.height);
    ctx.restore();
    this._overlays(lo, hi, info);
  }

  _overlays(lo, hi, info) {
    const { ctx, canvas } = this;
    const s = canvas.width / 1152; // overlay sizes are designed for a 1152-px-wide canvas
    ctx.save();
    ctx.lineWidth = 2 * s;
    ctx.font = `${Math.round(22 * s)}px system-ui, sans-serif`;
    ctx.textBaseline = "middle";

    const label = (text, x, y, align = "left") => {
      ctx.textAlign = align;
      ctx.strokeStyle = "rgba(0,0,0,0.75)";
      ctx.lineWidth = 4 * s;
      ctx.strokeText(text, x, y);
      ctx.fillStyle = "#fff";
      ctx.fillText(text, x, y);
    };

    if (this.overlays.spot && info.spot) {
      const [cx, cy] = this.sensorToCanvas(info.spot.x, info.spot.y);
      const r = 18 * s;
      ctx.strokeStyle = "rgba(0,0,0,0.7)";
      ctx.lineWidth = 5 * s;
      cross(ctx, cx, cy, r);
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 2 * s;
      cross(ctx, cx, cy, r);
      const right = cx < canvas.width * 0.75;
      label(info.fmt(info.spot.value), cx + (right ? 1 : -1) * (r + 8 * s), cy - r * 0.7, right ? "left" : "right");
    }

    if (this.overlays.extremes && info.extremes) {
      const e = info.extremes;
      for (const [pos, color, text] of [[e.maxAt, "#ff3b30", "▲ " + info.fmt(e.max)], [e.minAt, "#0a84ff", "▼ " + info.fmt(e.min)]]) {
        const [cx, cy] = this.sensorToCanvas(pos[0], pos[1]);
        ctx.strokeStyle = "#000";
        ctx.lineWidth = 5 * s;
        ctx.beginPath(); ctx.arc(cx, cy, 10 * s, 0, 2 * Math.PI); ctx.stroke();
        ctx.strokeStyle = color;
        ctx.lineWidth = 3 * s;
        ctx.beginPath(); ctx.arc(cx, cy, 10 * s, 0, 2 * Math.PI); ctx.stroke();
        const right = cx < canvas.width * 0.8;
        label(text, cx + (right ? 16 : -16) * s, cy, right ? "left" : "right");
      }
    }

    if (this.overlays.colorbar) {
      const w = 22 * s, h = canvas.height * 0.6, x = canvas.width - w - 16 * s, y = (canvas.height - h) / 2;
      for (let i = 0; i < 256; i++) {
        const k = 3 * (255 - i);
        ctx.fillStyle = `rgb(${this.lut[k]},${this.lut[k + 1]},${this.lut[k + 2]})`;
        ctx.fillRect(x, y + i * h / 256, w, h / 256 + 1);
      }
      ctx.strokeStyle = "rgba(0,0,0,0.7)";
      ctx.lineWidth = 2 * s;
      ctx.strokeRect(x, y, w, h);
      const hiText = info.fmt(hi), loText = info.fmt(lo), th = 28 * s;
      label(hiText, x + w, y - 18 * s, "right");
      label(loText, x + w, y + h + 18 * s, "right");
      // Where the limit labels are, in canvas pixels, for tap targets and the (HTML) highlight.
      const box = (text, cy) => { const tw = ctx.measureText(text).width; return { x: x + w - tw, y: cy - th / 2, w: tw, h: th }; };
      this.colorbarRects = { hi: box(hiText, y - 18 * s), lo: box(loText, y + h + 18 * s), bar: { x, y, w, h } };
    } else {
      this.colorbarRects = null;
    }

    ctx.restore();
  }
}

function cross(ctx, x, y, r) {
  ctx.beginPath();
  ctx.moveTo(x - r, y); ctx.lineTo(x - r * 0.3, y);
  ctx.moveTo(x + r * 0.3, y); ctx.lineTo(x + r, y);
  ctx.moveTo(x, y - r); ctx.lineTo(x, y - r * 0.3);
  ctx.moveTo(x, y + r * 0.3); ctx.lineTo(x, y + r);
  ctx.stroke();
}

export function fmt(v) {
  return Number.isFinite(v) ? String(Math.round(v)) : "–";
}

/**
 * Conversions between image values and what the user sees. Corrected (NUC) values are
 * hundredths of a degree Celsius, which is how the original app read them
 * (MainActivity.b: value / 100 * scale + offset). Uncorrected values are raw counts.
 */
export function makeUnits(unit, calibrated) {
  if (!calibrated) {
    return { calibrated, suffix: "", step: 1, toDisplay: (c) => c, fromDisplay: (v) => v, fmt: (c) => fmt(c) };
  }
  const f = unit === "F";
  const toDisplay = (c) => (f ? c / 100 * 1.8 + 32 : c / 100);
  const fromDisplay = (v) => (f ? (v - 32) / 1.8 * 100 : v * 100);
  const suffix = f ? "°F" : "°C";
  return {
    calibrated, suffix, step: 0.1, toDisplay, fromDisplay,
    fmt: (c) => (Number.isFinite(c) ? toDisplay(c).toFixed(1) + suffix : "–"),
  };
}
