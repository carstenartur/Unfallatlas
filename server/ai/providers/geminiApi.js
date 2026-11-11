'use strict';

const apiBase = 'https://generativelanguage.googleapis.com/v1beta/models';

function configuredModel() {
  return process.env.AI_ASSESSMENT_MODEL || 'gemini-3.6-flash';
}

function answerText(candidate) {
  const parts = candidate?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts.filter(part => part && !part.thought && typeof part.text === 'string')
    .map(part => part.text).join('');
}

module.exports = { apiBase, configuredModel, answerText };
