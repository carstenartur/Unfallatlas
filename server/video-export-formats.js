'use strict';

const VIDEO_EXPORT_FORMATS = Object.freeze({
  gif: Object.freeze({
    contentType: 'image/gif',
    extension: 'gif'
  }),
  webp: Object.freeze({
    contentType: 'image/webp',
    extension: 'webp'
  }),
  apng: Object.freeze({
    contentType: 'image/apng',
    extension: 'apng'
  })
});

const SUPPORTED_VIDEO_EXPORT_FORMATS = Object.freeze(Object.keys(VIDEO_EXPORT_FORMATS));

module.exports = {
  VIDEO_EXPORT_FORMATS,
  SUPPORTED_VIDEO_EXPORT_FORMATS
};
