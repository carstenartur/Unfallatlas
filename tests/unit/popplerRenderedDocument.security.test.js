'use strict';

const {
  parseBboxPages,
  parsePdfToHtmlPages,
} = require('../../scripts/poppler-rendered-document');

describe('Poppler extracted-text sanitization', () => {
  test.each([
    [
      'pdftotext bbox',
      () => parseBboxPages(
        '<doc><page width="100" height="100">' +
        '<word xMin="1" yMin="1" xMax="90" yMax="12">' +
        '&lt;script&gt;alert(1)&lt;/script&gt; Sicher' +
        '</word></page></doc>'
      )[0].words[0].text,
    ],
    [
      'pdftohtml XML',
      () => parsePdfToHtmlPages(
        '<pdf2xml><fontspec id="0" size="10"/>' +
        '<page width="100" height="100">' +
        '<text left="1" top="1" width="90" height="12" font="0">' +
        '&lt;script&gt;alert(1)&lt;/script&gt; Sicher' +
        '</text></page></pdf2xml>'
      )[0].texts[0].text,
    ],
  ])('does not return executable markup from %s', (_label, extract) => {
    const text = extract();
    expect(text).toContain('Sicher');
    expect(text).not.toMatch(/[<>]/);
    expect(text).not.toMatch(/<script/i);
  });
});
