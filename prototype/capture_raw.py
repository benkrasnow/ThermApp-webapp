"""Grab N raw frames from the Therm-App and save them for offline analysis."""

import argparse
import os
import time

from thermapp_usb import ThermApp, config_from_11bin

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_CAL = os.path.join(HERE, "..", "calibration", "215324084")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("-n", type=int, default=20)
    ap.add_argument("--out", default=os.path.join(HERE, "captures"))
    ap.add_argument("--cal", default=DEFAULT_CAL)
    ap.add_argument("--default-config", action="store_true", help="send SDK defaults instead of 11.bin")
    args = ap.parse_args()

    cfg = None if args.default_config else config_from_11bin(os.path.join(args.cal, "11.bin"))
    os.makedirs(args.out, exist_ok=True)
    cam = ThermApp(cfg)
    cam.start()
    try:
        t0 = time.monotonic()
        prev = None
        for i in range(args.n):
            f = cam.get_frame(timeout=3, after=prev)
            if f is None or f is prev:
                print("timeout waiting for frame")
                break
            prev = f
            open(os.path.join(args.out, "frame_%04d.raw" % i), "wb").write(f.raw)
            p = f.pixels
            print("#%02d serial=%d hw=%d fw=%d therm=%d tfpa=%d vgsk=%d  pix min=%d max=%d mean=%.1f"
                  % (i, f.serial, f.hw_version, f.fw_version, f.thermistor, f.tfpa, f.vgsk, p.min(), p.max(), p.mean()))
        dt = time.monotonic() - t0
        print("frames ok=%d dropped=%d  %.2f fps" % (cam.frames_ok, cam.frames_dropped, cam.frames_ok / dt))
    finally:
        cam.stop()


if __name__ == "__main__":
    main()
