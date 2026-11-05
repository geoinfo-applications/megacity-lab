#!/bin/bash
# Renders the social set into media/beauty. Needs the server on 8820. Then: python3 -I tools/frame_posts.py
cd "$(dirname "$0")/.."
export CHROME_DIR=${CHROME_DIR:-/tmp/megacity-beauty-chrome}
P="population=7500000&density=45000&maxFloors=90&centres=3&danji=0.9&slopeLimit=24&riverWiden=0&seed=1&hour=14"
run() { timeout 400 node tools/beauty.mjs "e=$2&n=$3&name=$1&$P&maxRise=$5" media/beauty @tools/beauty_shots/$4.json | cut -c1-260; }
run Flawil 2731000 1254000 flawil 0
run Rorschach 2754800 1260675 rorschach 330
run Rapperswil 2704000 1231500 rapperswil 0
run Walenstadt 2742350 1220950 walenstadt 500
run Nesslau 2733350 1231825 nesslau 550
