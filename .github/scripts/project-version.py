#!/usr/bin/env python3
"""Read or update all project version declarations without invoking Maven/npm."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[2]
VERSION_PATTERN = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+(?:-SNAPSHOT)?$")


def replace_artifact_version(path: Path, artifact_id: str, version: str) -> None:
    text = path.read_text(encoding="utf-8")
    pattern = re.compile(
        rf"(<artifactId>{re.escape(artifact_id)}</artifactId>\s*<version>)([^<]+)(</version>)"
    )
    updated, count = pattern.subn(rf"\g<1>{version}\g<3>", text, count=1)
    if count != 1:
        raise SystemExit(f"Could not identify exactly one version for {artifact_id} in {path}")
    path.write_text(updated, encoding="utf-8")


def read_artifact_version(path: Path, artifact_id: str) -> str:
    text = path.read_text(encoding="utf-8")
    match = re.search(
        rf"<artifactId>{re.escape(artifact_id)}</artifactId>\s*<version>([^<]+)</version>",
        text,
    )
    if not match:
        raise SystemExit(f"Could not read version for {artifact_id} from {path}")
    return match.group(1).strip()


def update_package_files(version: str) -> None:
    npm_version = version.removesuffix("-SNAPSHOT")
    package_path = ROOT / "package.json"
    package = json.loads(package_path.read_text(encoding="utf-8"))
    package["version"] = npm_version
    package_path.write_text(json.dumps(package, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    lock_path = ROOT / "package-lock.json"
    lock = json.loads(lock_path.read_text(encoding="utf-8"))
    lock["version"] = npm_version
    root_package = lock.setdefault("packages", {}).setdefault("", {})
    root_package["version"] = npm_version
    lock_path.write_text(json.dumps(lock, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def set_version(version: str) -> None:
    if not VERSION_PATTERN.fullmatch(version):
        raise SystemExit("Version must use X.Y.Z or X.Y.Z-SNAPSHOT")
    replace_artifact_version(ROOT / "pom.xml", "unfallatlas-build", version)
    replace_artifact_version(ROOT / "analysis-service/pom.xml", "unfallatlas-analysis-service", version)
    replace_artifact_version(ROOT / "qa-system-tests/pom.xml", "unfallatlas-build", version)
    update_package_files(version)


def main() -> None:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("get")
    set_parser = subparsers.add_parser("set")
    set_parser.add_argument("version")
    args = parser.parse_args()

    if args.command == "get":
        print(read_artifact_version(ROOT / "analysis-service/pom.xml", "unfallatlas-analysis-service"))
    else:
        set_version(args.version)


if __name__ == "__main__":
    main()
