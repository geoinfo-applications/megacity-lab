"""National 25 m land-cover tiles on the national tile grid, from swissTLM3D.

Classes: 0 open, 1 water, 2 forest, 3 rock/glacier. Rivers without a polygon are burned from their centre lines as class 4.
Output: <out>/cover_<c>_<r>.png, one 8-bit grey PNG per national tile; index tile set is whatever exists.
OBJEKTART names are read from GDB_Items at run time (the integers are ESRI subtypes with no field domain).

usage: build_cover.py <tlm.gdb.zip> <out dir>
"""
import os
import re
import sys
import time

import numpy as np
from osgeo import gdal, ogr, osr

gdal.UseExceptions()
ogr.UseExceptions()
gdal.SetConfigOption("OGR_ORGANIZE_POLYGONS", "ONLY_CCW")

E0, N0, T, COLS, ROWS, N = 2480000, 1300000, 25600, 14, 9, 1024
OPEN, WATER, FOREST, ROCK, RIVER = 0, 1, 2, 3, 4
COVER = {
    "Stehende Gewaesser": WATER, "Fliessgewaesser": WATER,
    "Wald": FOREST, "Gebueschwald": FOREST, "Wald offen": FOREST, "Gehoelzflaeche": FOREST,
    "Fels": ROCK, "Fels locker": ROCK, "Gletscher": ROCK, "Schneefeld Toteis": ROCK,
}
SUBTYPE = re.compile(r"<SubtypeName>(.*?)</SubtypeName><SubtypeCode>(\d+)</SubtypeCode>")


def subtype_table(source, wanted):
    items = source.GetLayerByName("GDB_Items")
    for item in items:
        if item.GetField("Name") == wanted:
            return {int(code): label for label, code in SUBTYPE.findall(item.GetField("Definition"))}
    raise SystemExit(f"no subtype table for {wanted}")


def main():
    zip_path, out = sys.argv[1], sys.argv[2]
    os.makedirs(out, exist_ok=True)
    source = ogr.Open(zip_path if zip_path.endswith(".gdb") else f"/vsizip/{zip_path}")
    if source is None or source.GetLayerByName("TLM_BODENBEDECKUNG") is None:
        names = gdal.ReadDir(f"/vsizip/{zip_path}")
        source = ogr.Open(f"/vsizip/{zip_path}/{[n for n in names if n.endswith('.gdb')][0]}")
    spatial = osr.SpatialReference()
    spatial.ImportFromEPSG(2056)
    w, h = COLS * N, ROWS * N
    cell = T / N
    driver = gdal.GetDriverByName("MEM")
    target = driver.Create("", w, h, 1, gdal.GDT_Byte)
    target.SetGeoTransform((E0, cell, 0, N0, 0, -cell))
    target.SetProjection(spatial.ExportToWkt())

    table = subtype_table(source, "TLM_BODENBEDECKUNG")
    print("Bodenbedeckung names:", sorted(set(table.values())), flush=True)
    codes = {}
    for code, label in table.items():
        if label in COVER:
            codes.setdefault(COVER[label], []).append(code)
    layer = source.GetLayerByName("TLM_BODENBEDECKUNG")
    # Order matters: forest first so water and rock overwrite it where polygons touch.
    for value in (FOREST, ROCK, WATER):
        t0 = time.time()
        layer.SetAttributeFilter(f"OBJEKTART IN ({','.join(map(str, codes[value]))})")
        print(f"class {value}: {layer.GetFeatureCount()} polygons", flush=True)
        gdal.RasterizeLayer(target, [1], layer, burn_values=[value], options=["ALL_TOUCHED=FALSE"])
        print(f"class {value}: {time.time() - t0:.0f} s", flush=True)
    layer.SetAttributeFilter(None)

    rivers = source.GetLayerByName("TLM_FLIESSGEWAESSER")
    if rivers is not None:
        t0 = time.time()
        river_mem = driver.Create("", w, h, 1, gdal.GDT_Byte)
        river_mem.SetGeoTransform((E0, cell, 0, N0, 0, -cell))
        river_mem.SetProjection(spatial.ExportToWkt())
        rivers.ResetReading()
        gdal.RasterizeLayer(river_mem, [1], rivers, burn_values=[1], options=["ALL_TOUCHED=TRUE"])
        print(f"river lines: {time.time() - t0:.0f} s", flush=True)
        line = river_mem.GetRasterBand(1).ReadAsArray()
    else:
        print("no TLM_FLIESSGEWAESSER layer", flush=True)
        line = None
    arr = target.GetRasterBand(1).ReadAsArray()
    if line is not None:
        arr[(line > 0) & (arr != WATER)] = RIVER
    png = gdal.GetDriverByName("PNG")
    for r in range(ROWS):
        for c in range(COLS):
            tile = arr[r * N:(r + 1) * N, c * N:(c + 1) * N]
            if not tile.any():
                continue
            mem = driver.Create("", N, N, 1, gdal.GDT_Byte)
            mem.GetRasterBand(1).WriteArray(tile)
            png.CreateCopy(f"{out}/cover_{c}_{r}.png", mem, options=["ZLEVEL=9"])
            aux = f"{out}/cover_{c}_{r}.png.aux.xml"
            if os.path.exists(aux):
                os.remove(aux)
    print("shares:", {name: round(float((arr == v).mean()), 4) for name, v in dict(open=OPEN, water=WATER, forest=FOREST, rock=ROCK, river=RIVER).items()}, flush=True)


if __name__ == "__main__":
    main()
