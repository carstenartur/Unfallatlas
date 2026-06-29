#!/usr/bin/env python3
"""Keep release-related metadata files aligned with the project version."""

from __future__ import annotations

import argparse
import datetime as dt
import json
from pathlib import Path
import re
from typing import Any


ROOT = Path.cwd()
ORCID_ID = "0009-0005-1047-6381"
ORCID_URL = "https://orcid.org/" + ORCID_ID


def set_cff_key(text: str, key: str, value: str) -> str:
    line = f'{key}: "{value}"'
    pattern = rf'^{re.escape(key)}: .*$'
    if re.search(pattern, text, flags=re.MULTILINE):
        return re.sub(pattern, line, text, flags=re.MULTILINE)
    if not text.endswith("\n"):
        text += "\n"
    return text + line + "\n"


def remove_cff_key(text: str, key: str) -> str:
    return re.sub(rf'^{re.escape(key)}: .*\n?', "", text, flags=re.MULTILINE)


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, data: dict[str, Any]) -> None:
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def update_citation(version: str, release_date: str | None) -> None:
    path = ROOT / "CITATION.cff"
    text = path.read_text(encoding="utf-8")
    text = set_cff_key(text, "version", version)
    if release_date:
        text = set_cff_key(text, "date-released", release_date)
    else:
        text = remove_cff_key(text, "date-released")
    path.write_text(text, encoding="utf-8")


def update_zenodo(version: str, release_date: str | None) -> None:
    path = ROOT / ".zenodo.json"
    data = read_json(path)
    data["version"] = version
    if release_date:
        data["publication_date"] = release_date
    else:
        data.pop("publication_date", None)
    write_json(path, data)


def update_codemeta(version: str, release_date: str | None) -> None:
    path = ROOT / "codemeta.json"
    data = read_json(path)
    data["version"] = version
    if release_date:
        data["datePublished"] = release_date
    else:
        data.pop("datePublished", None)
    write_json(path, data)


def update_citation_md(version: str, release_date: str | None) -> None:
    path = ROOT / "CITATION.md"
    text = path.read_text(encoding="utf-8")
    text = re.sub(
        r"(Carsten Hammer\. \*\*Unfallwerkbank\*\*\. Version )[0-9A-Za-z.-]+(\. 2026\.)",
        rf"\g<1>{version}\2",
        text,
    )
    text = re.sub(r"(  version\s+= \{)[^}]+(\},)", rf"\g<1>{version}\2", text)
    if release_date:
        if re.search(r"^  date\s+= \{[^}]+\},$", text, flags=re.MULTILINE):
            text = re.sub(r"^  date\s+= \{[^}]+\},$", f"  date         = {{{release_date}}},", text, flags=re.MULTILINE)
        else:
            text = re.sub(r"^(  version\s+= \{[^}]+\},)$", rf"\1\n  date         = {{{release_date}}},", text, flags=re.MULTILINE)
    else:
        text = re.sub(r"^  date\s+= \{[^}]+\},\n", "", text, flags=re.MULTILINE)
    if "ORCID" not in text:
        text = text.replace(
            "## What to cite\n",
            f"## Author identifier\n\nCarsten Hammer's ORCID iD is [{ORCID_URL}]({ORCID_URL}).\n\n## What to cite\n",
        )
    if "  orcid" not in text:
        text = re.sub(r"(  author\s+= \{Hammer, Carsten\},)", rf"\1\n  orcid        = {{{ORCID_URL}}},", text, flags=re.MULTILINE)
    path.write_text(text, encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("version", help="Version to write to metadata files")
    parser.add_argument(
        "--release",
        action="store_true",
        help="Set release date fields; otherwise remove release-only date fields for a development snapshot.",
    )
    args = parser.parse_args()

    release_date = dt.date.today().isoformat() if args.release else None
    update_citation(args.version, release_date)
    update_zenodo(args.version, release_date)
    update_codemeta(args.version, release_date)
    update_citation_md(args.version, release_date)


if __name__ == "__main__":
    main()
