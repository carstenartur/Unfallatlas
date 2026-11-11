/** @jest-environment node */
'use strict';
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const dgm=require('../../scripts/providers/hannover_dgm1_xyz_provider');
const elevation=require('../../js/ua.elevation_provider');
const risk=require('../../scripts/producers/osm_elevation_risk_producer');
const references=require('../fixtures/hannover-dgm1-real/reference-cases.json');
const fixtures=path.join(__dirname,'../fixtures/hannover-dgm1-real');

// These are automated checks against real downloaded municipal heights and
// genuine OSM geometries/tags. They are deliberately not QGIS/field receipts.
test.each(references.cases.map(c=>[c.kind,c]))('real official %s reference preserves its numerical/structure outcome',async (_kind,c)=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dgm-real-reference-'));
  try {
    const bytes=fs.readFileSync(path.join(fixtures,c.file));
    expect(bytes.length).toBe(c.bytes);
    expect(crypto.createHash('sha256').update(bytes).digest('hex')).toBe(c.sha256);
    fs.writeFileSync(path.join(root,c.file),bytes);
    const manifest={schemaVersion:1,sourceId:'hannover.dgm1',retrievedAt:c.dgmRetrievedAt || references.dgmRetrievedAt,
      distribution:{url:c.sourceUrl || references.dgmSourceUrl,path:c.file,bytes:c.bytes,sha256:c.sha256,publicationDate:references.publicationDate},grid:c.grid};
    const manifestBytes=Buffer.from(JSON.stringify(manifest)+'\n');fs.writeFileSync(path.join(root,'manifest.json'),manifestBytes);
    const provider=dgm.createHannoverDgm1XyzProvider({allowedRoot:root,manifestPath:'manifest.json',expectedManifestSha256:crypto.createHash('sha256').update(manifestBytes).digest('hex')});
    await expect(provider.preload()).resolves.toMatchObject({pointCount:c.pointCount});
    for(const window of [20,50]) {
      const result=await elevation.computeRoadGradient(provider,c.geometry,c.anchor,{windowMeters:window,spacingMeters:1,matchQuality:'high',osmTags:risk.riskTagsForWay(c.originalTags),context:{city:'Hannover'}});
      const expected=c.expected[String(window)].result;
      expect(result.usable).toBe(expected.usable);
      if(expected.gradientPercent === null) expect(result.gradientPercent).toBeNull();
      else expect(result.gradientPercent).toBeCloseTo(expected.gradientPercent, 6);
      expect(result.profileLengthMeters).toBe(expected.profileLengthMeters);
      expect(result.uncertaintyReasons).toEqual(expected.uncertaintyReasons);
      if (expected.quality) expect(result.quality).toBe(expected.quality);
      if (expected.residualMadMeters != null) expect(result.residualMadMeters).toBe(expected.residualMadMeters);
      if(c.kind==='structure')expect(result.gradientPercent).toBeNull();
    }
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('B6 terrain cells reproduce the former high result and the bridge endpoint suppresses the road estimate', async () => {
  const evidence = require('../fixtures/hannover-dgm1-real/westschnellweg-transition.json');
  const profile = require('../../scripts/producers/hannover_dgm1_road_profile_producer');
  const { approach, bridge, terrain } = evidence;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'westschnellweg-dgm1-'));
  try {
    fs.copyFileSync(path.join(fixtures, terrain.file), path.join(root, terrain.file));
    const manifest = Buffer.from(JSON.stringify({
      schemaVersion: 1, sourceId: 'hannover.dgm1', retrievedAt: terrain.retrievedAt, grid: terrain.grid,
      distribution: { path: terrain.file, url: terrain.sourceUrl, bytes: terrain.bytes, sha256: terrain.sha256 },
    }));
    fs.writeFileSync(path.join(root, 'manifest.json'), manifest);
    const provider = dgm.createHannoverDgm1XyzProvider({
      allowedRoot: root, manifestPath: 'manifest.json', expectedManifestSha256: dgm.sha256Buffer(manifest),
    });
    await expect(provider.preload()).resolves.toMatchObject({ pointCount: terrain.pointCount });
    const roads = { [approach.id]: approach.tags, [bridge.id]: bridge.tags };
    const geometries = { [approach.id]: approach.geometry, [bridge.id]: bridge.geometry };
    const endpoints = profile.bridgeEndpointIndex(roads, geometries);
    const tags = risk.riskTagsForWay(approach.tags);
    const anchor = profile.profileAnchor(approach.geometry);
    for (const window of [20, 50]) {
      const parameters = [elevation.computeRoadGradient, provider, approach.geometry, anchor, tags, window];
      const old = await profile.computeWindow(...parameters);
      expect(old.result).toMatchObject({ quality: 'high', gradientPercent: 22.6, uncertaintyPercent: 9.5 });
      const boundary = profile.bridgeEndpointsForWay(endpoints, approach.geometry, tags);
      expect(boundary).toEqual({ start: [bridge.id], end: [] });
      const reviewed = await profile.computeWindow(...parameters, boundary);
      expect(reviewed.result).toMatchObject({ quality: 'unusable', gradientPercent: null,
        uncertaintyReasons: ['bridge_transition_surface_not_represented_by_dtm'] });
    }
    await provider.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
