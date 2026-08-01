#!/usr/bin/env python3
"""Resolve an exact or conventional next development version for a release."""

from __future__ import annotations

import argparse
from pathlib import Path
import re
import sys
from typing import Mapping

_RELEASE = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+$")
_SNAPSHOT = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+-SNAPSHOT$")
_OUTPUT_KEYS = ("release", "next", "next_release", "maintenance_branch")


def version_tuple(version: str) -> tuple[int, int, int]:
    return tuple(map(int, version.removesuffix("-SNAPSHOT").split(".")))


def normalize(value: str, field: str, pattern: re.Pattern[str]) -> str:
    normalized = value.strip()
    if not pattern.fullmatch(normalized):
        expected = "X.Y.Z-SNAPSHOT" if pattern is _SNAPSHOT else "X.Y.Z"
        raise ValueError(f"{field} must use {expected}")
    return normalized


def patch_fallback(release: str) -> str:
    major, minor, patch = version_tuple(release)
    return f"{major}.{minor}.{patch + 1}-SNAPSHOT"


def resolve_plan(
    release_version: str,
    next_development_version: str = "",
) -> dict[str, str]:
    release = normalize(release_version, "release_version", _RELEASE)
    exact_next = next_development_version.strip()
    next_version = (
        normalize(exact_next, "next_development_version", _SNAPSHOT)
        if exact_next
        else patch_fallback(release)
    )
    if version_tuple(next_version) <= version_tuple(release):
        raise ValueError(
            f"next development version {next_version} must be newer than release {release}"
        )
    major, minor, _ = version_tuple(release)
    return {
        "release": release,
        "next": next_version,
        "next_release": next_version.removesuffix("-SNAPSHOT"),
        "maintenance_branch": f"maintenance/{major}.{minor}.x",
    }


def append_outputs(path: Path, plan: Mapping[str, str]) -> None:
    with path.open("a", encoding="utf-8") as output:
        for key in _OUTPUT_KEYS:
            print(f"{key}={plan[key]}", file=output)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--release", required=True)
    parser.add_argument("--next-development-version", default="")
    parser.add_argument("--github-output", type=Path)
    args = parser.parse_args()
    try:
        plan = resolve_plan(args.release, args.next_development_version)
        if args.github_output:
            append_outputs(args.github_output, plan)
        for key in _OUTPUT_KEYS:
            print(f"{key}={plan[key]}")
    except ValueError as error:
        print(f"::error::{error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
