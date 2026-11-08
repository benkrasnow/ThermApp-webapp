# Therm-App factory calibration — serial 215324084

> The full protocol and calibration write-up is in [docs/therm-app-protocol.md](../docs/therm-app-protocol.md). These notes are the working record for this camera.

Pulled on 2026-11-08 from the Pixel 6 (`/sdcard/ThermApp/215324084/`, files dated 2022-12-29) with `adb pull`. MD5 checksums matched the phone. **Keep a backup copy elsewhere.** Opgal's server is gone, so these files can't be downloaded again.

## Camera identity (from the files)

- `versionFormat = 1`: 384×288, coefficient maps stored as little-endian **float32**, each 442,368 bytes (384·288·4).
- Device type is `1`, so this is **not a TH (thermography) unit**. There are no `2a…22c` sets. The SDK runs the non-TH NUC path, and the LOW/MED/HIGH auto-range and transient logic do not apply.
- The bad-pixel map has 55 bad pixels. `Factory.1.bin` is absent, which means bad-pixel repair was never run.

## Files

| File | SDK role | Notes |
|---|---|---|
| `0.bin` | Device parameters | 152 B. Three int16 values: versionFormat=1, thermal calib flag=1, device type=1. A 66-byte text field holds `060416` (a date?). float32[18..37] hold the TH model parameters, unused on this unit. |
| `1.bin` | Bad-pixel map | 1.0 = good, 0.0 = bad |
| `2.bin` | `tfpa_nuc` | × Tfpa |
| `3.bin` | `tfpa_sq_nuc` | × Tfpa² |
| `4.bin` | `tfpa_X_pix_nuc` | × Tfpa·p |
| `5.bin` | `linear_nuc` | × p |
| `6.bin` | `offset_nuc` | constant term |
| `7.bin` | `square_nuc` | × p² |
| `8.bin` | `vgsk_nuc` | × Vgsk |
| `9.bin` | `vgsk_sq_nuc` | × Vgsk² |
| `10.bin` | `vgsk_X_pix_nuc` | × Vgsk·p |
| `11.bin` | Camera configuration header | 104 B. Holds 32 × int16 words that are sent to the camera, followed by the AGC limits (min 1300, max 1580), adrTarget = 0.25, and Dist params (all 0). |
| `FilesList.json` | Manifest | The old app uses it to check that the download is complete. |

## NUC formula (non-TH path)

Recovered by disassembling the RenderScript kernel `thermappsdk_ipn.bc` from the original app (the app and its decompiled code are not part of this repository). For pixel `i`:

```
p     = int16 raw pixel  (frame bytes 64 + 2·i, little-endian, signed)
Tfpa  = frame header word 15   (uint16)
Vgsk  = frame header word 18   (uint16)

out[i] = offset[i]
       + Tfpa·tfpa[i] + Tfpa²·tfpa_sq[i] + Tfpa·p·tfpa_X_pix[i]
       + p·linear[i]  + p²·square[i]
       + Vgsk·vgsk[i] + Vgsk²·vgsk_sq[i] + Vgsk·p·vgsk_X_pix[i]
→ truncated to int32
```

The SDK's processing chain after that:
1. Bad pixels (where `1.bin` is 0) are replaced from their neighbours (native `Func2`).
2. The value is shifted by −27767 and clamped to int16.
3. The HPF, histogram AGC and LUT stage runs (`Func3`).
4. The palette is applied.

All coefficients at bad pixels are 0.

## Temperature scale

The NUC output is in **hundredths of a degree Celsius**. ThermAppPlus's `MainActivity.b()` converts it as `value / 100 × scale + offset`: scale 1 and offset 0 for °C, 1.8 and 32 for °F, 1 and 273.15 for K. ThermAppPlus can also apply an emissivity/reflected-temperature correction, but it is skipped at the default emissivity of 1.0.

## VGSK bias loop (native `Func1`, from `libipthermapp.so`)

The NUC is only valid at the operating point the SDK holds the sensor at. On a fixed scene, readings peak around the target and drop by several °C when the bias is ±20 DAC steps off. The SDK's loop, disassembled:

1. Histogram every 16-bit word from the start of the frame (header included) through the last pixel. Values are masked to 12 bits and binned into 256 bins of 16 counts.
2. Compute `com` as the mean bin. The target is `trunc(adrTarget × 256)`, which is 64 for this camera (raw mean ≈ 1024).
3. If `|target − com| > 7` bins, set `next = trunc(V + (target − com) / 7)`. Apply it only if `vgskMin < next < vgskMax`.
4. Repeat every frame, on the commanded value (config word 18).

`Func6` stores the min, max and target, which come from `11.bin`. On 640×480 models `Func1` overrides the limits to 1392 and 2949. Ported in `web/js/processing.js` (`VgskController`).

## Frame rate (config word 13)

The sensor always runs at **25.98 fps** (38.49 ms period), whatever word 13 is set to. **Word 13 sets how many frames per second the camera transmits.** Below 25 it skips frames, and 25 or more (tested up to 255) sends every frame, so "25" is a nominal label for full rate. Going faster would need different sensor readout timing (possibly words 28–29, which are unidentified and untested), and the factory calibration was made at this timing.

Frame header **word 26 is the sensor's frame counter**. It advances at 25.98 fps even when frames aren't sent, so gaps at full rate measure frames truly lost between camera and host. Temperatures are unchanged across transmit rates, within 0.06 °C on a static scene.

Below 25 fps the stream changes shape. Frames arrive in back-to-back pairs, some are followed by 11,776 bytes of padding instead of the next magic, and short filler reads of about 2.5 KB arrive between bursts. So validate each frame by its own contents rather than by what follows it. Pixels are 12-bit, so the 8-byte magic `A5A5A5A5 A5A5D5A5` can only appear at a frame start; a second magic inside a 221,696-byte window means the frame was cut short.

## `11.bin` header words, compared with the SDK defaults in `p.java`

```
11.bin : A5A5 A5A5 A5A5 A5D5 | 2 -27212 3285 4 118 | 288 384 288 384 | 25 30412 14603 | 1884 2949 1475 2048 2949 2949 0 1392 2949 | 64 12052 0 250 2 0 0
default: A5A5 A5A5 A5A5 A5D5 | 2 0 0 0 0           | 288 384 288 384 | 25 0 0         | 1884 2949 1524 2048 2949 2949 0 1392 2949 | 64 0 0 80 3 0 4095
```

The SDK copies words 0–31 into the header it sends, but **skips word 13**: the loop in `ThermAppAPI.b()` jumps index 13. Word 18 (VGSK DAC) is 1475 here, against the default 1524. The SDK then adjusts word 18 live using the AGC min/max.
