# Therm-App: feasibility of a replacement app

Analysis of `ThermAppPlus_base.apk` (com.thermappplus v1.0R112, targetSdk 23, minSdk 18), decompiled with jadx 1.5.1.
> This is the original feasibility study, written right after decompiling the app. The decompiled code it refers to (`decompiled/…`) is Opgal's and ThermAppPlus's proprietary code. It is **not included in this repository**; [therm-app-protocol.md](therm-app-protocol.md) describes what was learned from it without reproducing it.

The key SDK classes (as named by jadx) were:

- `thermapp/sdk/ThermAppAPI.java`: Opgal's SDK, covering the frame pipeline, calibration loading and the auto-ranging state machine
- `thermapp/sdk/DeviceIF.java`: the USB layer, a thin JNI wrapper over `libusbthermapp.so`
- `thermapp/sdk/p.java`: the default 64-byte configuration header sent to the camera
- `thermapp/sdk/i.java`: bad-pixel repair (BPR)
- `thermapp/sdk/b.java`, `f.java`, `q.java`: the calibration download from Opgal's server
- `native/`: `libusbthermapp.so`, `libipthermapp.so` and the RenderScript bitcode (`thermappsdk_ipn.bc` for NUC, `thermappsdk_ipd.bc` for display)

## Verdict

**A new app is very doable.** The USB protocol is simple and the community has already reverse-engineered it. Opgal's SDK is ordinary Java. The two native libraries are small, and their logic can be rebuilt from the Java side.

The hard part is **per-camera factory calibration data**, not USB. Opgal's calibration server is gone (see below). A new app therefore needs the calibration files that the old app already downloaded to a phone.

| Piece | Difficulty | Notes |
|---|---|---|
| USB connect + frame capture | Easy | Bulk transfers. Open-source C code already works on Linux and macOS. |
| Raw image → usable picture (no calibration) | Easy | Shutterless flat-field + bad-pixel masking gives a decent "Enhanced" image. |
| Factory NUC, i.e. Opgal-quality image | Moderate | Needs the per-serial `.bin` files and the exact kernel formula from `thermappsdk_ipn.bc`. |
| Radiometric temperature (°C) | Moderate–hard | Same files, plus `0.bin` coefficients, the TH auto-range LOW/MED/HIGH switching and the transient model. Logic is all visible in `ThermAppAPI.a(byte[])`. |
| UI: palettes, spot/area/line, capture, video | Routine app work | |

Rough effort for one experienced developer:
- Working live view on Windows or Linux: a few days.
- Calibrated, radiometric Android app with core features: about 3–6 weeks.

## Why the current app is dying

1. **32-bit only native code.** `libusbthermapp.so` and `libipthermapp.so` ship only for `armeabi-v7a`. Many current phones are 64-bit-only and cannot load them at all; Pixel 7 and later are examples.
2. **RenderScript.** The whole image pipeline runs on `android.support.v8.renderscript`, which Google has deprecated.
3. **Calibration server is dead.** `http://api.therm-app.com/mobileservice.svc/` and `therm-app.com` both now return a parked-domain redirect (`/lander`). `StartVideo()` refuses to run unless `CheckDeviceData()` finds the per-serial files on disk. As a result, **a fresh install on a new phone cannot start video, even if it runs.**
4. Old APIs: Apache `DefaultHttpClient`, Google Play license check (`CHECK_LICENSE`), `TelephonyManager.getDeviceId()`, and raw `/sdcard/ThermApp` paths. targetSdk 23 is also at the floor of what Android 14+ will install.

## ⚠️ Action item: preserve calibration data now

On any phone where the old app has run with your camera, copy this whole folder somewhere safe:

```
/sdcard/ThermApp/<camera serial number>/
```

It contains `FilesList.json` or `Data.json`, `0.bin`, `1.bin` (the bad-pixel map), `2.bin`…`10.bin`, `11*.bin` (camera configuration headers), and on TH units the `2a`…`22c` thermography sets. Without these files, only uncalibrated imaging is possible. Uncalibrated imaging is still useful, but it cannot measure absolute temperature.

The serial number is in bytes 10–13 of every frame header. The app also displays it as "Therm-App Camera Serial #".

## The USB protocol (from decompile + community code)

- **VID/PID:** `0x1772:0x0002` (decimal 6002/2, see `res/xml/device_filter.xml`). The device uses a vendor-specific class, not UVC.
- **Interface 0.** Bulk **OUT EP 0x02** sends the configuration header. Bulk **IN EP 0x81** receives frames.
- **Configuration header:** 32 × uint16 little-endian (64 bytes). The defaults are in `p.java`:
  `A5A5 A5A5 A5A5 A5D5 | ctrl | 0 0 0 0 | 288 384 288 384 | 25 | 0 0 | 1884 2949 1524 2048 2949 2949 0 1392 2949 | 64 0 0 80 3 0 4095`
  - word 4 is control: `2` = stream video, `1` = idle (used during connect/stop)
  - words 16–24 are DAC (AD5628) bias voltages: VoutA DC offset, gain, FPA VBUS, and so on
  - word 18 is the VGSK voltage, which the SDK adjusts live via `Func1`
  - word 25 is the header size (64)
  - At start-up the per-serial `11.bin`/`11a-c.bin` overwrite these defaults with factory values. The app re-sends the header before every frame read.
- **Frame:** 221,696 bytes at 384×288. The 640×480 variant (`versionFormat==2`) uses 614,912 bytes.
  - 64-byte header, starting with magic `0xA5A5A5A5 / 0xA5D5`
  - 384×288 × int16 pixels
  - 448-byte trailer
- **Header fields** (16-bit word index):
  - serial: bytes 10–13
  - hardware version: bytes 14–15
  - firmware: bytes 16–17
  - word 14 is the thermistor reading used for thermography
  - word 15 is T_fpa (focal plane temperature)
  - word 18 is VGSK
  - The community header notes a frame counter as well.
- Frame rate is about 8.7 Hz on the export-limited units.

## Image pipeline (what a new app must replicate)

1. **NUC (non-uniformity correction).** The `ipn` RenderScript kernel computes a corrected value per pixel. It uses per-pixel float maps (`2.bin`–`10.bin`: square, linear, offset, T_fpa, T_fpa², T_fpa×pix, VGSK, VGSK², VGSK×pix) together with the frame's T_fpa and VGSK.
   - The exact formula is compiled into `thermappsdk_ipn.bc`, which is only 2.6 KB of LLVM bitcode. An old `llvm-dis` (3.x) can recover it.
   - File format: little-endian float32 at 384×288. `versionFormat 0` uses float64.
2. **Bad-pixel replacement** (`Func2`). `1.bin` marks dead pixels as 0, and they are replaced from their neighbours.
3. **High-pass filter, histogram AGC and LUT** (`Func3`) for "Enhanced" mode. Thermography mode skips the HPF.
4. **Palette mapping** (`ipd` kernel). The 9 palettes are XML files in `assets/palettes`.
5. **Temperature.** For TH units, a polynomial in the thermistor reading (`0.bin` floats 20–27) gives the housing temperature. That temperature selects the LOW/MED/HIGH calibration sets, with hysteresis thresholds at floats 30–33, and applies a transient warm-up compensation. All of this is plain Java, readable in `ThermAppAPI.a(byte[])` and `m()`.

The two native libraries are small (18 KB and 88 KB). `libipthermapp` is pure maths (histogram, bad pixels, VGSK tuning). `libusbthermapp` is stock libusb plus about 100 lines of glue. Neither needs to be reused: rewriting them is cleaner, and a rewrite gives 64-bit support for free.

## Existing open-source work

- [Pidbip/ThermAppCam](https://github.com/Pidbip/ThermAppCam) (GPLv3, 2015–16) is the original reverse-engineering. It is a C/libusb driver plus a Qt viewer and v4l2loopback output. It has a crude self-made flat-field instead of factory NUC. [EFraim's fork](https://github.com/EFraim/ThermAppCam) is the same code.
- [Hacks4ROS/h4r_thermapp_camera](https://github.com/Hacks4ROS/h4r_thermapp_camera) wraps the same library as a ROS Indigo node. It is unmaintained (2015) and is useful mainly for its udev rule.
- [oil3/therm-app-mac](https://github.com/oil3/therm-app-mac) (Jan 2025) is a macOS CLI and a native Swift app. It confirms the protocol still works on a modern OS without a driver.
- None of these projects use Opgal's factory calibration files. Combining that work with the decompiled SDK logic would be new.

## Recommended architecture

Write the core once in a portable language and put thin front-ends on it:

- **Core library** (C/C++ or Rust; Kotlin is possible for Android-only), split into two parts:
  - **USB transport:** libusb works everywhere. On Android, open the device with `UsbManager` and hand the file descriptor to `libusb_wrap_sys_device`, which is how the original app did it. Android-only alternative: Java `UsbDeviceConnection.bulkTransfer`, which needs no native code at all.
  - **Processing:** frame parsing, NUC, bad pixels, AGC, palettes and radiometry. On Android this can run on the CPU, which is fine at 110k pixels and about 9 fps. A Vulkan or GL compute shader is an option, but not required.
- **Android app:** Kotlin + Compose, built for arm64-v8a and armeabi-v7a, using the `USB_DEVICE_ATTACHED` intent filter and MediaStore for saving. Calibration files are imported from a folder the user picks, with no server.
- **Windows:** the camera is a vendor-class device, so bind **WinUSB** to `1772:0002` once (Zadig, or ship an INF). libusb then works unchanged. The front-end can be Qt, Python (pyusb + numpy + OpenCV, the quickest prototype) or Rust + egui. A virtual-webcam output, as v4l2loopback provides on Linux, is a nice extra.
- **Linux and macOS** come almost free with libusb. Linux needs a udev rule.

Suggested order:
1. Run a Python + pyusb prototype on Windows to capture raw frames. This validates the protocol against your camera, takes about a day, and needs no calibration files.
2. Disassemble `thermappsdk_ipn.bc` to get the exact NUC formula, then check it in the prototype against the saved calibration files.
3. Port the processing to the shared core and build the Android app on top of it.

## Answered (2026-11-08)

- **Camera:** serial 215324084, a standard 384×288 Therm-App. It is *not* a TH unit, so the TH auto-range and transient logic don't apply.
- **Calibration data:** copied off the Pixel 6 into [calibration/215324084/](../calibration/215324084/), with checksums verified.
- **NUC formula:** recovered from the RenderScript bitcode. See [calibration/README.md](../calibration/README.md) and [therm-app-protocol.md](therm-app-protocol.md#9-image-pipeline-raw-counts-to-temperature).

## Open questions to check with the hardware
- Bad-pixel repair (`i.java`) rewrites `1.bin` from frames taken with the lens cap on. It is easy to carry over, so a new app can keep maintaining the map.
