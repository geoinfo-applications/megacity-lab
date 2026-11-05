"""Frames media/beauty/*.png as 1080x1350 posts: clean JPEG plus a version with title and credit. Uses headless chromium."""
import json
import pathlib
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
SETS = {"set": ROOT / "media" / "beauty", "set2": ROOT / "media" / "beauty2", "set3": ROOT / "media" / "beauty3"}

POSTS = [
    ("03_flawil_gegenlicht", "Flawil, 7.5 Mio.", "Feierabend im Fürstenland. 69'208 Gebäude, höchster Turm 457 m."),
    ("02_flawil_nebelmeer", "Flawil, 7.5 Mio.", "Nebelmeer, wie jeden November. Nur die Türme schauen heraus."),
    ("01_flawil_saentis", "Flawil, 7.5 Mio.", "Der Säntis hat jetzt Nachbarn. Höchster Turm 457 m."),
    ("04_flawil_nacht", "Flawil, 7.5 Mio.", "Die blaue Stunde. Im Schnitt 29 Minuten zur Arbeit."),
    ("05_rorschach_bodensee", "Rorschach, 6.1 Mio.", "Am Bodensee. 38'434 Gebäude, höchster Turm 455 m."),
    ("06_rapperswil_zuerichsee", "Rapperswil, 7.5 Mio.", "Am Zürichsee. 73'437 Gebäude, höchster Turm 453 m."),
    ("07_walenstadt_walensee", "Walenstadt, 1.3 Mio.", "Am Walensee. 25'945 Gebäude, höchster Turm 452 m."),
    ("08_nesslau_toggenburg", "Nesslau, 2.6 Mio.", "Im Toggenburg. 110'845 Gebäude, höchster Turm 453 m."),
]

POSTS_2 = [
    ("fl_hill_e_gegen", "Flawil, 7.5 Mio.", "Feierabend im Fürstenland. 69'208 Gebäude, höchster Turm 457 m."),
    ("fl_roof_fog", "Flawil, 7.5 Mio.", "Nebelmeer, wie jeden November. Nur die Türme schauen heraus."),
    ("fl_blvd_gold", "Flawil, 7.5 Mio.", "Stosszeit auf der Hauptachse. Im Schnitt 29 Minuten zur Arbeit."),
    ("fl_blvd_night", "Flawil, 7.5 Mio.", "Flawil schläft nicht mehr."),
    ("fl_roof_night", "Flawil, 7.5 Mio.", "Aussicht vom Nachbarturm, rund 340 m über Boden."),
    ("fl_plan_night", "Flawil, 7.5 Mio.", "Von oben, bei Nacht. Die Strassenlampen zeichnen die Karte."),
    ("ro_shore_night", "Rorschach, 6.1 Mio.", "Am Bodensee. 38'434 Gebäude, höchster Turm 455 m."),
    ("ra_shore_low", "Rapperswil, 7.5 Mio.", "Am Zürichsee. 73'437 Gebäude, höchster Turm 453 m."),
    ("wa_shore_low", "Walenstadt, 1.3 Mio.", "Am Walensee. 25'945 Gebäude, höchster Turm 452 m."),
    ("ne_roof", "Nesslau, 2.6 Mio.", "Im Toggenburg. 110'845 Gebäude, höchster Turm 453 m."),
]

POSTS_3 = [
    ("flawil_saentis_abend", "Flawil, 7.5 Mio.", "Der Säntis hat jetzt Nachbarn. 69'208 Gebäude, höchster Turm 457 m."),
    ("flawil_saentis_nebel", "Flawil, 7.5 Mio.", "Nebelmeer, wie jeden November. Der Säntis schaut trotzdem heraus."),
    ("flawil_saentis_nacht", "Flawil, 7.5 Mio.", "Die blaue Stunde vor dem Alpstein. Im Schnitt 29 Minuten zur Arbeit."),
    ("rorschach_saentis_see", "Rorschach, 6.1 Mio.", "Am Bodensee, den Säntis im Rücken. 38'434 Gebäude."),
    ("rorschach_saentis_nacht", "Rorschach, 6.1 Mio.", "Die Hafenbeleuchtung hat etwas zugelegt."),
    ("rapperswil_schloss_nah", "Rapperswil, 7.5 Mio.", "Das Schloss steht noch. 82'469 Gebäude rundherum."),
    ("walenstadt_churfirsten_flumserberg", "Walenstadt, 1.3 Mio.", "Die Churfirsten, jetzt mit Stadt davor. 25'945 Gebäude."),
    ("walenstadt_churfirsten_see", "Walenstadt, 1.3 Mio.", "Die Churfirsten bleiben. Höchster Turm 452 m, weit unter dem Grat."),
    ("nesslau_churfirsten_abend", "Nesslau, 2.6 Mio.", "Im Toggenburg, vor den Churfirsten. 110'845 Gebäude."),
    ("nesslau_churfirsten_nacht", "Nesslau, 2.6 Mio.", "Unter den Churfirsten geht das Licht nicht mehr aus."),
]

CREDIT = ("Spielzeug, kein Planungsmodell. Gebäude, Autos, Menschen, Wolken, Nebel und Schnee sind erfunden, Sonnenstand frei gewählt. "
          "Gelände und Bild: © swisstopo (swissALTIRegio, SWISSIMAGE, swissTLM3D).<br>"
          "Erstellt mit Claude. #30DayMapChallenge. Das echte Land: geoportal.ch")

PAGE = """<!doctype html><meta charset="utf-8"><style>
:root{{--accent:#d20a12;--magenta:#e5005c;--orange:#e84e0f}}
*{{box-sizing:border-box}}body{{margin:0;width:1080px;height:1350px;position:relative;overflow:hidden;background:#000;
font-family:"Aptos","Open Sans",Verdana,sans-serif;color:#fff}}
img{{position:absolute;inset:0;width:1080px;height:1350px}}
.shade{{position:absolute;left:0;right:0;bottom:0;height:430px;background:linear-gradient(to top,rgba(4,6,14,.86),rgba(4,6,14,.62) 48%,rgba(4,6,14,0))}}
.logo{{--q:17px;position:absolute;top:40px;right:44px;display:grid;grid-template-columns:repeat(3,var(--q)) calc(var(--q)*.5) auto;
grid-template-rows:repeat(2,var(--q));filter:drop-shadow(0 1px 5px rgba(0,0,0,.55))}}
.logo i{{display:block}}.m{{grid-area:1/2;background:var(--magenta)}}.r{{grid-area:1/3;background:var(--accent)}}.o{{grid-area:2/1;background:var(--orange)}}
.w{{grid-area:1/5;align-self:center;font-size:calc(var(--q)*1.4);line-height:1;letter-spacing:.05em;color:#fff;white-space:nowrap}}.g{{font-weight:700}}.i{{font-weight:300}}
h1{{position:absolute;left:44px;bottom:158px;margin:0;font-size:78px;line-height:1.05;font-weight:600;letter-spacing:-.01em}}
.sub{{position:absolute;left:46px;right:46px;bottom:108px;font-size:29px;line-height:1.25}}
.peak{{position:absolute;transform:translate(-50%,-100%);font-size:22px;font-weight:600;line-height:1.1;text-align:center;color:#fff;text-shadow:0 1px 4px rgba(0,0,0,.85);white-space:nowrap}}
.peak i{{display:block;width:1.5px;height:18px;margin:3px auto 0;background:rgba(255,255,255,.85);box-shadow:0 0 3px rgba(0,0,0,.7)}}
.cap{{position:absolute;left:46px;right:46px;bottom:26px;font-size:17px;line-height:1.35;color:rgba(255,255,255,.78)}}
</style><body><img src="file://{image}"><div class="shade"></div>
<div class="logo"><i class="m"></i><i class="r"></i><i class="o"></i><div class="w"><span class="g">GEO</span><span class="i">INFO</span></div></div>
{labels}<h1>{title}</h1><div class="sub">{line}</div><div class="cap">{credit}</div></body>"""


def label_html(meta):
    if not meta.exists():
        return ""
    placed, html = [], ""
    for item in json.loads(meta.read_text(encoding="utf-8"))["labels"]:
        x, y = item["x"] * 1080, item["y"] * 1350 - 8
        if not (70 < x < 1010 and 60 < y < 1050) or any(abs(x - px) < 92 and abs(y - py) < 46 for px, py in placed):
            continue
        placed.append((x, y))
        html += f'<div class="peak" style="left:{x:.0f}px;top:{y:.0f}px">{item["label"]}<i></i></div>'
    return html


def run(*command):
    subprocess.run(command, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def main():
    name = sys.argv[1] if len(sys.argv) > 1 else "set"
    posts = {"set": POSTS, "set2": POSTS_2, "set3": POSTS_3}[name]
    source_dir = SETS[name]
    CLEAN = ROOT / "media" / "post" / name / "clean"
    TITLED = ROOT / "media" / "post" / name / "titled"
    CLEAN.mkdir(parents=True, exist_ok=True)
    TITLED.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as work:
        work = pathlib.Path(work)
        for name, title, line in posts:
            source = source_dir / f"{name}.png"
            small = work / f"{name}.png"
            run("magick", str(source), "-filter", "Lanczos", "-resize", "1080x1350", str(small))
            run("magick", str(small), "-quality", "93", str(CLEAN / f"{name}_1080x1350.jpg"))
            page = work / f"{name}.html"
            page.write_text(PAGE.format(image=small, title=title, line=line, credit=CREDIT, labels=label_html(source_dir / f"{name}.json")), encoding="utf-8")
            shot = work / f"{name}_shot.png"
            run("chromium", "--headless=new", "--disable-gpu", "--hide-scrollbars", "--allow-file-access-from-files",
                "--window-size=1080,1350", f"--screenshot={shot}", f"file://{page}")
            run("magick", str(shot), "-quality", "93", str(TITLED / f"{name}_1080x1350.jpg"))
            print(name)


if __name__ == "__main__":
    sys.exit(main())
