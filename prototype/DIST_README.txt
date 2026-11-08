Therm-App Viewer for Windows
============================

A live viewer for the Opgal Therm-App thermal camera. No installation is needed. Copy
this folder anywhere and double-click ThermAppViewer.exe.

FIRST TIME ON A NEW COMPUTER: install the USB driver (once, needs admin)
  1. Plug in the Therm-App.
  2. Download Zadig from https://zadig.akeo.ie/ and run it.
  3. Choose Options > List All Devices, then select "USB2.0" with USB ID 1772 0002.
  4. Set the driver to WinUSB and click "Install Driver" (or "Replace Driver").

CALIBRATION
  The factory calibration for camera serial 215324084 is built in.
  For a different camera, copy that camera's folder from its old phone
  (/sdcard/ThermApp/<serial>/) into the "calibration" folder here, for example
  calibration\123456789\11.bin. The viewer picks the folder that matches the
  camera's serial number.

KEYS
  p / P     next / previous palette      e   local contrast on/off
  m / f     mirror / flip                n   factory correction on/off
  s         snapshot (PNG + raw frame)   r   record video on/off
  q / Esc   quit

Snapshots and videos are saved in the "media" folder next to the .exe.
The first launch can take a few seconds while Windows unpacks the app.

If Windows shows "Windows protected your PC", the app is just unsigned:
click "More info", then "Run anyway".
