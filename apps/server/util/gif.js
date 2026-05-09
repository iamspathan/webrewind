// Streaming GIF encoder that consumes PNG/JPEG frame Buffers as they're
// produced by the capture worker pool (which emits them out-of-order).
// Frames are buffered until the next-expected index is available, then
// drained in order into gif-encoder-2. The encoded GIF is collected in
// memory and returned as a Buffer; the caller is responsible for
// uploading it to object storage.

const { PassThrough } = require("stream");
const GIFEncoder = require("gif-encoder-2");
const { createCanvas, Image } = require("canvas");
const log = require("./logger");

function createStreamingGifEncoder({ delayMs = 500 } = {}) {
  // pending[index] -> Buffer; skipped holds indices we'll never encode
  // (capture skipped after retries). nextExpected advances monotonically.
  const pending = new Map();
  const skipped = new Set();
  let nextExpected = 0;
  let encoder = null;
  let canvas = null;
  let ctx = null;
  let passthrough = null;
  let collectedChunks = null;
  let streamClosed = null;
  let finished = false;
  let aborted = false;
  let framesEncoded = 0;
  // Serialize drain operations — canvas + gif-encoder-2 are not re-entrant.
  let drainChain = Promise.resolve();

  async function loadImage(buf) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = buf;
    });
  }

  async function initIfNeeded(firstBuf) {
    if (encoder) return;
    const first = await loadImage(firstBuf);
    const width = first.width;
    const height = first.height;

    passthrough = new PassThrough();
    collectedChunks = [];
    passthrough.on("data", (c) => collectedChunks.push(c));
    streamClosed = new Promise((resolve) => {
      passthrough.once("end", resolve);
      passthrough.once("close", resolve);
    });

    encoder = new GIFEncoder(width, height, "neuquant");
    encoder.createReadStream().pipe(passthrough);
    encoder.start();
    encoder.setDelay(delayMs);
    canvas = createCanvas(width, height);
    ctx = canvas.getContext("2d");

    // Draw the first frame now so we don't reload it.
    ctx.drawImage(first, 0, 0);
    encoder.addFrame(ctx);
    framesEncoded++;
  }

  async function encodeFrame(buf) {
    const image = await loadImage(buf);
    ctx.drawImage(image, 0, 0);
    encoder.addFrame(ctx);
  }

  function tryDrain() {
    drainChain = drainChain
      .then(async () => {
        if (aborted || finished) return;
        while (true) {
          if (skipped.has(nextExpected)) {
            nextExpected++;
            continue;
          }
          if (!pending.has(nextExpected)) break;
          const buf = pending.get(nextExpected);
          pending.delete(nextExpected);
          const isFirst = !encoder;
          try {
            if (isFirst) {
              await initIfNeeded(buf);
            } else {
              await encodeFrame(buf);
              framesEncoded++;
            }
          } catch (err) {
            log.warn("gif: frame encode failed, skipping", {
              index: nextExpected,
              err: err.message,
            });
          }
          nextExpected++;
        }
      })
      .catch(() => {
        // Never let a drain error poison the chain — future frames must still
        // have a chance to drain.
      });
    return drainChain;
  }

  return {
    onFrame(index, buf) {
      if (finished || aborted) return;
      pending.set(index, buf);
      tryDrain();
    },
    onSkip(index) {
      if (finished || aborted) return;
      skipped.add(index);
      tryDrain();
    },
    async finish() {
      if (finished) return { gifBuffer: null, framesEncoded };
      // Wait for any in-flight drain to settle before closing.
      await drainChain;
      finished = true;
      if (!encoder) {
        return { gifBuffer: null, framesEncoded: 0 };
      }
      try {
        encoder.finish();
      } catch (err) {
        log.warn("gif: encoder.finish failed", { err: err.message });
      }
      // PassThrough ends when the encoder's readable side EOFs.
      await streamClosed;
      const gifBuffer = Buffer.concat(collectedChunks);
      collectedChunks = null;
      return { gifBuffer, framesEncoded };
    },
    async abort() {
      if (finished || aborted) return;
      aborted = true;
      finished = true;
      try {
        await drainChain;
      } catch {
        /* ignore */
      }
      try {
        if (encoder) encoder.finish();
      } catch {
        /* ignore */
      }
      // Drop the partial stream so collected chunks aren't held in memory.
      if (passthrough && !passthrough.destroyed) {
        passthrough.destroy();
      }
      collectedChunks = null;
    },
  };
}

module.exports = { createStreamingGifEncoder };
