"""Diagnostic: step the VGSK DAC (config word 18) and report the raw pixel response."""

import os
import time

import numpy as np

from thermapp_usb import W_VGSK, ThermApp, config_from_11bin

cal = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "calibration", "215324084")
cam = ThermApp(config_from_11bin(os.path.join(cal, "11.bin")))
cam.start()
try:
    for v in range(1250, 1651, 50):
        cam.set_config_word(W_VGSK, v)
        time.sleep(0.6)
        f = cam.get_frame()
        p = f.pixels[2:-2, 2:-2]
        print("set=%d hdr_vgsk=%d tfpa=%d  raw p1=%d median=%d p99=%d mean=%.1f"
              % (v, f.vgsk, f.tfpa, np.percentile(p, 1), np.median(p), np.percentile(p, 99), p.mean()))
finally:
    cam.stop()
