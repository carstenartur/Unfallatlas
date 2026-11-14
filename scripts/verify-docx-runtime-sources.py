"""Check the generated runtime source and license records against the suppliers' bytes."""
import base64
import hashlib
import io
import json
import tarfile
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


def main():
    policy = json.loads((ROOT / "vendor/provenance-policy.json").read_text())
    runtimes = policy["verifiedBundleInventories"]["vendor/export/docx.js"]["generatedRuntimes"]
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
