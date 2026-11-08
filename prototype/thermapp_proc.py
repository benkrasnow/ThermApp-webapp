"""Image processing for the Therm-App: factory NUC, bad pixels, VGSK control, AGC, palettes.

The NUC formula comes from Opgal's RenderScript kernel (decompiled/native/thermappsdk_ipn.ll),
using the non-TH branch. See calibration/README.md for the file layouts.
"""

import glob
import os
import struct
import xml.etree.ElementTree as ET

import cv2
import numpy as np

from thermapp_usb import HEIGHT, WIDTH

ADC_MAX = 4095  # the sensor output is 12-bit


class Calibration:
    """Per-camera factory data loaded from a /sdcard/ThermApp/<serial>/ folder."""

    def __init__(self, folder):
        def load(name):
            return np.fromfile(os.path.join(folder, name), "<f4").reshape(HEIGHT, WIDTH)

        self.tfpa = load("2.bin")
        self.tfpa_sq = load("3.bin")
        self.tfpa_x_pix = load("4.bin")
        self.linear = load("5.bin")
        self.offset = load("6.bin")
        self.square = load("7.bin")
        self.vgsk = load("8.bin")
        self.vgsk_sq = load("9.bin")
        self.vgsk_x_pix = load("10.bin")
        self.bad = load("1.bin") == 0

        b11 = open(os.path.join(folder, "11.bin"), "rb").read()
        self.vgsk_min, self.vgsk_max = struct.unpack_from("<2h", b11, 64)
        self.adr_target = struct.unpack_from("<f", b11, 68)[0]

    def nuc(self, pixels, tfpa, vgsk):
        """Apply the factory polynomial. Returns float32 counts, roughly 0-4000 for a normal scene."""
        p = pixels.astype(np.float32)
        t = np.float32(tfpa)
        v = np.float32(vgsk)
        out = (self.offset
               + t * self.tfpa + t * t * self.tfpa_sq
               + p * (self.linear + p * self.square + t * self.tfpa_x_pix + v * self.vgsk_x_pix)
               + v * self.vgsk + v * v * self.vgsk_sq)
        return out


def replace_bad_pixels(img, bad):
    """Fill pixels flagged in the bad-pixel map from a 5x5 median of their surroundings."""
    med = cv2.medianBlur(img.astype(np.float32), 5)
    out = img.copy()
    out[bad] = med[bad]
    return out


class VgskController:
    """Holds the raw signal at adr_target of full scale by stepping the VGSK DAC.

    Stands in for the SDK's native Func1. The camera responds at about 24 counts per DAC
    step, and the new value appears a few frames later, so the loop is damped.
    """

    COUNTS_PER_STEP = 24.0

    def __init__(self, cal, start):
        self.lo, self.hi = cal.vgsk_min, cal.vgsk_max
        self.target = cal.adr_target * (ADC_MAX + 1)
        self.value = int(start)
        self._settle = 0

    def update(self, frame):
        if frame.vgsk != self.value:  # wait until the camera reports the last setting
            return self.value
        if self._settle > 0:
            self._settle -= 1
            return self.value
        median = float(np.median(frame.pixels[8:-8:2, 8:-8:2]))
        error = self.target - median
        if abs(error) > 0.05 * self.target:
            step = int(np.clip(round(0.6 * error / self.COUNTS_PER_STEP), -15, 15)) or int(np.sign(error))
            self.value = int(np.clip(self.value + step, self.lo, self.hi))
            self._settle = 2
        return self.value


class Agc:
    """Maps NUC counts to 0-255 with percentile limits that are smoothed over time."""

    def __init__(self, ignore=0.01, smoothing=0.2):
        self.ignore = ignore
        self.smoothing = smoothing
        self.lo = self.hi = None
        self.equalize = False

    def __call__(self, img):
        sample = img[4:-4:2, 4:-4:2]
        lo, hi = np.percentile(sample, [100 * self.ignore, 100 * (1 - self.ignore)])
        hi = max(hi, lo + 20)  # keep noise from being blown up on a flat scene
        if self.lo is None:
            self.lo, self.hi = lo, hi
        else:
            a = self.smoothing
            self.lo += a * (lo - self.lo)
            self.hi += a * (hi - self.hi)
        out = np.clip((img - self.lo) * (255.0 / (self.hi - self.lo)), 0, 255).astype(np.uint8)
        if self.equalize:
            out = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(6, 8)).apply(out)
        return out


def load_palettes(folder):
    """Load the original app's palette XML files into (name, 256x1x3 BGR LUT) pairs."""
    palettes = []
    for path in sorted(glob.glob(os.path.join(folder, "*.xml")), key=lambda p: int(os.path.basename(p)[:-4])):
        root = ET.parse(path).getroot()
        name = root.find("labels/label").text
        stops = sorted((int(c.get("step")), c.text.strip()) for c in root.find("colors"))
        xs = np.array([s for s, _ in stops], np.float32) * (255.0 / 256.0)
        # The app stores colours as #BBGGRR, which is already OpenCV's channel order.
        bgr = np.array([[int(h[i:i + 2], 16) for i in (1, 3, 5)] for _, h in stops], np.float32)
        idx = np.arange(256, dtype=np.float32)
        lut = np.stack([np.interp(idx, xs, bgr[:, c]) for c in range(3)], axis=1)
        palettes.append((name, lut.astype(np.uint8).reshape(256, 1, 3)))
    return palettes


def colorize(gray, lut):
    return cv2.applyColorMap(gray, lut) if lut is not None else cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)
