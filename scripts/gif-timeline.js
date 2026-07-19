'use strict';

const crypto = require('crypto');

const MIN_FRAME_DELAY_CENTISECONDS = 2;
const MIN_PAINTED_CANVAS_RATIO = 0.5;
const MIN_VISIBLE_CHANGE_RATIO = 0.001;

function fail(file, message) {
  throw new Error(`${message}: ${file}`);
}

function readSubBlocks(buffer, start, file) {
  const chunks = [];
  let offset = start;
  while (offset < buffer.length) {
    const size = buffer[offset++];
    if (size === 0) return { data: Buffer.concat(chunks), offset };
    if (offset + size > buffer.length) fail(file, 'truncated GIF data block');
    chunks.push(buffer.subarray(offset, offset + size));
    offset += size;
  }
  fail(file, 'unterminated GIF data block');
}

function decodeLzwIndices(data, minimumCodeSize, expectedPixels, paletteSize, file, frameNumber) {
  const clearCode = 1 << minimumCodeSize;
  const endCode = clearCode + 1;
  const prefixes = new Int16Array(4096);
  prefixes.fill(-1);
  const suffixes = new Uint8Array(4096);
  const stack = new Uint8Array(4096);
  for (let index = 0; index < clearCode; index += 1) suffixes[index] = index;
  const output = new Uint8Array(expectedPixels);

  let codeSize = minimumCodeSize + 1;
  let nextCode = endCode + 1;
  let bitOffset = 0;
  let previousCode = null;
  let decodedPixels = 0;
  let sawClear = false;
  let sawEnd = false;
  let firstIndex = 0;

  const readCode = () => {
    if (bitOffset + codeSize > data.length * 8) return null;
    let code = 0;
    for (let bit = 0; bit < codeSize; bit += 1) {
      code |= ((data[(bitOffset + bit) >>> 3] >>> ((bitOffset + bit) & 7)) & 1) << bit;
    }
    bitOffset += codeSize;
    return code;
  };

  while (true) {
    let code = readCode();
    if (code === null) break;
    if (!sawClear && code !== clearCode) {
      fail(file, `GIF frame ${frameNumber} LZW stream does not start with a clear code`);
    }
    if (code === clearCode) {
      sawClear = true;
      codeSize = minimumCodeSize + 1;
      nextCode = endCode + 1;
      previousCode = null;
      continue;
    }
    if (code === endCode) {
      sawEnd = true;
      break;
    }
    if (code > nextCode || code >= 4096 || previousCode === null && code >= clearCode) {
      fail(file, `GIF frame ${frameNumber} contains an invalid LZW code ${code}`);
    }

    const incomingCode = code;
    let stackSize = 0;
    if (code === nextCode) {
      if (previousCode === null) fail(file, `GIF frame ${frameNumber} contains an invalid LZW code ${code}`);
      if (stackSize >= stack.length) fail(file, `GIF frame ${frameNumber} exceeds the LZW decode stack`);
      stack[stackSize++] = firstIndex;
      code = previousCode;
    }
    let chainLength = 0;
    while (code >= clearCode) {
      if (code >= nextCode || code >= 4096 || prefixes[code] < 0 || chainLength++ >= 4096) {
        fail(file, `GIF frame ${frameNumber} references an invalid LZW table entry`);
      }
      if (stackSize >= stack.length) fail(file, `GIF frame ${frameNumber} exceeds the LZW decode stack`);
      stack[stackSize++] = suffixes[code];
      code = prefixes[code];
    }
    if (code >= paletteSize) {
      fail(file, `GIF frame ${frameNumber} uses palette index ${code} outside its color table`);
    }
    firstIndex = code;
    if (stackSize >= stack.length) fail(file, `GIF frame ${frameNumber} exceeds the LZW decode stack`);
    stack[stackSize++] = firstIndex;
    if (decodedPixels + stackSize > expectedPixels) {
      fail(file, `GIF frame ${frameNumber} decodes beyond its ${expectedPixels}-pixel rectangle`);
    }
    while (stackSize) output[decodedPixels++] = stack[--stackSize];

    if (previousCode !== null && nextCode < 4096) {
      prefixes[nextCode] = previousCode;
      suffixes[nextCode] = firstIndex;
      nextCode += 1;
      if (nextCode === (1 << codeSize) && codeSize < 12) codeSize += 1;
    }
    previousCode = incomingCode;
  }

  if (!sawClear) fail(file, `GIF frame ${frameNumber} LZW clear code is missing`);
  if (!sawEnd) fail(file, `GIF frame ${frameNumber} LZW end code is missing`);
  if (decodedPixels !== expectedPixels) {
    fail(file, `GIF frame ${frameNumber} decodes to ${decodedPixels} instead of ${expectedPixels} pixels`);
  }
  return output;
}

function deinterlace(indices, width, height) {
  const output = new Uint8Array(indices.length);
  let sourceOffset = 0;
  for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]]) {
    for (let y = start; y < height; y += step) {
      output.set(indices.subarray(sourceOffset, sourceOffset + width), y * width);
      sourceOffset += width;
    }
  }
  return output;
}

function paletteAt(buffer, offset, size, file, label) {
  const end = offset + (size * 3);
  if (end > buffer.length) fail(file, `truncated GIF ${label} color table`);
  return { bytes: buffer.subarray(offset, end), offset: end, size };
}

function canvasDigest(canvas) {
  return crypto.createHash('sha256').update(canvas).digest('hex');
}

function parseGifTimeline(buffer, file = 'GIF') {
  if (!Buffer.isBuffer(buffer) || buffer.length < 14) fail(file, 'invalid GIF signature');
  const signature = buffer.subarray(0, 6).toString('ascii');
  if (!['GIF87a', 'GIF89a'].includes(signature)) fail(file, 'invalid GIF signature');

  const width = buffer.readUInt16LE(6);
  const height = buffer.readUInt16LE(8);
  if (!width || !height) fail(file, 'invalid GIF dimensions');

  const logicalPacked = buffer[10];
  const hasGlobalColorTable = !!(logicalPacked & 0x80);
  const globalPaletteSize = hasGlobalColorTable ? 2 ** ((logicalPacked & 0x07) + 1) : 0;
  const backgroundIndex = buffer[11];
  let offset = 13;
  let globalPalette = null;
  if (hasGlobalColorTable) {
    globalPalette = paletteAt(buffer, offset, globalPaletteSize, file, 'global');
    offset = globalPalette.offset;
    if (backgroundIndex >= globalPaletteSize) fail(file, 'GIF background index is outside its global color table');
  }

  const canvasPixels = width * height;
  const canvas = new Uint8Array(canvasPixels * 4);
  const backgroundRgba = new Uint8Array(4);
  if (globalPalette) {
    backgroundRgba[0] = globalPalette.bytes[backgroundIndex * 3];
    backgroundRgba[1] = globalPalette.bytes[(backgroundIndex * 3) + 1];
    backgroundRgba[2] = globalPalette.bytes[(backgroundIndex * 3) + 2];
    backgroundRgba[3] = 255;
    for (let pixel = 0; pixel < canvasPixels; pixel += 1) canvas.set(backgroundRgba, pixel * 4);
  }
  const everPainted = new Uint8Array(canvasPixels);
  let paintedCanvasPixels = 0;
  let previousDisplayedCanvas = null;
  let maxChangedPixels = 0;
  let changedFrames = 0;
  const compositedFrameDigests = [];
  const uniqueFrameDigests = new Set();

  let frames = 0;
  let trailer = false;
  let pendingGraphicControl = null;
  const frameDelays = [];

  while (offset < buffer.length) {
    const introducer = buffer[offset];
    if (introducer === 0x3b) {
      if (pendingGraphicControl) fail(file, 'GIF graphic control extension has no following graphic block');
      trailer = true;
      offset += 1;
      break;
    }

    if (introducer === 0x21) {
      if (offset + 2 >= buffer.length) fail(file, 'truncated GIF extension');
      const label = buffer[offset + 1];
      if (label === 0xf9) {
        if (pendingGraphicControl) fail(file, 'duplicate GIF graphic control extension before graphic block');
        if (offset + 8 > buffer.length || buffer[offset + 2] !== 4 || buffer[offset + 7] !== 0) {
          fail(file, 'invalid GIF graphic control extension');
        }
        const packed = buffer[offset + 3];
        if (packed & 0xe0) fail(file, 'GIF graphic control extension uses reserved bits');
        const disposal = (packed >>> 2) & 0x07;
        if (disposal > 3) fail(file, `unsupported GIF disposal method ${disposal}`);
        pendingGraphicControl = {
          offset: offset + 4,
          centiseconds: buffer.readUInt16LE(offset + 4),
          disposal,
          transparent: !!(packed & 0x01),
          transparentIndex: buffer[offset + 6],
        };
        offset += 8;
      } else if (label === 0x01) {
        // A GCE applies to the next *graphic rendering block*, which can be a
        // Plain Text Extension as well as an image. Since text rendering and
        // its palette semantics are not implemented here, accepting it could
        // leak its GCE delay into the next image. Fail closed instead.
        fail(file, 'GIF Plain Text Extension is unsupported');
      } else {
        offset = readSubBlocks(buffer, offset + 2, file).offset;
      }
      continue;
    }

    if (introducer === 0x2c) {
      if (offset + 10 > buffer.length) fail(file, 'truncated GIF image descriptor');
      const left = buffer.readUInt16LE(offset + 1);
      const top = buffer.readUInt16LE(offset + 3);
      const frameWidth = buffer.readUInt16LE(offset + 5);
      const frameHeight = buffer.readUInt16LE(offset + 7);
      if (!frameWidth || !frameHeight || left + frameWidth > width || top + frameHeight > height) {
        fail(file, `GIF frame ${frames + 1} has an invalid image rectangle`);
      }
      const packed = buffer[offset + 9];
      const interlaced = !!(packed & 0x40);
      offset += 10;
      let palette = globalPalette;
      if (packed & 0x80) {
        const paletteSize = 2 ** ((packed & 0x07) + 1);
        palette = paletteAt(buffer, offset, paletteSize, file, 'local');
        offset = palette.offset;
      }
      if (!palette) fail(file, `GIF frame ${frames + 1} has no color table`);

      if (!pendingGraphicControl || pendingGraphicControl.centiseconds < MIN_FRAME_DELAY_CENTISECONDS) {
        fail(
          file,
          `GIF frame ${frames + 1} needs a graphic-control delay of at least ${MIN_FRAME_DELAY_CENTISECONDS} centiseconds`
        );
      }
      if (pendingGraphicControl.transparent && pendingGraphicControl.transparentIndex >= palette.size) {
        fail(file, `GIF frame ${frames + 1} transparent index is outside its color table`);
      }
      if (offset >= buffer.length) fail(file, 'GIF image data is missing');
      const lzwMinimumCodeSize = buffer[offset++];
      if (lzwMinimumCodeSize < 2 || lzwMinimumCodeSize > 8) fail(file, 'invalid GIF LZW code size');
      const imageData = readSubBlocks(buffer, offset, file);
      offset = imageData.offset;
      let indices = decodeLzwIndices(
        imageData.data,
        lzwMinimumCodeSize,
        frameWidth * frameHeight,
        palette.size,
        file,
        frames + 1
      );
      if (interlaced) indices = deinterlace(indices, frameWidth, frameHeight);

      const restoreCanvas = pendingGraphicControl.disposal === 3 ? canvas.slice() : null;
      for (let frameY = 0; frameY < frameHeight; frameY += 1) {
        const canvasRow = (top + frameY) * width;
        const frameRow = frameY * frameWidth;
        for (let frameX = 0; frameX < frameWidth; frameX += 1) {
          const colorIndex = indices[frameRow + frameX];
          if (pendingGraphicControl.transparent && colorIndex === pendingGraphicControl.transparentIndex) continue;
          const canvasPixel = canvasRow + left + frameX;
          if (!everPainted[canvasPixel]) {
            everPainted[canvasPixel] = 1;
            paintedCanvasPixels += 1;
          }
          const canvasOffset = canvasPixel * 4;
          const paletteOffset = colorIndex * 3;
          canvas[canvasOffset] = palette.bytes[paletteOffset];
          canvas[canvasOffset + 1] = palette.bytes[paletteOffset + 1];
          canvas[canvasOffset + 2] = palette.bytes[paletteOffset + 2];
          canvas[canvasOffset + 3] = 255;
        }
      }

      const digest = canvasDigest(canvas);
      compositedFrameDigests.push(digest);
      uniqueFrameDigests.add(digest);
      if (previousDisplayedCanvas) {
        const currentPixels = new Uint32Array(canvas.buffer, canvas.byteOffset, canvasPixels);
        const previousPixels = new Uint32Array(
          previousDisplayedCanvas.buffer,
          previousDisplayedCanvas.byteOffset,
          canvasPixels
        );
        let changedPixels = 0;
        for (let pixel = 0; pixel < canvasPixels; pixel += 1) {
          if (currentPixels[pixel] !== previousPixels[pixel]) changedPixels += 1;
        }
        if (changedPixels) changedFrames += 1;
        if (changedPixels > maxChangedPixels) maxChangedPixels = changedPixels;
      }
      previousDisplayedCanvas = canvas.slice();

      if (pendingGraphicControl.disposal === 2) {
        const disposalBackground = pendingGraphicControl.transparent &&
          pendingGraphicControl.transparentIndex === backgroundIndex
          ? new Uint8Array(4)
          : backgroundRgba;
        for (let frameY = 0; frameY < frameHeight; frameY += 1) {
          const canvasRow = (top + frameY) * width;
          for (let frameX = 0; frameX < frameWidth; frameX += 1) {
            canvas.set(disposalBackground, (canvasRow + left + frameX) * 4);
          }
        }
      } else if (pendingGraphicControl.disposal === 3) {
        canvas.set(restoreCanvas);
      }
      frames += 1;
      frameDelays.push(pendingGraphicControl);
      pendingGraphicControl = null;
      continue;
    }

    fail(file, `invalid GIF block introducer 0x${introducer.toString(16)}`);
  }

  if (!trailer || offset !== buffer.length || frames === 0) fail(file, 'incomplete GIF structure');
  const paintedCanvasRatio = paintedCanvasPixels / canvasPixels;
  const requiredChangedPixels = Math.max(1, Math.ceil(canvasPixels * MIN_VISIBLE_CHANGE_RATIO));
  if (frames > 1 && paintedCanvasRatio < MIN_PAINTED_CANVAS_RATIO) {
    fail(
      file,
      `GIF visual canvas coverage ${(paintedCanvasRatio * 100).toFixed(2)}% is below ${(MIN_PAINTED_CANVAS_RATIO * 100).toFixed(0)}%`
    );
  }
  if (frames > 1 && uniqueFrameDigests.size < 2) {
    fail(file, 'GIF has no visible composited frame diversity');
  }
  if (frames > 1 && maxChangedPixels < requiredChangedPixels) {
    fail(file, `GIF visible frame change ${maxChangedPixels} pixels is below required ${requiredChangedPixels}`);
  }
  const durationCentiseconds = frameDelays.reduce((sum, delay) => sum + delay.centiseconds, 0);
  return {
    width,
    height,
    frames,
    animated: frames > 1,
    durationMs: durationCentiseconds * 10,
    frameDelays,
    visualEvidence: {
      valid: true,
      paintedCanvasPixels,
      paintedCanvasRatio,
      uniqueCompositedFrames: uniqueFrameDigests.size,
      changedFrames,
      maxChangedPixels,
      requiredChangedPixels,
      compositedFrameDigests,
    },
  };
}

function capGifDuration(buffer, maxDurationMs, file = 'GIF') {
  if (!Number.isInteger(maxDurationMs) || maxDurationMs <= 0) {
    throw new Error('maxDurationMs must be a positive integer');
  }
  // Parsing deliberately precedes the under-cap early return. Besides the
  // timeline, it validates every frame delay and every LZW pixel stream.
  const timeline = parseGifTimeline(buffer, file);
  const output = Buffer.from(buffer);
  if (timeline.durationMs <= maxDurationMs) {
    return { buffer: output, beforeMs: timeline.durationMs, afterMs: timeline.durationMs, changed: false };
  }

  const targetCentiseconds = Math.floor(maxDurationMs / 10);
  if (targetCentiseconds < timeline.frames * MIN_FRAME_DELAY_CENTISECONDS) {
    fail(file, `cannot shorten GIF to ${maxDurationMs} ms without unreadable frame timing`);
  }

  const currentCentiseconds = timeline.durationMs / 10;
  const adjusted = timeline.frameDelays.map(delay => ({
    ...delay,
    adjusted: Math.max(
      MIN_FRAME_DELAY_CENTISECONDS,
      Math.floor(delay.centiseconds * targetCentiseconds / currentCentiseconds)
    ),
  }));
  let adjustedTotal = adjusted.reduce((sum, delay) => sum + delay.adjusted, 0);
  while (adjustedTotal > targetCentiseconds) {
    const candidate = adjusted.reduce((best, delay) => (
      delay.adjusted > MIN_FRAME_DELAY_CENTISECONDS && (!best || delay.adjusted > best.adjusted) ? delay : best
    ), null);
    if (!candidate) fail(file, `cannot shorten GIF to ${maxDurationMs} ms`);
    candidate.adjusted -= 1;
    adjustedTotal -= 1;
  }
  for (const delay of adjusted) output.writeUInt16LE(delay.adjusted, delay.offset);

  const result = parseGifTimeline(output, file);
  if (result.durationMs > maxDurationMs) fail(file, 'shortened GIF still exceeds duration budget');
  return { buffer: output, beforeMs: timeline.durationMs, afterMs: result.durationMs, changed: true };
}

module.exports = { capGifDuration, parseGifTimeline };
