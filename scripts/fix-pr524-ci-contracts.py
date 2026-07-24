#!/usr/bin/env python3
from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one match, found {count}")
    return text.replace(old, new, 1)


# Remove the obsolete license-gap expectation. The original Leaflet.draw MIT
# text is now shipped and validated, so this is no longer an unresolved gap.
site_test_path = Path("tests/unit/siteBuildContract.test.js")
site_test = site_test_path.read_text(encoding="utf-8")
site_test = site_test.replace(
    "test('vendor notice inventories delivered assets and blocks release while component evidence is incomplete'",
    "test('vendor notice inventories assets and declares component-level hardening gaps honestly'",
)
site_test = replace_once(
    site_test,
    "        'leaflet-image-embedded-d3-queue',\n        'leaflet-draw-license-text',",
    "        'leaflet-image-embedded-d3-queue',",
    "obsolete Leaflet.draw gap expectation",
)
site_test_path.write_text(site_test, encoding="utf-8")


capability_assets = [
    "vendor/leaflet.heat/leaflet-heat.js",
    "vendor/leaflet-draw/leaflet.draw.js",
    "vendor/leaflet-image/leaflet-image.js",
    "vendor/export/docx.js",
    "vendor/export/pdfmake.js",
    "vendor/export/pdfmake-fonts.js",
    "vendor/export/file-saver.js",
]

for workflow_name in [
    ".github/workflows/deploy-pages-current-data.yml",
    ".github/workflows/generate-data-deploy-pages.yml",
]:
    workflow_path = Path(workflow_name)
    text = workflow_path.read_text(encoding="utf-8")
    text = text.replace(
        "Materialize provenance-complete public Pages profile",
        "Materialize public browser profile with declared provenance gaps",
    )
    text = text.replace("exact reduced artifact", "exact public browser artifact")
    text = text.replace("exact reduced Pages artifact", "exact public browser Pages artifact")
    text = text.replace("_site/vendor/public-preview-sbom.cdx.json", "_site/vendor/sbom.cdx.json")
    text = replace_once(
        text,
        "            exclusions_ok=false\n",
        "            capabilities_ok=false\n",
        f"{workflow_name} capability variable",
    )
    text = replace_once(
        text,
        "              if ! grep -Eq 'vendor/(export|leaflet\\.heat|leaflet-draw|leaflet-image)/' \"$html_file\"; then\n"
        "                exclusions_ok=true\n"
        "              fi",
        "              if grep -Fq 'vendor/leaflet.heat/leaflet-heat.js' \"$html_file\" && \\\n"
        "                 grep -Fq 'vendor/leaflet-draw/leaflet.draw.js' \"$html_file\" && \\\n"
        "                 grep -Fq 'vendor/leaflet-image/leaflet-image.js' \"$html_file\" && \\\n"
        "                 grep -Fq 'vendor/export/docx.js' \"$html_file\" && \\\n"
        "                 grep -Fq 'vendor/export/pdfmake.js' \"$html_file\"; then\n"
        "                capabilities_ok=true\n"
        "              fi",
        f"{workflow_name} capability marker",
    )
    text = replace_once(
        text,
        '            if [[ "$profile_ok" == true && "$exclusions_ok" == true && "$assets_ok" == true ]]; then',
        '            if [[ "$profile_ok" == true && "$capabilities_ok" == true && "$assets_ok" == true ]]; then',
        f"{workflow_name} publication condition",
    )
    runtime_probe = (
        "                 curl --fail --silent --show-error --location \\\n"
        "                   --connect-timeout 10 --max-time 30 \\\n"
        "                   \"${base}/js/ua.public-preview.js?${query}\" >/dev/null; then"
    )
    extra_probes = "".join(
        "                 curl --fail --silent --show-error --location \\\n"
        "                   --connect-timeout 10 --max-time 30 \\\n"
        f"                   \"${{base}}/{asset}?${{query}}\" >/dev/null && \\\n"
        for asset in capability_assets
    )
    text = replace_once(
        text,
        runtime_probe,
        extra_probes + runtime_probe,
        f"{workflow_name} capability asset probes",
    )
    diagnostic_marker = (
        "            vendor/leaflet.markercluster/leaflet.markercluster.js \\\n"
        "            js/ua.public-preview.js; do"
    )
    diagnostic_replacement = (
        "            vendor/leaflet.markercluster/leaflet.markercluster.js \\\n"
        + "".join(f"            {asset} \\\n" for asset in capability_assets)
        + "            js/ua.public-preview.js; do"
    )
    text = replace_once(
        text,
        diagnostic_marker,
        diagnostic_replacement,
        f"{workflow_name} diagnostic asset list",
    )
    workflow_path.write_text(text, encoding="utf-8")


# Let the same live-link test validate either the published site or an exact
# locally built Pages candidate. PR checks must not compare a proposed contract
# with the still-old production deployment.
live_test_path = Path("tests/e2e/documentation-deeplinks.live.spec.js")
live_test = live_test_path.read_text(encoding="utf-8")
live_test = replace_once(
    live_test,
    "const outputDir = resolve(process.cwd(), 'out/qa/documentation-live-links');\n",
    "const outputDir = resolve(process.cwd(), 'out/qa/documentation-live-links');\n"
    "const applicationBaseUrl = process.env.DOCUMENTATION_APP_BASE_URL || null;\n\n"
    "function applicationUrl(canonicalUrl) {\n"
    "  if (!applicationBaseUrl) return canonicalUrl;\n"
    "  const canonical = new URL(canonicalUrl);\n"
    "  const base = new URL(applicationBaseUrl.endsWith('/') ? applicationBaseUrl : `${applicationBaseUrl}/`);\n"
    "  return new URL(`werkbank_v2.html${canonical.search}`, base).href;\n"
    "}\n",
    "live-link application URL override",
)
live_test = replace_once(
    live_test,
    "  expect(diagnostics.state.export.noticeText).toMatch(/Word\\/PDF.*deaktiviert/i);\n"
    "  expect(diagnostics.state.export.antragGroupHidden).toBe(true);\n"
    "  expect(diagnostics.state.export.wordDisabled).toBe(true);\n"
    "  expect(diagnostics.state.export.pdfDisabled).toBe(true);",
    "  expect(diagnostics.state.export.noticeText).toMatch(/Word.*PDF.*verfügbar/i);\n"
    "  expect(diagnostics.state.export.antragGroupHidden).toBe(false);\n"
    "  expect(diagnostics.state.export.wordDisabled).toBe(false);\n"
    "  expect(diagnostics.state.export.pdfDisabled).toBe(false);",
    "public document export expectations",
)
live_test = replace_once(
    live_test,
    "      const diagnostics = {\n"
    "        scenario: scenario.id, imagePath: scenario.imagePath, url: scenario.url,",
    "      const targetUrl = applicationUrl(scenario.url);\n"
    "      const diagnostics = {\n"
    "        scenario: scenario.id, imagePath: scenario.imagePath, url: scenario.url, targetUrl,",
    "live-link target URL diagnostics",
)
live_test = replace_once(
    live_test,
    "      const liveOrigin = new URL(scenario.url).origin;",
    "      const liveOrigin = new URL(targetUrl).origin;",
    "live-link target origin",
)
live_test = replace_once(
    live_test,
    "        await page.goto(scenario.url, { waitUntil: 'domcontentloaded', timeout: 90000 });",
    "        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });",
    "live-link navigation target",
)
live_test_path.write_text(live_test, encoding="utf-8")


visual_path = Path(".github/workflows/visual-check.yml")
visual = visual_path.read_text(encoding="utf-8")
visual = replace_once(
    visual,
    "      - name: Prepare clean candidate directory\n",
    "      - name: Build exact public Pages candidate\n"
    "        run: |\n"
    "          npm run build:site -- --input-dir out --poi-dir out --output-dir _site\n"
    "          npm run build:pages-profile -- --site _site\n"
    "          npm run validate:pages-profile -- --site _site\n\n"
    "      - name: Start exact public Pages candidate\n"
    "        run: |\n"
    "          npm run serve:site:existing > /tmp/pr-pages-server.log 2>&1 &\n"
    "          for _ in $(seq 1 60); do\n"
    "            curl --fail --silent http://127.0.0.1:8000/werkbank_v2.html >/dev/null && exit 0\n"
    "            sleep 1\n"
    "          done\n"
    "          cat /tmp/pr-pages-server.log >&2\n"
    "          exit 1\n\n"
    "      - name: Prepare clean candidate directory\n",
    "visual local Pages candidate steps",
)
visual = replace_once(
    visual,
    "      - name: Audit README screenshot links against published application\n"
    "        id: validate_live_links\n"
    "        run: npm run qa:live-documentation-links",
    "      - name: Audit README screenshot links against exact PR Pages candidate\n"
    "        id: validate_live_links\n"
    "        env:\n"
    "          DOCUMENTATION_APP_BASE_URL: http://127.0.0.1:8000/\n"
    "        run: npm run qa:live-documentation-links",
    "visual live-link audit target",
)
visual = visual.replace(
    "Zusätzlich werden die anklickbaren README-Screenshots in der veröffentlichten GitHub-Pages-Anwendung geöffnet und gegen ihren UI-/Kartenvertrag geprüft.",
    "Zusätzlich werden die anklickbaren README-Screenshots gegen das exakt im PR gebaute Pages-Artefakt geprüft; die Produktionsseite wird erst nach dem Merge auditiert.",
)
visual_path.write_text(visual, encoding="utf-8")

print("PR 524 CI contracts updated")
