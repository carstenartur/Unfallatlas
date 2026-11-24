#!/usr/bin/env python3
"""Rebuild PDF Unicode resources and, separately, five Fontkit shaper outputs."""

import base64
import hashlib
import io
import json
import re
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
        fontkit = work / "fontkit"
        shaper_lock = verify((fontkit / "package-lock.json").read_bytes(),
                             SPEC["sources"]["fontkit"]["lockSha256"], "Fontkit lock")
        shaper_packages = json.loads(shaper_lock)["packages"]
        app_lock = json.loads((ROOT / "package-lock.json").read_bytes())["packages"]
        for package in ["unicode-trie", "dfa"]:
            key = "node_modules/" + package
            if app_lock[key]["integrity"] != shaper_packages[key]["integrity"]:
                raise ValueError(f"Installed package lock differs from the shaper release: {package}")
        (deps / "unicode-trie").symlink_to(ROOT / "node_modules/unicode-trie", target_is_directory=True)
        (deps / "codepoints").symlink_to(work / "codepoints", target_is_directory=True)
        unicode_properties = work / "unicode-properties"
        for file in ["data.trie", "data.js", "data.base64.trie.js"]:
            (unicode_properties / file).unlink(missing_ok=True)
        subprocess.run(["node", "generate.js"], cwd=unicode_properties, check=True)

        # Keep the supplier's parser and trie generator. Supply the verified
        # Unicode release locally in place of its network transport.
        linebreak = work / "linebreak"
        (linebreak / "src/classes-trie-data.js").unlink(missing_ok=True)
        linebreak_fetch = """
            import { readFileSync } from 'node:fs';
            globalThis.fetch = async url => {
              if (url !== 'https://www.unicode.org/Public/15.0.0/ucd/LineBreak.txt') throw new Error(url);
              return new Response(readFileSync(process.argv[1]));
            };
            await import('./src/generate_data.js');
        """
        subprocess.run(["node", "--input-type=module", "-e", linebreak_fetch, str(work / "ucd15/LineBreak.txt")],
                       cwd=linebreak, check=True)

        subprocess.run(["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"], cwd=fontkit, check=True)
        for file in SPEC["sources"]["ucd12"]["files"]:
            shipped = fontkit / "node_modules/codepoints/data" / file
            if shipped.read_bytes() != (work / "ucd12" / file).read_bytes():
                raise ValueError(f"Fontkit codepoint generator input differs from Unicode: {file}")
        for command in ["trie:data", "trie:use", "trie:indic", "build"]:
            subprocess.run(["npm", "run", command], cwd=fontkit, check=True)
        subprocess.run(["python3", str(ROOT / "scripts/verify-fontkit-shaping.py"), str(fontkit)], check=True)

        # The exact distribution match binds attributed source and generated
        # state machines to the browser modules checked by the PDF inventory.
        for target in ["browser", "node"]:
            built = fontkit / "dist" / target
            installed = ROOT / "node_modules/fontkit/dist" / target
            local_files = sorted(file.relative_to(built) for file in built.rglob("*.js"))
            release_files = sorted(file.relative_to(installed) for file in installed.rglob("*.js"))
            if not local_files or local_files != release_files:
                raise ValueError(f"Rebuilt Fontkit {target} module set differs")
            for file in local_files:
                if (built / file).read_bytes() != (installed / file).read_bytes():
                    raise ValueError(f"Rebuilt Fontkit {target} module differs: {file}")
        for item in SPEC["fontkitReproductionOnly"]:
            generated = fontkit / "src/opentype/shapers/generated" / item["file"]
            data = verify(generated.read_bytes(), item["sha256"], str(generated))
            if len(data) != item["bytes"]:
                raise ValueError(f"Unexpected Fontkit generated bytes: {generated}")
            if item["encoding"] == "base64":
                bundle = ROOT / "node_modules/pdfmake/build/pdfmake.min.js"
                if bundle.read_bytes().count(base64.b64encode(data)) != 1:
                    raise ValueError(f"Unexpected Fontkit embedded bytes: {generated}")
            print(f"fontkit/{item['file']}  {len(data)} bytes  {item['sha256']}")

        for item in SPEC["outputs"]:
            module = work / item["package"] / item["module"]
            data = module.read_bytes()
            installed = ROOT / "node_modules" / item["package"] / item["module"]
            if data != installed.read_bytes():
                raise ValueError(f"Regenerated Unicode module differs: {installed}")
            if item["encoding"] == "uint8array":
                numbers = re.fullmatch(rb"export default new Uint8Array\(\[([0-9,]+)\]\);\n", data)
                if not numbers:
                    raise ValueError(f"Invalid Unicode trie module: {module}")
                data = bytes(int(value) for value in numbers[1].split(b","))
            elif item["encoding"] == "base64":
                data = (module.parent / item["file"]).read_bytes()
            verify(data, item["sha256"], str(module))
            if len(data) != item["bytes"]:
                raise ValueError(f"Unexpected regenerated Unicode bytes: {module}")
            print(f"{item['package']}/{item['file']}  {len(data)} bytes  {item['sha256']}")


if __name__ == "__main__":
    main()
