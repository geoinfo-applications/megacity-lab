"""Encode a Float32 DEM GeoTIFF into the page's .dem format.

Heights are quantised to 0.1 m as uint16, run through a 2D Paeth-free predictor
(r = q - left - up + upleft, wrapping mod 2^16), split into low/high byte planes, stored as an 8-bit grey PNG of 2h rows (filter 0).
The browser parses IDAT itself and inflates with DecompressionStream('deflate'), so no canvas colour management touches it. Header is a JSON sidecar.

usage: encode_dem.py <in.tif> <out_prefix> [jpeg_in.tif jpeg_quality]
"""
import json
import struct
import sys
import zlib

import numpy as np
from osgeo import gdal

gdal.UseExceptions()


def encode(arr):
    q = np.clip(np.round(arr * 10), 0, 65535).astype(np.int64)
    r = q.copy()
    r[:, 1:] -= q[:, :-1]
    r[1:, :] -= q[:-1, :]
    r[1:, 1:] += q[:-1, :-1]
    r = (r % 65536).astype(np.uint16)
    b = r.tobytes()
    h, w = arr.shape
    planes = np.frombuffer(b, np.uint8).reshape(-1, 2).T.reshape(2 * h, w)
    rows = np.zeros((2 * h, w + 1), np.uint8)
    rows[:, 1:] = planes
    return png_gray8(w, 2 * h, zlib.compress(rows.tobytes(), 9))


def png_chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)


def png_gray8(w, h, idat):
    head = struct.pack(">IIBBBBB", w, h, 8, 0, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + png_chunk(b"IHDR", head) + png_chunk(b"IDAT", idat) + png_chunk(b"IEND", b"")


def main():
    src, prefix = sys.argv[1], sys.argv[2]
    ds = gdal.Open(src)
    band = ds.GetRasterBand(1)
    a = band.ReadAsArray().astype(np.float64)
    nodata = band.GetNoDataValue()
    if nodata is not None:
        a[a == nodata] = np.nan
    a[~np.isfinite(a)] = np.nan
    a[a > 6000] = np.nan
    fill = np.nanmin(a) if np.isfinite(np.nanmin(a)) else 0
    a = np.where(np.isnan(a), fill, a)
    gt = ds.GetGeoTransform()
    blob = encode(a)
    with open(prefix + ".dem.png", "wb") as f:
        f.write(blob)
    meta = {
        "w": ds.RasterXSize, "h": ds.RasterYSize, "x0": gt[0], "y1": gt[3], "cell": gt[1],
        "min": round(float(a.min()), 1), "max": round(float(a.max()), 1), "bytes": len(blob),
    }
    with open(prefix + ".json", "w") as f:
        json.dump(meta, f)
    print(json.dumps(meta))


if __name__ == "__main__":
    main()
