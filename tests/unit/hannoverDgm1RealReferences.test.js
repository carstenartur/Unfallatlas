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
