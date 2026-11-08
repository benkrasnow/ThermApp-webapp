// Per-camera factory calibration: parsing the /sdcard/ThermApp/<serial>/ files and
// keeping them in IndexedDB so they only need importing once per browser.

import { PIXELS } from "./protocol.js";

export const REQUIRED_FILES = ["0.bin", "1.bin", "2.bin", "3.bin", "4.bin", "5.bin", "6.bin", "7.bin", "8.bin", "9.bin", "10.bin", "11.bin"];
const MAP_BYTES = PIXELS * 4;

/**
 * Validate a set of calibration files and describe them.
 * @param {Record<string, ArrayBuffer>} files  keyed by file name
 */
export function checkCalibration(files) {
  for (const name of REQUIRED_FILES) {
    if (!files[name]) {
      const got = Object.keys(files);
      throw new Error(`Missing ${name} (received ${got.length ? got.join(", ") : "no calibration files"})`);
    }
  }
  for (let i = 1; i <= 10; i++) {
    const n = files[`${i}.bin`].byteLength;
    if (n !== MAP_BYTES) {
      throw new Error(`${i}.bin is ${n} bytes, expected ${MAP_BYTES}. Only 384x288 cameras (calibration format 1) are supported.`);
    }
  }
  const p = new DataView(files["0.bin"]);
  const versionFormat = p.getInt16(0, true);
  const deviceType = p.getInt16(4, true);
  if (versionFormat !== 1) throw new Error(`Unsupported calibration format ${versionFormat}`);
  const h = new DataView(files["11.bin"]);
  return {
    versionFormat,
    isTH: deviceType === 2,
    vgskMin: h.getInt16(64, true),
    vgskMax: h.getInt16(66, true),
    adrTarget: h.getFloat32(68, true),
  };
}

/** Float32 coefficient maps in the shape the NUC code wants. */
export function calibrationMaps(files) {
  const f = (name) => new Float32Array(files[name].slice(0));
  const goodMap = f("1.bin");
  const bad = [];
  for (let i = 0; i < PIXELS; i++) if (goodMap[i] === 0) bad.push(i);
  return {
    tfpa: f("2.bin"), tfpaSq: f("3.bin"), tfpaXPix: f("4.bin"),
    linear: f("5.bin"), offset: f("6.bin"), square: f("7.bin"),
    vgsk: f("8.bin"), vgskSq: f("9.bin"), vgskXPix: f("10.bin"),
    badPixels: Int32Array.from(bad),
  };
}

/** Read calibration files picked with <input webkitdirectory> or a drop. */
export async function filesFromFileList(fileList) {
  const files = {};
  for (const file of fileList) {
    const name = file.name;
    if (/^\d+\.bin$/.test(name) || name === "FilesList.json") files[name] = await file.arrayBuffer();
  }
  return files;
}

/** Fetch calibration from a URL folder, e.g. "../calibration/215324084/" when serving the repo locally. */
export async function fetchCalibration(baseUrl) {
  const files = {};
  for (const name of REQUIRED_FILES) {
    const r = await fetch(baseUrl + name);
    if (!r.ok) return null;
    files[name] = await r.arrayBuffer();
  }
  return files;
}

// ---- IndexedDB stores, keyed by camera serial ----
//   calibration: { serial, files, imported }
//   dark:        { serial, offset, stats, tfpa, vgsk, captured }

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("thermapp", 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("calibration")) db.createObjectStore("calibration", { keyPath: "serial" });
      if (!db.objectStoreNames.contains("dark")) db.createObjectStore("dark", { keyPath: "serial" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(store, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const result = fn(t.objectStore(store));
    t.oncomplete = () => resolve(result.result);
    t.onerror = () => reject(t.error);
  });
}

export const calibrationStore = {
  get: (serial) => tx("calibration", "readonly", (s) => s.get(serial)),
  put: (serial, files) => tx("calibration", "readwrite", (s) => s.put({ serial, files, imported: new Date().toISOString() })),
  remove: (serial) => tx("calibration", "readwrite", (s) => s.delete(serial)),
  serials: () => tx("calibration", "readonly", (s) => s.getAllKeys()),
};

export const darkStore = {
  get: (serial) => tx("dark", "readonly", (s) => s.get(serial)),
  put: (record) => tx("dark", "readwrite", (s) => s.put(record)),
  remove: (serial) => tx("dark", "readwrite", (s) => s.delete(serial)),
};
