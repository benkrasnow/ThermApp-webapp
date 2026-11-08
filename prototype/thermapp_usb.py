"""USB transport for the Opgal Therm-App (VID 0x1772, PID 0x0002).

Protocol, reconstructed from Opgal's SDK (thermapp.sdk.DeviceIF / ThermAppAPI) and
Pidbip/ThermAppCam:
  * Bulk OUT 0x02: 64-byte configuration header (32 x uint16 LE), re-sent continuously.
  * Bulk IN  0x81: a byte stream of frames. Each frame is 221,696 bytes (384x288 model)
    and starts with the same A5A5 A5A5 A5A5 A5D5 magic as the configuration header.
"""

import os
import struct
import sys
import threading
import time

import numpy as np
import usb.backend.libusb1
import usb.core
import usb.util

VID, PID = 0x1772, 0x0002
EP_OUT, EP_IN = 0x02, 0x81

WIDTH, HEIGHT = 384, 288
HEADER_BYTES = 64
FRAME_BYTES = 221696  # 64 header + 384*288*2 pixels + 448 trailer
MAGIC = bytes.fromhex("a5a5a5a5a5a5d5a5")

# Header word indices
W_CONTROL = 4       # 2 = stream video, 1 = idle
W_FRAME_RATE = 13   # never overwritten from 11.bin by the SDK
W_VGSK = 18         # VGSK DAC (AD5628), tuned live by the SDK
W_HEADER_SIZE = 25

# SDK defaults (thermapp.sdk.p)
DEFAULT_CONFIG = [
    0xA5A5, 0xA5A5, 0xA5A5, 0xA5D5, 2, 0, 0, 0, 0, 288, 384, 288, 384, 25, 0, 0,
    1884, 2949, 1524, 2048, 2949, 2949, 0, 1392, 2949, 64, 0, 0, 80, 3, 0, 4095,
]

# A frame is an exact multiple of the 512-byte packet size, so a read only completes when
# its buffer is full; small reads keep frames from arriving in pairs.
READ_CHUNK = 65536


def _libusb_dll_path():
    """libusb-1.0.dll: bundled next to the code in a frozen build, else from the libusb package."""
    if getattr(sys, "frozen", False):
        return os.path.join(sys._MEIPASS, "libusb-1.0.dll")
    import libusb
    return libusb.dll._name


def config_from_11bin(path):
    """Build the configuration header the SDK sends, from a camera's 11.bin.

    Mirrors ThermAppAPI.b(): words 0-31 come from the file except word 13,
    which keeps the default.
    """
    data = open(path, "rb").read()
    words = list(struct.unpack_from("<32h", data, 0))
    cfg = list(DEFAULT_CONFIG)
    for i in range(32):
        if i != W_FRAME_RATE:
            cfg[i] = words[i] & 0xFFFF
    return cfg


def pack_config(words):
    return struct.pack("<32H", *[w & 0xFFFF for w in words])


class Frame:
    """One raw frame: header words plus a 288x384 int16 pixel array."""

    def __init__(self, buf):
        self.raw = bytes(buf)
        self.header = np.frombuffer(self.raw, "<u2", HEADER_BYTES // 2, 0)
        self.pixels = np.frombuffer(self.raw, "<i2", WIDTH * HEIGHT, HEADER_BYTES).reshape(HEIGHT, WIDTH)

    @property
    def serial(self):
        return struct.unpack_from("<I", self.raw, 10)[0]

    @property
    def hw_version(self):
        return struct.unpack_from("<H", self.raw, 14)[0]

    @property
    def fw_version(self):
        return struct.unpack_from("<H", self.raw, 16)[0]

    @property
    def thermistor(self):
        return int(self.header[14])

    @property
    def tfpa(self):
        return int(self.header[15])

    @property
    def vgsk(self):
        return int(self.header[18])


class ThermApp:
    """Opens the camera, streams frames on a background thread, keeps the latest one."""

    def __init__(self, config=None):
        dll = _libusb_dll_path()
        backend = usb.backend.libusb1.get_backend(find_library=lambda _: dll)
        if backend is None:
            raise RuntimeError("Could not load libusb from " + dll)
        self.dev = usb.core.find(idVendor=VID, idProduct=PID, backend=backend)
        if self.dev is None:
            raise RuntimeError("Therm-App camera not found.\n\nCheck that it is plugged in. On a new "
                               "computer, install the WinUSB driver for 'USB2.0 (1772:0002)' with Zadig first.")
        try:
            self.dev.set_configuration()
            usb.util.claim_interface(self.dev, 0)
        except usb.core.USBError as e:
            raise RuntimeError("Found the Therm-App but could not open it (%s).\n\nInstall the WinUSB driver "
                               "with Zadig, and close any other program using the camera." % e)
        self.config = list(config or DEFAULT_CONFIG)
        self._config_lock = threading.Lock()
        self._frame = None
        self._frame_cond = threading.Condition()
        self.frames_ok = 0
        self.frames_dropped = 0
        self._running = False
        self._thread = None

    def set_config_word(self, index, value):
        with self._config_lock:
            self.config[index] = value & 0xFFFF

    def set_config(self, words):
        with self._config_lock:
            self.config = [w & 0xFFFF for w in words]

    def start(self):
        self._running = True
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def stop(self):
        self._running = False
        if self._thread:
            self._thread.join(timeout=2)
        try:
            self.set_config_word(W_CONTROL, 1)
            self._send_config()
        except usb.core.USBError:
            pass
        usb.util.release_interface(self.dev, 0)
        usb.util.dispose_resources(self.dev)

    def get_frame(self, timeout=2.0, after=None):
        """Return the newest Frame, waiting for one newer than `after` if given."""
        with self._frame_cond:
            self._frame_cond.wait_for(lambda: self._frame is not None and self._frame is not after, timeout)
            return self._frame

    def _send_config(self):
        with self._config_lock:
            payload = pack_config(self.config)
        self.dev.write(EP_OUT, payload, timeout=1000)

    def _run(self):
        buf = bytearray()
        last_cfg = 0.0
        while self._running:
            now = time.monotonic()
            if now - last_cfg > 0.05:
                self._send_config()
                last_cfg = now
            try:
                buf += self.dev.read(EP_IN, READ_CHUNK, timeout=1000)
            except usb.core.USBTimeoutError:
                continue
            while True:
                start = buf.find(MAGIC)
                if start < 0:
                    del buf[: max(0, len(buf) - len(MAGIC))]
                    break
                if start > 0:
                    del buf[:start]
                if len(buf) < FRAME_BYTES:
                    break
                # Pixels are 12-bit, so the magic can't occur inside a frame; finding one means
                # this frame was cut short. Below 25 fps, padding (not the next magic) can follow a frame.
                inner = buf.find(MAGIC, len(MAGIC), FRAME_BYTES)
                if inner >= 0:
                    self.frames_dropped += 1
                    del buf[:inner]
                    continue
                frame = Frame(buf[:FRAME_BYTES])
                del buf[:FRAME_BYTES]
                self.frames_ok += 1
                with self._frame_cond:
                    self._frame = frame
                    self._frame_cond.notify_all()
