"""Verify the SVGO parser that PDFKit explicitly credits in lib/path.js."""

import hashlib
import json
from pathlib import Path
import re
import sys
from urllib.request import urlopen


def original(url, digest):
    raw = url.replace("https://github.com/", "https://raw.githubusercontent.com/").replace("/blob/", "/")
    with urlopen(raw, timeout=30) as response:
        data = response.read()
    if hashlib.sha256(data).hexdigest() != digest:
        raise ValueError(f"Changed publisher file: {url}")
    return data


def function_text(source, declaration):
    start = source.index(declaration)
    if source.count(declaration) != 1:
        raise ValueError(f"Ambiguous declaration: {declaration}")
    return source[start:source.index("\n};", start) + 3]


def tokens(source):
    return re.findall(r"\w+|[^\w\s]", re.sub(r"//[^\n]*", "", source))


def main(package_root):
    repo = Path(__file__).resolve().parents[1]
    inventory = json.loads((repo / "vendor/provenance-policy.json").read_bytes())["verifiedBundleInventories"]
    record = inventory["vendor/export/pdfmake.js"]["nestedPdfkitSources"]["pathParser"]
    upstream = original(record["upstreamReferenceUrl"], record["upstreamFileSha256"])
    license_text = original(record["licenseUrl"], record["sha256"])
    if license_text != (repo / "vendor/pdfmake-build/licenses/SVGO-MIT.txt").read_bytes():
        raise ValueError("SVGO original notice differs")
    source_map = json.loads((package_root / "js/pdfkit.browser.mjs.map").read_bytes())
    module = source_map["sourcesContent"][source_map["sources"].index("../lib/path.js")]
    shipped = function_text(module, "const parse = function (path) {")
    source = function_text(upstream.decode(), "export const parsePathData = (string) => {")
    source = re.sub(r"/\*\*.*?\*/", "", source, flags=re.S)
    source = re.sub(r"//[^\n]*", "", source)
    # PDFKit renamed four identifiers, removed a JSDoc array cast and nested
    # one else-if condition. Preserve token order for the rest of the function.
    source = source.replace("export const parsePathData = (string) => {", "const parse = function (path) {")
    source = source.replace("([])", "[]").replace("string", "path")
    source = source.replace("isWhiteSpace", "isWsp").replace("argsCountPerCommand", "parameters")
    source, count = re.subn(r"else if \(args.length !== 0\) \{\s*return pathData;\s*\}",
                            "else { if (args.length !== 0) { return pathData; } }", source)
    if count != 1 or tokens(source) != tokens(shipped):
        raise ValueError("PDFKit path parser differs from the SVGO reference")
    print("Verified the adapted SVGO parser in PDFKit and its original MIT notice")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("Usage: python3 scripts/verify-pdfkit-parser.py path/to/pdfkit")
    main(Path(sys.argv[1]))
