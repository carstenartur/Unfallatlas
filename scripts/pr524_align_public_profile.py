#!/usr/bin/env python3
"""One-shot alignment for PR #524.

This script converts the public Pages profile from a reduced capability set to
an honest full browser distribution. Concrete compliance failures stay hard;
declared component-level reproducibility gaps stay visible but non-blocking.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path.cwd()


def read(relative: str) -> str:
    return (ROOT / relative).read_text(encoding="utf-8")


def write(relative: str, text: str) -> None:
    (ROOT / relative).write_text(text, encoding="utf-8")


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if old in text:
        count = text.count(old)
        if count != 1:
            raise RuntimeError(f"{label}: expected one old block, found {count}")
        return text.replace(old, new, 1)
    if new in text:
        return text
    raise RuntimeError(f"{label}: neither old nor new block found")


def replace_optional(text: str, old: str, new: str) -> str:
    return text.replace(old, new)


def align_readme() -> None:
    path = "README.md"
    text = read(path)
    text = replace_optional(
        text,
        "![Startansicht des vollständigen Unfallwerkbank-Builds]",
        "![Startansicht der Unfallwerkbank]",
    )
    text = replace_optional(
        text,
        "[→ Öffentliche Kernvorschau öffnen]",
        "[→ Öffentliche Browser-Version öffnen]",
    )
    text = replace_once(
        text,
        "Die Ergebnisse lassen sich als reproduzierbarer Link teilen und als CSV,\n"
        "GeoJSON oder KML exportieren. Der vollständige lokale beziehungsweise\n"
        "Docker-Build erzeugt zusätzlich PDF- und Word-Antragsentwürfe mit Karten-\n"
        "und Tabellenkontext.",
        "Die Ergebnisse lassen sich als reproduzierbarer Link teilen und als CSV,\n"
        "GeoJSON, KML, PDF oder Word exportieren. Diese browserseitigen Funktionen\n"
        "stehen auch in der öffentlichen GitHub-Pages-Version zur Verfügung. Nur der\n"
        "Videoexport benötigt ein Server-Backend und bleibt dort deaktiviert.",
        "README feature summary",
    )
    text = replace_optional(
        text,
        "- **Öffentliche Kernvorschau:**",
        "- **Öffentliche Browser-Version:**",
    )
    text = replace_once(
        text,
        "> **Funktionsumfang der öffentlichen Vorschau:** Kartenanalyse, Filter, Cluster\n"
        "> sowie CSV-, GeoJSON- und KML-Export. Word/PDF, Heatmap und freie\n"
        "> Rechteckzeichnung sind dort aus Gründen der sicheren Vendor- und\n"
        "> Lizenzprovenienz vorübergehend deaktiviert. Der vollständige Funktionsumfang\n"
        "> steht im lokalen beziehungsweise Docker-Build zur Verfügung.",
        "> **Funktionsumfang der öffentlichen Browser-Version:** Kartenanalyse, Filter,\n"
        "> Cluster, Heatmap, freie Rechteckauswahl sowie CSV-, GeoJSON-, KML-, Word- und\n"
        "> PDF-Export. Nur der Videoexport ist auf GitHub Pages deaktiviert, weil er ein\n"
        "> Server-Backend benötigt. Für die Browser-Bundles sind keine konkreten\n"
        "> Lizenzbeschränkungen bekannt; offene bytegenaue Build- und SBOM-Nachweise\n"
        "> werden transparent als Hardening-Arbeit dokumentiert.",
        "README public scope",
    )
    text = replace_optional(text, "Lokale, vollständige Ausführung:", "Lokale Ausführung:")
    text = replace_optional(
        text,
        "1. **[Öffentliche Vorschau öffnen]",
        "1. **[Öffentliche Browser-Version öffnen]",
    )
    text = replace_optional(
        text,
        "5. **Exportieren** – öffentlich als CSV/GeoJSON/KML; im vollständigen Build zusätzlich als PDF/Word.",
        "5. **Exportieren** – als CSV, GeoJSON, KML, PDF oder Word; Video nur mit Server-Backend.",
    )
    text = replace_optional(
        text,
        "| **Cluster, Heatmap, Hotspots** | Mehrere Perspektiven auf Unfallschwerpunkte; Heatmap im vollständigen Build |",
        "| **Cluster, Heatmap, Hotspots** | Mehrere Perspektiven auf Unfallschwerpunkte einschließlich Heatmap |",
    )
    text = replace_optional(
        text,
        "| **Bereichsauswahl** | Geteilte Auswahlgrenzen in der URL; freie Rechteckzeichnung im vollständigen Build |",
        "| **Bereichsauswahl** | Geteilte Auswahlgrenzen in der URL und freie Rechteckzeichnung |",
    )
    text = replace_optional(
        text,
        "| **Export & Datenexport** | Öffentlich CSV, GeoJSON und KML; vollständig zusätzlich PDF und Word |",
        "| **Export & Datenexport** | CSV, GeoJSON, KML, PDF und Word; Video mit Server-Backend |",
    )
    text = replace_once(
        text,
        "Der folgende Screenshot dokumentiert die zusätzliche **Heatmap des vollständigen\n"
        "Builds** und ist deshalb bewusst nicht als identische Pages-Ansicht verlinkt:",
        "Der folgende Screenshot dokumentiert die **Heatmap**. Die Funktion ist auch in\n"
        "der öffentlichen Browser-Version verfügbar:",
        "README heatmap explanation",
    )
    text = replace_optional(
        text,
        "![Bonn Hbf – Rad+Auto-Heatmap im vollständigen Build]",
        "![Bonn Hbf – Rad+Auto-Heatmap]",
    )
    text = replace_once(
        text,
        "– dort stehen CSV, GeoJSON und KML zur Verfügung. Der Voll-Build-Screenshot mit\n"
        "Word/PDF ist in der [Nutzerdokumentation](docs/DOKUMENTATION.md#export-und-bezirksratsantrag)\n"
        "erklärt und wird nicht als identische Pages-Ansicht ausgegeben.",
        "– dort stehen CSV, GeoJSON, KML, Word und PDF zur Verfügung. Der Videoexport\n"
        "bleibt dem lokalen beziehungsweise Docker-Betrieb mit Server-Backend vorbehalten.",
        "README export explanation",
    )
    text = replace_optional(
        text,
        "| Startansicht (Voll-Build) | Cluster (öffentliche Vorschau) |",
        "| Startansicht | Cluster (öffentliche Browser-Version) |",
    )
    write(path, text)


def align_site_build_doc() -> None:
    path = "docs/site-build.md"
    text = read(path)
    if "## Vendor-, Lizenz- und Provenienzpolitik" in text:
        return
    start_marker = "Der Site-Build darf für Test und Review"
    end_marker = "\n## Netzwerk- und Offline-Verhalten"
    start = text.find(start_marker)
    end = text.find(end_marker, start)
    if start < 0 or end < 0:
        raise RuntimeError("site-build policy section not found")
    policy = """## Vendor-, Lizenz- und Provenienzpolitik

Der öffentliche Pages-Build liefert die vollständigen browserseitigen Funktionen aus:
Heatmap, freie Rechteckauswahl sowie Word- und PDF-Export. Nur der Videoexport
bleibt auf GitHub Pages deaktiviert, weil dafür ein Server-Backend erforderlich ist.

Die Veröffentlichung bleibt fail-closed bei konkreten Compliance-Fehlern:

- unbekannte oder mit der Verteilung unvereinbare Lizenz,
- fehlender erforderlicher Lizenz- oder Copyrighttext,
- Hash- oder Versionsdrift eines ausgelieferten Assets,
- nicht deklarierte Drittkomponente oder verschwiegene Restlücke.

Davon getrennt werden bytegenaue Reproduzierbarkeit, Build-Attestierungen und eine
vollständige komponentengenaue SBOM als Hardening-Ziel behandelt. Solche bekannten
Lücken bleiben in `third-party-notices.json`, `vendor/provenance-policy.json`, der
CycloneDX-SBOM und dem Build-Manifest sichtbar (`complete:false`), deaktivieren aber
nicht mehr pauschal die zugehörige Browserfunktion. Für vollständig attestierte Tag-
und Container-Releases bleibt `validate:vendor-provenance -- --require-complete`
als separates Supply-Chain-Gate bestehen. [Issue #406](https://github.com/carstenartur/Unfallatlas/issues/406)
verfolgt dieses Hardening, nicht ein behauptetes Nutzungsverbot.
"""
    write(path, text[:start] + policy + text[end:])


def align_live_qa_doc() -> None:
    path = "docs/documentation-live-link-qa.md"
    text = read(path)
    replacements = {
        "README screenshots may link to GitHub Pages only when the public distribution can reproduce the depicted state. Full-build-only screenshots remain visible as documentation images but are not presented as identical public-app links.":
            "README screenshots may link to GitHub Pages when the public browser distribution can reproduce the depicted state. Backend-only video states remain documentation-only.",
        "- Word/PDF are disabled and the full-build report group is hidden;":
            "- Word/PDF, Heatmap and rectangle drawing are enabled; only backend video is unavailable;",
        "The public export scenario includes the actual `.csv`, `.geojson` and `.kml` downloads.":
            "The public export scenario includes actual `.csv`, `.geojson` and `.kml` downloads and verifies the document-export controls declared by the published build manifest; final document binaries remain covered by the dedicated download and render gates.",
        "`tests/e2e/report-download-buttons.spec.js` runs against the normal canonical `_site` build, not the reduced Pages profile.":
            "`tests/e2e/report-download-buttons.spec.js` runs against the canonical `_site` build and exercises the same Word/PDF controls delivered by Pages.",
        "- Start and Bonn-Hbf heatmap images are explicitly marked as full-build screenshots and are not linked as identical Pages views.":
            "- Heatmap documentation is consistent with the public browser capability set.",
        "Full-build report controls are covered separately rather than weakening the distribution/provenance boundary.":
            "Document binaries are covered separately so the live URL audit stays fast while the distribution boundary remains explicit.",
    }
    for old, new in replacements.items():
        text = text.replace(old, new)
    write(path, text)


def align_documentation_contract() -> None:
    path = "scripts/documentation-deeplink-contract.cjs"
    text = read(path)
    text = replace_once(
        text,
        "    label: '→ Öffentliche Kernvorschau öffnen',\n"
        "    description: 'Explizite öffentliche Startansicht Hannover im reduzierten Pages-Profil',",
        "    label: '→ Öffentliche Browser-Version öffnen',\n"
        "    description: 'Explizite öffentliche Startansicht Hannover mit vollständigen Browserfunktionen',",
        "documentation start action",
    )
    text = text.replace(
        "description: 'Expliziter öffentlicher Exportdialog mit drei Datenexporten'",
        "description: 'Expliziter öffentlicher Exportdialog mit Daten- und Dokumentexporten'",
    )
    write(path, text)


def align_live_test() -> None:
    path = "tests/e2e/documentation-deeplinks.live.spec.js"
    text = read(path)
    old = (
        "  expect(diagnostics.state.export.publicPreview).toBe('public-preview-core-v1');\n"
        "  expect(diagnostics.state.export.noticeVisible).toBe(true);\n"
        "  expect(diagnostics.state.export.noticeText).toMatch(/Word\\/PDF.*deaktiviert/i);\n"
        "  expect(diagnostics.state.export.antragGroupHidden).toBe(true);\n"
        "  expect(diagnostics.state.export.wordDisabled).toBe(true);\n"
        "  expect(diagnostics.state.export.pdfDisabled).toBe(true);"
    )
    new = (
        "  expect(diagnostics.state.export.publicPreview).toBe('public-preview-core-v1');\n"
        "  expect(diagnostics.state.export.noticeVisible).toBe(true);\n"
        "  const liveDistribution = await page.evaluate(async () => {\n"
        "    const response = await fetch('build-manifest.json', { cache: 'no-store' });\n"
        "    if (!response.ok) throw new Error(`build-manifest HTTP ${response.status}`);\n"
        "    return (await response.json()).distribution || null;\n"
        "  });\n"
        "  expect(liveDistribution?.profile).toBe('public-preview-core-v1');\n"
        "  if (liveDistribution?.provenanceGapsBlockCapabilities === false) {\n"
        "    expect(liveDistribution.knownLicenseRestrictions).toEqual([]);\n"
        "    expect(liveDistribution.disabledCapabilities).toEqual(['video-export']);\n"
        "    expect(diagnostics.state.export.noticeText).toMatch(/Word- und PDF-Export.*verfügbar/i);\n"
        "    expect(diagnostics.state.export.noticeText).toMatch(/bekannte Lizenzbeschränkung.*besteht nicht/i);\n"
        "    expect(diagnostics.state.export.antragGroupHidden).toBe(false);\n"
        "    expect(diagnostics.state.export.wordDisabled).toBe(false);\n"
        "    expect(diagnostics.state.export.pdfDisabled).toBe(false);\n"
        "  } else {\n"
        "    expect(liveDistribution?.disabledCapabilities).toEqual(expect.arrayContaining([\n"
        "      'interactive-rectangle-drawing', 'heatmap', 'word-export', 'pdf-export',\n"
        "    ]));\n"
        "    expect(diagnostics.state.export.noticeText).toMatch(/Word\\/PDF.*deaktiviert/i);\n"
        "    expect(diagnostics.state.export.antragGroupHidden).toBe(true);\n"
        "    expect(diagnostics.state.export.wordDisabled).toBe(true);\n"
        "    expect(diagnostics.state.export.pdfDisabled).toBe(true);\n"
        "  }"
    )
    text = replace_once(text, old, new, "live distribution rollout contract")
    write(path, text)


def align_smoke_test() -> None:
    path = "tests/e2e/smoke.spec.js"
    text = read(path)
    manifest_marker = "    expect(notices.dependencies).toHaveLength(Object.keys(manifest.dependencies).length);\n"
    if "manifest.distribution.provenanceGapsBlockCapabilities" not in text:
        insertion = manifest_marker + """
    if (manifest.distribution?.profile === 'public-preview-core-v1') {
      expect(manifest.distribution.vendorInventoryComplete).toBe(false);
      expect(manifest.distribution.provenanceGapsBlockCapabilities).toBe(false);
      expect(manifest.distribution.knownLicenseRestrictions).toEqual([]);
      expect(manifest.distribution.disabledCapabilities).toEqual(['video-export']);
      const paths = new Set(manifest.vendorAssets.map(asset => asset.path));
      for (const required of [
        'vendor/leaflet.heat/leaflet-heat.js',
        'vendor/leaflet-draw/leaflet.draw.js',
        'vendor/leaflet-image/leaflet-image.js',
        'vendor/export/docx.js',
        'vendor/export/pdfmake.js',
        'vendor/export/pdfmake-fonts.js',
        'vendor/export/file-saver.js',
      ]) expect(paths.has(required), required).toBe(true);
    }
"""
        text = replace_once(text, manifest_marker, insertion, "smoke manifest policy")
    modal_marker = (
        "    const exportModal = page.locator('#modalOverlay');\n"
        "    await expect(exportModal).toBeVisible({ timeout: 5000 });\n"
    )
    if "const publicProfile = await page.locator" not in text:
        insertion = modal_marker + """
    const publicProfile = await page.locator('meta[name="unfallwerkbank:distribution-profile"]').getAttribute('content');
    if (publicProfile === 'public-preview-core-v1') {
      await expect(page.locator('#btnDraw')).toBeVisible();
      await expect(page.locator('#btnDraw')).toBeEnabled();
      await expect(page.locator('#toggleHeat')).toBeVisible();
      await expect(page.locator('#toggleHeat')).toBeEnabled();
      await expect(page.locator('#exportGroupAntrag')).toBeVisible();
      await expect(page.locator('#btnExportWord')).toBeEnabled();
      await expect(page.locator('#btnExportPDF')).toBeEnabled();
      await expect(page.locator('#videoExportContainer')).toBeHidden();
    }
"""
        text = replace_once(text, modal_marker, insertion, "smoke public capabilities")
    write(path, text)


def align_pages_workflow(relative: str) -> None:
    text = read(relative)
    text = text.replace(
        "Materialize provenance-complete public Pages profile",
        "Materialize public browser profile with declared provenance gaps",
    )
    text = text.replace("exact reduced artifact", "exact public browser artifact")
    text = text.replace("exact reduced Pages artifact", "exact public browser Pages artifact")
    text = text.replace("_site/vendor/public-preview-sbom.cdx.json", "_site/vendor/sbom.cdx.json")
    text = text.replace("exclusions_ok=false", "capabilities_ok=false")
    old_marker = (
        "              if ! grep -Eq 'vendor/(export|leaflet\\.heat|leaflet-draw|leaflet-image)/' \"$html_file\"; then\n"
        "                exclusions_ok=true\n"
        "              fi"
    )
    new_marker = (
        "              if grep -Fq 'vendor/leaflet.heat/leaflet-heat.js' \"$html_file\" && \\\n"
        "                 grep -Fq 'vendor/leaflet-draw/leaflet.draw.js' \"$html_file\" && \\\n"
        "                 grep -Fq 'vendor/leaflet-image/leaflet-image.js' \"$html_file\"; then\n"
        "                capabilities_ok=true\n"
        "              fi"
    )
    text = replace_once(text, old_marker, new_marker, f"{relative} capability marker")
    text = text.replace(
        'if [[ "$profile_ok" == true && "$exclusions_ok" == true && "$assets_ok" == true ]]; then',
        'if [[ "$profile_ok" == true && "$capabilities_ok" == true && "$assets_ok" == true ]]; then',
    )
    assets = [
        "vendor/leaflet.heat/leaflet-heat.js",
        "vendor/leaflet-draw/leaflet.draw.js",
        "vendor/leaflet-image/leaflet-image.js",
        "vendor/export/docx.js",
        "vendor/export/pdfmake.js",
        "vendor/export/pdfmake-fonts.js",
        "vendor/export/file-saver.js",
    ]
    slash = "\\"
    runtime_probe = (
        "                 curl --fail --silent --show-error --location " + slash + "\n"
        "                   --connect-timeout 10 --max-time 30 " + slash + "\n"
        "                   \"${base}/js/ua.public-preview.js?${query}\" >/dev/null; then"
    )
    if "vendor/export/docx.js?${query}" not in text:
        extra = "".join(
            "                 curl --fail --silent --show-error --location " + slash + "\n"
            "                   --connect-timeout 10 --max-time 30 " + slash + "\n"
            f"                   \"${{base}}/{asset}?${{query}}\" >/dev/null && " + slash + "\n"
            for asset in assets
        )
        text = replace_once(text, runtime_probe, extra + runtime_probe, f"{relative} asset probes")
    list_marker = (
        "            vendor/leaflet.markercluster/leaflet.markercluster.js " + slash + "\n"
        "            js/ua.public-preview.js; do"
    )
    if "            vendor/export/docx.js " + slash not in text:
        list_replacement = (
            "            vendor/leaflet.markercluster/leaflet.markercluster.js " + slash + "\n"
            + "".join(f"            {asset} {slash}\n" for asset in assets)
            + "            js/ua.public-preview.js; do"
        )
        text = replace_once(text, list_marker, list_replacement, f"{relative} diagnostic list")
    write(relative, text)


def align_site_build_test() -> None:
    path = "tests/unit/siteBuildContract.test.js"
    text = read(path)
    text = text.replace(
        "test('vendor notice inventories delivered assets and blocks release while component evidence is incomplete'",
        "test('vendor notice inventories assets and declares component-level hardening gaps honestly'",
    )
    text = text.replace(
        "        'leaflet-image-embedded-d3-queue',\n        'leaflet-draw-license-text',",
        "        'leaflet-image-embedded-d3-queue',",
    )
    write(path, text)


def align_policy() -> None:
    path = "vendor/provenance-policy.json"
    policy = json.loads(read(path))
    for gap in policy["unresolvedAssets"]:
        if gap["id"] in {"docx-opaque-upstream-bundle", "pdfmake-opaque-upstream-bundle"}:
            gap["missingEvidence"] = [
                "proof that the detected component and license inventory is exhaustive"
                if item == "full license and copyright evidence for every embedded component"
                else item
                for item in gap["missingEvidence"]
            ]
    write(path, json.dumps(policy, ensure_ascii=False, indent=2) + "\n")


def align_supplemental_license_validation() -> None:
    validator_path = "scripts/validate-public-pages-profile.js"
    validator = read(validator_path)
    marker = (
        "  assert(Array.isArray(notice.fontEvidence) && notice.fontEvidence.length === 4,\n"
        "    'expected four embedded Roboto font records');"
    )
    if "expected simpleheat supplemental license evidence" not in validator:
        insertion = """  const supplementalLicenses = notice.supplementalLicenses || [];
  assert(supplementalLicenses.length === 1,
    'expected simpleheat supplemental license evidence');
  const simpleheat = supplementalLicenses[0];
  assert(simpleheat.component === 'simpleheat@0.2.0' && simpleheat.spdx === 'BSD-2-Clause',
    'simpleheat supplemental license metadata drift');
  const simpleheatLicense = path.join(siteRoot, simpleheat.path || '');
  assert(fs.existsSync(simpleheatLicense), 'missing simpleheat supplemental license text');
  assertHash(simpleheat.sha256, 'simpleheat supplemental license hash');
  assert(sha256File(simpleheatLicense) === simpleheat.sha256,
    'simpleheat supplemental license hash drift');

""" + marker
        validator = replace_once(
            validator,
            marker,
            insertion,
            "supplemental license validator",
        )
    write(validator_path, validator)

    test_path = "tests/unit/publicPagesProfile.test.js"
    test = read(test_path)
    marker = "    expect(notice.excludedPackages).toEqual([]);\n"
    if "notice.supplementalLicenses" not in test:
        insertion = marker + (
            "    expect(notice.supplementalLicenses).toEqual([expect.objectContaining({\n"
            "      component: 'simpleheat@0.2.0', spdx: 'BSD-2-Clause',\n"
            "    })]);\n"
        )
        test = replace_once(test, marker, insertion, "supplemental license unit assertion")
    write(test_path, test)


def remove_one_shot_files() -> None:
    for relative in [
        ".github/workflows/apply-pr524-policy-alignment.yml",
        ".github/workflows/pr524-align-on-pr.yml",
        ".github/workflows/run-pr524-alignment.yml",
        ".github/workflows/pr524-align-simple.yml",
        ".github/pr524-policy-alignment.trigger",
        ".github/pr524-alignment-error.txt",
        "scripts/pr524_align_public_profile.py",
    ]:
        (ROOT / relative).unlink(missing_ok=True)


def main() -> None:
    align_readme()
    align_site_build_doc()
    align_live_qa_doc()
    align_documentation_contract()
    align_live_test()
    align_smoke_test()
    align_pages_workflow(".github/workflows/deploy-pages-current-data.yml")
    align_pages_workflow(".github/workflows/generate-data-deploy-pages.yml")
    align_site_build_test()
    align_policy()
    align_supplemental_license_validation()
    remove_one_shot_files()


if __name__ == "__main__":
    main()
