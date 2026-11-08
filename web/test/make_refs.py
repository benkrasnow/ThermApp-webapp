"""Write float64-computed NUC references for the saved prototype captures (web/test/ref_*.f32)."""
import os, sys
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "prototype"))
from thermapp_usb import Frame

cal = os.path.join(HERE, "..", "..", "calibration", "215324084")
L = lambda n: np.fromfile(os.path.join(cal, n), "<f4").reshape(288, 384).astype(np.float64)
tf, tfsq, tfx, lin, off, sq, vg, vgsq, vgx = [L("%d.bin" % i) for i in (2, 3, 4, 5, 6, 7, 8, 9, 10)]
for name in ("vgsk_1520", "vgsk_1560", "frame_0019"):
    f = Frame(open(os.path.join(HERE, "..", "..", "prototype", "captures", name + ".raw"), "rb").read())
    p = f.pixels.astype(np.float64); t, v = float(f.tfpa), float(f.vgsk)
    out = off + t*tf + t*t*tfsq + t*p*tfx + p*lin + p*p*sq + v*vg + v*v*vgsq + v*p*vgx
    out.astype("<f4").tofile(os.path.join(HERE, "ref_%s.f32" % name))
    med = np.median(f.pixels[8:-8:2, 8:-8:2])
    print(name, "tfpa", f.tfpa, "vgsk", f.vgsk, "nuc mean %.3f" % out.mean(), "median", med)
