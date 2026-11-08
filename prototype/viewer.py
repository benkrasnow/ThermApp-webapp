"""Live Therm-App viewer for Windows (and any OS with libusb).

Keys:
  p / P   next / previous palette        e   toggle local contrast (CLAHE)
  m       mirror      f   flip           r   start/stop video recording
  s       snapshot (PNG + raw frame)     n   toggle factory NUC (to compare)
  q, Esc  quit
"""

import argparse
import ctypes
import os
import sys
import time
import traceback

import cv2
import numpy as np

from thermapp_proc import Agc, Calibration, VgskController, colorize, load_palettes, replace_bad_pixels
from thermapp_usb import W_VGSK, ThermApp, config_from_11bin

FROZEN = getattr(sys, "frozen", False)
HERE = os.path.dirname(os.path.abspath(__file__))
# Read-only files shipped with the app (palettes, bundled calibration).
RESOURCES = sys._MEIPASS if FROZEN else HERE
# Where the user can see and add files: next to the .exe, or the repo root when run from source.
APP_DIR = os.path.dirname(sys.executable) if FROZEN else os.path.join(HERE, "..")
WINDOW = "Therm-App"


def find_calibration(serial, override=None):
    """Return the calibration folder for this camera serial.

    Looks in --cal, then a 'calibration' folder next to the app (so another camera's
    /sdcard/ThermApp/<serial>/ folder can simply be dropped in), then the bundled copy.
    """
    candidates = [override] if override else []
    candidates += [os.path.join(APP_DIR, "calibration", str(serial)),
                   os.path.join(RESOURCES, "calibration", str(serial))]
    for folder in candidates:
        if folder and os.path.isfile(os.path.join(folder, "11.bin")):
            return folder
    raise RuntimeError("No calibration data for camera serial %d.\n\nCopy the phone folder "
                       "/sdcard/ThermApp/%d/ into:\n%s" % (serial, serial, os.path.join(APP_DIR, "calibration")))


def show_error(msg):
    print(msg, file=sys.stderr)
    if FROZEN and sys.platform == "win32":
        ctypes.windll.user32.MessageBoxW(None, msg, "Therm-App Viewer", 0x10)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cal", help="calibration folder for this camera (default: chosen by serial)")
    ap.add_argument("--scale", type=int, default=2)
    ap.add_argument("--out", default=os.path.join(APP_DIR, "media"))
    ap.add_argument("--frames", type=int, default=0, help="exit after N frames (0 = run until q)")
    ap.add_argument("--headless", action="store_true", help="no window; save the last frame (for testing)")
    args = ap.parse_args()

    palettes = [("gray", None)] + [p for p in load_palettes(os.path.join(RESOURCES, "palettes")) if p[0] != "white hot"]
    agc = Agc()
    pal_idx, mirror, flip, use_nuc = 0, False, False, True
    writer = None
    os.makedirs(args.out, exist_ok=True)

    # Start with the SDK defaults just long enough to read the serial, then load that camera's data.
    cam = ThermApp()
    cam.start()
    try:
        first = cam.get_frame(timeout=3)
        if first is None:
            raise RuntimeError("The Therm-App was found but is not sending frames.\n\nUnplug it, plug it back in and try again.")
        cal_dir = find_calibration(first.serial, args.cal)
        cal = Calibration(cal_dir)
        vgsk = VgskController(cal, start=1520)
        config = config_from_11bin(os.path.join(cal_dir, "11.bin"))
        config[W_VGSK] = vgsk.value
        cam.set_config(config)
        print("Camera %d, calibration %s" % (first.serial, os.path.abspath(cal_dir)))
    except Exception:
        cam.stop()
        raise
    if not args.headless:
        cv2.namedWindow(WINDOW, cv2.WINDOW_AUTOSIZE)
    prev, count, fps, t_last = None, 0, 0.0, time.monotonic()
    try:
        while True:
            frame = cam.get_frame(timeout=3, after=prev)
            if frame is None or frame is prev:
                print("No frames from camera")
                break
            prev = frame
            count += 1
            if count < 3:  # the first frames after start-up are partial
                continue

            new_v = vgsk.update(frame)
            if new_v != frame.vgsk:
                cam.set_config_word(W_VGSK, new_v)

            if use_nuc:
                img = cal.nuc(frame.pixels, frame.tfpa, frame.vgsk)
            else:
                img = frame.pixels.astype(np.float32)
            img = replace_bad_pixels(img, cal.bad)
            spot = float(img[img.shape[0] // 2 - 1:img.shape[0] // 2 + 2, img.shape[1] // 2 - 1:img.shape[1] // 2 + 2].mean())

            gray = agc(img)
            if mirror:
                gray = gray[:, ::-1]
            if flip:
                gray = gray[::-1, :]
            name, lut = palettes[pal_idx]
            view = colorize(np.ascontiguousarray(gray), lut)
            view = cv2.resize(view, None, fx=args.scale, fy=args.scale, interpolation=cv2.INTER_LINEAR)

            now = time.monotonic()
            fps = 0.9 * fps + 0.1 / max(now - t_last, 1e-3)
            t_last = now
            h, w = view.shape[:2]
            cx, cy = w // 2, h // 2
            cv2.drawMarker(view, (cx, cy), (255, 255, 255), cv2.MARKER_CROSS, 16, 1)
            status = "%s | %.1f fps | VGSK %d | Tfpa %d | spot %.0f%s%s" % (
                name, fps, frame.vgsk, frame.tfpa, spot, "" if use_nuc else " | NUC OFF", " | REC" if writer else "")
            cv2.putText(view, status, (8, h - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 0, 0), 3, cv2.LINE_AA)
            cv2.putText(view, status, (8, h - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (255, 255, 255), 1, cv2.LINE_AA)

            if writer:
                writer.write(view)
            if args.headless:
                if args.frames and count >= args.frames:
                    cv2.imwrite(os.path.join(args.out, "headless_last.png"), view)
                    print(status)
                    break
                continue
            cv2.imshow(WINDOW, view)

            key = cv2.waitKey(1) & 0xFF
            if key in (ord("q"), 27) or cv2.getWindowProperty(WINDOW, cv2.WND_PROP_VISIBLE) < 1:
                break
            if args.frames and count >= args.frames:
                break
            if key == ord("p"):
                pal_idx = (pal_idx + 1) % len(palettes)
            elif key == ord("P"):
                pal_idx = (pal_idx - 1) % len(palettes)
            elif key == ord("e"):
                agc.equalize = not agc.equalize
            elif key == ord("m"):
                mirror = not mirror
            elif key == ord("f"):
                flip = not flip
            elif key == ord("n"):
                use_nuc = not use_nuc
                agc.lo = None
            elif key == ord("s"):
                stamp = time.strftime("%Y%m%d_%H%M%S")
                cv2.imwrite(os.path.join(args.out, "thermapp_%s.png" % stamp), view)
                open(os.path.join(args.out, "thermapp_%s.raw" % stamp), "wb").write(frame.raw)
                print("saved snapshot", stamp)
            elif key == ord("r"):
                if writer:
                    writer.release()
                    writer = None
                    print("recording stopped")
                else:
                    path = os.path.join(args.out, "thermapp_%s.mp4" % time.strftime("%Y%m%d_%H%M%S"))
                    writer = cv2.VideoWriter(path, cv2.VideoWriter_fourcc(*"mp4v"), 25, (w, h))
                    print("recording to", path)
    finally:
        if writer:
            writer.release()
        cam.stop()
        cv2.destroyAllWindows()
        print("frames ok=%d dropped=%d" % (cam.frames_ok, cam.frames_dropped))


if __name__ == "__main__":
    try:
        main()
    except RuntimeError as e:
        show_error(str(e))
        sys.exit(1)
    except Exception:
        show_error("Unexpected error:\n\n" + traceback.format_exc())
        sys.exit(1)
