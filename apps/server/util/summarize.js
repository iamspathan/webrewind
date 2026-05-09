// AI summaries for website screenshots. Calls the NVIDIA-hosted Gemma 3n
// vision endpoint (OpenAI-compatible chat completions) with the image
// inlined as base64 inside the message content — this is the format
// NVIDIA's integrate.api.nvidia.com expects for vision models, NOT the
// OpenAI structured `content: [{type:"image_url", ...}]` array.
//
// Used exclusively by the server — the NVIDIA API key never reaches the
// browser. The client calls our /summaries endpoint which proxies here.
//
// Env:
//   NVIDIA_API_KEY   required. Disable summaries by leaving this unset.
//   SUMMARY_MODEL    default "google/gemma-3n-e4b-it"
//   SUMMARY_PROMPT   override the user prompt if the default tone needs
//                    adjusting per deployment
//   SUMMARY_MAX_TOKENS   default 220 (caption-sized)
//   NVIDIA_TIMEOUT_MS    default 30_000

const axios = require("axios");
const https = require("https");
const log = require("./logger");

const ENDPOINT = "https://integrate.api.nvidia.com/v1/chat/completions";
const MODEL = process.env.SUMMARY_MODEL || "google/gemma-3n-e4b-it";
const MAX_TOKENS = Math.max(
  32,
  Number(process.env.SUMMARY_MAX_TOKENS || 220)
);
const TIMEOUT_MS = Math.max(
  5_000,
  Number(process.env.NVIDIA_TIMEOUT_MS || 30_000)
);
const DEFAULT_PROMPT =
  process.env.SUMMARY_PROMPT ||
  "This is an archived screenshot of a website from the Wayback Machine. In 2 concise sentences, describe the visual design, dominant colors, and notable UI elements (hero, navigation, imagery) — like a historian captioning a museum exhibit. Do not mention the Wayback banner if present.";

// Mirror INSECURE_TLS for the same reasons as util/wayback.js — corporate
// MITM proxies. Production leaves it unset.
const INSECURE_TLS =
  String(process.env.INSECURE_TLS || "").toLowerCase() === "true";
const httpsAgent = INSECURE_TLS
  ? new https.Agent({ rejectUnauthorized: false })
  : undefined;

function isEnabled() {
  return Boolean(process.env.NVIDIA_API_KEY);
}

/**
 * Summarize a single image.
 * @param {Buffer} imageBuffer raw bytes
 * @param {string} contentType "image/png" | "image/jpeg"
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<string>} trimmed caption text
 */
async function summarizeImage(imageBuffer, contentType, opts = {}) {
  if (!isEnabled()) {
    throw Object.assign(new Error("summaries are disabled"), { status: 503 });
  }
  if (!Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
    throw Object.assign(new Error("empty image buffer"), { status: 400 });
  }

  // Normalize content type to what Gemma understands in the data URI.
  const mime =
    contentType === "image/jpeg" || contentType === "image/jpg"
      ? "image/jpeg"
      : "image/png";
  const b64 = imageBuffer.toString("base64");

  const payload = {
    model: MODEL,
    messages: [
      {
        role: "user",
        // Gemma on NVIDIA's endpoint accepts the inline <img> tag
        // embedding — different from the OpenAI structured format. We
        // follow their published example exactly.
        content: `${DEFAULT_PROMPT} <img src="data:${mime};base64,${b64}" />`,
      },
    ],
    max_tokens: MAX_TOKENS,
    temperature: 0.2,
    top_p: 0.7,
    frequency_penalty: 0,
    presence_penalty: 0,
    stream: false,
  };

  try {
    const res = await axios.post(ENDPOINT, payload, {
      headers: {
        Authorization: `Bearer ${process.env.NVIDIA_API_KEY}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      timeout: TIMEOUT_MS,
      signal: opts.signal,
      httpsAgent,
      // Base64 of a full-page screenshot can be a couple of MB.
      maxBodyLength: 32 * 1024 * 1024,
      maxContentLength: 32 * 1024 * 1024,
    });

    const text =
      res.data &&
      res.data.choices &&
      res.data.choices[0] &&
      res.data.choices[0].message &&
      res.data.choices[0].message.content;

    if (typeof text !== "string" || text.trim().length === 0) {
      throw Object.assign(new Error("empty summary from model"), {
        status: 502,
      });
    }
    return text.trim();
  } catch (err) {
    // Axios errors carry response info — surface the upstream status so
    // the client can back off on 429 etc.
    if (err.response) {
      const upstream = err.response.status;
      log.warn("summarize: upstream error", {
        status: upstream,
        body:
          typeof err.response.data === "string"
            ? err.response.data.slice(0, 200)
            : undefined,
      });
      throw Object.assign(
        new Error(`summary upstream error: ${upstream}`),
        { status: upstream === 429 ? 429 : 502, upstreamStatus: upstream }
      );
    }
    if (err.code === "ECONNABORTED" || err.name === "AbortError") {
      throw Object.assign(new Error("summary timed out"), { status: 504 });
    }
    if (err.status) throw err; // rethrow our own tagged errors
    log.warn("summarize: network error", { err: err.message });
    throw Object.assign(new Error("summary network error"), { status: 502 });
  }
}

module.exports = { summarizeImage, isEnabled };
