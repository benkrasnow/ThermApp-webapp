"""Build ThermAppViewer.exe: one file with Python, libusb, palettes and the bundled calibration.

    .venv\\Scripts\\python prototype\\build_exe.py

Output: dist/ThermAppViewer/ (the .exe plus README and an empty calibration folder), zipped
as dist/ThermAppViewer.zip.
"""

import os
import shutil

import libusb
import PyInstaller.__main__

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
DIST = os.path.join(ROOT, "dist")
BUILD = os.path.join(ROOT, "build")
APP = os.path.join(DIST, "ThermAppViewer")
SEP = os.pathsep


def main():
    shutil.rmtree(APP, ignore_errors=True)
    args = [
        os.path.join(HERE, "viewer.py"),
        "--name", "ThermAppViewer",
        "--onefile",
        "--windowed",
        "--noconfirm",
        "--distpath", APP,
        "--workpath", BUILD,
        "--specpath", BUILD,
        "--paths", HERE,
        "--add-binary", libusb.dll._name + SEP + ".",
        "--add-data", os.path.join(HERE, "palettes") + SEP + "palettes",
    ]
    cal_root = os.path.join(ROOT, "calibration")
    for serial in sorted(os.listdir(cal_root)):
        folder = os.path.join(cal_root, serial)
        if os.path.isfile(os.path.join(folder, "11.bin")):
            args += ["--add-data", folder + SEP + os.path.join("calibration", serial)]
    PyInstaller.__main__.run(args)

    os.makedirs(os.path.join(APP, "calibration"), exist_ok=True)
    shutil.copy(os.path.join(HERE, "DIST_README.txt"), os.path.join(APP, "README.txt"))
    shutil.make_archive(APP, "zip", DIST, "ThermAppViewer")
    print("Built", os.path.join(APP, "ThermAppViewer.exe"))


if __name__ == "__main__":
    main()
