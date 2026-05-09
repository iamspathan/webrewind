require("dotenv").config();

const crypto = require("crypto");
const { EventEmitter } = require("events");
const express = require("express");
const rateLimit = require("express-rate-limit");
const puppeteer = require("puppeteer");
const fs = require("fs");
const cors = require("cors");
const path = require("path");
const swaggerJSDoc = require("swagger-jsdoc");
const swaggerUi = require("swagger-ui-express");

const { getURLs } = require("./util/wayback");
const log = require("./util/logger");
const { createCache } = require("./util/cache");
const { createStreamingGifEncoder } = require("./util/gif");
const storage = require("./util/storage");
const metrics = require("./util/metrics");
const summarize = require("./util/summarize");

// outputFileName validation — stays in this file so the route handler has
// a single source of truth. Also used as an object-key prefix in MinIO.
const SAFE_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

// Register metrics up front so /metrics reports zeros for unused ones
// (makes PromQL rate()/increase() behave sensibly from first scrape).
const mJobsTotal = metrics.counter(
  "webrewind_jobs_total",
  "Capture jobs by terminal status"
);
const mCapturesTotal = metrics.counter(
  "webrewind_captures_total",
  "Individual frame captures that succeeded"
);
const mCapturesSkippedTotal = metrics.counter(
  "webrewind_captures_skipped_total",
  "Individual frame captures that were skipped after retries"
);
const mCacheHits = metrics.counter(
  "webrewind_cache_hits_total",
  "Result cache hits on POST /screenshots"
);
const mCacheMisses = metrics.counter(
  "webrewind_cache_misses_total",
  "Result cache misses on POST /screenshots"
);
const mBrowserRecycles = metrics.counter(
  "webrewind_browser_recycles_total",
  "Shared Puppeteer browser recycle events by reason"
);
const mHttpRequests = metrics.counter(
  "webrewind_http_requests_total",
  "Completed HTTP requests by route+status"
);
const mActiveJobs = metrics.gauge(
  "webrewind_active_jobs",
  "Capture jobs currently running"
);
const mUploadsTotal = metrics.counter(
  "webrewind_uploads_total",
  "Objects uploaded to MinIO by kind"
);
const mUploadErrors = metrics.counter(
  "webrewind_upload_errors_total",
  "Failed object uploads by kind"
);
const mSummariesTotal = metrics.counter(
  "webrewind_summaries_total",
  "Image summary requests by outcome"
);

const resultCache = createCache({ storage });

// ---------- Config ----------
const PORT = Number(process.env.PORT || process.env.port || 3200);
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "http://localhost:5173";
const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;
const JOB_TTL_MS = 10 * 60 * 1000; // drop finished jobs after 10 minutes

// Capture tuning — override via env for different hardware.
const CAPTURE_CONCURRENCY = Math.max(
  1,
  Number(process.env.CAPTURE_CONCURRENCY || 4)
);
const NAV_TIMEOUT_MS = Number(process.env.CAPTURE_NAV_TIMEOUT_MS || 25000);
const NETWORK_IDLE_MS = Number(process.env.CAPTURE_NETWORK_IDLE_MS || 400);
const NETWORK_IDLE_TIMEOUT_MS = Number(
  process.env.CAPTURE_NETWORK_IDLE_TIMEOUT_MS || 5000
);

// Admission control.
const MAX_ACTIVE_JOBS = Math.max(
  1,
  Number(process.env.MAX_ACTIVE_JOBS || 3)
);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000);
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 5);
const TRUST_PROXY =
  String(process.env.TRUST_PROXY || "").toLowerCase() === "true" ||
  process.env.TRUST_PROXY === "1";

// Hosts known to hang archived pages (ads / analytics / tag managers).
// Aborting their requests shaves 2–10s per capture on older pages.
const BLOCK_HOSTS_RE = new RegExp(
  [
    "google-analytics\\.com",
    "googletagmanager\\.com",
    "googlesyndication\\.com",
    "doubleclick\\.net",
    "facebook\\.net",
    "connect\\.facebook\\.net",
    "scorecardresearch\\.com",
    "chartbeat\\.com",
    "hotjar\\.com",
    "mouseflow\\.com",
    "segment\\.io",
    "mixpanel\\.com",
    "adroll\\.com",
    "adsrvr\\.org",
    "newrelic\\.com",
  ].join("|")
);

// Resource types we can safely block without harming the screenshot.
const BLOCKED_RESOURCE_TYPES = new Set([
  "font",
  "media",
  "websocket",
  "eventsource",
  "manifest",
  "other",
]);

// ---------- Swagger ----------
const swaggerDocs = swaggerJSDoc({
  swaggerDefinition: {
    openapi: "3.0.0",
    info: {
      title: "Webrewind API",
      version: "1.0.0",
      description: "API Documentation",
    },
    servers: [{ url: PUBLIC_BASE_URL }],
  },
  apis: ["./index.js"],
});

const docsFolderPath = path.resolve(__dirname, "docs");
if (!fs.existsSync(docsFolderPath)) {
  fs.mkdirSync(docsFolderPath, { recursive: true });
}
fs.writeFileSync(
  path.join(docsFolderPath, "openapi.json"),
  JSON.stringify(swaggerDocs, null, 2)
);

// ---------- App ----------
const app = express();

// When behind a reverse proxy, trust X-Forwarded-* so rate limiting sees
// the real client IP. Opt-in via env to avoid spoofing in dev.
if (TRUST_PROXY) {
  app.set("trust proxy", 1);
}

app.use(express.json());
app.use(
  cors({
    origin: CLIENT_ORIGIN,
    methods: ["GET", "POST", "DELETE"],
    exposedHeaders: ["X-Request-Id"],
  })
);

// Request ID middleware — accept X-Request-Id from upstream (e.g. load
// balancer, curl --header) or mint a fresh UUID. Always echoed back on
// the response so clients can correlate logs with their call.
app.use((req, res, next) => {
  const incoming = req.get("x-request-id");
  req.id =
    typeof incoming === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(incoming)
      ? incoming
      : crypto.randomUUID();
  res.set("X-Request-Id", req.id);
  next();
});

// HTTP request counter. We label only on the coarse route (not full URL) so
// cardinality stays bounded even with user-supplied jobIds.
app.use((req, res, next) => {
  res.on("finish", () => {
    const route = coarseRoute(req.path);
    mHttpRequests.inc({
      route,
      method: req.method,
      status: String(res.statusCode),
    });
  });
  next();
});

function coarseRoute(p) {
  if (p === "/screenshots") return "/screenshots";
  if (p.startsWith("/screenshots/events/")) return "/screenshots/events/:id";
  if (p.startsWith("/screenshots/")) return "/screenshots/:id";
  if (p === "/summaries") return "/summaries";
  if (p === "/metrics" || p === "/health" || p === "/docs") return p;
  if (p.startsWith("/docs")) return "/docs";
  return "other";
}

// Rate limit only capture submissions — SSE streams must stay cheap and
// unthrottled; image GETs go direct to MinIO and never hit this process.
const screenshotsRateLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res
      .status(429)
      .set(
        "Retry-After",
        String(Math.ceil(RATE_LIMIT_WINDOW_MS / 1000))
      )
      .json({
        error: "too many capture requests",
        retryAfterSec: Math.ceil(RATE_LIMIT_WINDOW_MS / 1000),
      });
  },
});

// Summaries hit an external LLM — we want a higher burst budget than
// capture submissions (one timeline view can fire dozens as cards scroll
// past) but we still protect the upstream from a runaway client.
const SUMMARY_RATE_LIMIT_MAX = Math.max(
  1,
  Number(process.env.SUMMARY_RATE_LIMIT_MAX || 60)
);
const summariesRateLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: SUMMARY_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res
      .status(429)
      .set(
        "Retry-After",
        String(Math.ceil(RATE_LIMIT_WINDOW_MS / 1000))
      )
      .json({
        error: "too many summary requests",
        retryAfterSec: Math.ceil(RATE_LIMIT_WINDOW_MS / 1000),
      });
  },
});

app.use("/docs", swaggerUi.serve, swaggerUi.setup(swaggerDocs));

/**
 * @swagger
 * /health:
 *   get:
 *     summary: Health check
 *     responses:
 *       200: { description: OK }
 */
app.get("/health", (_req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

/**
 * @swagger
 * /metrics:
 *   get:
 *     summary: Prometheus metrics (text/plain; version=0.0.4)
 *     responses:
 *       200: { description: Metrics snapshot }
 */
app.get("/metrics", (_req, res) => {
  // Keep the active-jobs gauge in sync at scrape time so it reflects the
  // process's latest view even if we somehow failed to decrement elsewhere.
  mActiveJobs.set({}, activeJobCount);
  res.set("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
  res.send(metrics.render());
});

// ---------- Job bus (in-memory pub/sub for SSE progress) ----------
/**
 * jobs: Map<jobId, {
 *   emitter: EventEmitter,
 *   buffer: Array<{type, ...payload}>,   // replay buffer for late subscribers
 *   done: boolean,
 *   createdAt: number,
 * }>
 *
 * We keep a short replay buffer so a client connecting a moment after POST
 * still receives the events it missed (network latency, React mount timing).
 */
const jobs = new Map();
// Tracks outputFileNames that are currently being captured. Prevents two
// concurrent jobs from writing to the same MinIO prefix — the second's
// deletePrefix would wipe objects the first just uploaded.
const activeOutputs = new Set();

function createJob(outputFileName, requestId) {
  const jobId = crypto.randomUUID();
  const job = {
    emitter: new EventEmitter(),
    buffer: [],
    done: false,
    createdAt: Date.now(),
    outputFileName,
    requestId: requestId || null,
    abortController: new AbortController(),
    // "running" until a terminal event publishes. Used by DELETE to decide
    // 409 vs. honoring the cancel.
    status: "running",
  };
  // EventEmitter defaults to 10 listeners — a client may reconnect and briefly
  // overlap listeners, so bump this a bit.
  job.emitter.setMaxListeners(32);
  jobs.set(jobId, job);
  return { jobId, job };
}

function publishTo(job, event) {
  // Stamp every outbound event with the job+request IDs so clients can
  // correlate SSE messages with their original POST response.
  const stamped = {
    ...event,
    requestId: job.requestId || undefined,
  };
  job.buffer.push(stamped);
  job.emitter.emit("event", stamped);
  if (
    event.type === "done" ||
    event.type === "error" ||
    event.type === "cancelled"
  ) {
    job.done = true;
    if (event.type === "cancelled") job.status = "cancelled";
    else if (event.type === "error") job.status = "error";
    else job.status = "done";
    mJobsTotal.inc({ status: job.status });
    job.emitter.emit("end");
  }
}

// Periodically reap finished jobs so the map doesn't grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.done && now - job.createdAt > JOB_TTL_MS) {
      jobs.delete(id);
    }
  }
}, 60 * 1000).unref();

// ---------- Capture pipeline ----------
// Singleton browser: puppeteer.launch is ~1–2s, so we reuse across jobs.
// Pages are still created/closed per capture to isolate crashes and leaks.
const BROWSER_MAX_CAPTURES = Math.max(
  1,
  Number(process.env.BROWSER_MAX_CAPTURES || 500)
);
const BROWSER_MAX_AGE_MS = Math.max(
  60_000,
  Number(process.env.BROWSER_MAX_AGE_MS || 30 * 60 * 1000)
);

// Shape: { browser, startedAt, captures } | null
let sharedBrowser = null;
// Prevents a race when two jobs both decide to recycle at once.
let recycleInFlight = null;
// Set to true by the "between-jobs" check. Cleared once recycled.
let retireRequested = false;
// Tracks how many capture jobs are using the shared browser right now.
let activeJobCount = 0;

async function launchBrowser() {
  // Mirror INSECURE_TLS into Chromium. The axios client in util/wayback.js
  // already respects this flag for the CDX API; Chromium has its own cert
  // store and needs the CLI switch. Dev-only (corporate MITM); remove in
  // production by leaving INSECURE_TLS unset.
  const insecureTls =
    String(process.env.INSECURE_TLS || "").toLowerCase() === "true";
  const args = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage", // avoid small /dev/shm in containers
    "--disable-gpu",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
  ];
  if (insecureTls) args.push("--ignore-certificate-errors");
  const browser = await puppeteer.launch({
    // "new" opts into Chrome's new headless mode (shares code path with
    // headful Chrome). Puppeteer 19.x warns about the default flipping
    // from the old implementation; opting in now makes the warning go
    // away and avoids a surprise behaviour change on upgrade.
    headless: "new",
    args,
  });
  browser.on("disconnected", () => {
    // Only null out if this is still the current handle; a stale
    // disconnect (from a browser we already swapped out) must not clobber
    // the fresh one.
    if (sharedBrowser && sharedBrowser.browser === browser) {
      sharedBrowser = null;
    }
  });
  sharedBrowser = { browser, startedAt: Date.now(), captures: 0 };
  return browser;
}

async function recycleSharedBrowser(reason) {
  if (recycleInFlight) return recycleInFlight;
  const stale = sharedBrowser;
  recycleInFlight = (async () => {
    try {
      log.info("browser recycling", { reason, captures: stale?.captures });
      mBrowserRecycles.inc({ reason });
      if (stale && stale.browser.isConnected()) {
        await stale.browser.close().catch(() => {});
      }
      // Clear the slot so launchBrowser() installs a fresh handle.
      sharedBrowser = null;
      retireRequested = false;
      return await launchBrowser();
    } finally {
      recycleInFlight = null;
    }
  })();
  return recycleInFlight;
}

async function getSharedBrowser() {
  if (recycleInFlight) {
    return recycleInFlight;
  }

  if (
    retireRequested &&
    activeJobCount === 0 &&
    sharedBrowser &&
    sharedBrowser.browser.isConnected()
  ) {
    return recycleSharedBrowser("between-jobs");
  }

  if (sharedBrowser && sharedBrowser.browser.isConnected()) {
    const age = Date.now() - sharedBrowser.startedAt;
    const over =
      sharedBrowser.captures >= BROWSER_MAX_CAPTURES ||
      age >= BROWSER_MAX_AGE_MS;
    if (over && activeJobCount === 0) {
      return recycleSharedBrowser(
        sharedBrowser.captures >= BROWSER_MAX_CAPTURES ? "captures" : "age"
      );
    }
    if (over) {
      retireRequested = true;
    }
    return sharedBrowser.browser;
  }

  return launchBrowser();
}

function markCaptureSuccess() {
  if (sharedBrowser) sharedBrowser.captures++;
}

const BROWSER_UA =
  process.env.WAYBACK_BROWSER_UA ||
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

async function configurePage(page, viewport) {
  await page.setViewport(viewport);
  await page.setUserAgent(BROWSER_UA);
  await page.setCacheEnabled(false);

  await page.setRequestInterception(true);
  page.on("request", (req) => {
    try {
      const type = req.resourceType();
      if (BLOCKED_RESOURCE_TYPES.has(type)) return req.abort();
      if (BLOCK_HOSTS_RE.test(req.url())) return req.abort();
      req.continue();
    } catch {
      // Request may already be handled if navigation was cancelled.
    }
  });

  page.on("dialog", async (dialog) => {
    try {
      await dialog.accept();
    } catch {
      /* ignore */
    }
  });
  page.on("pageerror", () => {});
  page.on("error", () => {});
}

// Thrown when a job has been cancelled mid-flight. Distinct from normal
// errors so the caller can skip publishing a capture:skip event.
class CancelledError extends Error {
  constructor() {
    super("cancelled");
    this.name = "CancelledError";
  }
}

// Take a screenshot of `archiveUrl` and return the encoded image Buffer.
// The caller is responsible for uploading it.
async function captureOne(
  browser,
  archiveUrl,
  viewport,
  signal,
  captureOptions = {}
) {
  const format = captureOptions.format === "jpeg" ? "jpeg" : "png";
  const quality = Number.isInteger(captureOptions.quality)
    ? captureOptions.quality
    : 80;
  if (signal && signal.aborted) throw new CancelledError();

  const page = await browser.newPage();
  const onAbort = () => {
    page.close({ runBeforeUnload: false }).catch(() => {});
  };
  if (signal) signal.addEventListener("abort", onAbort, { once: true });

  try {
    await configurePage(page, viewport);

    await page.goto(archiveUrl, {
      timeout: NAV_TIMEOUT_MS,
      waitUntil: "domcontentloaded",
    });
    if (signal && signal.aborted) throw new CancelledError();
    await page
      .waitForNetworkIdle({
        idleTime: NETWORK_IDLE_MS,
        timeout: NETWORK_IDLE_TIMEOUT_MS,
      })
      .catch(() => {
        // Best-effort — if the page never idles, we still screenshot what's rendered.
      });
    if (signal && signal.aborted) throw new CancelledError();

    // Strip Wayback toolbar. No waiting: if it's not in the DOM now, it won't be.
    await page
      .evaluate(() => {
        const el = document.getElementById("wm-ipp-base");
        if (el && el.parentNode) el.parentNode.removeChild(el);
      })
      .catch(() => {});

    const screenshotArgs = { type: format };
    if (format === "jpeg") {
      screenshotArgs.quality = quality;
    }
    // Returns a Buffer when no `path` is provided.
    return await page.screenshot(screenshotArgs);
  } finally {
    if (signal) signal.removeEventListener("abort", onAbort);
    await page.close({ runBeforeUnload: false }).catch(() => {});
  }
}

function frameKey(outputFileName, index, ext) {
  return `${outputFileName}/${index}.${ext}`;
}

function gifKey(outputFileName) {
  return `${outputFileName}/${outputFileName}.gif`;
}

function contentTypeFor(format) {
  return format === "jpeg" ? "image/jpeg" : "image/png";
}

async function run(
  url,
  startYear,
  endYear,
  outputFileName,
  publish,
  signal,
  options = {},
  gifEncoder = null
) {
  const maxNumberOfCaptures = 300;
  const collapse = "timestamp:6";
  const viewport = { width: 1366, height: 1366 };
  const format = options.format === "jpeg" ? "jpeg" : "png";
  const quality = Number.isInteger(options.quality) ? options.quality : 80;
  const ext = format === "jpeg" ? "jpg" : "png";
  const contentType = contentTypeFor(format);
  const isAborted = () => signal && signal.aborted;

  // Wipe any prior objects for this outputFileName so a rebuild starts
  // clean (otherwise indices beyond the new count would linger as
  // orphans from the previous run).
  await storage.deletePrefix(`${outputFileName}/`);

  if (isAborted()) throw new CancelledError();

  publish({ type: "phase", phase: "fetching-urls" });

  const urls = await getURLs(
    url,
    maxNumberOfCaptures,
    startYear,
    endYear,
    collapse
  );
  if (isAborted()) throw new CancelledError();
  if (!urls || urls.length === 0) {
    throw Object.assign(new Error("no snapshots found for this URL/range"), {
      status: 404,
    });
  }

  publish({ type: "urls", total: urls.length });
  publish({
    type: "phase",
    phase: "capturing",
    concurrency: Math.min(CAPTURE_CONCURRENCY, urls.length),
  });

  const browser = await getSharedBrowser();

  // Accumulate image URLs in index order for the final "done" event +
  // cache manifest. Workers write via index so order is preserved.
  const imageUrls = new Array(urls.length).fill(null);
  // Wayback timestamps aligned 1:1 with imageUrls. Only set for
  // successfully-captured frames; skipped frames stay `null` and are
  // filtered out at the end alongside the URL.
  const timestamps = new Array(urls.length).fill(null);

  let nextIndex = 0;
  let successCount = 0;
  const total = urls.length;
  const effectiveConcurrency = Math.min(CAPTURE_CONCURRENCY, total);

  const worker = async () => {
    while (true) {
      if (isAborted()) return;
      const index = nextIndex++;
      if (index >= total) return;

      const archiveUrl = urls[index];
      const timestamp = archiveUrl.split("/")[4];

      publish({
        type: "capture:start",
        index,
        total,
        url: archiveUrl,
        timestamp,
      });

      // One bounded retry on capture + upload — a transient Wayback 503 or
      // a brief MinIO blip shouldn't mark the frame as skipped.
      let lastErr = null;
      let buf = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          buf = await captureOne(
            browser,
            archiveUrl,
            viewport,
            signal,
            { format, quality }
          );
          try {
            await storage.putObject(
              frameKey(outputFileName, index, ext),
              buf,
              contentType
            );
            mUploadsTotal.inc({ kind: "frame" });
          } catch (uploadErr) {
            mUploadErrors.inc({ kind: "frame" });
            throw uploadErr;
          }
          lastErr = null;
          break;
        } catch (e) {
          if (e instanceof CancelledError || isAborted()) {
            return;
          }
          lastErr = e;
        }
      }

      if (isAborted()) return;

      if (lastErr) {
        log.warn("capture: skip", { url: archiveUrl, err: lastErr.message });
        mCapturesSkippedTotal.inc();
        publish({
          type: "capture:skip",
          index,
          total,
          url: archiveUrl,
          timestamp,
          reason: lastErr.message,
        });
        // Let the streaming GIF encoder advance past this gap.
        if (gifEncoder) gifEncoder.onSkip(index);
        continue;
      }

      successCount++;
      markCaptureSuccess();
      mCapturesTotal.inc();

      const publicUrl = storage.buildPublicUrl(
        frameKey(outputFileName, index, ext)
      );
      imageUrls[index] = publicUrl;
      timestamps[index] = timestamp || null;
      publish({
        type: "capture:done",
        index,
        total,
        url: archiveUrl,
        timestamp,
        imageUrl: publicUrl,
        fileIndex: index,
      });
      // Feed the streaming encoder with the in-memory buffer — no extra
      // read needed since we already have it from page.screenshot().
      if (gifEncoder) {
        gifEncoder.onFrame(index, buf);
      }
    }
  };

  const workers = Array.from({ length: effectiveConcurrency }, () => worker());
  await Promise.all(workers);

  if (isAborted()) throw new CancelledError();

  // Filter to successful frames while keeping images and timestamps
  // aligned by index. A single filter on imageUrls would desync the two
  // arrays if any frame was skipped.
  const imagesOut = [];
  const timestampsOut = [];
  for (let i = 0; i < imageUrls.length; i++) {
    if (imageUrls[i]) {
      imagesOut.push(imageUrls[i]);
      timestampsOut.push(timestamps[i] || null);
    }
  }

  return {
    count: successCount,
    images: imagesOut,
    timestamps: timestampsOut,
  };
}

// ---------- Routes ----------
/**
 * @swagger
 * /screenshots:
 *   post:
 *     summary: Start a Wayback capture job; returns a jobId to subscribe to
 *     description: |
 *       Launches the capture asynchronously and returns immediately with a
 *       `jobId`. Subscribe to `/screenshots/events/{jobId}` (SSE) for live
 *       progress events, ending with a `done` event that carries the full
 *       image list. Images are stored in MinIO and returned as direct URLs.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [url, startYear, endYear]
 *             properties:
 *               url: { type: string }
 *               startYear: { type: integer }
 *               endYear: { type: integer }
 *               outputFileName:
 *                 type: string
 *                 description: |
 *                   Optional object-key prefix in MinIO. Must match
 *                   [A-Za-z0-9_-]{1,64} when supplied. If omitted, the
 *                   server derives a stable prefix from the cache key so
 *                   identical requests share a storage location.
 *               format: { type: string, enum: [png, jpeg], default: png }
 *               quality: { type: integer, minimum: 1, maximum: 100, default: 80 }
 *     responses:
 *       202: { description: Job accepted, returns { jobId } }
 *       400: { description: Invalid parameters }
 */
app.post("/screenshots", screenshotsRateLimiter, async (req, res) => {
  // Concurrency cap — independent from rate limit. Protects Puppeteer RSS.
  if (activeJobCount >= MAX_ACTIVE_JOBS) {
    res.set(
      "Retry-After",
      String(Math.ceil(RATE_LIMIT_WINDOW_MS / 1000))
    );
    return res.status(429).json({
      error: "server busy, try again shortly",
      activeJobs: activeJobCount,
      maxActiveJobs: MAX_ACTIVE_JOBS,
      retryAfterSec: Math.ceil(RATE_LIMIT_WINDOW_MS / 1000),
    });
  }

  const {
    url,
    startYear,
    endYear,
    outputFileName: rawOutputFileName,
    format: rawFormat,
    quality: rawQuality,
  } = req.body || {};

  const errs = [];
  if (typeof url !== "string" || !/^https?:\/\//i.test(url))
    errs.push("url must be a valid http(s) URL");
  const sy = Number(startYear);
  const ey = Number(endYear);
  if (!Number.isInteger(sy) || sy < 1900) errs.push("startYear invalid");
  if (!Number.isInteger(ey) || ey < 1900) errs.push("endYear invalid");
  if (Number.isInteger(sy) && Number.isInteger(ey) && sy > ey)
    errs.push("startYear must be <= endYear");
  // outputFileName is now optional. If the caller supplies one we still
  // enforce the old charset constraint so arbitrary strings can't be used
  // as object-key prefixes in MinIO. If omitted, we derive a stable value
  // from the cache key below so MinIO writes still happen under a
  // deterministic prefix per (url, years, format, quality).
  if (
    rawOutputFileName !== undefined &&
    (typeof rawOutputFileName !== "string" ||
      !SAFE_NAME_RE.test(rawOutputFileName))
  ) {
    errs.push(
      "outputFileName, when provided, must match [A-Za-z0-9_-]{1,64} (no spaces or slashes)"
    );
  }

  // Optional format/quality. Defaults preserve pre-#21 behavior (PNG).
  let format = "png";
  if (rawFormat !== undefined) {
    if (rawFormat === "png" || rawFormat === "jpeg") {
      format = rawFormat;
    } else {
      errs.push('format must be "png" or "jpeg"');
    }
  }
  let quality = 80;
  if (rawQuality !== undefined) {
    const q = Number(rawQuality);
    if (!Number.isInteger(q) || q < 1 || q > 100) {
      errs.push("quality must be an integer between 1 and 100");
    } else {
      quality = q;
    }
  }

  if (errs.length) {
    return res.status(400).json({ error: "invalid parameters", details: errs });
  }

  // Cache lookup. Key is derived from (url, range, format, quality) —
  // stable per logical request.
  const hitKey = resultCache.key({
    url,
    startYear: sy,
    endYear: ey,
    format,
    quality,
  });

  // If the caller didn't supply an outputFileName, derive one from the
  // first 16 hex chars of the cache key. This is deterministic per
  // request tuple, so:
  //   - Two concurrent identical requests land on the same active-jobs
  //     slot (the 409 guard below becomes a dedupe mutex — desirable,
  //     the second request would have been a cache hit anyway).
  //   - Re-captures for the same tuple overwrite the same MinIO prefix,
  //     which is what the existing `deletePrefix` before capture expects.
  const outputFileName =
    typeof rawOutputFileName === "string" && rawOutputFileName.length > 0
      ? rawOutputFileName
      : hitKey.slice(0, 16);

  // Reject duplicate in-flight jobs for the same output name — otherwise the
  // second job's deletePrefix() would wipe objects the first is uploading.
  if (activeOutputs.has(outputFileName)) {
    return res.status(409).json({
      error: "a capture is already running for this request",
    });
  }

  const hit = resultCache.enabled ? await resultCache.lookup(hitKey) : null;

  const { jobId, job } = createJob(outputFileName, req.id);
  activeOutputs.add(outputFileName);
  const publish = (event) => publishTo(job, event);
  const jobLog = log.child({ requestId: req.id, jobId });
  jobLog.info("capture requested", {
    url,
    startYear: sy,
    endYear: ey,
    format,
    quality,
  });

  if (hit && Array.isArray(hit.images) && hit.images.length > 0) {
    mCacheHits.inc();
    res.status(202).json({
      jobId,
      cached: true,
      streamUrl: `${PUBLIC_BASE_URL}/screenshots/events/${jobId}`,
    });
    publish({
      type: "done",
      images: hit.images,
      // Older manifests predate timestamps; send [] so the client takes
      // the approx-year code path without needing a null check.
      timestamps: Array.isArray(hit.timestamps) ? hit.timestamps : [],
      // Cached summaries — empty array if the old manifest didn't track
      // them. Client lazy-fetches any missing slots.
      summaries: Array.isArray(hit.summaries) ? hit.summaries : [],
      // Client uses cacheKey to address /summaries POSTs back into this
      // manifest. Safe to expose — it's derived from public inputs +
      // sha256, not a secret.
      cacheKey: hitKey,
      gif: hit.gifUrl || null,
      count: hit.count || hit.images.length,
      cached: true,
    });
    jobLog.info("cache hit", { images: hit.images.length });
    activeOutputs.delete(outputFileName);
    return;
  }

  if (resultCache.enabled) mCacheMisses.inc();

  // Return the jobId immediately — the rest happens in the background.
  res.status(202).json({
    jobId,
    streamUrl: `${PUBLIC_BASE_URL}/screenshots/events/${jobId}`,
  });

  // Fire-and-forget background task. All errors are pushed through the bus.
  (async () => {
    publish({ type: "phase", phase: "starting" });
    const signal = job.abortController.signal;
    activeJobCount++;
    // Streaming GIF encoder — encodes frames as they're captured, overlapping
    // work with Puppeteer so the encoding tail at the end is ~0.
    const gifEncoder = createStreamingGifEncoder({});
    try {
      const { count, images, timestamps } = await run(
        url,
        sy,
        ey,
        outputFileName,
        publish,
        signal,
        { format, quality },
        gifEncoder
      );

      if (signal.aborted) throw new CancelledError();

      // Drain remaining buffered frames, close the GIF stream, upload.
      publish({ type: "phase", phase: "encoding-gif" });
      let gifUrl = null;
      try {
        const { gifBuffer, framesEncoded } = await gifEncoder.finish();
        if (gifBuffer && framesEncoded > 0) {
          const gKey = gifKey(outputFileName);
          try {
            await storage.putObject(gKey, gifBuffer, "image/gif");
            mUploadsTotal.inc({ kind: "gif" });
            gifUrl = storage.buildPublicUrl(gKey);
            publish({ type: "gif", url: gifUrl });
          } catch (e) {
            mUploadErrors.inc({ kind: "gif" });
            throw e;
          }
        } else {
          publish({ type: "gif:failed", reason: "no frames encoded" });
        }
      } catch (e) {
        jobLog.warn("gif encode failed", { err: e.message });
        publish({ type: "gif:failed", reason: e.message });
      }

      publish({
        type: "done",
        images,
        timestamps,
        // Fresh capture: summaries are generated lazily by the client,
        // so start empty. The cache manifest is initialized with the
        // same empty slots and filled in via patchSummary() later.
        summaries: new Array(images.length).fill(""),
        cacheKey: hitKey,
        gif: gifUrl,
        count,
      });
      // Record cache entry only on genuine success (at least one image).
      if (resultCache.enabled && images.length > 0) {
        await resultCache.record(hitKey, {
          outputFileName,
          images,
          timestamps,
          gifUrl,
          count,
        });
      }
    } catch (err) {
      if (err instanceof CancelledError || signal.aborted) {
        // Abort the streaming encoder so the buffered partial GIF is dropped.
        await gifEncoder.abort().catch(() => {});
        // Wipe partial uploads so a retry with the same outputFileName starts
        // clean and orphan objects don't linger in MinIO.
        await storage
          .deletePrefix(`${outputFileName}/`)
          .catch(() => {});
        jobLog.info("job cancelled", { outputFileName });
        publish({ type: "cancelled" });
      } else {
        await gifEncoder.abort().catch(() => {});
        jobLog.error("job failed", {
          err: err.message,
          status: (err && err.status) || 500,
        });
        publish({
          type: "error",
          message: err.message || "internal error",
          status: (err && err.status) || 500,
          upstreamStatus: (err && err.upstreamStatus) || undefined,
        });
      }
    } finally {
      activeOutputs.delete(outputFileName);
      activeJobCount = Math.max(0, activeJobCount - 1);
    }
  })();
});

/**
 * @swagger
 * /screenshots/{jobId}:
 *   delete:
 *     summary: Cancel an in-flight capture job
 *     parameters:
 *       - in: path
 *         name: jobId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       202: { description: Cancellation requested }
 *       404: { description: Unknown jobId }
 *       409: { description: Job already finished }
 */
app.delete("/screenshots/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "unknown job" });
  if (job.done) {
    return res
      .status(409)
      .json({ error: "job already finished", status: job.status });
  }
  job.abortController.abort();
  res.status(202).json({ status: "cancelling" });
});

/**
 * @swagger
 * /screenshots/events/{jobId}:
 *   get:
 *     summary: SSE stream of progress events for a capture job
 *     parameters:
 *       - in: path
 *         name: jobId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: text/event-stream
 *       404: { description: Unknown jobId }
 */
app.get("/screenshots/events/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: "unknown job" });
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();

  let cleanedUp = false;
  const send = (event) => {
    if (cleanedUp || res.writableEnded) return;
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch {
      // socket already torn down — cleanup will happen via 'close'
    }
  };

  // Replay everything the job has produced so far.
  for (const event of job.buffer) send(event);

  if (job.done) {
    res.end();
    return;
  }

  const onEvent = (event) => send(event);
  const onEnd = () => {
    if (!res.writableEnded) res.end();
  };
  job.emitter.on("event", onEvent);
  job.emitter.once("end", onEnd);

  const heartbeat = setInterval(() => {
    if (cleanedUp || res.writableEnded) return;
    try {
      res.write(`: ping\n\n`);
    } catch {
      /* ignore */
    }
  }, 15000);

  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    clearInterval(heartbeat);
    job.emitter.off("event", onEvent);
    job.emitter.off("end", onEnd);
  };

  req.on("close", cleanup);
  res.on("close", cleanup);
  res.on("error", cleanup);
});

/**
 * @swagger
 * /summaries:
 *   post:
 *     summary: Generate an AI caption for a single captured frame
 *     description: |
 *       Proxies to the NVIDIA-hosted Gemma 3n vision model. The API key
 *       stays server-side; clients pass an image URL that must live in
 *       our own MinIO bucket. On success, the summary is written back
 *       into the result cache so future cache hits don't re-bill the LLM.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [cacheKey, frameIndex, imageUrl]
 *             properties:
 *               cacheKey: { type: string, description: "sha256 hex returned in the done SSE event" }
 *               frameIndex: { type: integer }
 *               imageUrl: { type: string, description: "must start with MINIO_PUBLIC_URL/BUCKET/" }
 *     responses:
 *       200: { description: "{ summary }" }
 *       400: { description: Invalid parameters }
 *       404: { description: Image object not found }
 *       429: { description: Upstream rate limit }
 *       502: { description: Upstream error }
 *       503: { description: Summaries disabled (no NVIDIA_API_KEY configured) }
 */
app.post("/summaries", summariesRateLimiter, async (req, res) => {
  if (!summarize.isEnabled()) {
    return res.status(503).json({
      error: "summaries are disabled (NVIDIA_API_KEY not set)",
    });
  }

  const { cacheKey, frameIndex, imageUrl } = req.body || {};
  const errs = [];
  if (typeof cacheKey !== "string" || !/^[a-f0-9]{64}$/.test(cacheKey)) {
    errs.push("cacheKey must be a sha256 hex string");
  }
  if (!Number.isInteger(frameIndex) || frameIndex < 0 || frameIndex > 10_000) {
    errs.push("frameIndex must be a non-negative integer");
  }
  if (typeof imageUrl !== "string" || imageUrl.length === 0) {
    errs.push("imageUrl is required");
  }
  if (errs.length) {
    return res.status(400).json({ error: "invalid parameters", details: errs });
  }

  // Enforce that the image lives in our bucket. Without this check the
  // endpoint would happily download and bill on any URL the caller
  // supplies — an easy pivot for abuse.
  const objectKey = storage.keyFromPublicUrl(imageUrl);
  if (!objectKey) {
    mSummariesTotal.inc({ outcome: "rejected" });
    return res
      .status(400)
      .json({ error: "imageUrl must point at this server's bucket" });
  }

  let object;
  try {
    object = await storage.getObjectBytes(objectKey);
  } catch (err) {
    mSummariesTotal.inc({ outcome: "storage-error" });
    log.warn("summaries: storage fetch failed", {
      key: objectKey,
      err: err.message,
    });
    return res.status(502).json({ error: "could not fetch image" });
  }
  if (!object || !object.body) {
    mSummariesTotal.inc({ outcome: "not-found" });
    return res.status(404).json({ error: "image not found" });
  }

  try {
    const summary = await summarize.summarizeImage(
      object.body,
      object.contentType
    );

    // Fire-and-forget cache write. A failure here just means the next
    // request for the same slot will regenerate — we still return the
    // summary the client is waiting on.
    resultCache
      .patchSummary(cacheKey, frameIndex, summary)
      .catch(() => {});

    mSummariesTotal.inc({ outcome: "ok" });
    return res.json({ summary });
  } catch (err) {
    const status = (err && err.status) || 502;
    mSummariesTotal.inc({
      outcome: status === 429 ? "rate-limited" : "upstream-error",
    });
    if (status === 429 && err.upstreamStatus === 429) {
      res.set("Retry-After", "30");
    }
    return res.status(status).json({
      error: err.message || "summary failed",
      upstreamStatus: (err && err.upstreamStatus) || undefined,
    });
  }
});

// ---------- 404 fallback ----------
app.use((_req, res) => {
  res.status(404).json({ error: "not found" });
});

// ---------- Error handler ----------
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "internal error" });
});

const server = app.listen(PORT, () => {
  console.log(`Server listening on ${PUBLIC_BASE_URL}`);
  console.log(`Docs: ${PUBLIC_BASE_URL}/docs`);
  console.log(
    `Capture concurrency: ${CAPTURE_CONCURRENCY} · nav timeout: ${NAV_TIMEOUT_MS}ms`
  );

  // Best-effort bucket bootstrap. If MinIO isn't up yet, /health still
  // works and the first capture will retry; log and move on.
  storage.ensureBucket().catch((err) => {
    log.warn("storage: ensureBucket failed (will retry on first upload)", {
      err: err.message,
    });
  });
});

// Graceful shutdown: close the shared Puppeteer browser and HTTP server.
async function shutdown(signal) {
  console.log(`\n${signal} received — shutting down`);
  server.close();
  if (sharedBrowser) {
    try {
      await sharedBrowser.browser.close();
    } catch {
      /* ignore */
    }
  }
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
