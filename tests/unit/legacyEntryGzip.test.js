'use strict';

const fs = require('fs');
const path = require('path');

function read(rel) {
  return fs.readFileSync(path.resolve(__dirname, '../../' + rel), 'utf8');
}

describe('legacy HTML entrypoints use gzip-capable loading', () => {
  test('combi.html includes ua.fetch_gz and gzip-only meta mode', () => {
    const html = read('combi.html');
    expect(html).toContain('<meta name="unfallatlas:data-mode" content="gzip-only" />');
    expect(html).toContain('js/ua.fetch_gz.js');
    expect(html).toContain('fetchJsonCompressed');
  });

  test('unfallwerkbank.html includes ua.fetch_gz and gzip-only meta mode', () => {
    const html = read('unfallwerkbank.html');
    expect(html).toContain('<meta name="unfallatlas:data-mode" content="gzip-only" />');
    expect(html).toContain('js/ua.fetch_gz.js');
    expect(html).toContain('fetchJsonCompressed');
  });

  test('werkbank_v2.html declares gzip-only data mode', () => {
    const html = read('werkbank_v2.html');
    expect(html).toContain('<meta name="unfallatlas:data-mode" content="gzip-only" />');
  });
});
