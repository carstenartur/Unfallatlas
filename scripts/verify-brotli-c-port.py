"""Compare the original Google C decoder with the two files in the published JS port."""

import ctypes as c
import hashlib
import io
import json
from pathlib import Path
import random
import subprocess
import sys
import tarfile
import tempfile
from urllib.request import urlopen


class Code(c.Structure):
    _fields_ = [("bits", c.c_uint8), ("value", c.c_uint16)]


class Memory(c.Structure):
    _fields_ = [("buffer", c.POINTER(c.c_uint8)), ("length", c.c_size_t), ("pos", c.c_size_t)]


def samples():
    # Deterministic complete prefix trees, including subtables and unused symbols.
    rng = random.Random(20150719)
    cases = [[1, [0, 1]], [1, [1, 1]]]
    for bits in [3, 5, 8]:
        for count in [4, 7, 16, 31, 72, 144, 256]:
            depths = [0]
            while len(depths) < count:
                pos = rng.choice([i for i, depth in enumerate(depths) if depth < 15])
                depth = depths.pop(pos) + 1
                depths.extend([depth, depth])
            depths += [0] * (count // 3)
            rng.shuffle(depths)
            cases.append([bits, depths])
    return cases


def reference(lib, cases):
    u8 = c.c_uint8
    lib.BrotliBuildHuffmanTable.argtypes = [c.POINTER(Code), c.c_int, c.POINTER(u8), c.c_int]
    result = []
    for bits, depths in cases:
        table = (Code * 65536)()
        size = lib.BrotliBuildHuffmanTable(table, bits, (u8 * len(depths))(*depths), len(depths))
        if not 0 < size <= len(table):
            raise ValueError("Invalid reference Huffman table length")
        result.append([[entry.bits, entry.value] for entry in table[:size]])
    buffer = (u8 * 6)(1, 2, 3, 4, 5, 6)
    source = Memory(buffer, len(buffer), 0)
    target = (u8 * 7)()
    sink = Memory(target, len(target), 0)
    reads = []
    for length in (2, 3, 3):
        data = (u8 * length)()
        count = lib.BrotliMemInputFunction(c.byref(source), data, length)
        reads.append([count, list(data)[:count], source.pos])
        if lib.BrotliMemOutputFunction(c.byref(sink), data, count) != count:
            raise ValueError("Unexpected C stream write failure")
    overflow = lib.BrotliMemOutputFunction(c.byref(sink), buffer, len(buffer)) < 0
    return [result, reads, list(target), sink.pos, overflow]


JS = """
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[1];
const { BrotliBuildHuffmanTable } = require(path.join(root, 'dec/huffman.js'));
const { BrotliInput, BrotliOutput } = require(path.join(root, 'dec/streams.js'));
const cases = JSON.parse(fs.readFileSync(0, 'utf8'));
const tables = cases.map(([bits, depths]) => {
  const table = [];
  const size = BrotliBuildHuffmanTable(table, 0, bits, depths, depths.length);
  return table.slice(0, size).map(entry => [entry.bits, entry.value]);
});
const buffer = Uint8Array.from([1, 2, 3, 4, 5, 6]);
const source = new BrotliInput(buffer);
const target = new Uint8Array(7);
const sink = new BrotliOutput(target);
const reads = [2, 3, 3].map(length => {
  const data = new Uint8Array(length);
  const count = source.read(data, 0, length);
  sink.write(data, count);
  return [count, Array.from(data.slice(0, count)), source.pos];
});
let overflow = false;
try { sink.write(buffer, buffer.length); }
catch (error) { if (error.message !== 'Output buffer is not large enough') throw error; overflow = true; }
process.stdout.write(JSON.stringify([tables, reads, Array.from(target), sink.pos, overflow]));
"""


def verify(package, archive):
    root = Path(__file__).resolve().parents[1]
    policy = json.loads((root / "vendor/provenance-policy.json").read_bytes())
    decoder = policy["verifiedBundleInventories"]["vendor/export/pdfmake.js"]["brotliDecoder"]
    port = decoder["cPort"]
    if hashlib.sha256(archive).hexdigest() != port["archiveSha256"]:
        raise ValueError("Brotli C source archive differs")
    with tempfile.TemporaryDirectory() as tmp, tarfile.open(fileobj=io.BytesIO(archive)) as tar:
        work = Path(tmp)
        prefix = tar.getmembers()[0].name + "/brotli/"
        for name in ["huffman.c", "streams.c", "huffman.h", "streams.h", "safe_malloc.h", "types.h"]:
            (work / name).write_bytes(tar.extractfile(prefix + "dec/" + name).read())
        original_license = tar.extractfile(prefix + "LICENSE").read()
        notice = (root / port["licenseFile"]).read_bytes()
        if original_license != (root / decoder["licenseTextPath"]).read_bytes() or not notice.endswith(original_license):
            raise ValueError("Original C license differs from the shipped notice")
        for record in port["records"]:
            c_file = (work / record["sourceUrl"].rsplit("/", 1)[1]).read_bytes()
            js = (package / "dec" / Path(record["sourcePath"]).name).read_bytes()
            if hashlib.sha256(c_file).hexdigest() != record["upstreamFileSha256"] or record["copyright"].encode() not in c_file:
                raise ValueError("Brotli C origin or copyright differs")
            if hashlib.sha256(js).hexdigest() != record["sourceSha256"] or hashlib.sha256(notice).hexdigest() != record["sha256"]:
                raise ValueError("Brotli port or shipped notice differs")
        subprocess.run(["cc", "-shared", "-fPIC", "huffman.c", "streams.c", "-o", "original.so"], cwd=work, check=True)
        cases = samples()
        expected = reference(c.CDLL(str(work / "original.so")), cases)
        js = subprocess.check_output(["node", "-e", JS, str(package.resolve())], input=json.dumps(cases).encode())
        if json.loads(js) != expected:
            raise ValueError("C and JavaScript Huffman tables or memory streams differ")
        print(f"Verified {sum(map(len, expected[0]))} Huffman table entries across {len(cases)} cases and memory stream reads/writes.")


if __name__ == "__main__":
    package = Path(sys.argv[1])
    if len(sys.argv) > 2:
        verify(package, Path(sys.argv[2]).read_bytes())
    else:
        policy = json.loads((Path(__file__).resolve().parents[1] / "vendor/provenance-policy.json").read_bytes())
        port = policy["verifiedBundleInventories"]["vendor/export/pdfmake.js"]["brotliDecoder"]["cPort"]
        with urlopen(port["upstreamArchive"], timeout=45) as response:
            verify(package, response.read())
