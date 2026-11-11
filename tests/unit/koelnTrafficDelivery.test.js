/** @jest-environment node */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {fetchDistribution, shouldStageKoelnTraffic} = require('../../scripts/providers/koeln_traffic_delivery');

test('downloads and verifies original bytes before making them available to the join', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'koeln-source-'));
  try {
    const bytes = Buffer.from('official observation');
    const source = {url:'https://example.org/counts', name:'counts.csv', bytes:bytes.length,
      sha256:crypto.createHash('sha256').update(bytes).digest('hex')};
    const request = async () => new Response(bytes);
    await fetchDistribution(root, source, request);
    expect(fs.readFileSync(path.join(root, source.name))).toEqual(bytes);
    await expect(fetchDistribution(root, source, async () => new Response(Buffer.alloc(bytes.length))))
      .rejects.toThrow(/SHA-256/);
    expect(fs.readFileSync(path.join(root, source.name))).toEqual(bytes);
    await expect(fetchDistribution(root, source, async () => new Response(Buffer.alloc(bytes.length + 1))))
      .rejects.toThrow(/size/);
  } finally {
    fs.rmSync(root, {recursive:true, force:true});
  }
});

test('production selection respects city, opt-in and external reviewed artifact pins', () => {
  const enabled = { CONTEXT_KOELN_MEASURED_COUNTS: 'true' };
  expect(shouldStageKoelnTraffic('koeln', enabled)).toBe(true);
  expect(shouldStageKoelnTraffic('bonn', enabled)).toBe(false);
  expect(shouldStageKoelnTraffic('koeln', {})).toBe(false);
  expect(shouldStageKoelnTraffic('koeln', {...enabled, KOELN_KFZ_MATCHED_ARTIFACT:'pinned.json'})).toBe(false);
  expect(shouldStageKoelnTraffic('koeln', {...enabled, KOELN_KFZ_MATCHED_ARTIFACT_SHA256:'abc'})).toBe(false);
});

test('retries a temporary municipal service failure and preserves integrity failures', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'koeln-source-retry-'));
  try {
    const bytes = Buffer.from('verified source');
    const source = {url:'https://example.org/csv', name:'counts.csv', bytes:bytes.length,
      sha256:crypto.createHash('sha256').update(bytes).digest('hex')};
    const request = jest.fn()
      .mockResolvedValueOnce(new Response('', {status:503}))
      .mockResolvedValueOnce(new Response(bytes));
    await fetchDistribution(root, source, request, async () => {});
    expect(request).toHaveBeenCalledTimes(2);
    const denied = jest.fn().mockResolvedValue(new Response('', {status:403}));
    await expect(fetchDistribution(root, source, denied, async () => {})).rejects.toThrow(/403/);
    expect(denied).toHaveBeenCalledTimes(1);
  } finally {
    fs.rmSync(root, {recursive:true, force:true});
  }
});
