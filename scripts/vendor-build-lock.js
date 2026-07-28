#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const RECIPE_SCHEMA_VERSION = 1;
const BUILD_LOCK_SCHEMA_VERSION = 1;
const RECIPE_TYPE = "unfallatlas-vendor-build-recipe";
const BUILD_LOCK_TYPE = "unfallatlas-vendor-build-lock";
const REFERENCE_TYPE = "vendor-build-lock-reference";
const HASH_PATTERN = /^[a-f0-9]{64}$/;

class VendorBuildLockError extends Error {
  constructor(code, message, details) {
    super(message ? `${code}: ${message}` : code);
    this.name = "VendorBuildLockError";
    this.code = code;
    this.details = details || null;
  }
}

function fail(code, message, details) {
  throw new VendorBuildLockError(code, message, details);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(value, required, optional, label) {
  if (!isPlainObject(value)) fail("invalid_object", `${label} must be an object`);
  const actual = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  const unknown = actual.filter((key) => !allowed.has(key));
  const missing = required.filter((key) => !Object.hasOwn(value, key));
  if (unknown.length || missing.length) {
    fail("invalid_fields", `${label} has invalid fields`, { unknown, missing });
  }
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    fail("invalid_value", `${label} must be a non-empty string`);
  }
  return value.trim();
}

function sha256Buffer(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function sha256File(file) {
  return sha256Buffer(fs.readFileSync(file));
}

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(",")}}`;
}

function npmPurl(name, version) {
  const encodedName = name.startsWith("@")
    ? `%40${name.slice(1).split("/").map(encodeURIComponent).join("/")}`
    : encodeURIComponent(name);
  return `pkg:npm/${encodedName}@${encodeURIComponent(version)}`;
}

function normalizeRelativePath(value, label) {
  const raw = requiredString(value, label).replace(/\\/g, "/");
  if (
    raw.startsWith("/") ||
    /^[A-Za-z]:\//.test(raw) ||
    raw.split("/").some(
      (segment) => !segment || segment === "." || segment === "..",
    )
  ) {
    fail("unsafe_path", `${label} must be a normalized relative path`);
  }
  return raw;
}

function resolveInside(root, relative, label) {
  const absoluteRoot = fs.realpathSync(root);
  const candidate = path.resolve(
    absoluteRoot,
    normalizeRelativePath(relative, label),
  );
  const rel = path.relative(absoluteRoot, candidate);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    fail("unsafe_path", `${label} escapes or equals its root`, {
      root: absoluteRoot,
      candidate,
    });
  }
  let cursor = absoluteRoot;
  for (const segment of rel.split(path.sep)) {
    cursor = path.join(cursor, segment);
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) {
      fail("unsafe_path", `${label} traverses a symbolic link`, {
        path: cursor,
      });
    }
  }
  return candidate;
}

function normalizeRecipe(value) {
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "type",
      "recipeId",
      "packageLock",
      "packageManager",
      "operations",
    ],
    ["knownGaps"],
    "recipe",
  );
  if (
    Number(value.schemaVersion) !== RECIPE_SCHEMA_VERSION ||
    value.type !== RECIPE_TYPE
  ) {
    fail("unsupported_recipe", "unsupported vendor build recipe schema or type");
  }
  const packageLock = normalizeRelativePath(
    value.packageLock,
    "recipe.packageLock",
  );
  if (!Array.isArray(value.operations) || value.operations.length === 0) {
    fail("empty_recipe", "recipe.operations must be non-empty");
  }
  const refs = new Set();
  const outputs = new Set();
  const operations = value.operations.map((operation, index) => {
    const label = `recipe.operations[${index}]`;
    assertExactKeys(
      operation,
      [
        "lockRef",
        "package",
        "expectedVersion",
        "sourcePath",
        "outputPath",
        "method",
      ],
      ["auxiliaryInputs"],
      label,
    );
    const lockRef = requiredString(operation.lockRef, `${label}.lockRef`);
    if (
      !/^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(lockRef) ||
      refs.has(lockRef)
    ) {
      fail(
        "invalid_lock_ref",
        `${label}.lockRef must be unique and identifier-safe`,
      );
    }
    refs.add(lockRef);
    const outputPath = normalizeRelativePath(
      operation.outputPath,
      `${label}.outputPath`,
    );
    if (!outputPath.startsWith("vendor/") || outputs.has(outputPath)) {
      fail(
        "invalid_output",
        `${label}.outputPath must be a unique vendor/ path`,
      );
    }
    outputs.add(outputPath);
    if (operation.method !== "byte-for-byte-copy") {
      fail(
        "unsupported_method",
        `${label}.method must be byte-for-byte-copy`,
      );
    }
    const auxiliaryInputs =
      operation.auxiliaryInputs == null ? [] : operation.auxiliaryInputs;
    if (!Array.isArray(auxiliaryInputs)) {
      fail(
        "invalid_auxiliary_inputs",
        `${label}.auxiliaryInputs must be an array`,
      );
    }
    return Object.freeze({
      lockRef,
      package: requiredString(operation.package, `${label}.package`),
      expectedVersion: requiredString(
        operation.expectedVersion,
        `${label}.expectedVersion`,
      ),
      sourcePath: normalizeRelativePath(
        operation.sourcePath,
        `${label}.sourcePath`,
      ),
      outputPath,
      method: operation.method,
      auxiliaryInputs: Object.freeze(
        [
          ...new Set(
            auxiliaryInputs.map((item, auxIndex) =>
              normalizeRelativePath(
                item,
                `${label}.auxiliaryInputs[${auxIndex}]`,
              ),
            ),
          ),
        ].sort(),
      ),
    });
  });
  const knownGaps = value.knownGaps == null ? [] : value.knownGaps;
  if (!Array.isArray(knownGaps)) {
    fail("invalid_known_gaps", "recipe.knownGaps must be an array");
  }
  return Object.freeze({
    schemaVersion: RECIPE_SCHEMA_VERSION,
    type: RECIPE_TYPE,
    recipeId: requiredString(value.recipeId, "recipe.recipeId"),
    packageLock,
    packageManager: requiredString(
      value.packageManager,
      "recipe.packageManager",
    ),
    operations: Object.freeze(operations),
    knownGaps: Object.freeze(
      knownGaps.map((gap, index) =>
        requiredString(gap, `recipe.knownGaps[${index}]`),
      ),
    ),
  });
}

function loadJsonFile(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    fail("invalid_json", `${label} is not valid JSON`, {
      file,
      message: error.message,
    });
  }
}

function lockPackage(lock, packageName) {
  if (
    !lock ||
    Number(lock.lockfileVersion) !== 3 ||
    !isPlainObject(lock.packages)
  ) {
    fail("invalid_package_lock", "package-lock.json must use lockfileVersion 3");
  }
  const lockPath = `node_modules/${packageName}`;
  const entry = lock.packages[lockPath];
  if (!entry || !entry.version || !entry.integrity || !entry.resolved) {
    fail(
      "missing_locked_package",
      `package-lock.json lacks complete metadata for ${packageName}`,
    );
  }
  return { lockPath, entry };
}

function readRegularFile(root, relative, label) {
  const file = resolveInside(root, relative, label);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    fail("missing_input", `${label} is missing or not a regular file`, {
      file,
    });
  }
  return {
    file,
    path: relative,
    bytes: fs.statSync(file).size,
    sha256: sha256File(file),
  };
}

function createBuildLock(options) {
  const opts = options || {};
  const repoRoot = fs.realpathSync(requiredString(opts.repoRoot, "repoRoot"));
  const outputRoot = fs.realpathSync(
    requiredString(opts.outputRoot, "outputRoot"),
  );
  const recipeFile = resolveInside(
    repoRoot,
    opts.recipePath || "vendor/build-lock.recipe.json",
    "recipePath",
  );
  const recipe = normalizeRecipe(
    loadJsonFile(recipeFile, "vendor build recipe"),
  );
  const packageLockFile = resolveInside(
    repoRoot,
    recipe.packageLock,
    "recipe.packageLock",
  );
  const packageLock = loadJsonFile(packageLockFile, "package-lock.json");
  const packageLockSha256 = sha256File(packageLockFile);
  const recipeSha256 = sha256File(recipeFile);
  const operationAttestations = recipe.operations.map((operation) => {
    const { lockPath, entry } = lockPackage(packageLock, operation.package);
    if (entry.version !== operation.expectedVersion) {
      fail(
        "version_mismatch",
        `${operation.package} recipe version differs from package-lock.json`,
        { expected: operation.expectedVersion, actual: entry.version },
      );
    }
    const packageRoot = resolveInside(
      repoRoot,
      lockPath,
      `package root for ${operation.package}`,
    );
    const packageMetadata = readRegularFile(
      packageRoot,
      "package.json",
      `${operation.package} package.json`,
    );
    const installed = loadJsonFile(
      packageMetadata.file,
      `${operation.package} package.json`,
    );
    if (installed.version !== entry.version) {
      fail(
        "installed_version_mismatch",
        `${operation.package} installed version differs from package-lock.json`,
      );
    }
    const input = readRegularFile(
      packageRoot,
      operation.sourcePath,
      `${operation.lockRef} source`,
    );
    const output = readRegularFile(
      outputRoot,
      operation.outputPath,
      `${operation.lockRef} output`,
    );
    if (input.bytes !== output.bytes || input.sha256 !== output.sha256) {
      fail(
        "output_drift",
        `${operation.outputPath} is not an exact copy of the locked package input`,
        { input, output },
      );
    }
    const auxiliaryInputs = operation.auxiliaryInputs.map((relative) =>
      readRegularFile(
        packageRoot,
        relative,
        `${operation.lockRef} auxiliary input`,
      ),
    );
    return Object.freeze({
      lockRef: operation.lockRef,
      method: operation.method,
      component: Object.freeze({
        name: operation.package,
        version: entry.version,
        purl: npmPurl(operation.package, entry.version),
        integrity: entry.integrity,
        resolved: entry.resolved,
        lockPath,
      }),
      input: Object.freeze({
        path: operation.sourcePath,
        bytes: input.bytes,
        sha256: input.sha256,
      }),
      auxiliaryInputs: Object.freeze(
        auxiliaryInputs.map((item) =>
          Object.freeze({
            path: item.path,
            bytes: item.bytes,
            sha256: item.sha256,
          }),
        ),
      ),
      output: Object.freeze({
        path: operation.outputPath,
        bytes: output.bytes,
        sha256: output.sha256,
      }),
    });
  });
  const lockId = sha256Buffer(
    Buffer.from(
      stableJson({
        recipe,
        recipeSha256,
        packageLockSha256,
        operations: operationAttestations,
      }),
    ),
  );
  return Object.freeze({
    schemaVersion: BUILD_LOCK_SCHEMA_VERSION,
    type: BUILD_LOCK_TYPE,
    lockId,
    recipe: Object.freeze({
      path: path.relative(repoRoot, recipeFile).replace(/\\/g, "/"),
      recipeId: recipe.recipeId,
      sha256: recipeSha256,
      packageManager: recipe.packageManager,
      knownGaps: recipe.knownGaps,
    }),
    packageLock: Object.freeze({
      path: recipe.packageLock,
      sha256: packageLockSha256,
      lockfileVersion: packageLock.lockfileVersion,
    }),
    operations: Object.freeze(operationAttestations),
  });
}

function buildLockReference(lock, lockRef) {
  if (
    !lock ||
    lock.type !== BUILD_LOCK_TYPE ||
    !HASH_PATTERN.test(String(lock.lockId || ""))
  ) {
    fail("invalid_build_lock", "a valid vendor build lock is required");
  }
  const ref = requiredString(lockRef, "lockRef");
  if (!lock.operations.some((operation) => operation.lockRef === ref)) {
    fail("unknown_lock_ref", `${ref} is not present in the vendor build lock`);
  }
  return Object.freeze({
    type: REFERENCE_TYPE,
    schemaVersion: BUILD_LOCK_SCHEMA_VERSION,
    lockId: lock.lockId,
    lockRef: ref,
  });
}

function writeBuildLock(options) {
  const opts = options || {};
  const lock = createBuildLock(opts);
  const outputRoot = fs.realpathSync(
    requiredString(opts.outputRoot, "outputRoot"),
  );
  const relative = normalizeRelativePath(
    opts.outputPath || "vendor/build-lock.json",
    "outputPath",
  );
  const destination = resolveInside(outputRoot, relative, "outputPath");
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, `${JSON.stringify(lock, null, 2)}\n`);
  return Object.freeze({
    lock,
    path: relative,
    sha256: sha256File(destination),
  });
}

function parseArgs(argv) {
  const options = {
    repoRoot: path.resolve(__dirname, ".."),
    outputRoot: path.resolve(__dirname, "..", "_site"),
    recipePath: "vendor/build-lock.recipe.json",
    outputPath: "vendor/build-lock.json",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--root") options.repoRoot = path.resolve(argv[++index]);
    else if (argument === "--output-root") {
      options.outputRoot = path.resolve(argv[++index]);
    } else if (argument === "--recipe") options.recipePath = argv[++index];
    else if (argument === "--output") options.outputPath = argv[++index];
    else if (argument === "--check") options.checkOnly = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else fail("unknown_argument", `unknown argument ${argument}`);
  }
  return options;
}

function printHelp() {
  process.stdout.write(
    "Usage: node scripts/vendor-build-lock.js [--root <repo>] " +
      "[--output-root <site>] [--recipe <path>] [--output <path>] [--check]\n",
  );
}

function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return 0;
  }
  if (options.checkOnly) {
    const lock = createBuildLock(options);
    process.stdout.write(`${lock.lockId}\n`);
  } else {
    const result = writeBuildLock(options);
    process.stdout.write(
      `[vendor-build-lock] wrote ${result.path} (${result.lock.lockId})\n`,
    );
  }
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
    process.exitCode = 1;
  }
}

module.exports = Object.freeze({
  RECIPE_SCHEMA_VERSION,
  BUILD_LOCK_SCHEMA_VERSION,
  RECIPE_TYPE,
  BUILD_LOCK_TYPE,
  REFERENCE_TYPE,
  VendorBuildLockError,
  sha256Buffer,
  stableJson,
  npmPurl,
  normalizeRecipe,
  createBuildLock,
  buildLockReference,
  writeBuildLock,
  parseArgs,
  main,
});
