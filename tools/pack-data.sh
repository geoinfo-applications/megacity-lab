#!/bin/bash
# Packs the built tiles the page loads into one zip for a GitHub Release. Landmarks stay out: only the stills scripts use them.
set -euo pipefail
cd "$(dirname "$0")/../site"
python3 -I -m zipfile -c ../megacity-data.zip nat cover
ls -la ../megacity-data.zip
