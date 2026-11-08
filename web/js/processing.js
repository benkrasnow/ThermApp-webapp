// Image processing that runs per frame in the worker. Port of prototype/thermapp_proc.py.

import { ADC_MAX, HEIGHT, PIXELS, WIDTH } from "./protocol.js";

/**
 * Factory non-uniformity correction (non-TH branch of Opgal's RenderScript kernel,
 * decompiled/native/thermappsdk_ipn.ll). Computed in float64, stored as float32.
 */
export function applyNuc(pixels, tfpa, vgsk, m, out) {
  const t = tfpa, t2 = tfpa * tfpa, v = vgsk, v2 = vgsk * vgsk;
  const { offset, tfpa: cT, tfpaSq, tfpaXPix, linear, square, vgsk: cV, vgskSq, vgskXPix } = m;
  for (let i = 0; i < PIXELS; i++) {
    const p = pixels[i];
    out[i] = offset[i] + t * cT[i] + t2 * tfpaSq[i]
      + p * (linear[i] + p * square[i] + t * tfpaXPix[i] + v * vgskXPix[i])
      + v * cV[i] + v2 * vgskSq[i];
  }
  return out;
}

/** Raw counts as float, for viewing without the factory correction. */
export function copyRaw(pixels, out) {
  for (let i = 0; i < PIXELS; i++) out[i] = pixels[i];
  return out;
}

const BAD_SCRATCH = new Float64Array(25);

/** Replace each bad pixel with the median of the good pixels in its 5x5 neighbourhood. */
export function fillBadPixels(img, badPixels, isBad) {
  for (let k = 0; k < badPixels.length; k++) {
    const idx = badPixels[k];
    const x0 = idx % WIDTH, y0 = (idx / WIDTH) | 0;
    let n = 0;
    for (let y = Math.max(0, y0 - 2); y <= Math.min(HEIGHT - 1, y0 + 2); y++) {
      for (let x = Math.max(0, x0 - 2); x <= Math.min(WIDTH - 1, x0 + 2); x++) {
        const j = y * WIDTH + x;
        if (!isBad[j]) BAD_SCRATCH[n++] = img[j];
      }
    }
    if (n) {
      const s = BAD_SCRATCH.subarray(0, n).sort();
      img[idx] = n & 1 ? s[n >> 1] : 0.5 * (s[(n >> 1) - 1] + s[n >> 1]);
    }
  }
  return img;
}

/** Median of a sparse grid of raw pixels, ignoring the border. */
export function rawMedian(pixels) {
  const hist = new Uint32Array(ADC_MAX + 1);
  let n = 0;
  for (let y = 8; y < HEIGHT - 8; y += 2) {
    for (let x = 8; x < WIDTH - 8; x += 2) {
      const v = pixels[y * WIDTH + x];
      hist[v < 0 ? 0 : v > ADC_MAX ? ADC_MAX : v]++;
      n++;
    }
  }
  let acc = 0;
  for (let v = 0; v <= ADC_MAX; v++) {
    acc += hist[v];
    if (acc * 2 >= n) return v;
  }
  return ADC_MAX;
}

/**
 * Mean histogram bin of a raw frame, exactly as the SDK's native CreateHistogramRaw +
 * GetCenterOfMass compute it: every 16-bit word from the start of the frame (header
 * included) through the last pixel, masked to 12 bits, in 256 bins of 16 counts.
 */
export function rawCenterOfMass(frameWords) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < frameWords.length; i++) hist[(frameWords[i] & 0xfff) >> 4]++;
  let sum = 0, weighted = 0;
  for (let b = 0; b < 256; b++) {
    sum += hist[b];
    weighted += hist[b] * b;
  }
  return weighted / sum;
}

/**
 * VGSK bias loop, a port of the SDK's native Func1 (libipthermapp.so, disassembled):
 * when the mean histogram bin is more than 7 bins from floor(adrTarget * 256), move the
 * DAC by diff/7 (truncated), and only if the result stays strictly inside the 11.bin limits.
 * It runs every frame on the commanded value. The factory NUC is defined at this operating
 * point, so absolute temperatures depend on matching it.
 */
export class VgskController {
  static DEADBAND_BINS = 7;

  constructor(min, max, adrTarget, start = 1520) {
    this.min = min;
    this.max = max;
    this.targetBin = Math.trunc(adrTarget * 256);
    this.value = start;
    this.auto = true;
    this.lastBin = 0;
  }

  /** Raw-count equivalent of the target, for display. */
  get target() {
    return this.targetBin * 16;
  }

  update(frameWords) {
    this.lastBin = rawCenterOfMass(frameWords);
    if (!this.auto) return this.value;
    const diff = this.targetBin - this.lastBin;
    if (Math.abs(diff) > VgskController.DEADBAND_BINS) {
      const next = Math.trunc(this.value + diff / VgskController.DEADBAND_BINS);
      if (next > this.min && next < this.max) this.value = next;
    }
    return this.value;
  }
}

/**
 * Averages corrected frames of a uniform cover into a zero-mean offset map. Subtracting
 * the map removes per-pixel offsets and gradients while keeping absolute temperatures,
 * because the map's average is zero.
 */
export class DarkFrameAccumulator {
  constructor(frames, isBad) {
    this.total = frames;
    this.count = 0;
    this.isBad = isBad;
    this.sum = new Float64Array(PIXELS);
    this.first = null;
  }

  get done() {
    return this.count >= this.total;
  }

  add(img, header) {
    if (!this.first) this.first = header;
    for (let i = 0; i < PIXELS; i++) this.sum[i] += img[i];
    this.count++;
  }

  /** Returns { offset: Float32Array, stats } with stats in image units. */
  finish() {
    const avg = new Float64Array(PIXELS);
    let sum = 0, n = 0;
    for (let i = 0; i < PIXELS; i++) {
      avg[i] = this.sum[i] / this.count;
      if (!this.isBad || !this.isBad[i]) { sum += avg[i]; n++; }
    }
    const mean = sum / n;
    const offset = new Float32Array(PIXELS);
    let sq = 0, min = Infinity, max = -Infinity;
    for (let i = 0; i < PIXELS; i++) {
      const d = avg[i] - mean;
      offset[i] = d;
      if (this.isBad && this.isBad[i]) continue;
      sq += d * d;
      if (d < min) min = d;
      if (d > max) max = d;
    }
    return { offset, stats: { mean, std: Math.sqrt(sq / n), min, max, frames: this.count } };
  }
}

export function subtractOffset(img, offset) {
  for (let i = 0; i < PIXELS; i++) img[i] -= offset[i];
  return img;
}

/** Exponential moving average across frames; strength 0 = off, towards 1 = heavier smoothing. */
export class TemporalFilter {
  constructor() {
    this.state = null;
    this.strength = 0;
  }

  apply(img) {
    if (this.strength <= 0) {
      this.state = null;
      return img;
    }
    if (!this.state) {
      this.state = Float32Array.from(img);
      return img;
    }
    const a = 1 - this.strength, s = this.state;
    for (let i = 0; i < PIXELS; i++) {
      s[i] += a * (img[i] - s[i]);
      img[i] = s[i];
    }
    return img;
  }

  reset() {
    this.state = null;
  }
}
