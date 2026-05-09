# Webrewind — Implementation Spec for Tasks #13–#25

Production-grade plan for the 13 remaining open tasks. Each section is self-contained and ordered so earlier tasks unblock later ones. File paths are absolute within the repo (e.g. `apps/server/index.js`).

---

## 0. Shared preliminaries

Before any of the tasks below, add two utility modules the later tasks depend on:

### 0.1 `apps/server/util/paths.js` (new)
Exports:
- `SCREENSHOT_ROOT = __dirname/..` (resolve to `apps/server`)
- `FOLDER_PREFIX = "screenshots-"`
- `SAFE_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/`
- `folderFor(outputFileName)` → `path.resolve(SCREENSHOT_ROOT, FOLDER_PREFIX + outputFileName)`
- `parseFolderName(folder)` → returns suffix or `null` if invalid

Move the constants out of `apps/server/index.js` and import from here. All later tasks reuse these.

### 0.2 `apps/server/util/logger.js` (new)
Thin wrapper around `console` with timestamps + a `jobId` prefix. Signature: `log.info(jobId, msg, meta?)`, `log.warn`, `log.error`. Keep dependency-free (no pino) — the project has no logger today and adding one should be a separate PR.

---

## Task #13 — Job cancellation (server + client)

### Goal
A user can abort an in-flight capture job. Server stops launching new pages, closes open pages, deletes partial output, releases `activeOutputs` slot, emits `cancelled` SSE event.

### Server changes — `apps/server/index.js`

1. Extend the job record (`createJob`) with:
   - `abortController: new AbortController()`
   - `status: "running" | "cancelled" | "done" | "error"`
2. Inside `run()`, plumb `signal` to each worker loop:
   ```js
   if (signal.aborted) return;
   ```
   Check at the top of the `while` loop, before `captureOne`, and after. Pass `signal` to `captureOne` and short-circuit with `throw new DOMException("cancelled", "AbortError")` if aborted.
3. In `captureOne`, on abort, call `page.close()` in the `finally` block — already present; just make sure the abort path hits `finally`.
4. Add `DELETE /screenshots/:jobId`:
   ```
   - 404 if unknown jobId
   - 409 if already done
   - else: job.abortController.abort(); respond 202 { status: "cancelling" }
   ```
5. In the background task's `catch`, detect `AbortError` and publish `{ type: "cancelled" }` instead of `{ type: "error" }`. In the `finally` block, on cancel, `fs.rmSync(folder, { recursive: true, force: true })` before releasing `activeOutputs`.
6. In `publishTo`, treat `cancelled` like `done`/`error` for stream termination.

### Client changes — `apps/client/src/WebsiteEvolutionViewer.tsx`

1. Store `currentJobId` in state when POST returns.
2. Add a "Cancel" button visible whenever a job is active. On click: `fetch(\`${API_BASE_URL}/screenshots/${jobId}\`, { method: "DELETE" })`.
3. Handle the new `cancelled` SSE event: show a neutral banner ("Capture cancelled"), clear progress state, re-enable the form.

### Client changes — `apps/client/src/components/evolution/CaptureProgress.tsx`
Accept and render a new `status: "cancelled"` state; wire the cancel button there if the component owns the control bar.

### Acceptance
- Start a job of 50 frames, click cancel at frame 10: server logs `cancelled`, folder is deleted, `activeOutputs` is empty, `SELECT jobId` returns a closed SSE stream with a final `cancelled` event.
- `DELETE` on an unknown job → 404. On a completed job → 409. On an in-flight job → 202.

---

## Task #14 — Disk cleanup reaper for screenshot folders

### Goal
`apps/server/screenshots-*` folders grow unboundedly. Reap folders older than a TTL on a timer, and expose a bounded total-disk cap.

### Config (env, documented in `CLAUDE.md`)
- `SCREENSHOT_TTL_MS` default `24 * 60 * 60 * 1000` (24h)
- `SCREENSHOT_MAX_BYTES` default `10 * 1024 * 1024 * 1024` (10 GiB). `0` disables.
- `SCREENSHOT_REAP_INTERVAL_MS` default `10 * 60 * 1000` (10 min)

### Implementation — `apps/server/util/reaper.js` (new)

```js
async function reapOnce({ root, prefix, ttlMs, maxBytes, activeOutputs }) {
  const entries = await fsp.readdir(root, { withFileTypes: true });
  const folders = entries.filter(
    (e) => e.isDirectory() && e.name.startsWith(prefix)
  );
  const stats = await Promise.all(
    folders.map(async (f) => {
      const dir = path.join(root, f.name);
      const s = await folderStats(dir); // returns {mtimeMs, bytes}
      return { name: f.name, dir, ...s };
    })
  );
  const now = Date.now();

  // 1. TTL pass — skip anything whose suffix is in activeOutputs.
  for (const s of stats) {
    const suffix = s.name.slice(prefix.length);
    if (activeOutputs.has(suffix)) continue;
    if (now - s.mtimeMs > ttlMs) {
      await fsp.rm(s.dir, { recursive: true, force: true });
      s.deleted = true;
    }
  }

  // 2. Size cap pass — delete oldest first until under cap.
  if (maxBytes > 0) {
    const live = stats.filter((s) => !s.deleted);
    const total = live.reduce((a, s) => a + s.bytes, 0);
    if (total > maxBytes) {
      live.sort((a, b) => a.mtimeMs - b.mtimeMs);
      let remaining = total;
      for (const s of live) {
        if (remaining <= maxBytes) break;
        const suffix = s.name.slice(prefix.length);
        if (activeOutputs.has(suffix)) continue;
        await fsp.rm(s.dir, { recursive: true, force: true });
        remaining -= s.bytes;
      }
    }
  }
}
```

`folderStats` walks the directory to sum sizes and picks the max `mtime` (so recently-appended metadata keeps the folder "fresh").

### Wire-up in `apps/server/index.js`
Inside the `app.listen` callback:
```js
const interval = setInterval(
  () => reapOnce({ root: SCREENSHOT_ROOT, prefix: FOLDER_PREFIX,
                   ttlMs, maxBytes, activeOutputs }).catch(console.error),
  SCREENSHOT_REAP_INTERVAL_MS
).unref();
```
Run once synchronously on boot as well so startup cleans up crash leftovers.

### Acceptance
- Create a folder with `mtime` set to 25h ago → reaper deletes it.
- Fill disk to 11 GiB across mixed folders → reaper brings it under 10 GiB, starting from oldest.
- A folder listed in `activeOutputs` is never deleted even if oversize.

---

## Task #15 — Result cache by (url, range) hash

### Goal
Identical `{url, startYear, endYear}` should skip the capture pipeline and return the previous result.

### Key derivation
`cacheKey = sha256(normalizedUrl + "|" + startYear + "|" + endYear)` — lowercase host, strip trailing slash, strip default port. `outputFileName` is **not** part of the key (it's a display label).

### Storage — `apps/server/util/cache.js` (new)
LRU-ish on-disk index:
- `apps/server/.cache/index.json` — `{ [key]: { folder, createdAt, gifUrl, count } }`
- Value points at an existing `screenshots-<folder>` directory.
- Use atomic write (`fs.writeFileSync(tmp); fs.renameSync(tmp, final)`).

API:
- `lookup(key)` → entry or null. Returns null (and evicts) if the folder no longer exists on disk (the reaper may have removed it).
- `record(key, { folder, gifUrl, count })` writes the entry.
- `invalidate(key)` removes the entry.

### Server changes — `apps/server/index.js`
In `POST /screenshots`:
1. Compute `cacheKey` from normalized inputs.
2. `const hit = lookup(cacheKey)`. If present:
   - Rebuild image URL list from on-disk PNG names.
   - Return `202 { jobId, cached: true, streamUrl }` and have the SSE stream emit a single `done` event with the cached payload immediately.
3. On successful `done`, call `record`.
4. On `error` / `cancelled`, do **not** record.

### Config
- `CACHE_ENABLED` default `true`.
- `CACHE_MAX_ENTRIES` default `200` — evict oldest on overflow (delete folder + index entry).

### Acceptance
- Two POSTs with identical url+year-range: second returns within <200ms, stream emits one `done` event, no Puppeteer work.
- Same url, different `outputFileName`: still a cache hit.
- After reaper deletes the folder, next POST is a miss and re-captures.

---

## Task #16 — Browser recycling after N captures

### Goal
Puppeteer's shared browser leaks memory over hundreds of pages. Replace it after N successful captures (or T seconds) to bound RSS.

### Config
- `BROWSER_MAX_CAPTURES` default `500`
- `BROWSER_MAX_AGE_MS` default `30 * 60 * 1000` (30 min)

### Implementation — `apps/server/index.js`

Wrap the singleton in a tiny state object:
```js
let sharedBrowser = null;      // { browser, startedAt, captures }
let recycleInFlight = null;    // Promise guard
```

`getSharedBrowser()` now:
1. If `sharedBrowser` is null or `!browser.isConnected()` → launch and set.
2. After each `captureOne`, increment `sharedBrowser.captures`.
3. Before handing out a browser, if `captures >= BROWSER_MAX_CAPTURES` or `Date.now() - startedAt > BROWSER_MAX_AGE_MS`, and there are **zero in-flight pages**, recycle: launch new browser, close old one.
4. Use `recycleInFlight` to serialize so two concurrent jobs don't both recycle.

### "Zero in-flight pages" tracking
Add a per-job `pagesInFlight` count. Maintain `totalPagesInFlight = sum(job.pagesInFlight)`. Only recycle when this hits 0. If a job is long-running, recycle on its next quiescent moment.

Alternative simpler approach (acceptable for v1): recycle **between** jobs only — check on `getSharedBrowser()` entry. No concurrent-job check needed. Document this tradeoff.

### Acceptance
- Run 501 captures in one job: log line `browser recycled after 500 captures`. PID of underlying Chromium changes (`browser.process().pid`).
- Browser older than 30m is recycled on next job start.

---

## Task #17 — MAX_ACTIVE_JOBS + rate limit on /screenshots

### Goal
Prevent resource exhaustion from concurrent or rapid submissions.

### Two layers

**A. Concurrency cap**
- `MAX_ACTIVE_JOBS` default `3`
- Maintain `activeJobCount`. On POST, if `activeJobCount >= MAX_ACTIVE_JOBS` → `429 { error: "server busy", retryAfterSec }`.
- Set `Retry-After` header.

**B. Per-IP rate limit**
- Add `express-rate-limit` (new dep). Config:
  - `windowMs: 60_000`, `max: 5` per IP on `POST /screenshots`.
  - Respond with structured JSON on limit hit.
- Apply only to `POST /screenshots` — SSE stream and GET routes are exempt.
- Behind a reverse proxy, set `app.set("trust proxy", 1)` guarded by env `TRUST_PROXY=1` to opt in.

### Config
- `RATE_LIMIT_WINDOW_MS` default `60000`
- `RATE_LIMIT_MAX` default `5`
- `TRUST_PROXY` default `false`

### Acceptance
- 4 concurrent POSTs with `MAX_ACTIVE_JOBS=3` → 4th returns 429 + Retry-After.
- 6 rapid POSTs from same IP within 60s → 6th returns 429.

---

## Task #18 — Streaming thumbnails in progress UI

### Goal
Currently `capture:done` events carry only `imageUrl`. Show a scrolling ribbon of just-captured thumbnails during the run.

### Server — nothing to change
`capture:done` already emits `imageUrl`. (Optional optimization: add a second smaller thumbnail next to the full PNG — see §Optional below.)

### Client — `apps/client/src/components/evolution/CaptureProgress.tsx`

1. Maintain `capturedFrames: { index, timestamp, imageUrl }[]` in state.
2. On each `capture:done`, append. Keep a sliding window (e.g. last 20) to bound DOM size.
3. Render a horizontal scroll strip below the progress bar:
   ```tsx
   <div className="flex gap-2 overflow-x-auto py-2">
     {capturedFrames.map(f => (
       <motion.img
         key={f.index}
         src={f.imageUrl}
         className="h-20 w-32 object-cover rounded-md border border-white/10"
         initial={{ opacity: 0, x: 20 }}
         animate={{ opacity: 1, x: 0 }}
       />
     ))}
   </div>
   ```
4. Auto-scroll the strip to the right as new frames arrive (`ref.current.scrollLeft = ref.current.scrollWidth`).
5. On mount, replay from SSE buffer handles the "connected late" case automatically (server already replays).

### Optional — server-side thumbnail
Add a `CAPTURE_THUMBNAIL=true` flag: after `page.screenshot(full)`, write a second `sharp`-downscaled 320×240 `<index>_thumb.jpg`. Emit `thumbUrl` in `capture:done`. Defer to v2 — only do this if the full-size images are too heavy for the strip.

### Acceptance
- During a 30-frame capture, thumbnails appear in the strip as captures complete, without jank.
- Sliding window prevents more than 20 thumbnails in DOM simultaneously.

---

## Task #19 — Streaming GIF encode during capture

### Goal
Today `createGifFromScreenshots` runs after all captures finish — doubling wall-clock time for large jobs. Encode frames into the GIF as they arrive.

### Implementation — `apps/server/index.js`

Refactor `run()` to own a `GifStream` instance:

```js
class GifStream {
  constructor(outPath) {
    this.outPath = outPath;
    this.writeStream = createWriteStream(outPath);
    this.encoder = null;   // lazy — need width/height from first frame
    this.pending = new Map(); // index -> buffer, for out-of-order delivery
    this.nextIndex = 0;
    this.canvas = null;
    this.ctx = null;
  }
  async addFrame(index, pngPath) {
    // buffer until contiguous — workers finish out of order
    this.pending.set(index, pngPath);
    while (this.pending.has(this.nextIndex)) {
      await this.#drawOne(this.pending.get(this.nextIndex));
      this.pending.delete(this.nextIndex);
      this.nextIndex++;
    }
  }
  async #drawOne(pngPath) {
    if (!this.encoder) { /* lazy init, read first image's dims */ }
    const img = await loadImage(pngPath);
    this.ctx.drawImage(img, 0, 0);
    this.encoder.addFrame(this.ctx);
  }
  async finish() {
    // flush any remaining pending in order
    while (this.pending.size) {
      const keys = [...this.pending.keys()].sort((a,b)=>a-b);
      for (const k of keys) {
        await this.#drawOne(this.pending.get(k));
        this.pending.delete(k);
      }
    }
    this.encoder.finish();
    await new Promise((r) => this.writeStream.on("close", r));
  }
}
```

In the worker, after a successful `captureOne`, call `gifStream.addFrame(index, pngPath)` **before** publishing `capture:done`.

Remove the post-run `createGifFromScreenshots` call; keep the old function as a fallback for recovery/CLI use.

Skip GIF streaming entirely when the job is `failFast` or the first frame fails (fall back to post-run encoding).

### Memory notes
- `pending` caps at `CAPTURE_CONCURRENCY` entries in steady state.
- Frames draw strictly in index order so GIF timeline matches capture timeline.

### Acceptance
- 50-frame run: total wall-clock reduced by roughly (gif_encode_time / 2). `gif` event arrives within a few hundred ms of last `capture:done`.
- GIF frame count equals successful capture count; order matches filename indices.
- Cancel mid-run → stream is flushed/discarded, partial GIF is deleted along with the folder.

---

## Task #20 — Cache-Control headers on /images

### Goal
`GET /images/:folder/:file` currently sends no cache headers, so every refresh re-downloads every PNG.

### Implementation — `apps/server/index.js`
Inside the existing `app.get("/images/:folder/:file", ...)`, before `res.sendFile`:
```js
res.set("Cache-Control", "public, max-age=31536000, immutable");
res.set("Vary", "Accept-Encoding");
```
Image names are immutable (an index is rewritten only when the entire folder is rebuilt with a new name), so `immutable` is safe.

For the GIF, use the same headers.

### Acceptance
- `curl -I /images/screenshots-foo/0.png` returns `Cache-Control: public, max-age=31536000, immutable`.
- Browser reload of the viewer hits 304 / memory cache for every image.

---

## Task #21 — JPEG capture format toggle

### Goal
PNG at 1366×1366 ≈ 500 KB–2 MB per frame. JPEG at quality 80 is typically 8–15× smaller. Expose a per-request toggle.

### Server — `apps/server/index.js`

1. Accept `format: "png" | "jpeg"` (default `"png"`) and optional `quality: 1–100` (default `80`) in the POST body. Validate.
2. In `captureOne`, switch on format:
   ```js
   const ext = format === "jpeg" ? "jpg" : "png";
   const screenshotArgs = format === "jpeg"
     ? { type: "jpeg", quality, path: join(folder, `${index}.jpg`) }
     : { path: join(folder, `${index}.png`) };
   await page.screenshot(screenshotArgs);
   ```
3. Update `SAFE_FILE_RE` to allow `.jpg`: `/^[A-Za-z0-9_.-]{1,128}\.(png|jpg|gif)$/`.
4. In the `/images/:folder/:file` handler, send the right `Content-Type`. `res.sendFile` does this via extension — works as-is.
5. Propagate `format` into the cache key (`cacheKey` now covers `{url, range, format, quality}`).
6. GIF encoding: `Image` from `canvas` accepts both; no changes needed. Keep `imageInfo-*.txt` extension-agnostic.

### Client — `apps/client/src/WebsiteEvolutionViewer.tsx`
Add an optional "High quality (PNG)" checkbox — off means JPEG/80. Submit accordingly.

### Acceptance
- POST with `format: "jpeg"` produces `*.jpg` files; resulting folder is ~10× smaller.
- POST with no format defaults to PNG (backwards compatible).
- Mixed-format folders can't happen (request cleans folder before writing).

---

## Task #22 — Dockerfile + docker-compose

### Files to add

#### `apps/server/Dockerfile` (new, multi-stage)
```dockerfile
FROM node:20-bookworm-slim AS deps
WORKDIR /app
# Puppeteer's Chromium deps + canvas native deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates fonts-liberation libasound2 libatk-bridge2.0-0 \
    libatk1.0-0 libcups2 libdbus-1-3 libdrm2 libgbm1 libgtk-3-0 \
    libnspr4 libnss3 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
    libxkbcommon0 libpango-1.0-0 libcairo2 libpng-dev libjpeg-dev \
    libgif-dev librsvg2-dev pkg-config python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json yarn.lock ./
COPY apps/server/package.json apps/server/
RUN yarn install --frozen-lockfile --production=false

FROM node:20-bookworm-slim AS runner
WORKDIR /app
# runtime libs only (smaller)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates fonts-liberation libasound2 libatk-bridge2.0-0 \
    libatk1.0-0 libcups2 libdbus-1-3 libdrm2 libgbm1 libgtk-3-0 \
    libnspr4 libnss3 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
    libxkbcommon0 libpango-1.0-0 libcairo2 \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/server/node_modules ./apps/server/node_modules
COPY apps/server ./apps/server
EXPOSE 3200
USER node
CMD ["node", "apps/server/index.js"]
```

#### `apps/client/Dockerfile` (new)
```dockerfile
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json yarn.lock ./
COPY apps/client/package.json apps/client/
RUN yarn install --frozen-lockfile
COPY apps/client ./apps/client
ARG VITE_API_BASE_URL=
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
RUN yarn workspace @webrewind/client build

FROM nginx:1.27-alpine AS runner
COPY --from=build /app/apps/client/dist /usr/share/nginx/html
COPY apps/client/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
```

#### `apps/client/nginx.conf` (new)
SPA fallback + proxy `/screenshots`, `/images`, `/health`, `/docs` to `server:3200`.

#### `docker-compose.yml` (new, root)
```yaml
services:
  server:
    build:
      context: .
      dockerfile: apps/server/Dockerfile
    environment:
      PORT: 3200
      CLIENT_ORIGIN: http://localhost:8080
      PUBLIC_BASE_URL: http://localhost:3200
      CAPTURE_CONCURRENCY: 4
    volumes:
      - screenshots:/app/apps/server
    ports:
      - "3200:3200"
    restart: unless-stopped
    shm_size: "1gb"            # Chromium needs this
  client:
    build:
      context: .
      dockerfile: apps/client/Dockerfile
      args:
        VITE_API_BASE_URL: ""  # use nginx proxy
    ports:
      - "8080:80"
    depends_on:
      - server
volumes:
  screenshots:
```

#### `.dockerignore` (new, root)
`node_modules`, `**/dist`, `**/build`, `**/.turbo`, `apps/server/screenshots-*`, `.git`.

### Acceptance
- `docker compose up --build` → client served at `localhost:8080`, API at `localhost:3200`.
- Capture job completes and PNGs are served via nginx proxy.
- `docker compose down` + `up` preserves past captures via the `screenshots` volume.

---

## Remaining 3 tasks (#23–#25)

These are referenced as "+3 pending" in the task list. The index appears to continue beyond the visible tasks. Three likely candidates, in implementation order; confirm in a later pass:

### Task #23 — Structured logging + request IDs
- Emit `{ts, level, jobId, requestId, msg, meta}` JSON via the `logger.js` stub from §0.2.
- Middleware to mint a `x-request-id` header if absent; propagate into SSE events as `requestId`.

### Task #24 — Metrics endpoint (`/metrics`)
- Add `prom-client`. Counters: `captures_started_total`, `captures_completed_total`, `captures_failed_total`, `cache_hits_total`. Histograms: `capture_duration_seconds`, `gif_encode_duration_seconds`, `page_nav_duration_seconds`.
- `GET /metrics` returns Prometheus text format. Exempt from CORS and rate limit.

### Task #25 — E2E smoke test
- Playwright test in `apps/client/tests/e2e/capture.spec.ts` that:
  1. Boots server+client via docker-compose (or local).
  2. Fills form with `example.com`, 2020–2021.
  3. Waits for `done` and asserts at least one frame appears in the viewer.
- Wire into `apps/client/package.json` as `yarn workspace @webrewind/client test:e2e`.
- Not part of `turbo run build`; run in CI only.

**Action item before implementing #23–#25:** confirm the exact intended scope of these three with the user — the titles above are a reasonable inference but the original task list was truncated.

---

## Ordering / dependency graph

```
#0  (shared utils)          ── must land first
│
├── #13 cancellation        ── standalone
├── #14 reaper              ── standalone
├── #20 cache-control       ── standalone, one-liner
├── #21 jpeg toggle         ── standalone (touches SAFE_FILE_RE used elsewhere)
│
├── #16 browser recycling   ── standalone, no client change
├── #17 MAX_ACTIVE_JOBS     ── standalone
│
├── #15 result cache        ── depends on #14 (reaper must honor cache folders)
├── #18 streaming thumbs    ── depends on nothing but benefits from #21
├── #19 streaming gif       ── depends on #13 (needs abort-aware finish)
│
├── #22 docker              ── last; picks up all env vars from tasks above
├── #23 logging             ── parallel with #24
├── #24 metrics             ── uses counters instrumented during #13–#19
└── #25 e2e                 ── last
```

Recommended PR slicing: (#0 + #20 + #14), (#13), (#16 + #17), (#15), (#21), (#18 + #19), (#22), then observability in a final pass.

## Out of scope

- Cloudflare R2 upload (`util/cloudflare.js` remains commented out; decision deferred).
- Auth / multi-tenant. Server assumes a trusted single-tenant deployment.
- Replacing Puppeteer with Playwright. Considered but the current pipeline is stable; defer.
