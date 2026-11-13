"""Compare Fontkit's shipped Arabic and Indic tables with their cited HarfBuzz sources."""

import hashlib
import json
from pathlib import Path
import re
import sys
from urllib.request import urlopen


def arabic_rows(source, upstream):
    start = "arabic_state_table[][NUM_STATE_MACHINE_COLS] =" if upstream else "const STATE_TABLE = ["
    end = "};" if upstream else "];"
    table = source.split(start, 1)[1].split(end, 1)[0]
    opening, closing = (r"\{", r"\}") if upstream else (r"\[", r"\]")
    return re.findall(opening + r"\s*(\w+)\s*,\s*(\w+)\s*,\s*(\d+)\s*" + closing, table)


def indic_upstream(source):
    table = source.split("static const indic_config_t indic_configs[] =", 1)[1].split("};", 1)[0]
    pattern = (r"\{HB_SCRIPT_(\w+),\s*(true|false),\s*(0x[0-9A-F]+|0)u?,"
               r"\s*BASE_POS_(\w+),\s*REPH_POS_(\w+),\s*REPH_MODE_(\w+),\s*BLWF_MODE_(\w+)\}")
    rows = {}
    for name, old_spec, virama, base, position, reph, blwf in re.findall(pattern, table):
        if name == "SINHALA":
            continue  # Fontkit delegates Sinhala to its universal shaper.
        if position == "DONT_CARE":
            if not re.search(r"REPH_POS_DONT_CARE\s*=\s*POS_RA_TO_BECOME_REPH\b", source):
                raise ValueError("Unknown HarfBuzz reph position alias")
            position = "RA_TO_BECOME_REPH"
        key = "DEFAULT" if name == "INVALID" else name
        if key in rows:
            raise ValueError(f"Duplicate HarfBuzz Indic configuration: {name}")
        rows[key] = (old_spec, int(virama, 0), base, position, reph, blwf)
    return rows


def indic_fontkit(source):
    table = source.split("export const INDIC_CONFIGS = {", 1)[1].split("};", 1)[0]
    table = re.sub(r"//[^\n]*", "", table)
    pattern = (r"(\w+): \{\s*hasOldSpec: (true|false),\s*virama: (0x[0-9A-F]+|0),"
               r"\s*basePos: '(\w+)',\s*rephPos: POSITIONS\.(\w+),"
               r"\s*rephMode: '(\w+)',\s*blwfMode: '(\w+)'\s*\}")
    rows = {}
    for name, old_spec, virama, base, position, reph, blwf in re.findall(pattern, table):
        if name.upper() in rows:
            raise ValueError(f"Duplicate Fontkit Indic configuration: {name}")
        rows[name.upper()] = (old_spec, int(virama, 0), *(v.upper() for v in (base, position, reph, blwf)))
    return rows


def main(package_root):
    root = Path(__file__).resolve().parents[1]
    policy = json.loads((root / "vendor/provenance-policy.json").read_text())
    pdf = policy["verifiedBundleInventories"]["vendor/export/pdfmake.js"]
    sections = {section["record"]["ref"]: section for section in pdf["fontkitSources"]["sections"]}
    for name in ("arabic", "indic"):
        section = sections[f"urn:unfallatlas:vendor-source:fontkit:harfbuzz-{name}"]
        record = section["record"]
        url = record["upstreamReferenceUrl"].replace("https://github.com/", "https://raw.githubusercontent.com/").replace("/blob/", "/")
        with urlopen(url, timeout=30) as response:
            original = response.read()
        if hashlib.sha256(original).hexdigest() != record["upstreamFileSha256"]:
            raise ValueError(f"HarfBuzz {name} reference hash differs")
        header = original.split(b"*/", 1)[0] + b"*/\n"
        notice = root / "vendor/pdfmake-build/licenses" / section["licenseFile"]
        if notice.read_bytes() != header:
            raise ValueError(f"HarfBuzz {name} notice differs from the upstream source header")
        source = (Path(package_root) / section["file"]).read_text()
        if name == "arabic":
            reference, actual = arabic_rows(original.decode(), True), arabic_rows(source, False)
            count = 42
        else:
            reference, actual = indic_upstream(original.decode()), indic_fontkit(source)
            count = 11
        if len(reference) != count or reference != actual:
            raise ValueError(f"Fontkit {name} table differs from the upstream reference")
        print(f"Fontkit {name}: {count} matching table entries and original copyright notice")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("Usage: python3 scripts/verify-fontkit-shaping.py path/to/fontkit")
    main(sys.argv[1])
