# Plan: Therm-App browser app

> The original plan, written before the web app was built (2026-11-08). Phases 0–2 and much of 3 are done, Android works, and hosting is next; see the main [README](../README.md) for the current state.

The goal is a web page that connects to the Therm-App over **WebUSB**. It shows live thermal video, offers camera and image controls, and saves stills and video. The same page should run on Windows, macOS, Linux, ChromeOS and Android phones, with nothing to install beyond the one-time Windows USB driver.

This builds directly on the Windows prototype (`prototype/`). The protocol and processing are already proven there, so the web app is a port plus a UI, not new research.

## Platform reality check

| Platform | Works? | Notes |
|---|---|---|
| Chrome / Edge on Windows | Yes | Needs the WinUSB driver, the same one-time Zadig step as the exe. |
| Chrome / Edge on macOS, ChromeOS | Yes | No driver. |
| Chrome on Linux | Yes | One udev rule for 1772:0002. |
| Chrome on Android | Yes | USB-OTG phone. This could replace the Android app entirely. |
| Firefox, Safari, anything on iOS | **No** | No WebUSB. Firefox has declined to implement it, and iPhones have no USB host access for web pages. |

Other constraints:
- **Secure origin.** WebUSB only works from `https://` or `http://localhost`. Hosting on **GitHub Pages** (free, HTTPS) is the simplest option. Installed as a PWA, the page also works offline after the first visit.
- **User gesture.** The browser's own device picker must be clicked once. After that, Chrome remembers the permission and can reconnect automatically.
- **Claude Artifacts can't host it.** Artifacts run sandboxed and would block USB access.
- **Calibration stays local.** The page imports the camera's calibration folder once and keeps it in the browser's storage (IndexedDB). Nothing is uploaded.

## Architecture

```
USB (WebUSB, in a Worker) ──raw frames──▶ Processing (Worker)
                                          ├ frame sync + header parse
                                          ├ factory NUC (from calibration .bin files)
                                          ├ bad-pixel fill
                                          ├ VGSK auto-bias ──config word 18──▶ back to USB
                                          └ float image + stats
                        ──▶ Display (WebGL2): AGC, palette, mirror/flip, zoom, overlays
                        ──▶ Capture: stills (PNG + raw/float data), video (MediaRecorder), raw-frame recording
```

- **Language and tooling:** TypeScript, built with Vite into plain static files, with no heavy framework. A small reactive library such as Preact is enough for the control panel.
- **Threads:** USB and processing run in a Web Worker, so the UI never stutters. WebUSB is available inside workers in Chrome; if that fails on any platform, fall back to the main thread.
- **Throughput:** about 5.5 MB/s (25 fps × 221,696 bytes). Keeping 2–4 `transferIn` requests in flight keeps the pipe full.
- **NUC in JavaScript:** about 110k pixels × 15 operations per frame. That is a few milliseconds in plain typed-array JS, even on a phone. WebGL is used only for colour mapping and display.
- **Correctness:** golden tests. The Python prototype processes the saved `captures/*.raw` frames into reference outputs, and the TypeScript port must match them within float tolerance. This catches any mistake in the port without needing the camera.

### Module map (ported from the prototype)

| Web module | From | Notes |
|---|---|---|
| `usb.ts` | `thermapp_usb.py` | `requestDevice`, claim interface 0, config writes on EP 2, read loop on EP 0x81, magic sync |
| `frame.ts` | `Frame` | Header fields: serial, Tfpa, VGSK, thermistor |
| `calibration.ts` | `Calibration` | Folder import (`showDirectoryPicker` or `<input webkitdirectory>`), IndexedDB cache keyed by serial |
| `nuc.ts` | `Calibration.nuc` + `replace_bad_pixels` | |
| `vgsk.ts` | `VgskController` | |
| `agc.ts`, `palettes.ts` | `Agc`, `load_palettes` | The 9 palettes are converted to JSON at build time (#BBGGRR!) |
| `render.ts` | `viewer.py` drawing | WebGL2 shader: AGC + palette LUT texture |

## Features

**MVP:**
- Connect/disconnect, auto-reconnect, and a status bar (fps, serial, VGSK, sensor temperature)
- Calibration import screen, with a clear explanation of the dead-server problem
- Live view with palette picker, mirror/flip and fullscreen
- AGC: auto, or a locked range (freeze the current range for consistent comparisons)
- Spot meter (relative counts), crosshair and min/max markers
- **Stills:** a PNG of the coloured view, plus a data file with the float NUC image and header, so a picture can be re-coloured or re-analysed later
- **Video:** `MediaRecorder` on the canvas produces MP4 (H.264) where Chrome supports it, otherwise WebM. Saved through the File System Access API to a chosen folder on desktop, or as a download on Android.
- Settings saved in `localStorage`

**Next:**
- **Raw recording:** every frame's raw bytes go to a file, with an offline "replay" mode that reprocesses with any palette or settings. Thermal footage benefits from this.
- **Image quality:**
  - column-stripe filter and right-edge fix
  - temporal noise filter
  - CLAHE-style local contrast
  - frame averaging for stills
- Bad-pixel repair: lens-cap capture, then update the stored map
- ROI box/line with min/max/avg, picture-in-picture with the phone's own camera (getUserMedia), and time-lapse

## Phases

| # | Phase | Outcome |
|---|---|---|
| 0 | **WebUSB spike** (`web/spike.html`, already written) | Confirms Chrome can open the camera and sustain 25 fps on Windows, and later on the Pixel 6. |
| 1 | Project scaffold + core port | Vite/TS project, the modules above, golden tests passing against the Python outputs. |
| 2 | Live viewer MVP | Connect, calibrate, view, palettes, AGC, overlays. |
| 3 | Capture | Stills, video, raw recording and replay. |
| 4 | PWA + hosting | Offline install, GitHub Pages deploy, tested on Android Chrome with the camera on OTG. |
| 5 | Image quality + extras | Stripes, edge, noise, bad-pixel repair. |

The Windows exe stays as a fallback for computers without Chrome or Edge.

## Open decisions

1. **Hosting:** public GitHub Pages (anyone with the link can use it, though only with their own camera and calibration) or local-only. Public is recommended, since it's what makes it portable.
2. **Android:** if the web app works well in Android Chrome, it can replace the planned native Android app. Phase 4 will tell. The main risk is Android's USB handling of the device, which only testing will show.
3. **Repository:** turn this folder into a git repo, and optionally push it to GitHub, before Phase 1. The decompiled Opgal code should stay out of any public repo.
