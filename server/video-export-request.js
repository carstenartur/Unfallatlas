'use strict';

const contract = require('../js/ua.video-export-contract.js');

const LEGACY_KEYS = new Set(contract.LEGACY_KEYS);

function parseVideoExportState(body) {
  if (body != null && (typeof body !== 'object' || Array.isArray(body))) {
    throw new contract.VideoExportContractError(
      'invalid_state',
      'request',
      body,
      'Video request body must be a JSON object'
    );
  }
  const raw = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  if (Object.prototype.hasOwnProperty.call(raw, 'state')) {
    const unknown = Object.keys(raw).filter(key => key !== 'state' && key !== 'format');
    if (unknown.length) {
      throw new contract.VideoExportContractError(
        'unknown_parameter',
        'request',
        unknown,
        `Canonical video request contains unknown fields: ${unknown.join(', ')}`
      );
    }
    return contract.normalizeState(raw.state);
  }

  const unknown = Object.keys(raw).filter(key => key !== 'format' && !LEGACY_KEYS.has(key));
  if (unknown.length) {
    throw new contract.VideoExportContractError(
      'unknown_parameter',
      'request',
      unknown,
      `Video request contains unknown fields: ${unknown.join(', ')}`
    );
  }
  const legacy = { ...raw };
  delete legacy.format;
  return contract.fromLegacyParams(legacy);
}

function contractErrorBody(error) {
  return {
    error: error && error.code || 'invalid_video_export_state',
    category: 'invalid_request',
    path: error && error.path || 'state',
    message: error && error.message || 'Invalid video export state',
  };
}

function validateVideoExportState(req, res, next) {
  try {
    req.videoExportState = parseVideoExportState(req.body);
    next();
  } catch (error) {
    if (error instanceof contract.VideoExportContractError || error && error.status === 400) {
      return res.status(400).json(contractErrorBody(error));
    }
    return res.status(400).json(contractErrorBody(error));
  }
}

module.exports = {
  LEGACY_KEYS,
  contractErrorBody,
  parseVideoExportState,
  validateVideoExportState,
};
