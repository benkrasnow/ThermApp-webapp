// Therm-App USB protocol constants and frame/config parsing.
// Port of prototype/thermapp_usb.py; see calibration/README.md for the derivation.

export const VID = 0x1772;
export const PID = 0x0002;
export const EP_OUT = 2;
export const EP_IN = 1;

export const WIDTH = 384;
export const HEIGHT = 288;
export const PIXELS = WIDTH * HEIGHT;
export const HEADER_BYTES = 64;
export const FRAME_BYTES = 221696; // 64 header + 384*288*2 pixels + 448 trailer
export const MAGIC = Uint8Array.of(0xa5, 0xa5, 0xa5, 0xa5, 0xa5, 0xa5, 0xd5, 0xa5);
export const ADC_MAX = 4095; // the sensor output is 12-bit

// Config header word indices
export const W_CONTROL = 4;    // 2 = stream video, 1 = idle
// Frames the camera transmits per second. The sensor always runs at ~25.98 fps; lower values
// make the camera skip frames, and 25 or more sends every frame. The SDK never overwrites this from 11.bin.
export const W_FRAME_RATE = 13;
export const MAX_FPS = 25;
export const SENSOR_FPS = 25.98;
export const W_VGSK = 18;      // VGSK bias DAC

// SDK defaults (thermapp.sdk.p)
export const DEFAULT_CONFIG = [
  0xA5A5, 0xA5A5, 0xA5A5, 0xA5D5, 2, 0, 0, 0, 0, 288, 384, 288, 384, 25, 0, 0,
  1884, 2949, 1524, 2048, 2949, 2949, 0, 1392, 2949, 64, 0, 0, 80, 3, 0, 4095,
];

/** Config header the SDK sends, from a camera's 11.bin (words 0-31 except word 13). */
export function configFrom11bin(buf) {
  const dv = new DataView(buf);
  const cfg = DEFAULT_CONFIG.slice();
  for (let i = 0; i < 32; i++) {
    if (i !== W_FRAME_RATE) cfg[i] = dv.getUint16(2 * i, true);
  }
  return cfg;
}

/** Header fields from one raw frame (an ArrayBuffer of FRAME_BYTES). */
export function parseHeader(buf) {
  const dv = new DataView(buf);
  return {
    serial: dv.getUint32(10, true),
    hwVersion: dv.getUint16(14, true),
    fwVersion: dv.getUint16(16, true),
    thermistor: dv.getUint16(28, true), // word 14
    tfpa: dv.getUint16(30, true),       // word 15
    vgsk: dv.getUint16(36, true),       // word 18
    counter: dv.getUint16(52, true),    // word 26: sensor frame counter, advances even when frames aren't sent
  };
}

/** The 384x288 signed 16-bit pixel block of a raw frame. */
export function framePixels(buf) {
  return new Int16Array(buf, HEADER_BYTES, PIXELS);
}
