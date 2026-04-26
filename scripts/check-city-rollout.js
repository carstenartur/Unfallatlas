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
 *     node scripts/check-city-rollout.js --fix    # Drift automatisch beheben (idempotent)
 *
 * Exit-Code:
 *   0 – keine Inkonsistenz gefunden (Upgrade-Kandidaten sind kein
 *       Fehler, sondern eine Empfehlung)
 *   1 – Inkonsistenzen vorhanden (Status 2 oder 3 oben)
 *
 * Der --fix-Modus hebt alle Upgrade-Kandidaten automatisch auf
 * `accidentDataSupport: 'supported'` hoch und ergänzt die passenden
 * qualityFlags.  Der Modus ist idempotent: mehrfaches Ausführen hat
 * keinen weiteren Effekt.  Schreibt direkt in cityCatalogData.json.
 */

const fs   = require('fs');
const path = require('path');

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
  const wantFix  = argv.includes('--fix');

  if (wantFix) {
    return applyFix();
  }

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

/**
 * Hebt alle Upgrade-Kandidaten automatisch auf `supported` hoch
 * und ergänzt die passenden qualityFlags in cityCatalogData.json.
 * Idempotent: mehrfaches Ausführen hat keinen weiteren Effekt.
 *
 * @returns {number} Exit-Code (0 = OK, 1 = verbleibende Inkonsistenz)
 */
function applyFix() {
  const result = classify();

  if (result.upgradeCandidates.length === 0) {
    console.log('check-city-rollout --fix: keine Upgrade-Kandidaten, nichts zu tun.');
  } else {
    const catalogPath = cityRegistry.CATALOG_PATH;
    const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));

    for (const candidate of result.upgradeCandidates) {
      const entry = catalog.cities.find(c => c.id === candidate.id);
      if (!entry) continue;

      entry.accidentDataSupport = 'supported';

      const flags = new Set(entry.qualityFlags || []);
      flags.delete('rollout-queued');
      flags.add('accident-data-generated');
      if (candidate.hasPoi) flags.add('poi-generated');
      entry.qualityFlags = Array.from(flags);

      console.log(`check-city-rollout --fix: ${candidate.id} auf supported hochgestuft.`);
    }

    fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + '\n', 'utf8');
    // Registry-Cache leeren damit nachfolgende classify()-Aufrufe den neuen Stand sehen
    cityRegistry.reload();
  }

  // Nach dem Fix erneut klassifizieren und Fehlercode zurückgeben
  const after = classify();
  const hasErrors =
    after.inconsistentSupported.length > 0 ||
    after.txtWithoutCatalog.length > 0;
  return hasErrors ? 1 : 0;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = { classify, applyFix };
