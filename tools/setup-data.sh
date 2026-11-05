#!/bin/bash
# Builds everything the page loads from public Swiss federal data. Needs GDAL with Python bindings, curl and about 8 GB free.
set -euo pipefail
cd "$(dirname "$0")/.."

SOURCES=data/sources
python3 -m venv --system-site-packages .venv
.venv/bin/pip install --quiet -r requirements.txt
PY=".venv/bin/python -I"
export OGR_ORGANIZE_POLYGONS=ONLY_CCW

only_match() {
    local found
    found=$(find "$1" -type "$2" -name "$3" | head -1)
    [ -n "$found" ] || { echo "nothing named $3 in $1" >&2; exit 1; }
    echo "$found"
}

$PY tools/fetch_sources.py "$SOURCES"
$PY tools/fetch_national.py data/nat
NAMES_CSV=$(only_match "$SOURCES/names" f '*_PKT.csv')
TLM_REGIO=$(only_match "$SOURCES/tlmregio" d '*Product.gdb')
$PY tools/build_national.py data/nat "$(dirname "$NAMES_CSV")" site/nat
$PY tools/build_infra.py "$TLM_REGIO" site/nat
$PY tools/build_horizon.py data/nat site/nat
$PY tools/build_cover.py "$SOURCES/tlm3d.gdb.zip" site/cover
$PY tools/recode_cover.py site/cover
$PY tools/fetch_landmarks.py
echo "Done. Start with: python3 -I tools/serve.py site 8820"
