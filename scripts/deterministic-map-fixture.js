#!/usr/bin/env node
'use strict';

const zlib = require('zlib');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let crcTable = null;

function getCrcTable() {
  if (crcTable) return crcTable;
  crcTable = new Uint32Array(256);
  for (let value = 0; value < 256; value += 1) {
    let crc = value;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
    }
    crcTable[value] = crc >>> 0;
  }
  return crcTable;
}

function crc32(buffer) {
  const table = getCrcTable();
  let crc = 0xffffffff;
  for (const byte of buffer) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data = Buffer.alloc(0)) {
  const name = Buffer.from(type, 'ascii');
  if (name.length !== 4) throw new Error(`PNG chunk type must be four bytes: ${type}`);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])), 0);
  return Buffer.concat([length, name, data, checksum]);
}

function createSurface(width, height, rgba) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 64 || height < 64) {
    throw new Error('Map fixture dimensions must be integers >= 64');
  }
  const pixels = Buffer.alloc(width * height * 4);
  for (let offset = 0; offset < pixels.length; offset += 4) {
    pixels[offset] = rgba[0];
    pixels[offset + 1] = rgba[1];
    pixels[offset + 2] = rgba[2];
    pixels[offset + 3] = rgba[3] == null ? 255 : rgba[3];
  }
  return { width, height, pixels };
}

function setPixel(surface, x, y, rgba) {
  const roundedX = Math.round(x);
  const roundedY = Math.round(y);
  if (roundedX < 0 || roundedY < 0 || roundedX >= surface.width || roundedY >= surface.height) return;
  const offset = (roundedY * surface.width + roundedX) * 4;
  surface.pixels[offset] = rgba[0];
  surface.pixels[offset + 1] = rgba[1];
  surface.pixels[offset + 2] = rgba[2];
  surface.pixels[offset + 3] = rgba[3] == null ? 255 : rgba[3];
}

function fillRect(surface, x, y, width, height, rgba) {
  const left = Math.max(0, Math.floor(x));
  const top = Math.max(0, Math.floor(y));
  const right = Math.min(surface.width, Math.ceil(x + width));
  const bottom = Math.min(surface.height, Math.ceil(y + height));
  for (let row = top; row < bottom; row += 1) {
    for (let column = left; column < right; column += 1) setPixel(surface, column, row, rgba);
  }
}

function drawLine(surface, x0, y0, x1, y1, rgba, thickness = 1) {
  let startX = Math.round(x0);
  let startY = Math.round(y0);
  const endX = Math.round(x1);
  const endY = Math.round(y1);
  const deltaX = Math.abs(endX - startX);
  const deltaY = Math.abs(endY - startY);
  const stepX = startX < endX ? 1 : -1;
  const stepY = startY < endY ? 1 : -1;
  let error = deltaX - deltaY;
  const radius = Math.max(0, Math.floor(thickness / 2));
  while (true) {
    fillRect(surface, startX - radius, startY - radius, radius * 2 + 1, radius * 2 + 1, rgba);
    if (startX === endX && startY === endY) break;
    const twiceError = error * 2;
    if (twiceError > -deltaY) {
      error -= deltaY;
      startX += stepX;
    }
    if (twiceError < deltaX) {
      error += deltaX;
      startY += stepY;
    }
  }
}

function drawCircle(surface, centerX, centerY, radius, fill, stroke = null, strokeWidth = 1) {
  const outer = radius + Math.max(0, strokeWidth);
  for (let y = Math.floor(centerY - outer); y <= Math.ceil(centerY + outer); y += 1) {
    for (let x = Math.floor(centerX - outer); x <= Math.ceil(centerX + outer); x += 1) {
      const distance = Math.hypot(x - centerX, y - centerY);
      if (stroke && distance <= radius + strokeWidth && distance >= radius - strokeWidth) {
        setPixel(surface, x, y, stroke);
      } else if (distance < radius - strokeWidth) {
        setPixel(surface, x, y, fill);
      }
    }
  }
}

function drawDashedRect(surface, x, y, width, height, rgba, thickness = 3, dash = 14) {
  for (let offset = 0; offset < width; offset += dash * 2) {
    drawLine(surface, x + offset, y, Math.min(x + offset + dash, x + width), y, rgba, thickness);
    drawLine(surface, x + offset, y + height, Math.min(x + offset + dash, x + width), y + height, rgba, thickness);
  }
  for (let offset = 0; offset < height; offset += dash * 2) {
    drawLine(surface, x, y + offset, x, Math.min(y + offset + dash, y + height), rgba, thickness);
    drawLine(surface, x + width, y + offset, x + width, Math.min(y + offset + dash, y + height), rgba, thickness);
  }
}

function drawRoad(surface, points, width) {
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    drawLine(surface, previous[0], previous[1], current[0], current[1], [164, 169, 173, 255], width + 6);
    drawLine(surface, previous[0], previous[1], current[0], current[1], [248, 248, 244, 255], width);
    if (width >= 10) drawLine(surface, previous[0], previous[1], current[0], current[1], [212, 177, 82, 255], 2);
  }
}

function encodePng(surface, metadata = {}) {
  const { width, height, pixels } = surface;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const scanlines = Buffer.alloc((stride + 1) * height);
  for (let row = 0; row < height; row += 1) {
    const destination = row * (stride + 1);
    scanlines[destination] = 0;
    pixels.copy(scanlines, destination + 1, row * stride, (row + 1) * stride);
  }
  const textChunks = Object.entries(metadata).map(([key, value]) =>
    chunk('tEXt', Buffer.from(`${key}\0${String(value)}`, 'latin1'))
  );
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    ...textChunks,
    chunk('IDAT', zlib.deflateSync(scanlines, { level: 9 })),
    chunk('IEND'),
  ]);
}

function createDeterministicMapPng(options = {}) {
  const width = Number(options.width || 960);
  const height = Number(options.height || 640);
  const surface = createSurface(width, height, [232, 238, 229, 255]);

  // Water, parks and blocks provide a stable cartographic background.
  fillRect(surface, width * 0.72, 0, width * 0.16, height, [180, 216, 233, 255]);
  fillRect(surface, width * 0.08, height * 0.08, width * 0.22, height * 0.18, [190, 218, 181, 255]);
  fillRect(surface, width * 0.43, height * 0.68, width * 0.18, height * 0.22, [196, 222, 184, 255]);
  for (let row = 0; row < 5; row += 1) {
    for (let column = 0; column < 7; column += 1) {
      const x = width * 0.05 + column * width * 0.12 + (row % 2) * width * 0.025;
      const y = height * 0.34 + row * height * 0.105;
      fillRect(surface, x, y, width * 0.065, height * 0.055, [215, 210, 199, 255]);
    }
  }

  // Main and secondary roads with center lines.
  drawRoad(surface, [[-20, height * 0.56], [width * 0.28, height * 0.49], [width * 0.55, height * 0.54], [width + 20, height * 0.43]], 18);
  drawRoad(surface, [[width * 0.48, -20], [width * 0.51, height * 0.34], [width * 0.55, height * 0.54], [width * 0.62, height + 20]], 16);
  drawRoad(surface, [[width * 0.12, -20], [width * 0.2, height * 0.3], [width * 0.28, height * 0.49], [width * 0.33, height + 20]], 10);
  drawRoad(surface, [[-20, height * 0.22], [width * 0.34, height * 0.27], [width * 0.7, height * 0.2]], 8);
  drawRoad(surface, [[width * 0.08, height + 20], [width * 0.18, height * 0.74], [width * 0.55, height * 0.54], [width * 0.78, height * 0.78]], 8);

  // Selected analysis area and accident markers.
  drawDashedRect(surface, width * 0.24, height * 0.28, width * 0.44, height * 0.46, [177, 36, 36, 255], 4, 16);
  const accidents = [
    [0.29, 0.49, [215, 38, 56, 255]],
    [0.37, 0.47, [226, 112, 32, 255]],
    [0.47, 0.52, [215, 38, 56, 255]],
    [0.54, 0.55, [127, 63, 152, 255]],
    [0.58, 0.61, [226, 112, 32, 255]],
    [0.42, 0.32, [226, 112, 32, 255]],
    [0.31, 0.65, [127, 63, 152, 255]],
    [0.63, 0.4, [215, 38, 56, 255]],
  ];
  for (const [x, y, colour] of accidents) {
    drawCircle(surface, width * x, height * y, 9, colour, [255, 255, 255, 255], 3);
  }

  // North arrow and compact legend without relying on fonts.
  fillRect(surface, 18, 18, 198, 82, [255, 255, 255, 238]);
  drawLine(surface, 48, 78, 48, 35, [31, 41, 55, 255], 4);
  drawLine(surface, 48, 35, 38, 50, [31, 41, 55, 255], 4);
  drawLine(surface, 48, 35, 58, 50, [31, 41, 55, 255], 4);
  drawCircle(surface, 90, 42, 7, [215, 38, 56, 255], [255, 255, 255, 255], 2);
  drawCircle(surface, 90, 62, 7, [226, 112, 32, 255], [255, 255, 255, 255], 2);
  drawCircle(surface, 90, 82, 7, [127, 63, 152, 255], [255, 255, 255, 255], 2);
  fillRect(surface, 108, 36, 82, 8, [80, 80, 80, 255]);
  fillRect(surface, 108, 56, 62, 8, [110, 110, 110, 255]);
  fillRect(surface, 108, 76, 72, 8, [95, 95, 95, 255]);

  return encodePng(surface, {
    Title: options.title || 'Deterministic Unfallwerkbank map fixture',
    Source: 'Synthetic QA fixture; no external map tiles',
    Scenario: options.scenario || 'Bonn urban junction',
  });
}

function toDataUrl(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new Error('toDataUrl expects a Buffer');
  return `data:image/png;base64,${buffer.toString('base64')}`;
}

module.exports = {
  PNG_SIGNATURE,
  crc32,
  createDeterministicMapPng,
  toDataUrl,
};
