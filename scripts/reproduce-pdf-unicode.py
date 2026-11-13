#!/usr/bin/env python3
"""Rebuild PDF Unicode resources and, separately, five Fontkit shaper outputs."""

import base64
import hashlib
import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
from urllib.request import urlopen
from zipfile import ZipFile


ROOT = Path(__file__).resolve().parents[1]
SPEC = json.loads((ROOT / "vendor/pdfmake-build/unicode-data.json").read_bytes())


def verify(data, expected, label):
    if hashlib.sha256(data).hexdigest() != expected:
        raise ValueError(f"SHA-256 differs: {label}")
    return data


def main():
    with tempfile.TemporaryDirectory(prefix="pdf-unicode-") as temp:
        work = Path(temp)
        license = SPEC["license"]
        notices = ROOT / "vendor/pdfmake-build/licenses"
        verify((notices / license["file"]).read_bytes(), license["sha256"], "archived Unicode license")

        for name, spec in SPEC["sources"].items():
            with urlopen(spec["url"], timeout=90) as src:
                archive = verify(src.read(), spec["sha256"], name)
            directory = work / name
            directory.mkdir()
            if "files" in spec:
                with ZipFile(io.BytesIO(archive)) as ucd:
                    notice = spec["notice"]
                    original = verify(ucd.read(notice["archivePath"]), notice["sha256"], notice["file"])
                    if original != (notices / notice["file"]).read_bytes():
                        raise ValueError(f"Archived release notice differs from the original: {name}")
                    for file, digest in spec["files"].items():
                        target = directory / file
                        target.parent.mkdir(parents=True, exist_ok=True)
                        target.write_bytes(verify(ucd.read(file), digest, file))
            else:
                with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as package:
                    # Each verified release archive has a single top-level directory.
                    for member in package:
                        if member.isfile():
                            rel = Path(*Path(member.name).parts[1:])
                            if rel.is_absolute() or ".." in rel.parts:
                                raise ValueError(f"Invalid package member: {member.name}")
                            dest = directory / rel
                            dest.parent.mkdir(parents=True, exist_ok=True)
                            dest.write_bytes(package.extractfile(member).read())

        # Every byte of the UCD input bundled by codepoints must match Unicode's ZIP.
        for file in SPEC["sources"]["ucd12"]["files"]:
            if (work / "codepoints/data" / file).read_bytes() != (work / "ucd12" / file).read_bytes():
                raise ValueError(f"UCD 12.0.0 differs from codepoints: {file}")

        deps = work / "node_modules"
        deps.mkdir()
        shaper_lock = json.loads((work / "fontkit/package-lock.json").read_bytes())["packages"]
        app_lock = json.loads((ROOT / "package-lock.json").read_bytes())["packages"]
        for package in ["unicode-trie", "dfa"]:
            key = "node_modules/" + package
            if app_lock[key]["integrity"] != shaper_lock[key]["integrity"]:
                raise ValueError(f"Installed package lock differs from the shaper release: {package}")
            (deps / package).symlink_to(ROOT / key, target_is_directory=True)
        (deps / "codepoints").symlink_to(work / "codepoints", target_is_directory=True)
        # Replace only the generator's network transport. It receives the
        # verified official bytes for its original hard-coded URL.
        request = deps / "request"
        request.mkdir()
        (request / "package.json").write_text('{"name":"request","main":"index.js"}')
        (request / "index.js").write_text(
            "const fs=require('node:fs');module.exports=(url,callback)=>{"
            "if(url!=='http://www.unicode.org/Public/14.0.0/ucd/LineBreak.txt')throw Error(url);"
            "callback(null,{},fs.readFileSync(" + json.dumps(str(work / "ucd14/LineBreak.txt")) + ",'utf8'));};"
        )
        subprocess.run(["node", str(work / "unicode-properties/generate.js")], cwd=work, check=True)
        # The source tarball already contains this trie; require actual regeneration.
        (work / "linebreak/src/classes.trie").unlink()
        subprocess.run(["node", str(work / "linebreak/src/generate_data.js")], cwd=work, check=True)

        shapers = work / "fontkit/src/opentype/shapers"
        for item in SPEC["fontkitReproductionOnly"]:
            (shapers / item["file"]).unlink(missing_ok=True)
        for generator in ["generate-data.js", "gen-indic.js", "gen-use.js"]:
            subprocess.run(["node", str(shapers / generator)], cwd=shapers, check=True)

        built = (ROOT / "node_modules/pdfmake/build/pdfmake.min.js").read_bytes()
        outputs = [(work / ("linebreak/src" if item["package"] == "linebreak" else ""),
                    item["package"], item) for item in SPEC["outputs"]]
        outputs.extend((shapers, "fontkit (reproduction only)", item) for item in SPEC["fontkitReproductionOnly"])
        for directory, package, item in outputs:
            file = directory / item["file"]
            data = verify(file.read_bytes(), item["sha256"], item["file"])
            embedded = base64.b64encode(data) if item["encoding"] == "base64" else data
            if len(data) != item["bytes"] or built.count(embedded) != 1:
                raise ValueError(f"Unexpected generated or embedded bytes: {file}")
            print(f"{package}/{item['file']}  {len(data)} bytes  {item['sha256']}")


if __name__ == "__main__":
    main()
