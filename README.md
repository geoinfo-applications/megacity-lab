# Megacity Lab

Click anywhere in Switzerland, set a few numbers, and a procedural city rises on the real terrain. A toy, not a planning model. Built by GEOINFO with Claude.

## Run it

You need Python 3, GDAL with its Python bindings, curl, a browser with WebGL2, and about 8 GB of free disk.

```bash
tools/setup-data.sh                  # downloads public Swiss data and builds the tiles, resumes if interrupted
python3 -I tools/serve.py site 8820  # then open http://127.0.0.1:8820/
```

Fürstenland Seoul directly: `http://127.0.0.1:8820/#e=2731000&n=1254000&name=Flawil`. The URL hash holds place, params and seed, so any city reloads.

The data is not in this repository. `setup-data.sh` writes the sources to `data/` and the tiles to `site/nat`, `site/cover` and `site/landmarks`, all ignored by git.

To skip the build, download `megacity-data.zip` from the [`data-v1` release](https://github.com/geoinfo-applications/megacity-lab/releases/tag/data-v1) and unpack it into `site/`. It leaves out `site/landmarks`, which only the stills scripts use; `tools/fetch_landmarks.py` fetches those.

## Stills

Rest the camera and **Refine** sharpens the view with real light. **Photo** renders the current view at 3200 px and downloads a PNG. The looks (Time of day, Golden hour, Sea of fog, Blue hour) set light and air. A lake in view gets a true reflection.

The social set needs chromium and ImageMagick: `tools/render_set.sh` with the server running, then `python3 -I tools/frame_posts.py`.

## How a city is made

`site/js/gen/generate.js` runs in a worker. All from one seed:

1. Water from swissTLM3D. One river trunk is widened and its bed carved, tapering out 140 m above its lowest point.
2. Buildable land: slope limit, no water, no rock, forest stands over 25 ha stay.
3. Centres: the click, then the real places with the most buildings around them today.
4. Metro: a ring and radials. Stations pull density.
5. Footprint: most attractive cells until population / density is covered.
6. Streets: tensor field, grids near centres, contours on slopes. Real motorways and rail stay.
7. Buildings on a 6.25 m raster: villas, apartment estates, mixed use, towers on podiums. Up to three passes open the fabric until floors add up to the people asked.
8. Commute: gravity to 12 job hubs, routed on a 50 m grid, one congestion pass.

## Assumptions in the numbers

Sourced: Seoul 605 km², 9.64 M people in Q1 2024 ([Seoul statistics](https://seoulsolution.kr/en/node/2113)). The density preset divides the two.

Assumed, unchecked: 33 m² home per person, 0.62 net to gross floor, 0.5 jobs per person, 28 m² per job, 25 % of commuters by car, 40 % of them in the peak hour, road speeds and capacities. Preset shapes for Hong Kong and Los Angeles are rough. Nothing is calibrated against a real city.

## Checks

```bash
node --test --max-old-space-size=8192 test/generator.test.mjs     # generator invariants on real terrain, needs the data
node tools/shoot.mjs "e=2731000&n=1254000&name=Flawil&still" media/out '[{"name":"view","view":{"distance":7000,"pitch":0.24,"yaw":0.6}}]'
```

`shoot.mjs` drives headless chromium on the GPU and needs the server on 8820.

## Licence and data

The code is MIT licensed, see `LICENSE`. That covers neither the data nor the GEOINFO name and logo in `tools/frame_posts.py`.

`setup-data.sh` downloads the data from the Swiss federal geoportal. The same sources are credited on `site/sources.html`.

- SWISSIMAGE, swissALTI3D, swissTLM3D, swissTLMRegio, swissNAMES3D: © swisstopo, [terms of use](https://www.swisstopo.admin.ch/ogd-conditions).
- swissALTIRegio: Bundesamt für Landestopografie swisstopo; Tarquini S., I. Isola, M. Favalli, A. Battistini, G. Dotta (2023). TINITALY, a digital elevation model of Italy with a 10 meters cell size (Version 1.1). Istituto Nazionale di Geofisica e Vulcanologia (INGV). https://doi.org/10.13127/tinitaly/1.1; DGM Österreich, geoland.at; DGM1, Bayerische Vermessungsverwaltung – www.geodaten.bayern.de; DGM1, Baden-Württemberg: LGL, www.lgl-bw.de, dl-de/by-2-0; RGEAlti, Institut National de l'information géographique et forestière, données originales téléchargées sur https://geoservices.ign.fr/rgealti#telechargement5m, mise à jour du juillet 2023.
