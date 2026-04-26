# Unfallatlas – Release Guide

This document describes how to create a versioned release of Unfallatlas and
what artefacts are produced for downstream consumers.

---

## Prerequisites

- You must have write access to the `carstenartur/Unfallatlas` repository.
- `analysis-service/pom.xml` must carry a `-SNAPSHOT` version (e.g.
  `0.1.0-SNAPSHOT`).  The release workflow enforces this and fails with a clear
  error message if the version is not a SNAPSHOT.

---

## Triggering a Release

1. Open **GitHub → Actions → Release Workflow**.
2. Click **Run workflow** and fill in the inputs:

   | Input | Description | Example |
   |-------|-------------|---------|
   | `release_version` | Semantic version to release (`X.Y.Z`) | `0.1.0` |
   | `skip_tests` | Skip the test suite (not recommended) | `false` |
   | `dry_run` | Validate and build everything without publishing | `true` |

3. Start with `dry_run: true` to verify the run is green before publishing.
4. Re-run with `dry_run: false` to publish the actual release.

---

## What Happens During a Release

### Preflight job

- Checks out the repository with full history.
- Reads the current SNAPSHOT version from `analysis-service/pom.xml`.
- Validates that `release_version` follows `X.Y.Z` semver.
- Confirms that the tag `v<release_version>` does not yet exist.
- Runs `mvn validate` on the analysis-service POM.
- Writes a summary table to the GitHub Actions step summary.

### Release job

1. **Version bump** – sets `analysis-service/pom.xml` to `<release_version>`
   and syncs `package.json` if it carries a `version` field.
2. **Commit** – commits the version change to `main` (via a protected
   temp-branch + GitHub API fast-forward so branch-protection rules are
   respected).
3. **Build & Verify** – runs `mvn clean verify` (and `npm test` unless
   `skip_tests` is set).
4. **Website bundle** – zips the static web application into
   `unfallatlas-website-<version>.zip` (HTML pages, `css/`, `js/`, `tours/`,
   `templates/`).  The large GeoJSON/CSV data in `out/` is intentionally
   **excluded** from this bundle; those files are regenerated independently by
   the *Generate & Commit* workflow.
5. **Git tag** – creates an annotated tag `v<release_version>` via the GitHub
   API.  This tag triggers `docker-publish.yml`, which publishes the Docker
   image.
6. **Maintenance branch** – creates `maintenance/<major>.<minor>.x` if it does
   not yet exist.
7. **GitHub Release** – creates a GitHub Release with auto-generated release
   notes and attaches the two release assets.
8. **Next-SNAPSHOT PR** – bumps the version to
   `<major>.<minor>.<patch+1>-SNAPSHOT`, pushes a branch
   `release/prepare-next-…`, and opens a pull request.

---

## Release Artefacts

After a successful release with version `X.Y.Z`:

| Artefact | Location |
|----------|----------|
| Docker image | `ghcr.io/carstenartur/unfallatlas:X.Y.Z` |
| Docker image (minor alias) | `ghcr.io/carstenartur/unfallatlas:X.Y` |
| Docker image (latest) | `ghcr.io/carstenartur/unfallatlas:latest` |
| Spring Boot JAR | GitHub Release asset `unfallatlas-analysis-service-X.Y.Z.jar` |
| Static website bundle | GitHub Release asset `unfallatlas-website-X.Y.Z.zip` |
| Git tag | `vX.Y.Z` on `main` |
| Maintenance branch | `maintenance/X.Y.x` |

---

## Consuming the Docker Image

```bash
# Pull a specific version
docker pull ghcr.io/carstenartur/unfallatlas:0.1.0

# Or always use the latest release
docker pull ghcr.io/carstenartur/unfallatlas:latest

# Run (in-memory H2, no external DB required)
docker run -p 8081:8081 ghcr.io/carstenartur/unfallatlas:0.1.0

# Run with external PostgreSQL
docker run -p 8081:8081 \
  -e SPRING_PROFILES_ACTIVE=prod \
  -e ANALYSIS_DB_URL=jdbc:postgresql://db:5432/unfallatlas \
  -e ANALYSIS_DB_USER=unfallatlas \
  -e ANALYSIS_DB_PASSWORD=secret \
  ghcr.io/carstenartur/unfallatlas:0.1.0
```

---

## Maintenance Branches

Each release creates a `maintenance/<major>.<minor>.x` branch.  Bug fixes for
a published minor version should be cherry-picked onto that branch and released
from it using the same workflow (pointing the workflow at the branch rather than
`main`).

---

## After the Release

The release workflow automatically opens a pull request titled
**"Prepare for next development iteration X.Y.Z-SNAPSHOT"**.  Review and merge
this PR to resume normal development on the next patch version.

---

## Dry Run

Running with `dry_run: true` performs all validation and build steps but skips:

- Pushing the release commit to `main`
- Creating the Git tag
- Creating the GitHub Release
- Uploading release assets
- Creating the maintenance branch
- Pushing the next-SNAPSHOT branch / opening the PR

Each skipped step emits a `::notice::` annotation in the workflow log so you
can verify what *would* happen.
