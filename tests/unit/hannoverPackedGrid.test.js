/** @jest-environment node */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {loadPackedGrid} = require('../../scripts/providers/hannover_dgm1_packed_grid');
const {sha256Buffer} = require('../../scripts/providers/hannover_dgm1_xyz_provider');

test('reads across adjoining tile boundaries, leaves uncovered cells empty and validates the raster pin', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'dgm-tiles-'));
  try {
    const bytes = Buffer.alloc(2 * 500 * 500 * 4);
    for (let x=0; x<1000; x++) for (let y=0; y<500; y++) bytes.writeFloatLE(x+y,(x*500+y)*4);
    const file = path.join(root, 'heights.f32');
    fs.writeFileSync(file,bytes);
    const metadata = {distribution:{bytes:bytes.length,sha256:sha256Buffer(bytes)},grid:{tiles:[[548000,5801500],[548500,5801500]]}};
    const grid = loadPackedGrid(file,metadata);
    expect(grid.sampleProjected(548500.25,5801600.75)).toBe(600);
    expect(grid.sampleProjected(549004.5,5801600.75)).toBeNull();
    grid.close();
    expect(() => grid.close()).not.toThrow();
    expect(() => grid.sampleProjected(548500.25,5801600.75)).toThrow(/closed/);
    expect(() => loadPackedGrid(file,{...metadata, distribution:{bytes:bytes.length,sha256:'0'.repeat(64)}})).toThrow(/SHA-256/);
  } finally {
    fs.rmSync(root,{recursive:true,force:true});
  }
});
