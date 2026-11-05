"""National store: site/nat/{dem_c_r.dem.png, img_c_r.jpg, index.json, overview.jpg, names.json}.

usage: build_national.py <data/nat> <data/names> <site/nat>
"""
import csv
import json
import os
import subprocess
import sys
from concurrent.futures import ProcessPoolExecutor

import numpy as np
from osgeo import gdal

gdal.UseExceptions()
HERE = os.path.dirname(os.path.abspath(__file__))
E0, N0, T, COLS, ROWS, N = 2480000, 1300000, 25600, 14, 9, 1024
OVERVIEW_PX = 112  # per tile in the overview mosaic


def tile(args):
    src, out, c, r = args
    key = f"{c}_{r}"
    png = gdal.Open(f"{src}/img_{key}.png")
    rgba = png.ReadAsArray()
    alpha = rgba[3] if rgba.shape[0] == 4 else np.full(rgba.shape[1:], 255, np.uint8)
    coverage = float((alpha > 0).mean())
    dem_ds = gdal.Open(f"{src}/dem_{key}.tif")
    dem = dem_ds.GetRasterBand(1).ReadAsArray()
    dem_ds = None
    valid = float((dem < 6000).mean())
    if valid < 0.02:
        return key, None
    if not os.path.exists(f"{out}/dem_{key}.dem.png"):
        subprocess.run([sys.executable, "-I", os.path.join(HERE, "encode_dem.py"), f"{src}/dem_{key}.tif", f"{out}/dem_{key}"], check=True,
                       stdout=subprocess.DEVNULL)
        os.remove(f"{out}/dem_{key}.json")
    has_img = coverage > 0.01
    if has_img and not os.path.exists(f"{out}/img_{key}.jpg"):
        # Fill transparent areas (outside Switzerland) with a neutral grey before JPEG.
        rgb = rgba[:3].astype(np.float32)
        a = (alpha / 255.0)[None]
        rgb = rgb * a + np.array([107, 111, 102], np.float32)[:, None, None] * (1 - a)
        mem = gdal.GetDriverByName("MEM").Create("", N, N, 3, gdal.GDT_Byte)
        for i in range(3):
            mem.GetRasterBand(i + 1).WriteArray(np.clip(rgb[i], 0, 255).astype(np.uint8))
        gdal.GetDriverByName("JPEG").CreateCopy(f"{out}/img_{key}.jpg", mem, options=["QUALITY=78"])
        if os.path.exists(f"{out}/img_{key}.jpg.aux.xml"):
            os.remove(f"{out}/img_{key}.jpg.aux.xml")
    # Overview pixels: imagery where present, else a hillshade-ish grey from the DEM.
    small_ds = gdal.Translate("", png, format="MEM", width=OVERVIEW_PX, height=OVERVIEW_PX, resampleAlg="average")
    small = small_ds.ReadAsArray()
    small_ds = None
    return key, {"img": has_img, "coverage": round(coverage, 3), "overview": small.tolist()}


def names(src):
    places = []

    def add(name, e, n, kind, importance, z=None):
        entry = [name, int(float(e)), int(float(n)), kind, int(importance)]
        if z is not None:
            entry.append(int(round(z)))  # official height, for peak labels
        places.append(entry)

    pop_rank = {"> 100000": 9800, "50000 bis 100000": 9500, "10000 bis 49999": 9000, "2000 bis 9999": 7000,
                "1000 bis 1999": 5500, "100 bis 999": 4200, "< 100": 1800, "50 bis 99": 1800, "20 bis 49": 1500, "< 20": 1200}
    with open(f"{src}/swissNAMES3D_PKT.csv", encoding="utf-8-sig") as f:
        for r in csv.DictReader(f, delimiter=";"):
            kind = r["OBJEKTART"]
            z = float(r["Z"] or 0)
            if kind == "Ort":
                add(r["NAME"], r["E"], r["N"], "place", pop_rank.get(r["EINWOHNERKATEGORIE"], 1500))
            elif kind == "Hauptgipfel":
                add(r["NAME"], r["E"], r["N"], "peak", 2500 + z, z)
            elif kind in ("Alpiner Gipfel", "Gipfel"):
                add(r["NAME"], r["E"], r["N"], "peak", 800 + z / 2, z)
            elif kind in ("Pass", "Strassenpass"):
                add(r["NAME"], r["E"], r["N"], "pass", 3200 if kind == "Strassenpass" else 1500)
    with open(f"{src}/swissNAMES3D_PLY.csv", encoding="utf-8-sig") as f:
        for r in csv.DictReader(f, delimiter=";"):
            kind = r["OBJEKTART"]
            rank = {"See": ("lake", 4500), "Tal": ("valley", 2600), "Gletscher": ("glacier", 3000), "Graben": ("torrent", 600)}.get(kind)
            if rank:
                add(r["NAME"], r["E"], r["N"], *rank)
    seen = set()
    out = []
    for p in sorted(places, key=lambda p: -p[4]):
        key = (p[0], p[3], p[1] // 2000, p[2] // 2000)
        if key in seen:
            continue
        seen.add(key)
        out.append(p)
    return out


def main():
    src, names_src, out = sys.argv[1:4]
    os.makedirs(out, exist_ok=True)
    jobs = [(src, out, c, r) for r in range(ROWS) for c in range(COLS)]
    tiles = {}
    mosaic = np.zeros((ROWS * OVERVIEW_PX, COLS * OVERVIEW_PX, 3), np.float32)
    with ProcessPoolExecutor(8) as ex:
        for key, info in ex.map(tile, jobs):
            if info is None:
                continue
            c, r = (int(v) for v in key.split("_"))
            ov = np.array(info.pop("overview"), np.float32)
            rgb, alpha = ov[:3], (ov[3] / 255.0 if ov.shape[0] == 4 else np.ones(ov.shape[1:]))
            block = np.transpose(rgb * alpha + 26 * (1 - alpha), (1, 2, 0))
            mosaic[r * OVERVIEW_PX:(r + 1) * OVERVIEW_PX, c * OVERVIEW_PX:(c + 1) * OVERVIEW_PX] = block
            tiles[key] = info
    mem = gdal.GetDriverByName("MEM").Create("", mosaic.shape[1], mosaic.shape[0], 3, gdal.GDT_Byte)
    for i in range(3):
        mem.GetRasterBand(i + 1).WriteArray(np.clip(mosaic[:, :, i] * 1.15 + 6, 0, 255).astype(np.uint8))
    gdal.GetDriverByName("JPEG").CreateCopy(f"{out}/overview.jpg", mem, options=["QUALITY=85"])
    for extra in ("overview.jpg.aux.xml",):
        if os.path.exists(f"{out}/{extra}"):
            os.remove(f"{out}/{extra}")
    index = {"e0": E0, "n0": N0, "tile": T, "cells": N, "cols": COLS, "rows": ROWS, "tiles": tiles}
    with open(f"{out}/index.json", "w") as f:
        json.dump(index, f)
    with open(f"{out}/names.json", "w") as f:
        json.dump({"places": names(names_src)}, f, ensure_ascii=False, separators=(",", ":"))
    print("tiles", len(tiles), "with imagery", sum(1 for t in tiles.values() if t["img"]))


if __name__ == "__main__":
    main()
