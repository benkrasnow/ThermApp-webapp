# Therm-App Windows prototype

This is a live viewer for the Opgal Therm-App that uses the camera's own factory calibration, with no Opgal software. It is tested on Windows 11 with serial 215324084.

> **Superseded by the web app** in [`../web`](../web). This prototype is kept because it was the reference implementation, and the web app's golden tests compare against references it generates (`web/test/make_refs.py`). It doesn't have the later fixes: the exact Opgal VGSK loop, temperatures, and the improved frame sync.

## Setup (one time)

1. Plug the camera into the PC. Use [Zadig](https://zadig.akeo.ie/) to install **WinUSB** on `USB2.0 (1772:0002)`.
2. Create the Python environment from the project root:
   ```
   python -m venv .venv
   .venv\Scripts\python -m pip install -r prototype\requirements.txt
   ```
   The `libusb` package bundles `libusb-1.0.dll`, so there's nothing else to install.

## Run

```
.venv\Scripts\python prototype\viewer.py
```

| Key | Action |
|---|---|
| `p` / `P` | Next / previous palette (gray plus the original app's 8 palettes) |
| `e` | Toggle local contrast enhancement (CLAHE) |
| `m` / `f` | Mirror / flip |
| `s` | Snapshot: a PNG of the view and the `.raw` frame, saved to `prototype/media/` |
| `r` | Start/stop MP4 recording |
| `n` | Toggle factory NUC, to see the raw sensor output |
| `q` / Esc | Quit |

### Standalone .exe (retired, unmaintained)

```
.venv\Scripts\python -m pip install pyinstaller
.venv\Scripts\python prototype\build_exe.py
```

This produces `dist/ThermAppViewer/ThermAppViewer.exe`, about 69 MB, plus `dist/ThermAppViewer.zip` to copy to other PCs.
- **What's inside:** the exe bundles Python, libusb, the palettes, and every calibration folder under `calibration/`.
- **Calibration lookup:** at start-up the viewer reads the camera serial and looks for a matching calibration folder in this order:
  1. `--cal`
  2. `calibration\<serial>\` next to the exe
  3. the bundled copy
- **Media** is saved to `media\` next to the exe.
- **Errors** appear in a message box.
- **New PCs** still need the one-time Zadig/WinUSB step; it is described in [DIST_README.txt](DIST_README.txt).

The other scripts:
- `capture_raw.py -n 20` saves raw frames to `captures/` and prints the header fields.
- `vgsk_sweep.py` steps the bias DAC and prints the raw response. It's a diagnostic.

## Files

- `thermapp_usb.py`: USB transport. It sends the 64-byte configuration (built from `11.bin`), syncs on the frame magic, and parses frames.
- `thermapp_proc.py`: factory NUC polynomial, bad-pixel fill, VGSK bias controller, AGC and palette loading.
- `viewer.py`: the OpenCV front-end.

## Measured behaviour (2026-11-08)

- **Frames:** 25 fps from the camera, about 23 fps rendered at 2× scale, 0 dropped. The header serial matches the calibration folder.
- **Sensor:** the ADC is **12-bit** (0–4095).
- **VGSK:** the bias DAC is config word 18. It moves the raw level by about 24 counts per step. **Using the `11.bin` value of 1475 directly leaves the signal clipped near the floor.** The SDK's native `Func1` keeps it at `adrTarget` (0.25) of full scale, inside the `11.bin` limits of 1300–1580. `VgskController` copies that behaviour: it holds the raw median at about 1024, which works out to roughly VGSK 1520 in this room, and settles in about 1.5 s from either limit.
- **NUC:** the factory NUC gives a clean image at the target bias. It degrades if the bias is far off target, at 1560 for example.

## Known gaps / next steps

- **Image quality:**
  - faint vertical column striping
  - a bright band about 12 px wide on the right edge
  
  The original app runs a high-pass and histogram stage (native `Func3`), which probably hides both. Options are to disassemble `libipthermapp.so` (`Func1`, `Func2`, `Func3`) for exact parity, or to add a column-offset filter.
- **No temperature readout.** This camera is a non-TH model, and the SDK only does radiometry for TH units. The spot value is NUC counts. A relative scale, or a user-supplied two-point calibration, could be added.
- Bad-pixel repair (lens-cap capture → update `1.bin`) is not ported yet.
