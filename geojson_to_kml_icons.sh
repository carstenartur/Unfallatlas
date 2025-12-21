#!/bin/sh
set -eu

# Usage:
#   ./geojson_to_kml_icons.sh out/output_all_years.geojson out/unfaelle_icons.kml
#
# Requirements:
#   - ogr2ogr (GDAL)
#   - python3 (stdlib)

IN="${1:-out/output_all_years.geojson}"
OUT="${2:-out/unfaelle_icons.kml}"

TMPDIR="$(mktemp -d)"
TMPKML="$TMPDIR/tmp.kml"

cleanup() { rm -rf "$TMPDIR"; }
trap cleanup EXIT

command -v ogr2ogr >/dev/null 2>&1 || { echo "ERROR: ogr2ogr (GDAL) fehlt."; exit 2; }
command -v python3 >/dev/null 2>&1 || { echo "ERROR: python3 fehlt."; exit 2; }

echo "== 1) GeoJSON -> KML (roh) =="
ogr2ogr -f KML "$TMPKML" "$IN"

echo "== 2) Styles (Farbe nach Kategorie) + Icons (Rad/Fuß/PKW) =="

python3 - "$TMPKML" "$OUT" <<'PY'
import sys
import xml.etree.ElementTree as ET

src, dst = sys.argv[1], sys.argv[2]

NS = {"kml": "http://www.opengis.net/kml/2.2"}
ET.register_namespace("", NS["kml"])

def k(tag):
    return f"{{{NS['kml']}}}{tag}"

tree = ET.parse(src)
root = tree.getroot()
doc = root.find("kml:Document", NS)
if doc is None:
    raise SystemExit("ERROR: KML enthält kein <Document>.")

# KML-Farbformat: aabbggrr
# rot:    ff0000ff
# orange: ff00a5ff
# gelb:   ff00ffff
# blau:   ffff5500
CAT_COLOR = {
    "1": "ff0000ff",
    "2": "ff00a5ff",
    "3": "ff00ffff",
    "0": "ffff5500",
}

# Kostenlose Standard-Icons (Google KML-Iconset)
ICON = {
    "rad":  "http://maps.google.com/mapfiles/kml/shapes/cycling.png",
    "fuss": "http://maps.google.com/mapfiles/kml/shapes/man.png",
    "pkw":  "http://maps.google.com/mapfiles/kml/shapes/cabs.png",
    "def":  "http://maps.google.com/mapfiles/kml/shapes/placemark_circle.png",
}

# Scale kann man je nach Geschmack anpassen
CAT_SCALE = {"1": "1.3", "2": "1.15", "3": "1.0", "0": "0.95"}

def add_style(style_id, color, icon_href, scale):
    st = ET.Element(k("Style"), id=style_id)

    iconstyle = ET.SubElement(st, k("IconStyle"))
    ET.SubElement(iconstyle, k("color")).text = color
    ET.SubElement(iconstyle, k("scale")).text = scale
    icon = ET.SubElement(iconstyle, k("Icon"))
    ET.SubElement(icon, k("href")).text = icon_href

    labelstyle = ET.SubElement(st, k("LabelStyle"))
    ET.SubElement(labelstyle, k("scale")).text = "0.8"

    balloon = ET.SubElement(st, k("BalloonStyle"))
    ET.SubElement(balloon, k("text")).text = (
        "<![CDATA["
        "<b>$[name]</b><br/>"
        "Jahr: $[year]<br/>"
        "Kategorie: $[ukategorie]<br/>"
        "Beteiligung: Rad=$[istrad] / Fuß=$[istfuss] / PKW=$[istpkw]<br/>"
        "Licht: $[ulichtverh]<br/>"
        "Straße: $[strasse]<br/>"
        "Straßenzustand: $[strzustand]<br/>"
        "]]>"
    )

    return st

def get_extended_value(pm, key):
    ext = pm.find("kml:ExtendedData", NS)
    if ext is None:
        return None
    for data in ext.findall("kml:Data", NS):
        if data.get("name") == key:
            v = data.find("kml:value", NS)
            if v is not None and v.text is not None:
                return v.text.strip()
    return None

def ensure_data(pm, key, value):
    ext = pm.find("kml:ExtendedData", NS)
    if ext is None:
        ext = ET.SubElement(pm, k("ExtendedData"))
    # update existing
    for data in ext.findall("kml:Data", NS):
        if data.get("name") == key:
            v = data.find("kml:value", NS)
            if v is None:
                v = ET.SubElement(data, k("value"))
            v.text = "" if value is None else str(value)
            return
    # create new
    data = ET.SubElement(ext, k("Data"), name=key)
    v = ET.SubElement(data, k("value"))
    v.text = "" if value is None else str(value)

# Style-Kombinationen: Kategorie (1/2/3/0) x Icon-Typ (rad/fuss/pkw/def)
STYLE_IDS = []
for cat in ("1","2","3","0"):
    for it in ("rad","fuss","pkw","def"):
        sid = f"cat{cat}_{it}"
        STYLE_IDS.append(sid)

# Styles im Document einfügen (am Anfang)
insert_pos = 0
children = list(doc)
for i, ch in enumerate(children):
    if ch.tag in (k("Folder"), k("Placemark"), k("Schema")):
        insert_pos = i
        break
    insert_pos = i + 1

styles = []
for cat in ("1","2","3","0"):
    color = CAT_COLOR.get(cat, CAT_COLOR["0"])
    scale = CAT_SCALE.get(cat, CAT_SCALE["0"])
    for it in ("rad","fuss","pkw","def"):
        sid = f"cat{cat}_{it}"
        styles.append(add_style(sid, color, ICON[it], scale))

for off, st in enumerate(styles):
    doc.insert(insert_pos + off, st)

def pick_icon_type(pm):
    # Priorität: Rad > Fuß > PKW > default
    israd  = get_extended_value(pm, "istrad")
    isfuss = get_extended_value(pm, "istfuss")
    ispkw  = get_extended_value(pm, "istpkw")

    # Manche Exporte heißen evtl. IstRad/IstFuss/IstPKW -> wir sichern beide Varianten
    if israd is None:
        israd = get_extended_value(pm, "IstRad")
    if isfuss is None:
        isfuss = get_extended_value(pm, "IstFuss")
    if ispkw is None:
        ispkw = get_extended_value(pm, "IstPKW")

    # Normalisieren
    israd  = (israd or "").strip()
    isfuss = (isfuss or "").strip()
    ispkw  = (ispkw or "").strip()

    if israd == "1":
        return "rad", israd, isfuss, ispkw
    if isfuss == "1":
        return "fuss", israd, isfuss, ispkw
    if ispkw == "1":
        return "pkw", israd, isfuss, ispkw
    return "def", israd, isfuss, ispkw

placemarks = doc.findall(".//kml:Placemark", NS)
for pm in placemarks:
    # Kategorie lesen
    cat = get_extended_value(pm, "ukategorie")
    if cat is None:
        cat = get_extended_value(pm, "UKATEGORIE")
    cat = (cat or "").strip()
    if cat not in ("1","2","3"):
        cat = "0"

    itype, israd, isfuss, ispkw = pick_icon_type(pm)

    # Balloon-Felder sicherstellen (damit $[...] immer gefüllt ist)
    ensure_data(pm, "ukategorie", get_extended_value(pm, "ukategorie") or get_extended_value(pm, "UKATEGORIE") or "")
    ensure_data(pm, "year",       get_extended_value(pm, "year") or get_extended_value(pm, "UJAHR") or "")
    ensure_data(pm, "ulichtverh", get_extended_value(pm, "ulichtverh") or get_extended_value(pm, "ULICHTVERH") or "")
    ensure_data(pm, "strasse",    get_extended_value(pm, "strasse") or get_extended_value(pm, "Strasse") or get_extended_value(pm, "STRASSE") or "")
    ensure_data(pm, "strzustand", get_extended_value(pm, "strzustand") or get_extended_value(pm, "STRZUSTAND") or "")

    # Beteiligung sicherstellen (für Popup)
    ensure_data(pm, "istrad",  israd)
    ensure_data(pm, "istfuss", isfuss)
    ensure_data(pm, "istpkw",  ispkw)

    sid = f"cat{cat}_{itype}"
    su = pm.find("kml:styleUrl", NS)
    if su is None:
        su = ET.SubElement(pm, k("styleUrl"))
    su.text = f"#{sid}"

tree.write(dst, encoding="utf-8", xml_declaration=True)
print(f"Wrote styled KML with icons: {dst}")
PY

echo "== fertig =="
echo "Output: $OUT"
echo ""
echo "Tipp: Öffne die KML in Google Earth Pro. Du kannst dort eine Tour aufnehmen und als Video exportieren."