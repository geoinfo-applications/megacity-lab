"""National 25 m tiles: swissALTIRegio DEM + SWISSIMAGE (WMS) per 1024x1024 tile, LV95.

Grid: E0=2480000, N0=1300000, tile=25600 m, 14 cols x 9 rows. Tile (c, r) covers
E0+c*T .. E0+(c+1)*T, N0-(r+1)*T .. N0-r*T.
usage: fetch_national.py <outdir>
"""
import os
import sys
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from osgeo import gdal

gdal.UseExceptions()
for k, v in {"GDAL_HTTP_MULTIPLEX": "YES", "GDAL_HTTP_VERSION": "2", "GDAL_DISABLE_READDIR_ON_OPEN": "EMPTY_DIR", "VSI_CACHE": "TRUE"}.items():
    gdal.SetConfigOption(k, v)

SRC = "/vsicurl/https://data.geo.admin.ch/ch.swisstopo.swissaltiregio/swissaltiregio/swissaltiregio_2056_5728.tif"
E0, N0, T, COLS, ROWS, N = 2480000, 1300000, 25600, 14, 9, 1024


def tile(out, c, r):
    x0, x1 = E0 + c * T, E0 + (c + 1) * T
    y0, y1 = N0 - (r + 1) * T, N0 - r * T
    img = f"{out}/img_{c}_{r}.png"
    if not os.path.exists(img):
        q = urllib.parse.urlencode({
            "SERVICE": "WMS", "VERSION": "1.3.0", "REQUEST": "GetMap", "LAYERS": "ch.swisstopo.swissimage", "STYLES": "",
            "CRS": "EPSG:2056", "FORMAT": "image/png", "TRANSPARENT": "TRUE", "BBOX": f"{x0},{y0},{x1},{y1}", "WIDTH": N, "HEIGHT": N,
        })
        urllib.request.urlretrieve("https://wms.geo.admin.ch/?" + q, img + ".part")
        os.rename(img + ".part", img)
    dem = f"{out}/dem_{c}_{r}.tif"
    if not os.path.exists(dem):
        gdal.Translate(dem + ".part.tif", SRC, projWin=[x0, y1, x1, y0], xRes=25, yRes=25, resampleAlg="average", outputType=gdal.GDT_Float32)
        os.rename(dem + ".part.tif", dem)
    return c, r


def main():
    out = sys.argv[1]
    os.makedirs(out, exist_ok=True)
    jobs = [(c, r) for r in range(ROWS) for c in range(COLS)]
    with ThreadPoolExecutor(8) as ex:
        for c, r in ex.map(lambda j: tile(out, *j), jobs):
            print("tile", c, r, flush=True)


if __name__ == "__main__":
    main()
