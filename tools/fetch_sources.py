"""Downloads the source datasets, newest STAC release of each, into <dir>. Resumes partial files.

usage: fetch_sources.py <dir>
"""
import json
import pathlib
import shutil
import subprocess
import sys
import urllib.request
import zipfile

STAC = "https://data.geo.admin.ch/api/stac/v0.9/collections/{}/items?limit=100"
STAC_SOURCES = {
    # GDAL only recognises the zipped geodatabase by this double extension.
    "tlm3d.gdb": ("ch.swisstopo.swisstlm3d", ".gdb.zip"),
    "tlmregio": ("ch.swisstopo.swisstlmregio", ".gdb.zip"),
    "names": ("ch.swisstopo.swissnames3d", ".csv.zip"),
}


def newest_asset(collection, suffix):
    url = STAC.format(collection)
    assets = []
    while url:
        request = urllib.request.Request(url, headers={"User-Agent": "megacity-lab"})
        page = json.load(urllib.request.urlopen(request, timeout=60))
        for item in page["features"]:
            assets += [(item["id"], asset["href"]) for key, asset in item["assets"].items() if key.endswith(suffix)]
        url = next((link["href"] for link in page.get("links", []) if link["rel"] == "next"), None)
    if not assets:
        raise SystemExit(f"no {suffix} asset in {collection}")
    return max(assets)[1]


def download(url, target):
    if target.exists():
        return
    partial = target.with_name(target.name + ".part")
    subprocess.run(["curl", "-fL", "--retry", "5", "--retry-all-errors", "-C", "-", "-o", str(partial), url], check=True)
    partial.rename(target)


def extract(bundle, member, folder):
    # swisstopo's archives are written on Windows: their member names separate folders with backslashes.
    parts = pathlib.PurePosixPath(member.filename.replace("\\", "/")).parts
    if member.is_dir() or not parts:
        return
    if ".." in parts or parts[0] == "/":
        raise SystemExit(f"unsafe path in archive: {member.filename}")
    target = folder.joinpath(*parts)
    target.parent.mkdir(parents=True, exist_ok=True)
    with bundle.open(member) as source, open(target, "wb") as sink:
        shutil.copyfileobj(source, sink)


def unpack(archive):
    folder = archive.with_suffix("")
    if not folder.exists():
        partial = folder.with_name(folder.name + ".part")
        with zipfile.ZipFile(archive) as bundle:
            for member in bundle.infolist():
                extract(bundle, member, partial)
        partial.rename(folder)
    return folder


def main():
    root = pathlib.Path(sys.argv[1])
    root.mkdir(parents=True, exist_ok=True)
    for name, (collection, suffix) in STAC_SOURCES.items():
        download(newest_asset(collection, suffix), root / f"{name}.zip")
    for name in ("tlmregio", "names"):
        print(name, unpack(root / f"{name}.zip"), flush=True)


if __name__ == "__main__":
    main()
