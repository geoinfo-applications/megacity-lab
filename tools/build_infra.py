"""Per-tile vectors: site/nat/infra_c_r.json, all from swissTLMRegio. Motorways and main roads without ramps, railways and
building centroids. Coordinates are integer metres relative to the tile's south-west corner.

usage: build_infra.py <swissTLMRegio.gdb> <site/nat>
"""
import json
import os
import sys

from osgeo import ogr

ogr.UseExceptions()
E0, N0, T = 2480000, 1300000, 25600
# Subtype codes from the geodatabase: 301 Autob_Ri, 302 Autobahn, 303 Autostr, 304 HauptStrAB4, 305 HauptStrAB6.
MOTORWAY_CLASSES = {301, 302, 303}
MAIN_ROAD_CLASSES = {304, 305}


def rectangle(x0, y0, x1, y1):
    ring = ogr.Geometry(ogr.wkbLinearRing)
    for x, y in ((x0, y0), (x1, y0), (x1, y1), (x0, y1), (x0, y0)):
        ring.AddPoint_2D(x, y)
    polygon = ogr.Geometry(ogr.wkbPolygon)
    polygon.AddGeometry(ring)
    return polygon


def lines(geometry):
    geometry = geometry.Clone()
    geometry.FlattenTo2D()
    kind = ogr.GT_Flatten(geometry.GetGeometryType())
    if kind == ogr.wkbLineString:
        return [geometry.GetPoints()]
    if kind in (ogr.wkbMultiLineString, ogr.wkbGeometryCollection):
        return [line for i in range(geometry.GetGeometryCount()) for line in lines(geometry.GetGeometryRef(i))]
    return []


def relative(points, x0, y0):
    return [[round(p[0] - x0), round(p[1] - y0)] for p in points]


def each_feature(layer, box, visit):
    layer.SetSpatialFilterRect(*map(float, box))
    layer.ResetReading()
    for feature in layer:
        geometry = feature.GetGeometryRef()
        if geometry is not None:
            visit(feature, geometry)
    layer.SetSpatialFilter(None)


def tile_vectors(layers, box):
    clip = rectangle(*box)
    x0, y0, x1, y1 = box
    out = {"main": [], "rail": [], "b": []}

    def add_road(feature, geometry):
        road_class = feature.GetField("OBJVAL")
        if road_class not in MOTORWAY_CLASSES | MAIN_ROAD_CLASSES or feature.GetField("UNDERCONST"):
            return
        for line in lines(geometry.Intersection(clip)):
            if len(line) > 1:
                out["main"].append({"motorway": road_class in MOTORWAY_CLASSES, "c": relative(line, x0, y0)})

    def add_rail(feature, geometry):
        for line in lines(geometry.Intersection(clip)):
            if len(line) > 1:
                out["rail"].append({"c": relative(line, x0, y0)})

    def add_building(feature, geometry):
        point = geometry.Centroid()
        if x0 <= point.GetX() < x1 and y0 <= point.GetY() < y1:
            out["b"] += [round(point.GetX() - x0), round(point.GetY() - y0)]

    each_feature(layers["roads"], box, add_road)
    each_feature(layers["rail"], box, add_rail)
    each_feature(layers["buildings"], box, add_building)
    return out


def main():
    regio_gdb, store = sys.argv[1:3]
    # Keep the dataset referenced: a layer outlives a garbage-collected dataset only as a dangling pointer.
    source = ogr.Open(regio_gdb)
    layers = {name: source.GetLayer(layer) for name, layer in
              (("roads", "TLMRegio_Road"), ("rail", "TLMRegio_Railway"), ("buildings", "TLMRegio_Building"))}
    index = json.load(open(f"{store}/index.json"))
    for key, info in index["tiles"].items():
        c, r = (int(v) for v in key.split("_"))
        out = tile_vectors(layers, (E0 + c * T, N0 - (r + 1) * T, E0 + (c + 1) * T, N0 - r * T))
        info["infra"] = any(out.values())
        if info["infra"]:
            with open(f"{store}/infra_{key}.json", "w") as handle:
                json.dump(out, handle, separators=(",", ":"), ensure_ascii=False)
            print(key, len(out["main"]), len(out["rail"]), len(out["b"]) // 2, flush=True)
    json.dump(index, open(f"{store}/index.json", "w"))


if __name__ == "__main__":
    main()
