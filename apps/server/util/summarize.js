// AI summaries for website screenshots. Calls the NVIDIA-hosted Gemma 3n
// vision endpoint (OpenAI-compatible chat completions) with the image
// inlined as base64 inside the message content — this is the format
// NVIDIA's integrate.api.nvidia.com expects for vision models, NOT the
// OpenAI structured `content: [{type:"image_url", ...}]` array.
//
// Two modes:
//   • summarizeImage(buf, type)                        — standalone caption.
//   • summarizeDiff(currBuf, currType, prevBuf, ...)   — what changed vs.
//     the previous frame. The diff flavour gives the timeline its
//     edutainment feel ("Git history, but for websites") by narrating
//     the evolution rather than re-describing each page in isolation.
//
// The NVIDIA API key never reaches the browser — the client calls our
// /summaries endpoint which proxies here.
//
// Env:
//   NVIDIA_API_KEY        required. Disable summaries by leaving unset.
//   SUMMARY_MODEL         default "google/gemma-3n-e4b-it"
//   SUMMARY_PROMPT        override the single-image prompt
//   SUMMARY_DIFF_PROMPT   override the two-image diff prompt
//                         (supports {prev} / {curr} placeholders for
//                         human date labels)
//   SUMMARY_MAX_TOKENS    default 220 (caption-sized)
//   NVIDIA_TIMEOUT_MS     default 30_000

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
const SINGLE_PROMPT =
  process.env.SUMMARY_PROMPT ||
  "This is an archived screenshot of a website from the Wayback Machine. In 2 concise sentences, describe the visual design, dominant colors, and notable UI elements (hero, navigation, imagery) — like a historian captioning a museum exhibit. Do not mention the Wayback banner if present.";
const DIFF_PROMPT =
  process.env.SUMMARY_DIFF_PROMPT ||
  "These are two archived screenshots of the same website from the Wayback Machine, shown in chronological order. The first image is from {prev} and the second is from {curr}. In 2 concise, engaging sentences narrate what visibly CHANGED between them — think layout, color palette, typography, hero imagery, navigation structure, content focus, or overall brand tone. Lead with the single most noticeable change. If the pages look essentially unchanged, say so in one short sentence. Do not describe the Wayback toolbar or banner.";

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

function normalizeMime(contentType) {
  return contentType === "image/jpeg" || contentType === "image/jpg"
    ? "image/jpeg"
    : "image/png";
}

// Labels flow from user-controlled URL params → keep the injection
// surface small. Strip anything that isn't safe inside a plain sentence.
function sanitizeLabel(label, fallback) {
  if (typeof label !== "string") return fallback;
  const cleaned = label
    .replace(/[<>{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
  return cleaned || fallback;
}

/**
 * Shared NVIDIA call. `content` is the already-composed message string
 * (prompt + inline <img> tag(s)). Returns trimmed caption text or
 * throws a status-tagged error.
 */
async function callNvidia(content, opts = {}) {
  const payload = {
    model: MODEL,
    messages: [{ role: "user", content }],
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
      // Two inline screenshots can push the request past axios's small
      // default. 64 MB is comfortably larger than two viewport PNGs.
      maxBodyLength: 64 * 1024 * 1024,
      maxContentLength: 64 * 1024 * 1024,
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
    if (err.status) throw err;
    log.warn("summarize: network error", { err: err.message });
    throw Object.assign(new Error("summary network error"), { status: 502 });
  }
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

  const mime = normalizeMime(contentType);
  const b64 = imageBuffer.toString("base64");
  const content = `${SINGLE_PROMPT} <img src="data:${mime};base64,${b64}" />`;
  return callNvidia(content, opts);
}

/**
 * Summarize what changed between two frames of the same site. `prev`
 * comes FIRST in the prompt (chronological order matters for the
 * narration).
 *
 * @param {Buffer} currBuffer  current frame bytes
 * @param {string} currType    mime of current
 * @param {Buffer} prevBuffer  prior frame bytes
 * @param {string} prevType    mime of prior
 * @param {{ prevLabel?: string, currLabel?: string, signal?: AbortSignal }} [opts]
 * @returns {Promise<string>}  caption narrating the change
 */
async function summarizeDiff(
  currBuffer,
  currType,
  prevBuffer,
  prevType,
  opts = {}
) {
  if (!isEnabled()) {
    throw Object.assign(new Error("summaries are disabled"), { status: 503 });
  }
  if (
    !Buffer.isBuffer(currBuffer) ||
    currBuffer.length === 0 ||
    !Buffer.isBuffer(prevBuffer) ||
    prevBuffer.length === 0
  ) {
    throw Object.assign(new Error("empty image buffer"), { status: 400 });
  }

  const currMime = normalizeMime(currType);
  const prevMime = normalizeMime(prevType);
  const currB64 = currBuffer.toString("base64");
  const prevB64 = prevBuffer.toString("base64");
  const prev = sanitizeLabel(opts.prevLabel, "an earlier snapshot");
  const curr = sanitizeLabel(opts.currLabel, "a later snapshot");

  const prompt = DIFF_PROMPT.replace("{prev}", prev).replace("{curr}", curr);

  // Prior frame first, current frame second — matches the chronological
  // framing in the prompt so the model doesn't invert the story.
  const content =
    `${prompt} ` +
    `<img src="data:${prevMime};base64,${prevB64}" /> ` +
    `<img src="data:${currMime};base64,${currB64}" />`;

  return callNvidia(content, { signal: opts.signal });
}

module.exports = { summarizeImage, summarizeDiff, isEnabled };
