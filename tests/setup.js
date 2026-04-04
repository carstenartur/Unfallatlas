// Jest global setup for jsdom environment
// pdfmake 0.3.x requires TextEncoder/TextDecoder which are available in Node.js
// but not automatically exposed in the jsdom test environment.
const { TextEncoder, TextDecoder } = require('util');
global.TextEncoder = TextEncoder;
global.TextDecoder = TextDecoder;
