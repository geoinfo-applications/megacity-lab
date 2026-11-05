"""Small tiles for the distant terrain, so a first visit does not download every full tile within 96 km.

Writes <site/nat>/horizon/{dem_c_r.dem.png, img_c_r.jpg}: heights at 128 cells and imagery at 320 px per tile.
usage: build_horizon.py <data/nat> <site/nat>
"""
import json
import os
import subprocess
import sys

from osgeo import gdal

gdal.UseExceptions()
HERE = os.path.dirname(os.path.abspath(__file__))
HEIGHT_CELLS, IMAGE_PIXELS = 128, 320


def tile(sources, store, key, has_image):
    out = f"{store}/horizon"
    small_dem = f"{out}/dem_{key}.tif"
    gdal.Translate(small_dem, f"{sources}/dem_{key}.tif", width=HEIGHT_CELLS, height=HEIGHT_CELLS, resampleAlg="average")
    subprocess.run([sys.executable, "-I", os.path.join(HERE, "encode_dem.py"), small_dem, f"{out}/dem_{key}"], check=True, stdout=subprocess.DEVNULL)
    os.remove(f"{out}/dem_{key}.json")
    os.remove(small_dem)
    if has_image:
        gdal.Translate(f"{out}/img_{key}.jpg", f"{store}/img_{key}.jpg", format="JPEG", width=IMAGE_PIXELS, height=IMAGE_PIXELS,
                       resampleAlg="average", creationOptions=["QUALITY=72"])
        if os.path.exists(f"{out}/img_{key}.jpg.aux.xml"):
            os.remove(f"{out}/img_{key}.jpg.aux.xml")


def main():
    sources, store = sys.argv[1:3]
    os.makedirs(f"{store}/horizon", exist_ok=True)
    tiles = json.load(open(f"{store}/index.json"))["tiles"]
    for key, info in tiles.items():
        tile(sources, store, key, info["img"])
    print("horizon tiles", len(tiles), flush=True)


if __name__ == "__main__":
    main()
