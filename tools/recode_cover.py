"""Re-encode cover PNGs with filter 0 on every row, so the page and node can read them with one inflate and no PNG filter code.
usage: recode_cover.py <dir>"""
import glob, struct, sys, zlib
import numpy as np
from osgeo import gdal
gdal.UseExceptions()
def chunk(k, d): return struct.pack(">I", len(d)) + k + d + struct.pack(">I", zlib.crc32(k + d) & 0xFFFFFFFF)
for f in glob.glob(sys.argv[1] + "/cover_*.png"):
    ds = gdal.Open(f); a = ds.GetRasterBand(1).ReadAsArray().astype(np.uint8); ds = None
    h, w = a.shape; rows = np.zeros((h, w + 1), np.uint8); rows[:, 1:] = a
    open(f, "wb").write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 0, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(rows.tobytes(), 9)) + chunk(b"IEND", b""))
