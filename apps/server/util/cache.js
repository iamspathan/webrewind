// Result cache backed by MinIO/S3. Keyed by (url, startYear, endYear,
// format, quality) — the outputFileName is a display label and is NOT
// part of the key. Entries are stored as tiny JSON objects under
// _cache/<sha256>.json inside the bucket.
//
// Each entry carries the list of public image URLs + the gif URL + count,
// so a cache hit doesn't need a list-objects round-trip.

const crypto = require("crypto");
const log = require("./logger");

const CACHE_ENABLED =
  String(process.env.CACHE_ENABLED ?? "true").toLowerCase() !== "false";
const CACHE_PREFIX = "_cache/";

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hostname = u.hostname.toLowerCase();
    if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
      u.pathname = u.pathname.replace(/\/+$/, "");
    }
    if (
      (u.protocol === "http:" && u.port === "80") ||
      (u.protocol === "https:" && u.port === "443")
    ) {
      u.port = "";
    }
    return u.toString();
  } catch {
    return String(url);
  }
}

// Bump when the capture pipeline produces materially different output
// for the same (url, years, format) tuple — that way old manifests are
// effectively invalidated without having to walk MinIO and delete them.
//
//   v1 — initial, monthly captures (`collapse=timestamp:6`) with no
//        consecutive-duplicate filtering
//   v2 — monthly captures deduped by HTML digest (see util/wayback.js
//        convertToPublicUrls)
const CAPTURE_ALGO_VERSION = "v2";

function cacheKey({ url, startYear, endYear, format, quality }) {
  const payload = [
    normalizeUrl(url),
    Number(startYear),
    Number(endYear),
    format === "jpeg" ? `jpeg:${Number(quality)}` : "png",
    CAPTURE_ALGO_VERSION,
  ].join("|");
  return crypto.createHash("sha256").update(payload).digest("hex");
}

function objectKey(key) {
  return `${CACHE_PREFIX}${key}.json`;
}

function createCache({ storage }) {
  if (!CACHE_ENABLED) {
    return {
      enabled: false,
      async lookup() {
        return null;
      },
      async record() {},
      async invalidate() {},
      async patchSummary() {},
      key: cacheKey,
    };
  }

  async function invalidate(key) {
    try {
      await storage.deleteObject(objectKey(key));
    } catch (err) {
      log.warn("cache: invalidate failed", { key, err: err.message });
    }
  }

  async function lookup(key) {
    try {
      return await storage.getObjectJSON(objectKey(key));
    } catch (err) {
      log.warn("cache: lookup failed", { key, err: err.message });
      return null;
    }
  }

  async function writeManifest(key, payload) {
    await storage.putObject(
      objectKey(key),
      Buffer.from(JSON.stringify(payload)),
      "application/json",
      // Cache manifests are tiny and change as new jobs finish — don't
      // let browsers/CDNs pin an old one.
      { cacheControl: "no-cache" }
    );
  }

  async function record(key, entry) {
    const payload = {
      outputFileName: entry.outputFileName,
      images: entry.images || [],
      // Wayback timestamps aligned 1:1 with images. Older manifests
      // predate this field and will simply return undefined — the client
      // degrades to "approximate year" labels in that case.
      timestamps: entry.timestamps || [],
      // AI-generated captions aligned 1:1 with images. Sparse on fresh
      // captures (summaries are lazy) — slots default to empty string
      // and get filled in via patchSummary() as the client requests
      // them. Cache hits return whatever's been accumulated so far.
      summaries: entry.summaries || new Array(entry.images?.length || 0).fill(""),
      gifUrl: entry.gifUrl || null,
      count: entry.count || 0,
      createdAt: Date.now(),
    };
    try {
      await writeManifest(key, payload);
    } catch (err) {
      log.warn("cache: record failed", { key, err: err.message });
    }
  }

  /**
   * Insert a summary at `index` in the manifest for `key`. Read-modify-
   * write; there's no S3 optimistic concurrency for this path, but
   * summaries are idempotent — a later overwrite from a concurrent
   * request simply replaces a string with another string. Tolerable.
   */
  async function patchSummary(key, index, summary) {
    try {
      const entry = await storage.getObjectJSON(objectKey(key));
      if (!entry) {
        // Cache entry disappeared (e.g. invalidated between capture and
        // summary request). Nothing to patch — caller still gets the
        // summary in the HTTP response.
        return;
      }
      const images = Array.isArray(entry.images) ? entry.images : [];
      if (!Number.isInteger(index) || index < 0 || index >= images.length) {
        return;
      }
      const summaries = Array.isArray(entry.summaries)
        ? entry.summaries.slice()
        : new Array(images.length).fill("");
      // Pad older manifests where summaries was shorter than images.
      while (summaries.length < images.length) summaries.push("");
      summaries[index] = summary;
      entry.summaries = summaries;
      await writeManifest(key, entry);
    } catch (err) {
      log.warn("cache: patchSummary failed", {
        key,
        index,
        err: err.message,
      });
    }
  }

  return {
    enabled: true,
    lookup,
    record,
    invalidate,
    patchSummary,
    key: cacheKey,
  };
}

module.exports = { createCache, cacheKey };
