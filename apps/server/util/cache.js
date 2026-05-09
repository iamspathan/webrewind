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

function cacheKey({ url, startYear, endYear, format, quality }) {
  const payload = [
    normalizeUrl(url),
    Number(startYear),
    Number(endYear),
    format === "jpeg" ? `jpeg:${Number(quality)}` : "png",
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

  async function record(key, entry) {
    const payload = {
      outputFileName: entry.outputFileName,
      images: entry.images || [],
      gifUrl: entry.gifUrl || null,
      count: entry.count || 0,
      createdAt: Date.now(),
    };
    try {
      await storage.putObject(
        objectKey(key),
        Buffer.from(JSON.stringify(payload)),
        "application/json",
        // Cache manifests are tiny and change as new jobs finish — don't
        // let browsers/CDNs pin an old one.
        { cacheControl: "no-cache" }
      );
    } catch (err) {
      log.warn("cache: record failed", { key, err: err.message });
    }
  }

  return {
    enabled: true,
    lookup,
    record,
    invalidate,
    key: cacheKey,
  };
}

module.exports = { createCache, cacheKey };
