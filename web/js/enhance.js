// WebGL2 display pipeline: edge-preserving denoise, detail enhancement, upsampling and
// palette mapping, all at the GPU. It only shapes what is displayed and recorded;
// measurements always use the unenhanced temperatures.
//
//   I  = frame in °C relative to the display centre (uploaded as R32F)
//   D  = guidedFilter(I, r1, eps1)          denoise: eps1 = (strength · noise σ)²
//   B  = guidedFilter(D, r2, eps2)          base layer: eps2 = (detailScale · display span)²
//   O  = B + gain · (D − B)                 detail boost, halo-free because strong edges stay in B
//   out = palette(AGC(interpolate(O)))      Lanczos-3 / bicubic / bilinear / nearest, anti-ringing clamp
//
// Guided filter: He, Sun & Tang, "Guided Image Filtering" (2010/2013), self-guided form.

const VS = `#version 300 es
void main() {
  // One triangle covering the viewport.
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const HEAD = `#version 300 es
precision highp float;
precision highp int;
out vec4 frag;
`;

// Box sum along one axis, edge-replicated. mode 0: input .r → (v, v²); mode 1: input .rg → .rg
const FS_BOX = HEAD + `
uniform sampler2D src;
uniform ivec2 dir;
uniform int radius;
uniform int mode;
void main() {
  ivec2 size = textureSize(src, 0);
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec2 acc = vec2(0.0);
  for (int k = -radius; k <= radius; k++) {
    vec2 t = texelFetch(src, clamp(p + dir * k, ivec2(0), size - 1), 0).rg;
    acc += mode == 0 ? vec2(t.r, t.r * t.r) : t;
  }
  frag = vec4(acc / float(2 * radius + 1), 0.0, 1.0);
}`;

// Per-window linear coefficients: a = var / (var + eps), b = mean − a·mean
const FS_AB = HEAD + `
uniform sampler2D moments;
uniform float eps;
void main() {
  vec2 m = texelFetch(moments, ivec2(gl_FragCoord.xy), 0).rg;
  float v = max(m.y - m.x * m.x, 0.0);
  float a = v / (v + eps);
  frag = vec4(a, m.x - a * m.x, 0.0, 1.0);
}`;

// Guided-filter output q = mean(a)·I + mean(b)
const FS_Q = HEAD + `
uniform sampler2D meanAB;
uniform sampler2D guide;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec2 ab = texelFetch(meanAB, p, 0).rg;
  frag = vec4(ab.x * texelFetch(guide, p, 0).r + ab.y, 0.0, 0.0, 1.0);
}`;

// Detail boost, gated by local detail energy against the noise floor so that flat,
// noise-only areas aren't amplified: g = 1 + (gain − 1) · E / (E + noiseVar), where E is
// the mean of (D − B)² over 3×3.
const FS_DETAIL = HEAD + `
uniform sampler2D denoised;
uniform sampler2D base;
uniform float gain;
uniform float noiseVar;
void main() {
  ivec2 size = textureSize(denoised, 0), p = ivec2(gl_FragCoord.xy);
  float energy = 0.0;
  for (int dy = -1; dy <= 1; dy++) for (int dx = -1; dx <= 1; dx++) {
    ivec2 q = clamp(p + ivec2(dx, dy), ivec2(0), size - 1);
    float e = texelFetch(denoised, q, 0).r - texelFetch(base, q, 0).r;
    energy += e * e;
  }
  energy /= 9.0;
  float d = texelFetch(denoised, p, 0).r, b = texelFetch(base, p, 0).r;
  float g = 1.0 + (gain - 1.0) * energy / (energy + noiseVar);
  frag = vec4(b + g * (d - b), 0.0, 0.0, 1.0);
}`;

// Upsample to the output size, map through AGC and the palette, apply mirror/flip.
const FS_OUT = HEAD + `
uniform sampler2D img;
uniform sampler2D lut;
uniform vec2 outSize;
uniform int interp;     // 0 nearest, 1 bilinear, 2 bicubic (Catmull-Rom), 3 Lanczos-3
uniform bool mirror, flipY;
uniform float lo, hi;

ivec2 size;
float tap(int x, int y) { return texelFetch(img, clamp(ivec2(x, y), ivec2(0), size - 1), 0).r; }

float catmullRom(float x) {
  x = abs(x);
  return x < 1.0 ? 1.5 * x * x * x - 2.5 * x * x + 1.0
       : x < 2.0 ? -0.5 * x * x * x + 2.5 * x * x - 4.0 * x + 2.0 : 0.0;
}
float lanczos3(float x) {
  x = abs(x);
  if (x < 1e-5) return 1.0;
  if (x >= 3.0) return 0.0;
  float px = 3.14159265 * x;
  return 3.0 * sin(px) * sin(px / 3.0) / (px * px);
}

float sampleAt(vec2 s) {
  if (interp == 0) return tap(int(floor(s.x + 0.5)), int(floor(s.y + 0.5)));
  ivec2 i = ivec2(floor(s));
  vec2 f = s - vec2(i);
  float c00 = tap(i.x, i.y), c10 = tap(i.x + 1, i.y), c01 = tap(i.x, i.y + 1), c11 = tap(i.x + 1, i.y + 1);
  if (interp == 1) return mix(mix(c00, c10, f.x), mix(c01, c11, f.x), f.y);
  int n = interp == 2 ? 2 : 3;   // taps either side
  float acc = 0.0, wsum = 0.0;
  for (int dy = 1 - n; dy <= n; dy++) {
    float wy = interp == 2 ? catmullRom(float(dy) - f.y) : lanczos3(float(dy) - f.y);
    for (int dx = 1 - n; dx <= n; dx++) {
      float w = wy * (interp == 2 ? catmullRom(float(dx) - f.x) : lanczos3(float(dx) - f.x));
      acc += w * tap(i.x + dx, i.y + dy);
      wsum += w;
    }
  }
  // Anti-ringing: keep the result within the four nearest samples.
  float v = acc / wsum;
  return clamp(v, min(min(c00, c10), min(c01, c11)), max(max(c00, c10), max(c01, c11)));
}

void main() {
  size = textureSize(img, 0);
  vec2 pos = vec2(gl_FragCoord.x, outSize.y - gl_FragCoord.y);   // top-left origin
  if (mirror) pos.x = outSize.x - pos.x;
  if (flipY) pos.y = outSize.y - pos.y;
  vec2 s = pos * vec2(size) / outSize - 0.5;
  float g = clamp((sampleAt(s) - lo) / (hi - lo), 0.0, 1.0);
  frag = vec4(texture(lut, vec2((g * 255.0 + 0.5) / 256.0, 0.5)).rgb, 1.0);
}`;

export const INTERP = { nearest: 0, bilinear: 1, bicubic: 2, lanczos: 3 };

export class GlPipeline {
  /** Returns null if WebGL2 is unavailable. */
  static create(width, height) {
    const canvas = new OffscreenCanvas(width, height);
    const gl = canvas.getContext("webgl2", { antialias: false, depth: false, premultipliedAlpha: false, preserveDrawingBuffer: true });
    if (!gl) return null;
    try {
      return new GlPipeline(canvas, gl, width, height);
    } catch (err) {
      console.warn("WebGL pipeline unavailable:", err);
      return null;
    }
  }

  constructor(canvas, gl, width, height) {
    this.canvas = canvas;
    this.gl = gl;
    this.w = width;
    this.h = height;
    // Float render targets are needed for the filter passes; without them we only upsample.
    this.canFilter = !!gl.getExtension("EXT_color_buffer_float");
    this.prog = {
      box: this._program(FS_BOX), ab: this._program(FS_AB), q: this._program(FS_Q),
      detail: this._program(FS_DETAIL), out: this._program(FS_OUT),
    };
    this.vao = gl.createVertexArray();
    this.src = this._texture(gl.R32F, width, height);
    if (this.canFilter) {
      this.rgA = this._target(gl.RG32F);
      this.rgB = this._target(gl.RG32F);
      this.denoised = this._target(gl.R32F);
      this.base = this._target(gl.R32F);
      this.result = this._target(gl.R32F);
    }
    this.lut = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.lut);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.upload = new Float32Array(width * height);
  }

  /** @param {Uint8Array} rgbLut 256×3 */
  setPalette(rgbLut) {
    const rgba = new Uint8Array(256 * 4);
    for (let i = 0; i < 256; i++) {
      rgba[4 * i] = rgbLut[3 * i]; rgba[4 * i + 1] = rgbLut[3 * i + 1]; rgba[4 * i + 2] = rgbLut[3 * i + 2]; rgba[4 * i + 3] = 255;
    }
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.lut);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
  }

  /**
   * Render one frame into this.canvas.
   * @param {Float32Array} img  image values (hundredths of °C, or raw counts)
   * @param {object} p  { outW, outH, lo, hi, unitScale, interp, mirror, flip,
   *                      denoise: { on, radius, eps }, detail: { on, radius, eps, gain } }
   *   eps values are in the same units as (img · unitScale).
   */
  render(img, p) {
    const gl = this.gl;
    if (this.canvas.width !== p.outW || this.canvas.height !== p.outH) {
      this.canvas.width = p.outW;
      this.canvas.height = p.outH;
    }
    // Centre and scale so the filters work in small numbers (°C around mid-range):
    // keeps float32 variance (E[x²] − E[x]²) accurate.
    const centre = 0.5 * (p.lo + p.hi), k = p.unitScale, up = this.upload;
    for (let i = 0; i < up.length; i++) up[i] = (img[i] - centre) * k;
    gl.bindTexture(gl.TEXTURE_2D, this.src.tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.w, this.h, gl.RED, gl.FLOAT, up);
    gl.bindVertexArray(this.vao);

    let current = this.src;
    if (this.canFilter && (p.denoise.on || p.detail.on)) {
      let denoised = this.src;
      if (p.denoise.on) {
        this._guided(this.src, p.denoise.radius, p.denoise.eps, this.denoised);
        denoised = this.denoised;
      }
      if (p.detail.on && p.detail.gain !== 1) {
        this._guided(denoised, p.detail.radius, p.detail.eps, this.base);
        this._pass(this.prog.detail, this.result, { denoised, base: this.base }, { gain: p.detail.gain, noiseVar: p.detail.noiseVar });
        current = this.result;
      } else {
        current = denoised;
      }
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, p.outW, p.outH);
    const prog = this.prog.out;
    gl.useProgram(prog.program);
    this._bindTex(prog, "img", current.tex, 0);
    this._bindTex(prog, "lut", this.lut, 1);
    gl.uniform2f(prog.u.outSize, p.outW, p.outH);
    gl.uniform1i(prog.u.interp, p.interp);
    gl.uniform1i(prog.u.mirror, p.mirror ? 1 : 0);
    gl.uniform1i(prog.u.flipY, p.flip ? 1 : 0);
    gl.uniform1f(prog.u.lo, (p.lo - centre) * k);
    gl.uniform1f(prog.u.hi, (p.hi - centre) * k);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  _guided(input, radius, eps, output) {
    const P = this.prog;
    this._pass(P.box, this.rgA, { src: input }, { dir: [1, 0], radius, mode: 0 });
    this._pass(P.box, this.rgB, { src: this.rgA }, { dir: [0, 1], radius, mode: 1 });
    this._pass(P.ab, this.rgA, { moments: this.rgB }, { eps });
    this._pass(P.box, this.rgB, { src: this.rgA }, { dir: [1, 0], radius, mode: 1 });
    this._pass(P.box, this.rgA, { src: this.rgB }, { dir: [0, 1], radius, mode: 1 });
    this._pass(P.q, output, { meanAB: this.rgA, guide: input }, {});
  }

  _pass(prog, target, textures, uniforms) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, this.w, this.h);
    gl.useProgram(prog.program);
    let unit = 0;
    for (const [name, t] of Object.entries(textures)) this._bindTex(prog, name, t.tex, unit++);
    for (const [name, v] of Object.entries(uniforms)) {
      const loc = prog.u[name];
      if (Array.isArray(v)) gl.uniform2i(loc, v[0], v[1]);
      else if (name === "radius" || name === "mode") gl.uniform1i(loc, v);
      else gl.uniform1f(loc, v);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  _bindTex(prog, name, tex, unit) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(prog.u[name], unit);
  }

  _texture(format, w, h) {
    const gl = this.gl, tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, format, w, h);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST],
      [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    return { tex };
  }

  _target(format) {
    const gl = this.gl, t = this._texture(format, this.w, this.h);
    t.fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.tex, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error("float framebuffer incomplete");
    return t;
  }

  _program(fsSource) {
    const gl = this.gl;
    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VS));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fsSource));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    const u = {};
    const n = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const name = gl.getActiveUniform(program, i).name;
      u[name] = gl.getUniformLocation(program, name);
    }
    return { program, u };
  }
}

/**
 * Robust per-frame noise estimate (standard deviation, image units): median absolute
 * deviation of a 4-neighbour high-pass over a sparse grid. Scene edges barely move the
 * median, so this tracks sensor noise, including after temporal filtering.
 */
export function estimateNoise(img, width, height) {
  const samples = [];
  for (let y = 8; y < height - 8; y += 3) {
    for (let x = 8; x < width - 40; x += 3) {
      const i = y * width + x;
      samples.push(Math.abs(img[i] - 0.25 * (img[i - 1] + img[i + 1] + img[i - width] + img[i + width])));
    }
  }
  const s = Float32Array.from(samples).sort();
  // For white noise the high-pass has variance 1.25 σ²; MAD → σ factor 1.4826.
  return 1.4826 * s[s.length >> 1] / Math.sqrt(1.25);
}
