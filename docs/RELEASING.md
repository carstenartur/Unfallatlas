# Unfallwerkbank – Release Guide

This guide describes the authoritative GitHub Actions release path, its
acceptance gates, and the artefacts produced for downstream consumers.

---

## Prerequisites

Before starting a release:

- You must have write access to `carstenartur/Unfallatlas`.
- The repository version returned by
  `.github/scripts/project-version.py get` must use
  `X.Y.Z-SNAPSHOT`. The workflow derives the release version by removing the
  `-SNAPSHOT` suffix and rejects inconsistent Maven, npm, citation, or archive
  metadata.
- The current candidate must have a recent, fingerprint-matching Microsoft Word
  compatibility receipt. See
  [`word-compatibility-release-check.md`](word-compatibility-release-check.md).
- Known provenance limitations must be resolved far enough for the
  `release-site` gate to pass. In particular, issue
  [#406](https://github.com/carstenartur/Unfallatlas/issues/406) documents the
  remaining component-level vendor provenance work.

There is deliberately **no test-skipping release input**. A release cannot be
created with `-DskipTests`, `maven.test.skip`, or an equivalent workflow option.

---

## Triggering a release

1. Open **GitHub → Actions → Release Workflow**.
2. Select **Run workflow**.
3. Configure the inputs:

   | Input | Meaning | Example |
   |---|---|---|
   | `next_development_version` | Optional exact version to use after the release; must be `X.Y.Z-SNAPSHOT`. Leave empty to use the increment choice. | `2.1.5-SNAPSHOT` |
   | `next_version_increment` | `patch`, `minor`, or `major` when no exact next version is supplied. | `patch` |
   | `dry_run` | Run the complete release acceptance matrix and build candidate artefacts without remote repository or release mutation. | `true` |

4. Start with `dry_run: true`.
5. Inspect the uploaded acceptance evidence and candidate assets.
6. Only after the dry run and Word evidence are green, repeat with
   `dry_run: false`.

The release version itself is not entered manually. For example,
`2.1.4-SNAPSHOT` produces release `2.1.4`.

---

## Authoritative acceptance matrix

After setting and locally committing the release version, the workflow executes
one Maven-owned acceptance command on that exact commit:

```bash
mvn -B -ntp clean verify \
  -Prelease-site,pages,e2e,system-it,location-brief-golden,document-render \
  '-Dfailsafe.includes=**/*IT.java'
```

The explicit Failsafe override is required because the
`location-brief-golden` profile otherwise narrows the integration-test include
pattern to its own Golden test. The release command restores the complete
`**/*IT.java` matrix.

The profiles cover:

| Profile | Release responsibility |
|---|---|
| `pages` | Canonical Pages build, browser runtime checks, offline/vendor and manifest contracts |
| `e2e` | Chromium, Firefox, and WebKit end-to-end acceptance |
| `system-it` | Java/Testcontainers system integration tests |
| `location-brief-golden` | Versioned filing/location-brief Golden cases and evidence |
| `document-render` | Native PDF and LibreOffice-rendered DOCX auditing with Poppler |
| `release-site` | Publication bundle, media, licence, SBOM, and vendor-provenance gates |

The runner is prepared for this combined workload before the release version is
changed:

- unrelated preinstalled SDKs and unused Docker objects are removed to reclaim
  disk space;
- Docker availability is verified;
- the Ubuntu package source is normalised away from a stalled regional mirror;
- APT retries and connection timeouts are bounded;
- LibreOffice Writer, Poppler, and required document fonts are installed and
  verified;
- Playwright system dependencies are explicitly enabled for the pinned
  Chromium, Firefox, and WebKit browsers.

The job timeout is 180 minutes because the previously separate browser,
Testcontainers, and rendered-document gates now execute authoritatively on one
release commit.

---

## Failure and evidence behaviour

The acceptance command runs before the first remote mutation. A failed command
therefore prevents:

- pushing the release commit to `main`;
- creating a tag;
- creating a maintenance branch;
- creating or publishing a GitHub Release;
- uploading assets to a GitHub Release;
- preparing or pushing the next-development branch.

The **release-acceptance-evidence** workflow artefact is uploaded with
`if: always()` and retains, where produced:

- the Maven acceptance log and release contract record under `out/qa/`;
- Unit, Surefire, Failsafe, and Testcontainers reports;
- Playwright reports and test results;
- rendered PDF/DOCX and Golden-case evidence;
- coverage;
- the site build manifest, third-party notices, and CycloneDX output.

This makes a failed dry run diagnosable without weakening any gate.

---

## Dry run

A dry run performs the same version-setting, metadata validation, local release
commit, system provisioning, and complete acceptance matrix as a real release.
It also creates the deterministic website ZIP.

It then uploads:

- `release-acceptance-evidence`;
- `release-dry-run-candidate-<version>`, containing the candidate Spring Boot
  JAR and website ZIP.

A dry run does **not**:

- push the release commit;
- create a tag;
- create a maintenance branch;
- create or publish a GitHub Release;
- upload GitHub Release assets;
- mutate or push a next-development branch;
- open the next-development pull request.

The local release commit is necessary so the acceptance matrix tests the exact
metadata state that would be published. No remote repository state is changed.

---

## Real release sequence

After the acceptance matrix succeeds and `dry_run` is false:

1. **Push release commit** – the locally tested release commit is fast-forwarded
   to authoritative `main` through a temporary branch and the GitHub API.
2. **Create annotated tag** – `vX.Y.Z` is attached to that exact commit.
3. **Create maintenance branch** – `maintenance/X.Y.x` is created when absent.
4. **Create draft GitHub Release** – release notes are generated.
5. **Upload assets** – the Spring Boot JAR and deterministic static-site ZIP are
   attached.
6. **Publish release** – the draft becomes the latest public release.
7. **Prepare next development version** – all project and archive metadata is
   changed to the selected next `-SNAPSHOT` version on a dedicated branch and a
   pull request is opened.

The tag also triggers `docker-publish.yml`. That workflow repeats the
publication-specific site and complete vendor-provenance checks before
authenticating to GHCR and publishing an image.

---

## Deterministic website bundle

The release workflow packages the already verified `_site/` directory as:

```text
unfallatlas-website-X.Y.Z.zip
```

To make the archive reproducible:

- file names are sorted bytewise;
- file timestamps are normalised to `1980-01-01 00:00 UTC`;
- `zip -X` removes host-specific metadata.

The bundle contains the exact locked browser assets, accident/context data,
build manifest, notices, licence evidence, and SBOM output accepted by the
release gates.

---

## Release artefacts

After a successful release `X.Y.Z`:

| Artefact | Location |
|---|---|
| Docker image | `ghcr.io/carstenartur/unfallatlas:X.Y.Z` |
| Docker minor alias | `ghcr.io/carstenartur/unfallatlas:X.Y` |
| Docker latest alias | `ghcr.io/carstenartur/unfallatlas:latest` |
| Spring Boot JAR | GitHub Release asset `unfallatlas-analysis-service-X.Y.Z.jar` |
| Static website bundle | GitHub Release asset `unfallatlas-website-X.Y.Z.zip` |
| Git tag | `vX.Y.Z` |
| Maintenance branch | `maintenance/X.Y.x` |
| Automated acceptance evidence | `release-acceptance-evidence` Actions artefact |
| Word compatibility report | Artefact of the matching Microsoft Word compatibility run |

---

## Microsoft Word evidence

LibreOffice is the automated DOCX renderer in CI, but Microsoft Word remains a
separate release environment.

- `config/word-compatibility-inputs.json` defines compatibility-sensitive
  inputs.
- `npm run validate:word-compatibility -- --print-fingerprint` computes the
  current fingerprint.
- `npm run validate:word-compatibility -- --write-template ...` creates a
  receipt template.
- The completed receipt records the tested DOCX hash, Word version, platform,
  reviewer, page count, and required checks.
- The validator rejects stale evidence, changed inputs, failed checks,
  malformed metadata, and undeclared fields.

The normal maximum age is 30 days. Any compatibility-sensitive change
invalidates the receipt immediately.

---

## Consuming the Docker image

```bash
docker pull ghcr.io/carstenartur/unfallatlas:X.Y.Z

docker run -p 8081:8081 \
  ghcr.io/carstenartur/unfallatlas:X.Y.Z
```

With PostgreSQL:

```bash
docker run -p 8081:8081 \
  -e SPRING_PROFILES_ACTIVE=prod \
  -e ANALYSIS_DB_URL=jdbc:postgresql://db:5432/unfallatlas \
  -e ANALYSIS_DB_USER=unfallatlas \
  -e ANALYSIS_DB_PASSWORD=secret \
  ghcr.io/carstenartur/unfallatlas:X.Y.Z
```

---

## Maintenance branches

The workflow creates `maintenance/X.Y.x` as an immutable release-line anchor
when the branch does not already exist.

The current release workflow intentionally checks out authoritative `main` and
sets `main` as its release base. Automated patch releases directly from a
maintenance branch are therefore not yet supported by this workflow and must
not be inferred from the presence of the maintenance branch alone.

---

## After the release

Review and merge the automatically opened
`release/prepare-next-X.Y.Z-SNAPSHOT` pull request. Retain the automated
acceptance evidence and the matching Word compatibility report with the release
records.
