'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  VENDOR_BUILD_LOCK_REFERENCE_TYPE,
  VENDOR_BUILD_LOCK_SCHEMA_VERSION,
  VENDOR_BUILD_LOCK_TYPE,
  validateCompletenessClaims,
} = require('../../scripts/vendor-provenance');
const {
  loadAndValidateVendorBuildLock,
  validateCompleteSbom,
  validatePolicyBinding,
  validateVendorBuildLock,
} = require('../../scripts/validate-vendor-provenance');

const HASH = 'a'.repeat(64);
const LOCK_ID = 'unfallatlas-vendor-build-2026-07-19';
const PURL = 'pkg:npm/example@1.0.0';
const clone = value => JSON.parse(JSON.stringify(value));
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const sha512 = value => crypto.createHash('sha512').update(value).digest('hex');
const sriSha512 = value => `sha512-${crypto.createHash('sha512').update(value).digest('base64')}`;
const DSSE_PAYLOAD_TYPE = 'application/vnd.in-toto+json';

function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function dssePae(payloadType, payload) {
  return Buffer.concat([
    Buffer.from(`DSSEv1 ${Buffer.byteLength(payloadType)} ${payloadType} ${payload.length} `),
    payload,
  ]);
}

function createTrustedBuilder(suffix) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const der = publicKey.export({ format: 'der', type: 'spki' });
  return {
    privateKey,
    policy: {
      keyId: `ed25519:${sha256(der)}`,
      builderId: `https://builder-${suffix}.example/vendor`,
      publicKey: { type: 'ed25519', encoding: 'spki-der-base64', value: der.toString('base64') },
    },
  };
}

function signDsseStatement(statement, builder) {
  const payload = Buffer.from(canonicalJson(statement));
  const signature = crypto.sign(null, dssePae(DSSE_PAYLOAD_TYPE, payload), builder.privateKey);
  return {
    payloadType: DSSE_PAYLOAD_TYPE,
    payload: payload.toString('base64'),
    signatures: [{ keyid: builder.policy.keyId, sig: signature.toString('base64') }],
  };
}

function lockReference(lockRef) {
  return {
    type: VENDOR_BUILD_LOCK_REFERENCE_TYPE,
    schemaVersion: VENDOR_BUILD_LOCK_SCHEMA_VERSION,
    lockId: LOCK_ID,
    lockRef,
  };
}

function completeManifest() {
  const fontNames = ['Regular', 'Italic', 'Medium', 'MediumItalic']
    .map(style => `Example-${style}.ttf`);
  return {
    schemaVersion: 2,
    complete: true,
    inventoryScope: 'delivered-assets-component-level',
    knownGaps: [],
    provenancePolicy: { policyId: 'test-vendor-policy' },
    vendorBuildLock: {
      path: 'vendor/vendor-build-lock.json',
      sha256: HASH,
      reproducible: true,
      type: VENDOR_BUILD_LOCK_TYPE,
      schemaVersion: VENDOR_BUILD_LOCK_SCHEMA_VERSION,
      lockId: LOCK_ID,
    },
    sbom: { path: 'vendor/sbom.cdx.json', sha256: HASH, specVersion: '1.6', complete: true },
    dependencies: [{
      package: 'example',
      version: '1.0.0',
      spdx: 'MIT',
      evidence: 'bundled-license-text',
      licenseTextPath: 'vendor/licenses/example.txt',
      licenseTextSha256: HASH,
    }],
    components: [{
      name: 'example',
      version: '1.0.0',
      purl: PURL,
      integrity: 'sha512-example',
      resolved: 'https://registry.npmjs.org/example/-/example-1.0.0.tgz',
      licenseExpression: 'MIT',
      licenseTexts: [{
        path: 'vendor/licenses/example.txt',
        sha256: HASH,
        copyrightIncluded: true,
        attestation: lockReference('source:license:example'),
      }],
      attestation: lockReference('source:component:example'),
    }],
    assetAssessments: [{
      path: 'vendor/example.js',
      sha256: HASH,
      reproducible: true,
      provenanceComplete: true,
      contains: [PURL],
      containsFiles: fontNames.map(name => `urn:unfallatlas:font:${name}`).sort(),
      unresolvedDetectedComponents: [],
      gaps: [],
      buildAttestation: lockReference('output:vendor/example.js'),
    }],
    fontEvidence: fontNames.map(name => ({
      name,
      decodedFrom: 'vendor/example.js',
      decodedSha256: HASH,
      sourceSha256: HASH,
      nameTable: {
        family: 'Example',
        fullName: name.replace(/\.ttf$/, '').replace('-', ' '),
        postscriptName: name.replace(/\.ttf$/, ''),
        version: 'Version 1.000',
      },
      licenseExpression: 'OFL-1.1',
      licenseTexts: [{
        path: 'vendor/licenses/example-font.txt',
        sha256: HASH,
        copyrightIncluded: true,
        attestation: lockReference(`source:license:${name}`),
      }],
      attestation: lockReference(`source:font:${name}`),
    })),
  };
}

function completeSbom(manifest) {
  const asset = manifest.assetAssessments[0];
  const assetRef = `urn:unfallatlas:vendor-asset:${asset.path}`;
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    metadata: {
      properties: [{ name: 'unfallatlas:inventory-completeness', value: 'complete' }],
    },
    components: [
      { type: 'library', 'bom-ref': PURL, purl: PURL },
      { type: 'file', 'bom-ref': assetRef },
      ...manifest.fontEvidence.map(font => ({
        type: 'file',
        'bom-ref': `urn:unfallatlas:font:${font.name}`,
      })),
    ],
    dependencies: [{ ref: assetRef, dependsOn: [PURL, ...asset.containsFiles].sort() }],
    compositions: [{ aggregate: 'complete', assemblies: [assetRef] }],
  };
}

const MIT_LICENSE = `Copyright (c) 2026 Example Authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
`;

const OFL_LICENSE = `Copyright 2026 The Example Font Authors

SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007

PREAMBLE
The goals of the Open Font License are to stimulate worldwide development of
collaborative font projects and to provide a free and open framework in which
fonts may be shared and improved in partnership with others.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining a copy
of the Font Software, to use, study, copy, merge, embed, modify, redistribute,
and sell modified and unmodified copies of the Font Software.
`;

function createDeepFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-vendor-lock-'));
  const write = (relative, contents) => {
    const absolute = path.join(root, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, contents);
    return Buffer.from(contents);
  };
  const input = (id, type, relative, contents) => {
    const bytes = write(relative, contents);
    return { record: { id, type, path: relative, sha256: sha256(bytes) }, bytes };
  };

  const assetBytes = write('vendor/example.js', 'window.example = true;\n');
  const componentLicenseBytes = write('vendor/licenses/example.txt', MIT_LICENSE);
  const fontLicenseBytes = write('vendor/licenses/example-font.txt', OFL_LICENSE);
  const componentArchive = input(
    'input:component:example',
    'source-archive',
    'vendor/build-inputs/example-1.0.0.tgz',
    'deterministic component archive\n'
  );
  const toolInputs = [
    input('input:tool:node', 'toolchain-archive', 'vendor/build-inputs/node.tar.xz', 'node archive\n'),
    input('input:tool:npm', 'toolchain-archive', 'vendor/build-inputs/npm.tgz', 'npm archive\n'),
    input('input:tool:esbuild', 'toolchain-archive', 'vendor/build-inputs/esbuild.tgz', 'esbuild archive\n'),
  ];
  const configInput = input(
    'input:build-config',
    'build-config',
    'vendor/build-inputs/build-config.json',
    '{"minify":true}\n'
  );
  const buildScriptInput = input(
    'input:build-script',
    'build-config',
    'vendor/build-inputs/build-vendor.js',
    'require("esbuild").buildSync({});\n'
  );
  const componentLicenseInput = {
    record: {
      id: 'input:license:example',
      type: 'license-file',
      path: 'vendor/licenses/example.txt',
      sha256: sha256(componentLicenseBytes),
    },
    bytes: componentLicenseBytes,
  };
  const fontLicenseInput = {
    record: {
      id: 'input:license:font',
      type: 'license-file',
      path: 'vendor/licenses/example-font.txt',
      sha256: sha256(fontLicenseBytes),
    },
    bytes: fontLicenseBytes,
  };

  const manifest = completeManifest();
  manifest.assetAssessments[0].sha256 = sha256(assetBytes);
  manifest.components[0].integrity = sriSha512(componentArchive.bytes);
  manifest.components[0].licenseTexts[0].sha256 = sha256(componentLicenseBytes);
  manifest.dependencies[0].licenseTextSha256 = sha256(componentLicenseBytes);

  const fontInputs = manifest.fontEvidence.map((font, index) => {
    const source = input(
      `input:font:${index}`,
      'source-file',
      `vendor/build-inputs/${font.name}`,
      `font source ${font.name}\n`
    );
    font.decodedSha256 = source.record.sha256;
    font.sourceSha256 = source.record.sha256;
    font.licenseTexts[0].sha256 = sha256(fontLicenseBytes);
    return source;
  });

  const outputId = manifest.assetAssessments[0].buildAttestation.lockRef;
  const toolchain = [
    {
      id: 'tool:node',
      type: 'runtime',
      name: 'node',
      version: '24.4.1',
      upstream: {
        type: 'release-archive',
        locator: 'https://nodejs.org/dist/v24.4.1/node-v24.4.1-linux-x64.tar.xz',
        digest: { algorithm: 'sha256', value: toolInputs[0].record.sha256 },
        inputRef: toolInputs[0].record.id,
      },
    },
    {
      id: 'tool:npm',
      type: 'package-manager',
      name: 'npm',
      version: '11.4.2',
      upstream: {
        type: 'npm-registry-archive',
        locator: 'pkg:npm/npm@11.4.2',
        digest: { algorithm: 'sha256', value: toolInputs[1].record.sha256 },
        inputRef: toolInputs[1].record.id,
      },
    },
    {
      id: 'tool:esbuild',
      type: 'build-tool',
      name: 'esbuild',
      version: '0.25.6',
      upstream: {
        type: 'npm-registry-archive',
        locator: 'pkg:npm/esbuild@0.25.6',
        digest: { algorithm: 'sha256', value: toolInputs[2].record.sha256 },
        inputRef: toolInputs[2].record.id,
      },
    },
  ];

  const sources = [{
    id: manifest.components[0].attestation.lockRef,
    type: 'component',
    subject: {
      type: 'component',
      purl: PURL,
      version: manifest.components[0].version,
      integrity: manifest.components[0].integrity,
    },
    upstream: {
      type: 'npm-registry-archive',
      locator: manifest.components[0].resolved,
      digest: { algorithm: 'sha512', value: sha512(componentArchive.bytes) },
      inputRef: componentArchive.record.id,
    },
  }, {
    id: manifest.components[0].licenseTexts[0].attestation.lockRef,
    type: 'license',
    subject: {
      type: 'license',
      ownerRef: PURL,
      path: manifest.components[0].licenseTexts[0].path,
      sha256: manifest.components[0].licenseTexts[0].sha256,
      copyrightIncluded: true,
    },
    upstream: {
      type: 'source-file',
      locator: `${PURL}#LICENSE`,
      digest: { algorithm: 'sha256', value: componentLicenseInput.record.sha256 },
      inputRef: componentLicenseInput.record.id,
    },
  }];
  manifest.fontEvidence.forEach((font, index) => {
    const fontRef = `urn:unfallatlas:font:${font.name}`;
    sources.push({
      id: font.attestation.lockRef,
      type: 'font',
      subject: { type: 'font', ref: fontRef, name: font.name, sha256: font.sourceSha256 },
      upstream: {
        type: 'source-file',
        locator: `https://fonts.example/${font.name}`,
        digest: { algorithm: 'sha256', value: font.sourceSha256 },
        inputRef: fontInputs[index].record.id,
      },
    }, {
      id: font.licenseTexts[0].attestation.lockRef,
      type: 'license',
      subject: {
        type: 'license',
        ownerRef: fontRef,
        path: font.licenseTexts[0].path,
        sha256: font.licenseTexts[0].sha256,
        copyrightIncluded: true,
      },
      upstream: {
        type: 'source-file',
        locator: 'https://fonts.example/OFL.txt',
        digest: { algorithm: 'sha256', value: fontLicenseInput.record.sha256 },
        inputRef: fontLicenseInput.record.id,
      },
    });
  });

  const commandInputRefs = [
    ...toolInputs.map(entry => entry.record.id),
    componentArchive.record.id,
    ...fontInputs.map(entry => entry.record.id),
    configInput.record.id,
    buildScriptInput.record.id,
  ];
  const command = {
    id: 'command:build-vendor',
    cwd: '.',
    argv: ['node', 'vendor/build-inputs/build-vendor.js', '--locked'],
    toolchainRefs: toolchain.map(tool => tool.id),
    inputRefs: commandInputRefs,
    outputRefs: [outputId],
  };
  const baseInputs = [
    ...toolInputs.map(entry => entry.record),
    componentArchive.record,
    ...fontInputs.map(entry => entry.record),
    componentLicenseInput.record,
    fontLicenseInput.record,
    configInput.record,
    buildScriptInput.record,
  ];
  const inputById = new Map(baseInputs.map(entry => [entry.id, entry]));
  const toolInputById = new Map(toolInputs.map(entry => [entry.record.id, entry.record]));
  const attestedToolchain = command.toolchainRefs.map(ref => {
    const tool = toolchain.find(entry => entry.id === ref);
    const upstreamInput = toolInputById.get(tool.upstream.inputRef);
    return {
      id: tool.id,
      type: tool.type,
      name: tool.name,
      version: tool.version,
      upstream: {
        type: tool.upstream.type,
        locator: tool.upstream.locator,
        digest: { ...tool.upstream.digest },
        input: { path: upstreamInput.path, sha256: upstreamInput.sha256 },
      },
    };
  }).sort((left, right) => left.id.localeCompare(right.id));
  const resolvedDependencies = command.inputRefs.map(ref => {
    const resolvedInput = inputById.get(ref);
    return { uri: `file:${resolvedInput.path}`, digest: { sha256: resolvedInput.sha256 } };
  }).sort((left, right) => left.uri.localeCompare(right.uri));
  const builders = [createTrustedBuilder('a'), createTrustedBuilder('b')];
  const policy = { trustedVendorBuilders: builders.map(builder => builder.policy) };
  const statements = builders.map((builder, index) => ({
    _type: 'https://in-toto.io/Statement/v1',
    subject: [{
      name: manifest.assetAssessments[0].path,
      digest: { sha256: manifest.assetAssessments[0].sha256 },
    }],
    predicateType: 'https://slsa.dev/provenance/v1',
    predicate: {
      buildDefinition: {
        buildType: 'https://github.com/carstenartur/Unfallatlas/vendor-build/v1',
        externalParameters: {
          lockId: LOCK_ID,
          commandRef: command.id,
          cwd: command.cwd,
          argv: command.argv,
        },
        internalParameters: { toolchain: attestedToolchain },
        resolvedDependencies,
      },
      runDetails: {
        builder: { id: builder.policy.builderId },
        metadata: { invocationId: `urn:uuid:00000000-0000-4000-8000-00000000000${index + 1}` },
      },
    },
  }));
  const provenanceEntries = builders.map((builder, index) => input(
    `input:provenance:${index + 1}`,
    'dsse-provenance',
    `vendor/build-inputs/rebuild-${index + 1}.dsse.json`,
    `${JSON.stringify(signDsseStatement(statements[index], builder))}\n`
  ));
  const output = {
    id: outputId,
    path: manifest.assetAssessments[0].path,
    sha256: manifest.assetAssessments[0].sha256,
    commandRef: command.id,
    contains: [...manifest.assetAssessments[0].contains],
    containsFiles: [...manifest.assetAssessments[0].containsFiles],
    rebuilds: builders.map((builder, index) => ({
      builderKeyId: builder.policy.keyId,
      sha256: manifest.assetAssessments[0].sha256,
      provenanceInputRef: provenanceEntries[index].record.id,
    })),
  };
  const lock = {
    schemaVersion: VENDOR_BUILD_LOCK_SCHEMA_VERSION,
    type: VENDOR_BUILD_LOCK_TYPE,
    lockId: LOCK_ID,
    toolchain,
    commands: [command],
    inputs: [...baseInputs, ...provenanceEntries.map(entry => entry.record)],
    sources,
    outputs: [output],
  };
  const lockBytes = write(manifest.vendorBuildLock.path, `${JSON.stringify(lock, null, 2)}\n`);
  manifest.vendorBuildLock.sha256 = sha256(lockBytes);
  return { root, manifest, lock, policy, builders, statements, write };
}

describe('vendor provenance complete-claim mutation resistance', () => {
  test('accepts a structurally complete, versioned claim', () => {
    expect(() => validateCompletenessClaims(completeManifest())).not.toThrow();
  });

  test('rejects complete:true while known gaps remain', () => {
    const manifest = completeManifest();
    manifest.knownGaps.push({ id: 'opaque-bundle' });
    expect(() => validateCompletenessClaims(manifest)).toThrow(/known provenance gaps/);
  });

  test('keeps complete:true impossible when the separately bound policy trusts no builders', () => {
    const manifest = completeManifest();
    const policy = {
      schemaVersion: 1,
      policyId: manifest.provenancePolicy.policyId,
      trustedVendorBuilders: [],
      unresolvedAssets: [],
    };
    expect(() => validatePolicyBinding(manifest, policy)).toThrow(/two policy-trusted builders/);

    const substitutedArtifactPolicy = { ...policy, trackingIssue: 'https://attacker.example/keys' };
    expect(() => validatePolicyBinding(manifest, substitutedArtifactPolicy, policy))
      .toThrow(/policy metadata mismatch/);
  });

  test('rejects dummy component, font, license and asset attestations', () => {
    for (const mutate of [
      manifest => { manifest.components[0].attestation = {}; },
      manifest => { manifest.components[0].licenseTexts[0].attestation = {}; },
      manifest => { manifest.fontEvidence[0].attestation = {}; },
      manifest => { manifest.fontEvidence[0].licenseTexts[0].attestation = {}; },
      manifest => { manifest.assetAssessments[0].buildAttestation = {}; },
    ]) {
      const manifest = completeManifest();
      mutate(manifest);
      expect(() => validateCompletenessClaims(manifest)).toThrow(/build-lock reference/);
    }
  });

  test('rejects missing asset contains evidence and unresolved detected components', () => {
    const missingContains = completeManifest();
    missingContains.assetAssessments[0].contains = [];
    expect(() => validateCompletenessClaims(missingContains)).toThrow(/contains\/reproduction evidence/);

    const unresolved = completeManifest();
    unresolved.assetAssessments[0].unresolvedDetectedComponents = ['opaque-helper'];
    expect(() => validateCompletenessClaims(unresolved)).toThrow(/contains\/reproduction evidence/);
  });

  test('rejects missing, unbound or declarative-only component license evidence', () => {
    const missing = completeManifest();
    missing.components[0].licenseTexts = [];
    expect(() => validateCompletenessClaims(missing)).toThrow(/Component evidence is incomplete/);

    const missingCopyright = completeManifest();
    missingCopyright.components[0].licenseTexts[0].copyrightIncluded = false;
    expect(() => validateCompletenessClaims(missingCopyright)).toThrow(/Full license and copyright evidence/);

    const unboundDirectLicense = completeManifest();
    unboundDirectLicense.dependencies[0].licenseTextSha256 = 'b'.repeat(64);
    expect(() => validateCompletenessClaims(unboundDirectLicense)).toThrow(/not bound to its component/);
  });

  test('rejects missing or mismatched font provenance', () => {
    const noLicense = completeManifest();
    noLicense.fontEvidence[0].licenseTexts = [];
    expect(() => validateCompletenessClaims(noLicense)).toThrow(/Font provenance is incomplete/);

    const hashDrift = completeManifest();
    hashDrift.fontEvidence[0].sourceSha256 = 'b'.repeat(64);
    expect(() => validateCompletenessClaims(hashDrift)).toThrow(/Font provenance is incomplete/);
  });

  test('binds complete SBOM composition and dependency edges to asset contains relations', () => {
    const manifest = completeManifest();
    const sbom = completeSbom(manifest);
    expect(() => validateCompleteSbom(manifest, sbom)).not.toThrow();

    const missingEdge = clone(sbom);
    missingEdge.dependencies[0].dependsOn = [];
    expect(() => validateCompleteSbom(manifest, missingEdge)).toThrow(/contains relation mismatch/);

    const falseComposition = clone(sbom);
    falseComposition.compositions[0].aggregate = 'incomplete';
    expect(() => validateCompleteSbom(manifest, falseComposition)).toThrow(/exact complete composition/);

    const falseMetadata = clone(sbom);
    falseMetadata.metadata.properties[0].value = 'incomplete';
    expect(() => validateCompleteSbom(manifest, falseMetadata)).toThrow(/metadata is not marked complete/);
  });
});

describe('versioned vendor build-lock deep validation', () => {
  let fixture;

  beforeEach(() => {
    fixture = createDeepFixture();
  });

  afterEach(() => {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  const validateLock = (lock = fixture.lock, manifest = fixture.manifest, policy = fixture.policy) =>
    validateVendorBuildLock(fixture.root, manifest, lock, policy);
  const resetFixture = () => {
    fs.rmSync(fixture.root, { recursive: true, force: true });
    fixture = createDeepFixture();
  };
  const replaceProvenance = (lock, index, envelope) => {
    const ref = lock.outputs[0].rebuilds[index].provenanceInputRef;
    const input = lock.inputs.find(entry => entry.id === ref);
    const bytes = fixture.write(input.path, `${JSON.stringify(envelope)}\n`);
    input.sha256 = sha256(bytes);
  };

  test('accepts two policy-trusted Ed25519 builders with signed DSSE/in-toto/SLSA rebuilds', () => {
    expect(() => validateCompletenessClaims(fixture.manifest)).not.toThrow();
    expect(() => validateLock(clone(fixture.lock))).not.toThrow();
    expect(() => loadAndValidateVendorBuildLock(fixture.root, fixture.manifest, fixture.policy)).not.toThrow();
  });

  test('parses the hashed lock and rejects arbitrary lock contents', () => {
    const arbitrary = Buffer.from('{"arbitrary":true}\n');
    fixture.write(fixture.manifest.vendorBuildLock.path, arbitrary);
    fixture.manifest.vendorBuildLock.sha256 = sha256(arbitrary);
    expect(() => loadAndValidateVendorBuildLock(fixture.root, fixture.manifest, fixture.policy))
      .toThrow(/vendor build lock fields/);
  });

  test('rejects unsigned local JSON, wrong key IDs and lock-owned trust keys', () => {
    const unsigned = clone(fixture.lock);
    replaceProvenance(unsigned, 0, { builder: 'local', sha256: unsigned.outputs[0].sha256 });
    expect(() => validateLock(unsigned)).toThrow(/DSSE envelope/);

    resetFixture();
    const wrongKey = clone(fixture.lock);
    wrongKey.outputs[0].rebuilds[0].builderKeyId = `ed25519:${'b'.repeat(64)}`;
    expect(() => validateLock(wrongKey)).toThrow(/DSSE key id mismatch/);

    const lockOwnedKey = clone(fixture.lock);
    lockOwnedKey.trustedVendorBuilders = clone(fixture.policy.trustedVendorBuilders);
    expect(() => validateLock(lockOwnedKey, fixture.manifest, { trustedVendorBuilders: [] }))
      .toThrow(/vendor build lock fields/);
    expect(() => validateLock(clone(fixture.lock), fixture.manifest, { trustedVendorBuilders: [] }))
      .toThrow(/two policy-trusted builders/);
  });

  test('rejects output and signed rebuild hash mismatches', () => {
    const outputMismatch = clone(fixture.lock);
    outputMismatch.outputs[0].sha256 = 'b'.repeat(64);
    expect(() => validateLock(outputMismatch))
      .toThrow(/output\/asset binding mismatch/);

    const rebuildMismatch = clone(fixture.lock);
    rebuildMismatch.outputs[0].rebuilds[1].sha256 = 'b'.repeat(64);
    expect(() => validateLock(rebuildMismatch))
      .toThrow(/Output\/rebuild hash, builder or provenance mismatch/);
  });

  test('rejects payload, subject, command and complete input binding drift', () => {
    const changedPayload = clone(fixture.lock);
    const originalInput = changedPayload.inputs.find(entry => entry.id === 'input:provenance:1');
    const envelope = JSON.parse(fs.readFileSync(path.join(fixture.root, originalInput.path), 'utf8'));
    const payload = Buffer.from(envelope.payload, 'base64');
    payload[0] ^= 1;
    envelope.payload = payload.toString('base64');
    replaceProvenance(changedPayload, 0, envelope);
    expect(() => validateLock(changedPayload)).toThrow(/DSSE signature verification failed/);

    resetFixture();
    const wrongSubject = clone(fixture.lock);
    const statement = clone(fixture.statements[0]);
    statement.subject[0].digest.sha256 = 'b'.repeat(64);
    replaceProvenance(wrongSubject, 0, signDsseStatement(statement, fixture.builders[0]));
    expect(() => validateLock(wrongSubject)).toThrow(/output subject mismatch/);

    resetFixture();
    const commandDrift = clone(fixture.lock);
    commandDrift.commands[0].argv[2] = '--frozen';
    expect(() => validateLock(commandDrift)).toThrow(/command\/input\/toolchain mismatch/);

    resetFixture();
    const inputDrift = clone(fixture.lock);
    const config = inputDrift.inputs.find(entry => entry.id === 'input:build-config');
    const changedConfig = fixture.write(config.path, '{"minify":false}\n');
    config.sha256 = sha256(changedConfig);
    expect(() => validateLock(inputDrift)).toThrow(/command\/input\/toolchain mismatch/);
  });

  test('rejects the same trusted builder twice and duplicate invocation IDs', () => {
    const sameBuilder = clone(fixture.lock);
    sameBuilder.outputs[0].rebuilds[1].builderKeyId = sameBuilder.outputs[0].rebuilds[0].builderKeyId;
    expect(() => validateLock(sameBuilder)).toThrow(/hash, builder or provenance mismatch/);

    const duplicateInvocation = clone(fixture.lock);
    const statement = clone(fixture.statements[1]);
    statement.predicate.runDetails.metadata.invocationId =
      fixture.statements[0].predicate.runDetails.metadata.invocationId;
    replaceProvenance(duplicateInvocation, 1, signDsseStatement(statement, fixture.builders[1]));
    expect(() => validateLock(duplicateInvocation)).toThrow(/builders and invocations must be unique/);
  });

  test('rejects unbound license lock refs and dummy license bytes', () => {
    const unboundManifest = clone(fixture.manifest);
    unboundManifest.components[0].licenseTexts[0].attestation.lockRef = 'source:license:unbound';
    expect(() => validateLock(clone(fixture.lock), unboundManifest))
      .toThrow(/source refs mismatch/);

    const dummy = Buffer.from('Copyright (c) Nobody\nDummy license evidence\n');
    fixture.write('vendor/licenses/example.txt', dummy);
    const dummyManifest = clone(fixture.manifest);
    dummyManifest.components[0].licenseTexts[0].sha256 = sha256(dummy);
    dummyManifest.dependencies[0].licenseTextSha256 = sha256(dummy);
    const dummyLock = clone(fixture.lock);
    const input = dummyLock.inputs.find(entry => entry.id === 'input:license:example');
    input.sha256 = sha256(dummy);
    const source = dummyLock.sources.find(entry => entry.id === 'source:license:example');
    source.subject.sha256 = sha256(dummy);
    source.upstream.digest.value = sha256(dummy);
    expect(() => validateLock(dummyLock, dummyManifest))
      .toThrow(/not a full license and copyright text/);
  });

  test('rejects traversal, symlinked inputs, shell commands and upstream drift', () => {
    const traversal = clone(fixture.lock);
    traversal.inputs[0].path = '../outside.tar.xz';
    expect(() => validateLock(traversal))
      .toThrow(/Unsafe vendor build input path/);

    const symlinkTarget = path.join(fixture.root, 'vendor/build-inputs/node-target.tar.xz');
    fs.writeFileSync(symlinkTarget, 'node archive\n');
    const symlinkPath = path.join(fixture.root, 'vendor/build-inputs/node-link.tar.xz');
    fs.symlinkSync(symlinkTarget, symlinkPath);
    const symlink = clone(fixture.lock);
    symlink.inputs[0].path = 'vendor/build-inputs/node-link.tar.xz';
    expect(() => validateLock(symlink))
      .toThrow(/traverses a symbolic link/);

    const shellCommand = clone(fixture.lock);
    shellCommand.commands[0].argv = ['sh', '-c', 'node build.js'];
    expect(() => validateLock(shellCommand))
      .toThrow(/not a direct toolchain argv invocation/);

    const upstreamDrift = clone(fixture.lock);
    upstreamDrift.sources.find(source => source.type === 'component').upstream.digest.value = 'b'.repeat(128);
    expect(() => validateLock(upstreamDrift))
      .toThrow(/upstream digest does not match local input/);
  });
});
