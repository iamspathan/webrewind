const fs = require("fs");
const https = require("https");
const axios = require("axios");

// ---------- TLS handling ----------
// Some networks (corporate proxies, Zscaler, etc.) MITM HTTPS with their own
// root CA. NODE_EXTRA_CA_CERTS works for this, but must be set BEFORE Node
// starts — too early for dotenv to load. So we build a custom https.Agent
// based on env vars that are loaded via dotenv.
//
//   EXTRA_CA_CERT_PATH=/absolute/path/to/corp-root-ca.pem
//   INSECURE_TLS=true   (dev only — disables cert verification)
function buildHttpsAgent() {
  const caPath = process.env.EXTRA_CA_CERT_PATH;
  const insecure = String(process.env.INSECURE_TLS || "").toLowerCase() === "true";

  if (insecure) {
    console.warn(
      "[wayback] INSECURE_TLS=true — TLS certificate verification disabled. Do not use in production."
    );
    return new https.Agent({ rejectUnauthorized: false });
  }
  if (caPath) {
    if (!fs.existsSync(caPath)) {
      throw new Error(`EXTRA_CA_CERT_PATH set but file not found: ${caPath}`);
    }
    const ca = fs.readFileSync(caPath);
    console.log(`[wayback] using extra CA cert from ${caPath}`);
    return new https.Agent({ ca });
  }
  return undefined; // use Node default
}

const httpsAgent = buildHttpsAgent();

// Wayback rate-limits anonymous user-agents aggressively. Send a real UA.
const USER_AGENT =
  process.env.WAYBACK_USER_AGENT ||
  "Webrewind/1.0 (+https://github.com/iamspathan/webrewind)";

const waybackClient = axios.create({
  baseURL: "https://web.archive.org",
  timeout: 60000,
  headers: {
    "User-Agent": USER_AGENT,
    Accept: "application/json, */*;q=0.5",
  },
  // CDX expects repeated `filter=X&filter=Y`, not `filter[]=`. axios's default
  // serializer uses bracket notation, so we override it.
  paramsSerializer: {
    serialize: (params) => {
      const qs = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null) continue;
        if (Array.isArray(value)) {
          for (const v of value) qs.append(key, String(v));
        } else {
          qs.append(key, String(value));
        }
      }
      return qs.toString();
    },
  },
  ...(httpsAgent ? { httpsAgent } : {}),
});

// Sleep helper
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Retry GET with exponential backoff on 429 / 5xx / network errors.
// Honours Retry-After header when present.
async function getWithRetry(path, config, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await waybackClient.get(path, config);
    } catch (err) {
      lastErr = err;
      const status = err.response && err.response.status;
      const retryable =
        status === 429 ||
        (status >= 500 && status < 600) ||
        err.code === "ECONNABORTED" ||
        err.code === "ECONNRESET" ||
        err.code === "ETIMEDOUT";
      if (!retryable || i === attempts - 1) throw err;

      const retryAfter = Number(
        err.response && err.response.headers && err.response.headers["retry-after"]
      );
      const backoffMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Math.min(1000 * 2 ** i, 8000) + Math.floor(Math.random() * 500);
      console.warn(
        `[wayback] ${status || err.code} — retrying in ${backoffMs}ms (attempt ${i + 1}/${attempts})`
      );
      await sleep(backoffMs);
    }
  }
  throw lastErr;
}

function setPayload(url, limit, startYear, stopYear, collapse) {
  // CDX accepts multiple `filter=` params — skip dead captures + non-HTML
  // mimetypes (images, PDFs, redirects) upstream so we don't waste Puppeteer
  // time on them. `!` prefix = negation in CDX filter syntax.
  return {
    url,
    limit,
    output: "json",
    fl: "timestamp,original",
    from: startYear,
    to: stopYear,
    collapse,
    filter: ["statuscode:200", "mimetype:text/html"],
  };
}

function convertToPublicUrls(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  // First row is the header (["timestamp","original"]) — drop it
  return rows.slice(1).map(([timestamp, original]) => {
    return `https://web.archive.org/web/${timestamp}/${original}`;
  });
}

async function getURLs(url, limit, startYear, stopYear, collapse) {
  // See: https://github.com/internetarchive/wayback/tree/master/wayback-cdx-server#basic-usage
  const params = setPayload(url, limit, startYear, stopYear, collapse);
  try {
    const response = await getWithRetry("/cdx/search/cdx/", { params });
    return convertToPublicUrls(response.data);
  } catch (err) {
    // Translate axios errors into structured errors our route handler can pass through
    if (err.response) {
      const status = err.response.status;
      const message =
        status === 503
          ? "Wayback Machine is temporarily unavailable. Please try again shortly."
          : status === 429
          ? "Wayback Machine rate limit hit. Please wait and retry."
          : status >= 500
          ? `Wayback Machine error (${status}). Please try again shortly.`
          : `Wayback Machine rejected the request (${status}).`;
      throw Object.assign(new Error(message), {
        status: status >= 500 ? 502 : status, // map upstream 5xx → 502 Bad Gateway
        upstreamStatus: status,
      });
    }
    if (err.code === "ECONNABORTED") {
      throw Object.assign(new Error("Wayback Machine request timed out."), {
        status: 504,
      });
    }
    if (err.code === "ENOTFOUND" || err.code === "ECONNREFUSED") {
      throw Object.assign(new Error("Cannot reach Wayback Machine (network error)."), {
        status: 502,
      });
    }
    throw err;
  }
}

exports.getURLs = getURLs;
