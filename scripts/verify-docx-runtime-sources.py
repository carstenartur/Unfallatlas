"""Check the generated runtime source and license records against the suppliers' bytes."""
import base64
import hashlib
import io
import json
import tarfile
import re
from pathlib import Path
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
BABEL_LICENSE_ARCHIVE = "https://registry.npmjs.org/@babel/runtime/-/runtime-7.28.6.tgz"
BABEL_LICENSE_INTEGRITY = "sha512-05WQkdpL9COIMz4LjTxGpPNCdlpyimKppYNoJ5Di5EUObifl8t4tuLuUBBZEpoLYOmfvIWrsp9fCl0HoPRVTdA=="


def download(url):
    with urlopen(url, timeout=45) as response:
        return response.read()


def npm_files(url, integrity, paths):
    raw = download(url)
    digest = "sha512-" + base64.b64encode(hashlib.sha512(raw).digest()).decode()
    if digest != integrity:
        raise ValueError(f"Package integrity differs: {url}")
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:gz") as archive:
        return {name: archive.extractfile("package/" + name).read() for name in paths}


def verify_packer_sources(entries, supplier_root):
    for item in entries:
        record = item["record"]
        package = record["sourcePurl"].split("/")[1].split("@")[0]
        filename = "index.js" if package == "stream-browserify" else "events.js"
        files = npm_files(record["sourceArchive"], record["sourceIntegrity"], [filename, "LICENSE"])
        if hashlib.sha256(files[filename]).hexdigest() != record["upstreamFileSha256"]:
            raise ValueError(f"Changed upstream source for {record['sourcePurl']}")
        if package == "stream-browserify":
            adapted = (supplier_root / record["sourcePath"]).read_bytes()
            if hashlib.sha256(adapted).hexdigest() != record["sourceSha256"]:
                raise ValueError("Changed DOCX Stream implementation")
            header = adapted.split(b"/**\n", 1)[1].split(b" */", 1)[0]
            notice = b"\n".join(line[3:] if line.startswith(b" * ") else b"" for line in header.splitlines()[2:]).strip()
            expected = notice + b"\n\n" + files["LICENSE"]
            # Compare resource cleanup, event routing and backpressure event bindings
            # against the implementation explicitly named by the supplier.
            events = rb"(source|dest)\.(on|removeListener)\(['\"]([a-z]+)['\"],\s*(\w+)"
            if sorted(re.findall(events, adapted)) != sorted(re.findall(events, files[filename])):
                raise ValueError("DOCX pipe event bindings differ from stream-browserify")
        else:
            expected = files["LICENSE"]
            if (supplier_root / "node_modules/events/events.js").read_bytes() != files[filename]:
                raise ValueError("DOCX EventEmitter differs from the locked original")
        if expected != (ROOT / item["licenseFile"]).read_bytes():
            raise ValueError(f"Changed original or adapted notice for {record['sourcePurl']}")


def main():
    policy = json.loads((ROOT / "vendor/provenance-policy.json").read_text())
    inventory = policy["verifiedBundleInventories"]["vendor/export/docx.js"]
    verify_packer_sources(inventory["attributedSections"], Path.cwd())
    runtimes = inventory["generatedRuntimes"]
    for runtime in runtimes:
        if runtime["component"] == "rolldown@1.2.18":
            licenses = npm_files(
                runtime["sourceArchive"], runtime["sourceIntegrity"], ["LICENSE", "THIRD-PARTY-LICENSE"]
            )
            sources = {runtime["modules"][0]["sourcePath"]: download(runtime["sourceUrl"])}
        elif runtime["component"] == "@oxc-project/runtime@0.156.0":
            paths = [module["sourcePath"] for module in runtime["modules"]]
            sources = npm_files(
                runtime["sourceArchive"], runtime["sourceIntegrity"], ["LICENSE", "README.md", *paths]
            )
            licenses = {name: sources[name] for name in ["LICENSE", "README.md"]}
            babel = npm_files(BABEL_LICENSE_ARCHIVE, BABEL_LICENSE_INTEGRITY, ["LICENSE"])
            licenses["@babel/runtime LICENSE"] = babel["LICENSE"]
        else:
            raise ValueError(f"Unrecognized runtime: {runtime['component']}")

        for module in runtime["modules"]:
            if hashlib.sha256(sources[module["sourcePath"]]).hexdigest() != module["sourceSha256"]:
                raise ValueError(f"Changed source for {module['label']}")
        notice = b"\n\n".join(label.encode() + b"\n" + contents for label, contents in licenses.items())
        if notice != (ROOT / runtime["licenseFile"]).read_bytes():
            raise ValueError(f"Archived notices differ for {runtime['component']}")


if __name__ == "__main__":
    main()
