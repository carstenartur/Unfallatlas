"""Compare attributed Fontkit shaping rules with the cited HarfBuzz sources."""

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


def fallback_cases(source, upstream):
    if upstream:
        source = source.split("recategorize_combining_class (", 1)[1].split("return klass;\n}", 1)[0]
        case = r"case (?:HB_MODIFIED_COMBINING_CLASS_(CCC\d+)|(0x[0-9A-F]+)u):"
        value = r"(?:return|klass =) HB_UNICODE_COMBINING_CLASS_(\w+);"
    else:
        source = source.split("  getCombiningClass(codePoint) {", 1)[1].split("return combiningClass;", 1)[0]
        case = r"case (?:'(CCC\d+)'|(0x[0-9a-f]+)):"
        value = r"return '(\w+)';"
    cases = {}
    pending = []
    for line in source.splitlines():
        line = line.strip()
        label = re.match(case, line)
        if label:
            key = (label[1] or label[2]).upper()
            if key in cases or key in pending:
                raise ValueError(f"Duplicate fallback case {key}")
            pending.append(key)
        elif pending:
            result = re.fullmatch(value, line)
            if result or line == "break;":
                cases.update(dict.fromkeys(pending, result[1].upper() if result else "UNCHANGED"))
                pending.clear()
    if pending:
        raise ValueError("Unresolved fallback cases")
    return cases


def verify_fallback(reference, source):
    original = fallback_cases(reference, True)
    shipped = fallback_cases(source, False)
    # Fontkit 2.0.4 spells the Thai nikhahit case as U+0E3D. Upstream Fontkit
    # fixed this after the pinned release, in ed87e83d97851d984558f9c219b830917f9993a5.
    if (original.keys() - shipped.keys() != {"0X0E4D"} or
            shipped.keys() - original.keys() != {"0X0E3D"} or
            original.pop("0X0E4D") != "ABOVE_RIGHT" or shipped.pop("0X0E3D") != "ABOVE_RIGHT" or
            len(original) != 51 or original != shipped):
        raise ValueError("Fontkit fallback combining-class cases differ from the pinned comparison")
    print("Fontkit fallback: 51 matching cases and the documented Thai U+0E3D/U+0E4D difference")


def grammar_rules(source):
    # Ragel uses dots for explicit concatenation. The Fontkit compiler uses
    # adjacency. Token lists preserve boundaries between category names.
    source = re.sub(r"#[^\n]*", "", source).split("main", 1)[0]
    rules = {}
    for name, expression in re.findall(r"^\s*([a-z][a-z_]*)\s*=\s*([^;]+);", source, re.M):
        tokens = re.findall(r"\w+|[^\w\s.]", expression)
        aliases = {"PLACEHOLDER": "Placeholder", "DOTTEDCIRCLE": "Dotted_Circle"}
        tokens = [aliases.get(token, token) for token in tokens]
        if tokens[0] == "(" and tokens[-1] == ")":
            depth = 0
            for index, token in enumerate(tokens):
                depth += (token == "(") - (token == ")")
                if depth == 0:
                    if index == len(tokens) - 1:
                        tokens = tokens[1:-1]
                    break
        if name in rules:
            raise ValueError(f"Duplicate grammar rule {name}")
        rules[name] = tokens
    return rules


def verify_grammar(name, original, source):
    upstream = grammar_rules(original)
    shipped = grammar_rules(source)
    # Ragel handles unmatched input with its extra 'other = any' rule.
    if upstream.pop("other", None) != ["any"]:
        raise ValueError(f"Unexpected {name} fallback grammar")
    if name == "indic-grammar":
        changed = "syllable_tail"
        tail = shipped[changed]
        if tail[-6:] != ["A", "{", "0", ",", "3", "}"]:
            raise ValueError("Unexpected Indic syllable tail")
        expected = tail + ["?", "VD", "{", "0", ",", "2", "}"]
        count = 20
    else:
        changed = "independent_cluster"
        expected = ["(", "IND", "|", "O", "|", "Rsv", "|", "WJ", ")", "VS", "?"]
        if shipped[changed] != expected[:5] + expected[7:]:
            raise ValueError("Unexpected USE independent cluster")
        count = 12
    if upstream.pop(changed) != expected:
        raise ValueError(f"Unexpected {name} adaptation of {changed}")
    shipped.pop(changed)
    if len(upstream) != count - 1 or upstream != shipped:
        raise ValueError(f"{name} rules differ from their HarfBuzz reference")
    print(f"Fontkit {name}: {count - 1} matching rules and the documented change to {changed}")


def main(package_root):
    root = Path(__file__).resolve().parents[1]
    policy = json.loads((root / "vendor/provenance-policy.json").read_text())
    pdf = policy["verifiedBundleInventories"]["vendor/export/pdfmake.js"]
    inputs = pdf["fontkitSources"]["sections"] + pdf["fontkitSources"]["grammarInputs"]
    sections = {section["record"]["ref"]: section for section in inputs}
    for name in ("arabic", "indic", "fallback", "indic-grammar", "use-grammar"):
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
        if name.endswith("-grammar"):
            verify_grammar(name, original.decode(), source)
            continue
        if name == "fallback":
            verify_fallback(original.decode(), source)
            continue
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
