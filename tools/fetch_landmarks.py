"""Sharp terrain and imagery for landmark mountains: swissALTI3D and SWISSIMAGE tiles from swisstopo's open STAC, cut to site/landmarks."""
import concurrent.futures
import io
import json
import math
import pathlib
import sys
import urllib.request

import numpy as np
import rasterio
from PIL import Image
from rasterio.enums import Resampling

STAC = "https://data.geo.admin.ch/api/stac/v0.9/collections/{}/items?bbox={},{},{},{}&limit=100"
REGIONS = {"alpstein": (2739, 1230, 2751, 1240), "churfirsten": (2733, 1221, 2745, 1228)}
ROOT = pathlib.Path(__file__).resolve().parents[1]
DEM_M, IMAGE_M = 5, 2.5
Image.MAX_IMAGE_PIXELS = None


def wgs84(e, n):
    y, x = (e - 2600000) / 1e6, (n - 1200000) / 1e6
    lon = 2.6779094 + 4.728982 * y + 0.791484 * y * x + 0.1306 * y * x * x - 0.0436 * y ** 3
    lat = 16.9023892 + 3.238272 * x - 0.270978 * y * y - 0.002528 * x * x - 0.0447 * y * y * x - 0.014 * x ** 3
    return lon * 100 / 36, lat * 100 / 36


def latest_asset(collection, e, n, suffix):
    lon, lat = wgs84(e * 1000 + 500, n * 1000 + 500)
    request = urllib.request.Request(STAC.format(collection, lon - 1e-4, lat - 1e-4, lon + 1e-4, lat + 1e-4), headers={"User-Agent": "megacity-lab"})
    items = json.load(urllib.request.urlopen(request, timeout=60))["features"]
    best = None
    for item in items:
        if f"{e}-{n}" not in item["id"]:
            continue
        for key, asset in item["assets"].items():
            if suffix in key and (best is None or item["id"] > best[0]):
                best = (item["id"], asset["href"])
    return best[1] if best else None


def read_tile(url, cells, bands, resampling):
    with rasterio.open(url) as source:
        return source.read(bands, out_shape=(len(bands), cells, cells), resampling=resampling)


def fetch(collection, suffix, e, n, cells, bands, resampling):
    url = latest_asset(collection, e, n, suffix)
    return (e, n, read_tile(url, cells, bands, resampling)) if url else (e, n, None)


def mosaic(region, collection, suffix, metres, bands, resampling):
    e0, n0, e1, n1 = region
    cells = int(1000 / metres)
    canvas = np.zeros((len(bands), (n1 - n0) * cells, (e1 - e0) * cells), dtype=np.float32)
    jobs = [(e, n) for e in range(e0, e1) for n in range(n0, n1)]
    missing = 0
    with concurrent.futures.ThreadPoolExecutor(8) as pool:
        for e, n, tile in pool.map(lambda job: fetch(collection, suffix, job[0], job[1], cells, bands, resampling), jobs):
            if tile is None:
                missing += 1
                continue
            row = (n1 - 1 - n) * cells
            canvas[:, row:row + cells, (e - e0) * cells:(e - e0 + 1) * cells] = tile
    print(collection, "tiles", len(jobs), "missing", missing, flush=True)
    return canvas


def main():
    out = ROOT / "site" / "landmarks"
    out.mkdir(parents=True, exist_ok=True)
    index = json.loads((out / "index.json").read_text()) if (out / "index.json").exists() else {}
    for name, region in REGIONS.items():
        if len(sys.argv) > 1 and name not in sys.argv[1:]:
            continue
        dem = mosaic(region, "ch.swisstopo.swissalti3d", "_2_2056_5728.tif", DEM_M, [1], Resampling.bilinear)[0]
        image = mosaic(region, "ch.swisstopo.swissimage-dop10", "_2_2056.tif", IMAGE_M, [1, 2, 3], Resampling.average)
        dem.astype("<f4").tofile(out / f"{name}.bin")
        picture = np.clip(np.moveaxis(image, 0, 2), 0, 255).astype(np.uint8)
        Image.fromarray(picture).save(out / f"{name}.jpg", quality=88)
        e0, n0, e1, n1 = region
        index[name] = {"e0": e0 * 1000, "n0": n0 * 1000, "e1": e1 * 1000, "n1": n1 * 1000, "w": dem.shape[1], "h": dem.shape[0], "min": float(dem[dem > 0].min()), "max": float(dem.max())}
        (out / "index.json").write_text(json.dumps(index, indent=1))
        print(name, index[name], flush=True)


if __name__ == "__main__":
    main()
