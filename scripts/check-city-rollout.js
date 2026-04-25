#!/usr/bin/env node
'use strict';

/**
 * scripts/check-city-rollout.js
 *
 * Diagnose-Tool für den schrittweisen Stufe-A-Rollout des Städte-Katalogs.
 * Beantwortet drei Fragen, ohne irgendetwas im Repo zu verändern:
 *
 *   1. Welche Städte aus dem Katalog/`cities.txt` haben *bereits*
 *      Workflow-Daten in `out/`, sind aber im Katalog noch nicht auf
 *      `accidentDataSupport: 'supported'` hochgestuft?  → Upgrade-Kandidaten.
 *   2. Welche Städte sind als `'supported'` deklariert, obwohl die
 *      GeoJSON in `out/` fehlt?  → Inkonsistenz, sollte runtergestuft
 *      werden (wird auch vom Test „Materialisierungs-Honesty" erfasst).
 *   3. Welche Städte stehen in `cities.txt`, sind aber im Katalog gar
 *      nicht erfasst?  → Katalog-Eintrag fehlt.
 *
 * Aufruf:
 *
 *     node scripts/check-city-rollout.js          # Klartext-Report
 *     node scripts/check-city-rollout.js --json   # maschinenlesbar
 *
 * Exit-Code:
 *   0 – keine Inkonsistenz gefunden (Upgrade-Kandidaten sind kein
 *       Fehler, sondern eine Empfehlung)
 *   1 – Inkonsistenzen vorhanden (Status 2 oder 3 oben)
 *
 * Bewusst keine Schreiboperation: das Hochstufen erfolgt manuell im
 * PR, damit jede Statusänderung im Review sichtbar bleibt
 * (siehe docs/CITY_CATALOG.md, Abschnitt „Eine Stadt von
 * `partially_supported` auf `supported` heben").
 */

const path = require('path');
const fs   = require('fs');

const cityRegistry = require(path.join(__dirname, '..', 'server', 'cities', 'cityRegistry.js'));

function classify() {
  const cities    = cityRegistry.listCities();
  const txtSlugs  = new Set(cityRegistry.readCitiesTxt().map(e => e.slug));
  const byId      = new Map(cities.map(c => [c.id, c]));

  const upgradeCandidates = [];   // Daten da, aber noch partially_supported
  const inconsistentSupported = []; // supported, aber Daten fehlen
  const txtWithoutCatalog = [];     // in cities.txt, aber kein Katalog-Eintrag

  for (const c of cities) {
    const assets = cityRegistry.getDataAssets(c.id);
    const inTxt  = txtSlugs.has(c.id);

    if (c.accidentDataSupport === 'supported' && !assets.accidents) {
      inconsistentSupported.push({
        id: c.id, displayName: c.displayName,
        reason: 'accidentDataSupport=supported aber out/output_all_years_*.geojson fehlt'
      });
    }

    if (c.accidentDataSupport !== 'supported' && assets.accidents && inTxt) {
      upgradeCandidates.push({
        id: c.id, displayName: c.displayName,
        currentStatus: c.accidentDataSupport,
        hasAccidents: true, hasPoi: assets.poi,
        recommendation: assets.poi
          ? 'auf "supported" heben + qualityFlags: ["accident-data-generated","poi-generated"]'
          : 'auf "supported" heben + qualityFlags: ["accident-data-generated"] (POI fehlt noch)'
      });
    }
  }

  for (const slug of txtSlugs) {
    if (!byId.has(slug)) {
      txtWithoutCatalog.push({ slug, reason: 'in cities.txt, aber kein Katalog-Eintrag' });
    }
  }

  return { upgradeCandidates, inconsistentSupported, txtWithoutCatalog };
}

function printReport({ upgradeCandidates, inconsistentSupported, txtWithoutCatalog }) {
  const line = (...a) => console.log(...a);
  line('# Städte-Katalog – Rollout-Diagnose');
  line('');
  line(`## 1. Upgrade-Kandidaten (Daten vorhanden, aber noch nicht "supported"): ${upgradeCandidates.length}`);
  if (upgradeCandidates.length === 0) {
    line('  – keine –');
  } else {
    for (const u of upgradeCandidates) {
      line(`  • ${u.displayName.padEnd(22)} (id=${u.id}) – aktuell ${u.currentStatus}`);
      line(`      → ${u.recommendation}`);
    }
  }
  line('');
  line(`## 2. Inkonsistent "supported" ohne Workflow-Daten: ${inconsistentSupported.length}`);
  if (inconsistentSupported.length === 0) {
    line('  – keine –');
  } else {
    for (const i of inconsistentSupported) {
      line(`  • ${i.displayName} (id=${i.id}): ${i.reason}`);
    }
  }
  line('');
  line(`## 3. cities.txt-Einträge ohne Katalog: ${txtWithoutCatalog.length}`);
  if (txtWithoutCatalog.length === 0) {
    line('  – keine –');
  } else {
    for (const t of txtWithoutCatalog) line(`  • ${t.slug}: ${t.reason}`);
  }
}

function main(argv) {
  const wantJson = argv.includes('--json');
  const result   = classify();
  if (wantJson) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    printReport(result);
  }
  // Inkonsistenzen sind blockierend; reine Upgrade-Empfehlungen nicht.
  const hasErrors =
    result.inconsistentSupported.length > 0 ||
    result.txtWithoutCatalog.length > 0;
  return hasErrors ? 1 : 0;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = { classify };
