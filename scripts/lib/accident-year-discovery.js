'use strict';

const OFFICIAL_INDEX_URL =
  'https://www.opengeodata.nrw.de/produkte/transport_verkehr/unfallatlas/';
const FIRST_ACCIDENT_YEAR = 2016;
const DEFAULT_TIMEOUT_MS = 30_000;
const CSV_FILE_PATTERN = /Unfallorte(\d{4})_EPSG25832_CSV\.zip/gi;

function normalizeYear(value, label = 'year') {
  const year = Number.parseInt(String(value), 10);
  if (!Number.isInteger(year) || year < FIRST_ACCIDENT_YEAR || year > 9999) {
    throw new Error(`[accident-year-discovery] Invalid ${label}: ${value}`);
  }
  return year;
}

function parseAvailableAccidentYears(html) {
  if (typeof html !== 'string') {
    throw new TypeError('[accident-year-discovery] Official index HTML must be a string');
  }

  const years = new Set();
  for (const match of html.matchAll(CSV_FILE_PATTERN)) {
    years.add(normalizeYear(match[1], 'year in official index'));
  }

  return [...years].sort((left, right) => left - right);
}

function expectedYearsThrough(highestYear, firstYear = FIRST_ACCIDENT_YEAR) {
  const first = normalizeYear(firstYear, 'first year');
  const highest = normalizeYear(highestYear, 'highest year');
  if (highest < first) {
    throw new Error(
      `[accident-year-discovery] Highest year ${highest} is before first year ${first}`
    );
  }

  return Array.from({ length: highest - first + 1 }, (_unused, index) => first + index);
}

function validateAvailableAccidentYears(years, firstYear = FIRST_ACCIDENT_YEAR) {
  if (!Array.isArray(years) || years.length === 0) {
    throw new Error(
      '[accident-year-discovery] No official Unfallorte CSV distributions were found'
    );
  }

  const normalized = [...new Set(years.map((year) => normalizeYear(year)))].sort(
    (left, right) => left - right
  );
  const highestYear = normalized.at(-1);
  const expected = expectedYearsThrough(highestYear, firstYear);
  const available = new Set(normalized);
  const missing = expected.filter((year) => !available.has(year));

  if (missing.length > 0) {
    throw new Error(
      `[accident-year-discovery] Official index is incomplete through ${highestYear}; missing CSV years: ${missing.join(', ')}`
    );
  }

  return expected;
}

function parseYearOverride(value) {
  const values = Array.isArray(value) ? value : String(value || '').split(/[\s,;]+/);
  const years = values.filter((item) => String(item).trim() !== '').map((item) => normalizeYear(item));

  if (years.length === 0) {
    throw new Error('[accident-year-discovery] --years must contain at least one year');
  }

  return [...new Set(years)].sort((left, right) => left - right);
}

async function fetchOfficialIndexHtml({
  indexUrl = OFFICIAL_INDEX_URL,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('[accident-year-discovery] No fetch implementation is available');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('[accident-year-discovery] timeoutMs must be greater than zero');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(indexUrl, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        accept: 'text/html,application/xhtml+xml',
        'user-agent': 'Unfallwerkbank accident-year discovery',
      },
    });

    if (!response || !response.ok) {
      const status = response ? `${response.status} ${response.statusText || ''}`.trim() : 'no response';
      throw new Error(
        `[accident-year-discovery] Failed to read official index ${indexUrl}: ${status}`
      );
    }

    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

async function discoverAccidentYears(options = {}) {
  const html = options.html ?? (await fetchOfficialIndexHtml(options));
  return validateAvailableAccidentYears(
    parseAvailableAccidentYears(html),
    options.firstYear ?? FIRST_ACCIDENT_YEAR
  );
}

module.exports = {
  OFFICIAL_INDEX_URL,
  FIRST_ACCIDENT_YEAR,
  DEFAULT_TIMEOUT_MS,
  parseAvailableAccidentYears,
  expectedYearsThrough,
  validateAvailableAccidentYears,
  parseYearOverride,
  fetchOfficialIndexHtml,
  discoverAccidentYears,
};
