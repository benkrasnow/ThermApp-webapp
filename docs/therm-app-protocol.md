# Opgal Therm-App: USB protocol, configuration and calibration

*Engineering notes from the Therm-App Web project. Last updated 2026-11-08.*

This document describes how to talk to an Opgal Therm-App thermal camera without Opgal's software. It covers the USB transfer protocol, the 32-word configuration block, the frame format, the per-camera factory calibration, and how temperatures are derived. Each claim is labelled with how it was established and how confident we are.

- **Hardware tested:** one standard (non-TH) Therm-App, 384×288, serial 215324084, hardware version 4, firmware 118.
- **Software:** a Windows 11 PC using Chrome/Edge WebUSB and Python with libusb.

Other models, such as the TH (thermography) and the 640×480 HZ/Pro, are covered only where Opgal's SDK code shows how they differ.

## Contents

1. [Sources and confidence levels](#1-sources-and-confidence-levels)
2. [USB interface](#2-usb-interface)
3. [Session sequence](#3-session-sequence)
4. [Configuration block](#4-configuration-block)
5. [Frame format](#5-frame-format)
6. [Stream behaviour and frame synchronisation](#6-stream-behaviour-and-frame-synchronisation)
7. [Frame rate](#7-frame-rate)
8. [Factory calibration files](#8-factory-calibration-files)
9. [Image pipeline: raw counts to temperature](#9-image-pipeline-raw-counts-to-temperature)
10. [The VGSK bias loop](#10-the-vgsk-bias-loop)
11. [What is in Opgal's native libraries](#11-what-is-in-opgals-native-libraries)
12. [Experiment log](#12-experiment-log)
13. [Open questions](#13-open-questions)
14. [Safety notes for experimenters](#14-safety-notes-for-experimenters)
15. [References](#15-references)

---

## 1. Sources and confidence levels

| Source | What it gave us |
|---|---|
| **ThermAppPlus APK** (`com.thermappplus` 1.0R112), decompiled with jadx 1.5.1 | Opgal's Java SDK (`thermapp.sdk.*`), embedded in the app: connection sequence, configuration defaults, calibration file loading, the temperature scale and the TH-model logic |
| **RenderScript bitcode** in the APK (`thermappsdk_ipn.bc`, `thermappsdk_ipd.bc`), disassembled with LLVM via llvmlite | The exact NUC (non-uniformity correction) formula |
| **Native libraries** in the APK (`libipthermapp.so`, `libusbthermapp.so`, 32-bit ARM), disassembled with Capstone | The VGSK bias-control algorithm (`Func1`) and an inventory of the other native functions |
| **Pidbip/ThermAppCam** (GPLv3, 2015–16) and its forks EFraim/ThermAppCam, Hacks4ROS/h4r_thermapp_camera and oil3/therm-app-mac | Independent community reverse-engineering: USB setup, register guesses (DAC naming), the frame counter location and an experimental sensor-temperature formula |
| **Live experiments** on the camera | Most of the configuration-word behaviour, frame timing, stream shape and the effect of settings on temperature (see §12) |

Confidence labels used below:
- **Confirmed:** verified by experiment on the camera, or it is exact code from Opgal's SDK.
- **Strong:** consistent across several independent sources, but not tested in isolation.
- **Inferred:** our interpretation, plausible but unverified.
- **Unknown.**

## 2. USB interface

| Property | Value | Confidence |
|---|---|---|
| VID / PID | `0x1772` / `0x0002` (manufacturer string "SLS", product "USB2.0", serial string "00001") | Confirmed |
| Speed | USB 2.0 high-speed, self-powered descriptor, 100 mA | Confirmed |
| Class | `0xFF` vendor-specific (device and interface). Not UVC, so it needs a generic driver: WinUSB on Windows, nothing on macOS, a udev rule on Linux. | Confirmed |
| Configuration | 1 configuration, 1 interface (0), 2 endpoints | Confirmed |
| `EP 0x02` Bulk OUT, 512 B max packet | Configuration block, host to camera | Confirmed |
| `EP 0x81` Bulk IN, 512 B max packet | Continuous frame stream, camera to host | Confirmed |

There are no vendor control requests. The community driver issues standard `GET_DESCRIPTOR` and `SET_CONFIGURATION` control transfers that mirror normal enumeration, and those aren't required. Opgal's SDK opens the device through Android's `UsbManager`, passes the file descriptor to a bundled libusb (`libusb_get_device_with_fd` / `libusb_wrap_sys_device`), claims interface 0, and uses bulk transfers only.

Throughput at full rate is 25.98 frames/s × 221,696 B, about 5.76 MB/s.

## 3. Session sequence

What Opgal's SDK does (`ThermAppAPI.ConnectToDevice` / `AfterConnect` / `StartVideo`), and what works for us:

1. Open the device and claim interface 0.
2. Send the **default configuration block** (§4) with control word 4 = `2`.
3. Read frames from EP 0x81. Parse the camera's **serial number** from the frame header (§5); the SDK waits up to 3 s for it.
4. Look up the per-serial calibration files (§8). Overwrite configuration words 0–31 from that camera's `11.bin`, except word 13. The bias (word 18) is then driven by the VGSK loop (§10).
5. Keep **re-sending the configuration block continuously**. The SDK sends it before every frame read. We send it every 50 ms, and any interval up to at least 1 s also works. Changes to the block take effect within a few frames.
6. To stop, send the block with control word 4 = `1` (idle), then release the interface.

## 4. Configuration block

The block is 32 × uint16, little-endian (64 bytes), sent on EP 0x02. The camera **echoes the block back as the first 64 bytes of every frame**. It substitutes live measurements in words 14, 15 and 26 and its own identity in words 5–8, and forces a few read-only words. Comparing what was sent with what came back is therefore a direct way to classify each word.

`11.bin` in the calibration set is a frame header saved at the factory: its live words are frozen at their factory values. That is why it contains a serial number, a thermistor reading and a frame-counter value.

**Columns:**
- **SDK default:** `thermapp.sdk.p`.
- **Factory (11.bin):** for camera 215324084.
- **Echo behaviour:** observed when sending both sets.

| Word | SDK default | Factory (11.bin) | Echo behaviour | Meaning | Confidence |
|---|---|---|---|---|---|
| 0–2 | `A5A5` | `A5A5` | echoed | Preamble | Confirmed |
| 3 | `A5D5` | `A5D5` | echoed | Preamble. As bytes, words 0–3 are the frame sync marker `A5 A5 A5 A5 A5 A5 D5 A5`. | Confirmed |
| 4 | 2 | 2 | echoed | **Control.** `2` = stream video, `1` = idle (SDK `GetControl_Index`). Pidbip calls the low nibble "modes" and its comment says "test pattern"; no other values tested. | Confirmed for 1/2 |
| 5–6 | 0, 0 | 38324, 3285 | **camera-supplied** (returned even when 0 is sent) | **Serial number**, uint32 = 215,324,084 (bytes 10–13 of a frame) | Confirmed |
| 7 | 0 | 4 | camera-supplied | **Hardware version** | Confirmed |
| 8 | 0 | 118 | camera-supplied | **Firmware version.** The SDK maps 256 to 7. | Confirmed |
| 9 | 288 | 288 | echoed | Image height | Strong |
| 10 | 384 | 384 | echoed | Image width | Strong |
| 11 | 288 | 288 | echoed | Image height (second copy; window vs output?) | Inferred |
| 12 | 384 | 384 | echoed | Image width (second copy) | Inferred |
| 13 | 25 | 25 | echoed | **Transmit frame rate.** Frames sent per second: 1–24 decimates, 25 or more sends every frame. Does **not** change the sensor rate (§7). The SDK never loads it from `11.bin`; for `versionFormat 2` it sets 2500. | Confirmed |
| 14 | 0 | 30412 | **live** (camera overwrites) | **Thermistor** reading (housing). On TH models the SDK feeds it into a 5th-order polynomial from `0.bin` to get housing temperature. Reads ~30403 and is very stable on our unit. | Strong |
| 15 | 0 | 14603 | **live** | **T_fpa**, the focal-plane temperature reading, used by the NUC (§9). Rises as the camera warms (~14600 at factory capture, 17200–17950 in our room). Pidbip's experimental conversion is °C ≈ (T_fpa − 14336) × 0.00652. | Confirmed as NUC input; °C conversion unverified |
| 16 | 1884 | 1884 | echoed | DAC output. Pidbip: AD5628 "VoutA, DC offset". | Inferred |
| 17 | 2949 | 2949 | echoed | DAC output (VoutB?) | Inferred |
| 18 | 1524 | 1475 | echoed | **VGSK bias DAC**: shifts the raw signal by ~24 counts per step and is an input to the NUC. Servoed by the SDK (§10). Pidbip calls it "VoutC, gain". | Confirmed |
| 19 | 2048 | 2048 | echoed | DAC output. Pidbip: "VoutD". | Inferred |
| 20 | 2949 | 2949 | echoed | DAC output. Pidbip: "VoutE, FPA VBUS". | Inferred |
| 21 | 2949 | 2949 | echoed | DAC output? | Inferred |
| 22 | 0 | 0 | echoed | ? | Unknown |
| 23 | 1392 | 1392 | echoed | DAC output? 1392 is also the VGSK lower limit the native code uses for 640×480 models. | Unknown |
| 24 | 2949 | 2949 | echoed | DAC output? 2949 is the 640×480 VGSK upper limit. | Unknown |
| 25 | 64 | 64 | echoed | **Header size in bytes**. The SDK uses `word25 / 2` as the pixel offset in 16-bit words. | Confirmed (SDK) |
| 26 | 0 | 12052 | **live** | **Sensor frame counter**, uint16, wraps. Advances at 25.98 Hz even when frames aren't transmitted. Also found independently by Pidbip. | Confirmed |
| 27 | 0 | 0 | echoed | ? | Unknown |
| 28 | 80 | 250 | echoed (writable) | **Analog readout setting, tied to calibration.** It does **not** change timing. 80 vs 250 changes the raw signal level dramatically (mean 2214 vs 855 counts on the same scene), and temperatures are only correct at the factory value. Perhaps integration time, ramp or ADC gain. | Confirmed effect; meaning unknown |
| 29 | 3 | 2 | **read-only**: camera returns 2 whatever is sent | Status or mode? (The factory value is just the snapshot of this.) | Confirmed read-only |
| 30 | 0 | 0 | echoed | ? | Unknown |
| 31 | 4095 | 0 | **read-only**: camera returns 0 when 4095 is sent | ? | Confirmed read-only |

### What we suspected about words 28 and 29, and what the tests showed

Early on we guessed that words 28–29 might control sensor timing, and could therefore raise the frame rate. The only reasoning was elimination: they were the only unexplained words whose factory values (250, 2) differed from the SDK defaults (80, 3). **There was no direct evidence, and the tests ruled it out:**

- **Word 29 is read-only.** The camera reports 2 whatever is sent, so the factory value 2 is simply that readback. Word 31 behaves the same way.
- **Word 28 is writable, but timing doesn't change.** With 80 or 250, both values that Opgal's own software sends, the sensor runs at 25.98 fps. What changes is the analog signal level, by about 2.6×, and with it the calibration. It's a readout parameter that must stay at the factory value for valid temperatures.

No configuration word is known to change the sensor's frame period.

## 5. Frame format

Each frame is **221,696 bytes** at 384×288. For `versionFormat 2` (640×480) the SDK uses 614,912.

| Bytes | Content |
|---|---|
| 0–63 | **Header:** the 32-word configuration echo described in §4. It starts with the sync marker `A5 A5 A5 A5 A5 A5 D5 A5`. |
| 64–221,247 | **Pixels:** 384 × 288 × int16, little-endian, row-major, top row first. Values are 12-bit (0–4095), the ADC range. The SDK treats them as signed. |
| 221,248–221,695 | **Trailer:** 448 bytes, all `0xFF` on our unit |

Useful header fields, by byte offset:

| Field | Offset | Notes |
|---|---|---|
| Serial | 10–13 | uint32 |
| Hardware version | 14–15 | |
| Firmware version | 16–17 | |
| Thermistor | 28–29 | word 14 |
| T_fpa | 30–31 | word 15 |
| VGSK | 36–37 | word 18 |
| Frame counter | 52–53 | word 26 |

## 6. Stream behaviour and frame synchronisation

EP 0x81 carries a continuous byte stream with no USB-level framing, so the host must find frame boundaries itself.

**Synchronisation rule we use:**
1. Search for the 8-byte marker.
2. Take 221,696 bytes from it.
3. Accept the frame if the marker does **not** appear again inside those bytes.

Because pixels are 12-bit, a pixel's high byte is at most `0x0F`, so the marker cannot occur in pixel data. A second marker inside the window therefore means the frame was cut short, and it is discarded.

**Don't validate a frame by what follows it.** At full rate the next frame's marker follows immediately. Below full rate the camera sends frames in **back-to-back pairs**, often followed by **11,776 bytes of padding**, with short filler transfers of about 2.5 KB between bursts. A rule that requires the next marker right after a frame wrongly rejects good frames.

**Use small bulk reads (≤ 64 KB, with 3–4 in flight).** 221,696 = 433 × 512 is an exact multiple of the packet size, so the camera never sends a short packet and a read completes only when its buffer is full. With 256 KB reads, about one read in six delivered two frames at once, and a consumer that keeps only the latest frame silently lost about 15% of them. With 64 KB reads, every sensor frame is received (262 of 262 over 10 s).

## 7. Frame rate

| Fact | Evidence |
|---|---|
| The sensor runs at **25.98 fps** (38.49 ms period), fixed | Slope of frame counter (word 26) against host time, at every setting tested |
| Word 13 sets the **transmit** rate. Values 1–24 decimate; ≥ 25 (tested to 255) sends every frame. | Counter advances at 25.98 fps whatever the setting; received frames track the setting |
| Temperatures don't depend on the transmit rate | Same static scene: 18.62 °C at 25, 15 and 9 fps; 18.56 °C at 5 fps |
| No known way to run the sensor faster | Word 13 is capped; word 28 changes signal level, not timing (§4). Sensor timing is presumably fixed in firmware or FPGA. |

"25 fps" is a nominal label. A host that times frames correctly will measure about 26 fps.

## 8. Factory calibration files

Each camera has a set of factory files, downloaded per serial number from `http://api.therm-app.com/mobileservice.svc/` (`SessionStart`, `GetFilesList`, `GetFile`, `SessionEnd`; JSON over HTTP POST). The app kept them in `/sdcard/ThermApp/<serial>/`. **The server no longer exists:** both `api.therm-app.com` and `therm-app.com` now serve a parked-domain redirect. Existing copies on old phones are the only source, so preserve them.

| File | Contents (format 1: little-endian float32 maps, 384×288 = 442,368 B) |
|---|---|
| `0.bin` | 152 B. int16 `versionFormat` (0 = float64 maps, 1 = float32, 2 = 640×480 float32), int16 thermal-calibration flag, int16 device type (2 = TH). A 66-byte text field. float32[18–37] holds TH parameters: thermistor polynomial, LOW/MED/HIGH switching thresholds and transient model constants. |
| `1.bin` | Bad-pixel map: 1.0 = good, 0.0 = bad (55 on our unit) |
| `2.bin` | NUC coefficient × T_fpa |
| `3.bin` | × T_fpa² |
| `4.bin` | × T_fpa · p |
| `5.bin` | × p (linear) |
| `6.bin` | constant offset |
| `7.bin` | × p² |
| `8.bin` | × VGSK |
| `9.bin` | × VGSK² |
| `10.bin` | × VGSK · p |
| `11.bin` | 104 B. 32-word factory configuration block (a frame-header snapshot), then: int16 VGSK min, int16 VGSK max, float32 `adrTarget` at byte 68, three float32 (unused at 0), five float32 "DistParam" (piecewise-linear output remap, TH only) |
| `FilesList.json` | Manifest of names and lengths, used by the app to check completeness |
| TH models only | `2a…22c.bin`: three extra calibration sets (LOW/MED/HIGH ranges), plus delta-T and transient-offset maps, and `11a–c.bin` |

When loading `11.bin`, the SDK copies words 0–31 into the configuration **except word 13**. For format 2 it forces word 13 to 2500.

## 9. Image pipeline: raw counts to temperature

For each pixel *i*, with *p* = raw signed pixel value, *T* = T_fpa (header word 15) and *V* = VGSK (header word 18). This is the non-TH branch of the RenderScript kernel `root()` in `thermappsdk_ipn.bc`:

```
out[i] = offset[i]
       + T·tfpa[i] + T²·tfpa_sq[i] + T·p·tfpa_X_pix[i]
       + p·linear[i] + p²·square[i]
       + V·vgsk[i] + V²·vgsk_sq[i] + V·p·vgsk_X_pix[i]
       → truncated to int32
```

**`out` is in hundredths of a degree Celsius.** ThermAppPlus converts it as `out / 100 × scale + offset`: scale 1 and offset 0 for °C, 1.8 and 32 for °F, 1 and 273.15 for K (`MainActivity.b()`). This was verified against known temperatures with our camera.

The TH-model branch adds three things:
- a thermography path selected by a `Thermal` flag;
- a `Comp_en`-gated term, `DeltaT × delta_t_therm_tfpa[i] + transient_offset[i]`, for warm-up compensation;
- a piecewise-linear remap using DistParam1–5.

After the NUC:
1. **Bad pixels** (zero in `1.bin`) are replaced from neighbours. We use the median of the good pixels in the 5×5 neighbourhood.
2. **Emissivity** is optional. ThermAppPlus applies a Stefan–Boltzmann correction using emissivity and a background temperature, skipped at emissivity 1.0. Not implemented by us.
3. **Display:** AGC (percentile limits) followed by a 256-entry palette. ThermAppPlus's palette XML files store colours as `#BBGGRR`.

Our additions beyond the original app:
- **Dark-frame (flat-field) correction:** average N frames of a uniform cover, subtract the map minus its own mean. This removes fixed-pattern offsets and gradients without shifting the absolute level. ThermAppPlus had a similar lens-cap "background noise" routine.
- An optional temporal noise filter.

## 10. The VGSK bias loop

The NUC polynomial is only valid at the operating point Opgal's software holds the sensor at. On a fixed scene, readings peak near that point and fall by several °C when VGSK is about 20 steps away from it. The loop is in native `Func1` (`libipthermapp.so`, 448 bytes of Thumb-2). Disassembled, it does the following:

1. Histogram every 16-bit word from the start of the frame (**header included**) through the last pixel. Each word is masked to 12 bits and binned as `value >> 4`, giving 256 bins of 16 counts.
2. Compute `com` = mean bin (centre of mass).
3. Compute `target = trunc(adrTarget × 256)`. The constant 256.0 is in the literal pool, and adrTarget = 0.25 gives bin 64, a raw mean of about 1024.
4. If `|target − com| > 7`, set `next = trunc(V + (target − com) / 7)`. The constant 1/7 is in the literal pool.
5. Apply `next` only if `vgskMin < next < vgskMax` (strictly; limits from `11.bin`, set via `Func6`). Otherwise keep V.
6. Repeat every frame, applied to the commanded value, without waiting for the camera to report the change.

For 640×480 models `Func1` replaces the limits with 1392 and 2949. Inside the ±7-bin deadband readings can differ by a few tenths of a degree; this is inherent to the original design.

## 11. What is in Opgal's native libraries

The APK ships only **32-bit ARM** (`armeabi-v7a`) native code. This is the main reason the original app fails on 64-bit-only phones.

**`libusbthermapp.so` (88 KB)** is stock libusb plus JNI glue:
- `initUSB(fd)`
- `SendConfigurationHeader(bytes)`, a bulk OUT
- `GetNextFrame(buf)`, async bulk IN with frame assembly
- `CloseUSB()`

**`libipthermapp.so` (18 KB):**

| Function | Status |
|---|---|
| `Func1` | VGSK loop (§10). Fully decoded. |
| `Func2` | Bad-pixel replacement. Not decoded; replaced with our own. |
| `Func3` | **Stub: returns 0.** The SDK's HPF/AGC call does nothing in this build; ThermAppPlus did its own display processing. |
| `Func6` | Stores VGSK min, max and target in globals |
| `Func7` / `Func8` / `Func9` | One-instruction get/set of globals `frame_rate` and `version_format`. Not called from Java and not used by other native code, so not a frame-rate control. |
| `CreateHistogramRaw`, `GetCenterOfMass` | Helpers for `Func1` |

**RenderScript:** `thermappsdk_ipn.bc` holds the NUC (§9) and `thermappsdk_ipd.bc` the palette/LUT display kernel. Both are LLVM bitcode that a current LLVM can read.

## 12. Experiment log

All tests were run on serial 215324084 at room temperature, with the camera viewing a static indoor scene.

| # | Experiment | Result |
|---|---|---|
| 1 | Send `11.bin` configuration verbatim (VGSK 1475) | Raw signal clipped near floor (~75 counts); image unusable. VGSK must be servoed. |
| 2 | Step VGSK 1250–1650 | Raw level moves ~24 counts per step above ~1475; ADC saturates at 4095 |
| 3 | NUC output vs VGSK, same scene | Peaks at ~1520–1530 (17.4 °C); 10.7 °C at 1500, 12.7 °C at 1540, 5.5 °C at 1550 |
| 4 | Word 13 = 1…255 | Received rate tracks the setting up to 25. The sensor counter always advances at 25.98 fps. |
| 5 | Temperature vs word 13 | Within 0.06 °C from 5 to 25 fps |
| 6 | Stream shape below full rate | Frame pairs, 11,776 B padding, ~2.5 KB filler transfers |
| 7 | Read size 256 KB vs 64 KB | 256 KB: ~15% of frames arrive paired; 64 KB: 262/262 received |
| 8 | Header echo with factory vs SDK configuration | Classified each word as echoed, live, camera-supplied or read-only (§4) |
| 9 | Word 28 = 80 vs 250 | Sensor rate unchanged (25.97 vs 25.98); raw mean 2214 vs 855; temperature invalid at 80 |
| 10 | Absolute accuracy | °C = NUC/100 agrees with known temperatures (user check) with the VGSK loop ported exactly |

## 13. Open questions

- **Words 16, 17 and 19–24:** probably AD5628 DAC channels (bias voltages). Their exact roles and safe ranges are unknown.
- **Word 28:** what physical parameter it sets. It is writable and changes signal gain or level, but its meaning is unknown.
- **Words 22, 27 and 30:** always 0, echoed. Words 29 and 31: read-only, purpose unknown.
- **Word 4:** other modes. Pidbip's comment hints at a test pattern; untested.
- **The 448-byte trailer:** all `0xFF` here. It may carry data on other models.
- **T_fpa and thermistor in °C:** only Pidbip's experimental T_fpa formula exists.
- **TH and 640×480 models:** described from SDK code only; untested.
- **Sensor timing:** no way found to change it. It may be fixed in firmware; export rules for thermal cameras are one possible reason, but that is speculation.

## 14. Safety notes for experimenters

- The camera is no longer sold, and its calibration server is gone. Treat both the hardware and the `/sdcard/ThermApp/<serial>/` files as irreplaceable, and back up the files first.
- Words 16–24 appear to set detector bias voltages. Don't sweep them outside values Opgal's software is known to send. The exception is VGSK (word 18) within the `11.bin` limits, which the SDK itself does.
- Word 28: only 80 and 250 have been observed in Opgal's software. Any other value is untested.
- Every setting here is volatile: the camera needs the block re-sent continuously, so unplugging restores defaults. Nothing has ever been written to non-volatile memory.

## 15. References

- Pidbip, *ThermAppCam*, GPLv3, 2015–16: https://github.com/Pidbip/ThermAppCam
- EFraim, fork of the above: https://github.com/EFraim/ThermAppCam
- Hacks4ROS, *h4r_thermapp_camera* (ROS Indigo node, 2015): https://github.com/Hacks4ROS/h4r_thermapp_camera
- oil3, *therm-app-mac* (macOS, 2025): https://github.com/oil3/therm-app-mac
- EEVblog forum thread, "Opgal Therm-App – first smartphone thermal imager to ship": https://www.eevblog.com/forum/thermal-imaging/opgal-therm-app-first-smartphone-thermal-imager-to-ship/
- Tools: jadx 1.5.1, LLVM via llvmlite, Capstone, pyelftools, libusb/pyusb, Chrome WebUSB.

Opgal's decompiled code isn't reproduced here: this document describes its behaviour, constants and algorithms only.
