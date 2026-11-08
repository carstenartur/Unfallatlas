'use strict';

// Node-based document QA must use pdfmake's Node build. The browser build
// starts a Web Worker when decoding PNGs with transparency.
const pdfMake = require('pdfmake');
const fonts = require('pdfmake/fonts/Roboto');
const bundledFontFiles = new Set(Object.values(fonts.Roboto));

pdfMake.addFonts(fonts);
pdfMake.setUrlAccessPolicy(() => false);
pdfMake.setLocalAccessPolicy(file => bundledFontFiles.has(file));

module.exports = pdfMake;
