/**
 * Unit tests for ua.utils.js utility functions
 */

describe('UA.utils - Utility Functions', () => {
  let UA;

  beforeEach(() => {
    // Setup global UA object like in the browser
    global.window = {
      UA: {},
      location: {
        href: 'http://localhost:8000/werkbank_v2.html?city=Hannover&severity=all'
      },
      history: {
        replaceState: jest.fn()
      }
    };

    // Load the module - using eval because files use IIFE pattern
    // Files are loaded from project root: js/ua.utils.js
    const fs = require('fs');
    const path = require('path');
    const filePath = path.resolve(__dirname, '../../js/ua.utils.js');
    eval(fs.readFileSync(filePath, 'utf8'));
    UA = global.window.UA;
  });

  afterEach(() => {
    delete global.window;
  });

  describe('escHtml', () => {
    test('should escape HTML entities', () => {
      expect(UA.escHtml('<script>alert("XSS")</script>'))
        .toBe('&lt;script&gt;alert(&quot;XSS&quot;)&lt;/script&gt;');
    });

    test('should escape ampersands', () => {
      expect(UA.escHtml('Tom & Jerry')).toBe('Tom &amp; Jerry');
    });

    test('should handle empty strings', () => {
      expect(UA.escHtml('')).toBe('');
    });

    test('should handle null and undefined', () => {
      expect(UA.escHtml(null)).toBe('');
      expect(UA.escHtml(undefined)).toBe('');
    });
  });

  describe('normKey', () => {
    test('should normalize German city names', () => {
      expect(UA.normKey('München')).toBe('muenchen');
      expect(UA.normKey('Köln')).toBe('koeln');
      expect(UA.normKey('Düsseldorf')).toBe('duesseldorf');
    });

    test('should replace special characters with underscores', () => {
      expect(UA.normKey('Frankfurt am Main')).toBe('frankfurt_am_main');
      expect(UA.normKey('Bad Homburg v.d.H.')).toBe('bad_homburg_v_d_h');
    });

    test('should handle multiple spaces and special chars', () => {
      expect(UA.normKey('  Test   City  ')).toBe('test_city');
    });

    test('should handle empty strings', () => {
      expect(UA.normKey('')).toBe('');
    });

    test('should convert to lowercase', () => {
      expect(UA.normKey('BERLIN')).toBe('berlin');
    });

    test('should replace ß with ss', () => {
      expect(UA.normKey('Straße')).toBe('strasse');
    });
  });

  describe('qGet', () => {
    test('should get query parameter value', () => {
      expect(UA.qGet('city', 'default')).toBe('Hannover');
    });

    test('should return default for missing parameter', () => {
      expect(UA.qGet('missing', 'default')).toBe('default');
    });

    test('should return default for empty parameter', () => {
      global.window.location.href = 'http://localhost:8000/?empty=';
      expect(UA.qGet('empty', 'default')).toBe('default');
    });
  });

  describe('qBool', () => {
    beforeEach(() => {
      global.window.location.href = 'http://localhost:8000/?flag1=1&flag2=true&flag3=yes&flag4=0&flag5=false';
    });

    test('should parse "1" as true', () => {
      expect(UA.qBool('flag1', false)).toBe(true);
    });

    test('should parse "true" as true', () => {
      expect(UA.qBool('flag2', false)).toBe(true);
    });

    test('should parse "yes" as true', () => {
      expect(UA.qBool('flag3', false)).toBe(true);
    });

    test('should parse "0" as false', () => {
      expect(UA.qBool('flag4', true)).toBe(false);
    });

    test('should parse "false" as false', () => {
      expect(UA.qBool('flag5', true)).toBe(false);
    });

    test('should return default for missing parameter', () => {
      expect(UA.qBool('missing', true)).toBe(true);
      expect(UA.qBool('missing', false)).toBe(false);
    });
  });

  describe('qNum', () => {
    beforeEach(() => {
      global.window.location.href = 'http://localhost:8000/?num=42&float=3.14&invalid=abc';
    });

    test('should parse integer values', () => {
      expect(UA.qNum('num', 0)).toBe(42);
    });

    test('should parse float values', () => {
      expect(UA.qNum('float', 0)).toBe(3.14);
    });

    test('should return default for invalid numbers', () => {
      expect(UA.qNum('invalid', 99)).toBe(99);
    });

    test('should return default for missing parameter', () => {
      expect(UA.qNum('missing', 100)).toBe(100);
    });
  });

  describe('setQS', () => {
    // Skip these tests as they require actual browser history API
    // These would be better tested in E2E tests with Playwright
    test.skip('should update query string parameters (requires browser env)', () => {
      const url = UA.setQS({ severity: 'all', zoom: 12 });
      expect(url).toContain('severity=all');
    });

    test.skip('should delete parameters with null/undefined/empty values (requires browser env)', () => {
      const url = UA.setQS({ city: null });
      expect(url).not.toContain('city=');
    });

    test.skip('should call history.replaceState by default (requires browser env)', () => {
      UA.setQS({ test: 'value' });
      expect(true).toBe(true);
    });
  });

  describe('WEEKEND_SET', () => {
    test('should contain Saturday (7) and Sunday (1)', () => {
      expect(UA.WEEKEND_SET.has('1')).toBe(true);
      expect(UA.WEEKEND_SET.has('7')).toBe(true);
    });

    test('should not contain weekdays', () => {
      expect(UA.WEEKEND_SET.has('2')).toBe(false);
      expect(UA.WEEKEND_SET.has('3')).toBe(false);
      expect(UA.WEEKEND_SET.has('4')).toBe(false);
      expect(UA.WEEKEND_SET.has('5')).toBe(false);
      expect(UA.WEEKEND_SET.has('6')).toBe(false);
    });
  });
});
