'use strict';

const crypto = require('crypto');
const {
  createRoleMapFixture,
  verifyRoleMapFixtures
} = require('../../scripts/release-map-fixture');
const points = [{
  id: 'A001',
  lat: 50.73,
  lon: 7.09,
  severity: 1
}, {
  id: 'A002',
  lat: 50.731,
  lon: 7.091,
  severity: 3
}];
const bounds = {
  south: 50.72,
  west: 7.08,
  north: 50.74,
  east: 7.10
};
const snapshotHash = 'a'.repeat(64);
test('role maps bind exact IDs, source snapshot, severity colors and visible label boxes', () => {
  const overview = createRoleMapFixture({
    role: 'overview',
    points,
    bounds,
    snapshotHash
  });
  const cluster = createRoleMapFixture({
    role: 'cluster',
    points: points.slice(0, 1),
    bounds,
    snapshotHash
  });
  expect(overview.receipt.accidentIds).toEqual(['A001', 'A002']);
  expect(cluster.receipt.accidentIds).toEqual(['A001']);
  expect(overview.receipt.snapshotHash).toBe(snapshotHash);
  expect(overview.receipt.basemap).toMatch(/deterministic test basemap/i);
  expect(overview.receipt.severityColors['3']).toBe('#ffff33');
  expect(overview.receipt.labels.map(x => x.id)).toEqual(['A001', 'A002']);
  expect(crypto.createHash('sha256').update(overview.png).digest('hex')).toBe(overview.receipt.sha256);
  expect(overview.png.equals(cluster.png)).toBe(false);
  expect(verifyRoleMapFixtures([overview, cluster], snapshotHash)).toBe(true);
});
test('rejects duplicate IDs, missing source binding, wrong subset and reused map bytes', () => {
  expect(() => createRoleMapFixture({
    role: 'overview',
    points: [points[0], points[0]],
    bounds,
    snapshotHash
  })).toThrow(/duplicate/i);
  expect(() => createRoleMapFixture({
    role: 'overview',
    points,
    bounds
  })).toThrow(/snapshot/i);
  const one = createRoleMapFixture({
    role: 'overview',
    points,
    bounds,
    snapshotHash
  });
  const bad = {
    ...one,
    receipt: {
      ...one.receipt,
      role: 'cluster',
      accidentIds: ['A999']
    }
  };
  expect(() => verifyRoleMapFixtures([one, bad], snapshotHash)).toThrow(/bytes|subset|receipt/i);
  expect(() => verifyRoleMapFixtures([one], 'b'.repeat(64))).toThrow(/snapshot/i);
});
test('dense coincident points retain individually readable nonoverlapping labels', () => {
  const dense = Array.from({
    length: 18
  }, (_, i) => ({
    ...points[0],
    id: `A${String(i + 1).padStart(3, '0')}`
  }));
  const map = createRoleMapFixture({
    role: 'detail',
    points: dense,
    bounds,
    snapshotHash
  });
  expect(map.receipt.labels).toHaveLength(18);
  for (const box of map.receipt.labels) for (const marker of map.receipt.labels) {
    expect(marker.markerX + 8 < box.xMin || marker.markerX - 8 > box.xMax || marker.markerY + 8 < box.yMin || marker.markerY - 8 > box.yMax).toBe(true);
  }
  for (const [i, a] of map.receipt.labels.entries()) for (const b of map.receipt.labels.slice(i + 1)) {
    expect(a.xMax <= b.xMin || b.xMax <= a.xMin || a.yMax <= b.yMin || b.yMax <= a.yMin).toBe(true);
  }
});

test('receipt ID edits cannot relabel unchanged PNG markers', () => {
  const map=createRoleMapFixture({role:'overview',points,bounds,snapshotHash});
  const relabeled={...map,receipt:{...map.receipt,accidentIds:['A001','A999']}};
  expect(()=>verifyRoleMapFixtures([relabeled],snapshotHash)).toThrow(/IDs|receipt/i);
});
