'use strict';

const fs = require('fs');
const path = require('path');

describe('Werkbank deployment asset versions', () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../../werkbank_v2.html'), 'utf8');
  const version = '2026-07-19';

  test.each([
    'css/ua.css',
    'js/ua.core.js',
    'js/ua.utils.js',
    'js/ua.ui.js',
    'js/ua.lifecycle.js',
    'js/ua.map_v2.js',
    'js/ua.popup_context.js',
    'js/ua.report_v2.js',
    'js/ua.app_v2.js',
    'js/ua.tour.js',
    'js/ua.political-context.js',
    'js/ua.priorities.js',
  ])('%s uses the current cache buster', (asset) => {
    expect(html).toContain(`${asset}?v=${version}`);
  });

  test('support metadata and runtime BUILD expose the same release timestamp', () => {
    const timestamp = `${version} 00:00 UTC`;
    expect(html).toContain(`<meta name="unfallwerkbank-build" content="${timestamp}"/>`);
    expect(html).toContain(`window.UA = { BUILD: "${timestamp}" }`);
  });
});
