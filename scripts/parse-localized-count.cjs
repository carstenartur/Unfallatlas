'use strict';

/**
 * Extracts an integer accident count from the localized status line used by
 * the workbench UI. Counts are integers, so dots, commas, normal spaces,
 * non-breaking spaces and narrow non-breaking spaces are grouping separators
 * rather than decimal separators.
 */
function parseLocalizedInteger(value) {
  const digits = String(value == null ? '' : value).replace(/\D/gu, '');
  if (!digits) return null;
  const number = Number(digits);
  return Number.isSafeInteger(number) ? number : null;
}

function visibleCountFromStatus(text) {
  const match = String(text || '').match(
    /(?:lokal\s+|im\s+Viewport:\s*)(\d(?:[\d.,\u00A0\u202F\s]*\d)?)(?:\s+Unfälle)?/iu,
  );
  return match ? (parseLocalizedInteger(match[1]) ?? 0) : 0;
}

module.exports = Object.freeze({
  parseLocalizedInteger,
  visibleCountFromStatus,
});
