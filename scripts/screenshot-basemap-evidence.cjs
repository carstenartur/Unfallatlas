'use strict';

function isAuthenticRaster(response) {
  return response && response.status >= 200 && response.status < 300 &&
    /^image\/(?:png|jpe?g|webp)(?:;|$)/i.test(String(response.contentType || '')) &&
    response.fixture !== true;
}

function validatePublicationBasemap(capture, requirement, label, errors) {
  const basemap = capture && capture.basemap;
  if (!capture || capture.profile !== 'publication' || !basemap || basemap.authentic !== true) {
    errors.push(`${label}: authentic publication basemap evidence is missing`);
    return;
  }
  if (basemap.requirement !== requirement) {
    errors.push(`${label}: basemap requirement ${basemap.requirement || '(missing)'} does not match ${requirement}`);
  }

  const responses = Array.isArray(basemap.responses) ? basemap.responses : [];
  if (responses.some(response =>
      /svg/i.test(String(response.contentType || '')) || response.fixture === true)) {
    errors.push(`${label}: synthetic/SVG map responses cannot certify publication media`);
  }

  const standard = responses.some(response =>
    response.kind === 'standard' && isAuthenticRaster(response));
  const labels = responses.some(response =>
    response.kind === 'labels' && isAuthenticRaster(response));
  const officialOrthophoto = responses.some(response =>
    response.kind === 'orthophoto' && response.officialForExport === true &&
    isAuthenticRaster(response));
  const orthophotoFailure = responses.some(response =>
    response.kind === 'orthophoto' && (response.status >= 400 || response.status === 0));
  const osmAttribution = /OpenStreetMap/i.test(String(basemap.attribution || ''));

  const valid = requirement === 'standard' ? standard && osmAttribution
    : requirement === 'orthophoto' ? officialOrthophoto
      : requirement === 'hybrid' ? officialOrthophoto && labels && osmAttribution
        : requirement === 'fallback' ? orthophotoFailure && standard && osmAttribution
          : false;
  if (!valid) {
    errors.push(`${label}: authentic ${requirement} basemap requirement is not met`);
  }
}

module.exports = { validatePublicationBasemap };
