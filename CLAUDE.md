# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project overview

**Webrewind** — a tool that captures snapshots of a website across time using the Internet Archive's Wayback Machine and presents the evolution visually. Turborepo-orchestrated Yarn workspaces monorepo with a React client and an Express server.

## Repository layout

```
webrewind/
├── package.json          # root: workspaces + turbo scripts
├── turbo.json            # Turborepo pipeline (dev/build/lint/preview)
├── apps/
│   ├── client/           # Vite + React + TS frontend  (@webrewind/client)
│   │   └── src/
│   │       ├── App.tsx
│   │       ├── WebsiteEvolutionViewer.tsx   # main UI: form + 3D viewer
│   │       ├── components/ui/               # shadcn-style Radix components
│   │       └── lib/utils.ts
│   └── server/           # Express + Puppeteer backend  (@webrewind/server)
│       ├── index.js                         # API + screenshot/GIF pipeline
│       ├── util/wayback.js                  # Wayback CDX API client
│       ├── util/storage.js                  # MinIO/S3 client (aws-sdk)
│       ├── util/gif.js                      # streaming GIF encoder (buffer sink)
│       └── util/cache.js                    # result cache backed by MinIO
```

## Tech stack

- **Client:** React 18, TypeScript, Vite, Tailwind CSS, Radix UI, react-hook-form + zod, framer-motion, react-three-fiber/drei (Three.js), date-fns
- **Server:** Node.js, Express, Puppeteer (headless Chromium), canvas + gif-encoder-2, axios, swagger-jsdoc/ui-express, aws-sdk (talks to MinIO)
- **Storage:** MinIO (S3-compatible). Frames and GIFs are uploaded to a public bucket; the browser loads them by direct URL.
- **Monorepo:** Yarn 1 workspaces + Turborepo 2.x

## Commands

Run from repo root:

- `yarn install` — install all workspaces
- `yarn dev` / `yarn start` — runs `turbo run dev` (starts client + server in parallel)
- `yarn build` — `turbo run build` (currently only the client has a build)
- `yarn lint` — `turbo run lint`
- `yarn preview` — `turbo run preview`

Per workspace (bypassing turbo):

- `yarn workspace @webrewind/client dev` — Vite dev server on `http://localhost:5173`
- `yarn workspace @webrewind/client build` — `tsc -b && vite build`
- `yarn workspace @webrewind/client lint` — ESLint
- `yarn workspace @webrewind/server dev` — `nodemon index.js` on port `3200`
- `yarn workspace @webrewind/server start` — `node index.js` (production-style, no reload)

## Turborepo pipeline (`turbo.json`)

- `build` — depends on upstream `^build`; outputs `dist/**`, `build/**`
- `lint` — no outputs cached
- `dev` — `cache: false`, `persistent: true` (long-running)
- `preview` — `cache: false`, `persistent: true`

Turbo artifacts (`.turbo/`, `dist/`, `build/`) are gitignored.

## Architecture notes

### HTTP surface (`apps/server/index.js`)
- `GET /health` — liveness check (`{status, uptime}`)
- `GET /docs` — Swagger UI (spec also written to `apps/server/docs/openapi.json` on boot)
- `GET /metrics` — Prometheus text-format metrics
- `POST /screenshots` — accepts a job and returns `202 { jobId, streamUrl }`. Progress is streamed over SSE; the terminal `done` event carries `{ images, gif, count }` with direct MinIO URLs.
- `DELETE /screenshots/:jobId` — cancel an in-flight job
- `GET /screenshots/events/:jobId` — SSE progress stream
- 404 + error middleware return structured JSON.

The server no longer serves image bytes itself — frames and GIFs are uploaded to MinIO and returned as direct URLs (see `MINIO_PUBLIC_URL`).

### Screenshot pipeline
1. `util/wayback.js :: getURLs()` queries the Wayback CDX API (`https://web.archive.org/cdx/search/cdx/`) with `collapse=timestamp:6`.
2. `run()` clears any prior objects under `<outputFileName>/` in MinIO (`deletePrefix`), then drives a Puppeteer worker pool through each archive URL, strips `#wm-ipp-base`, and captures the viewport to a Buffer.
3. Each Buffer is uploaded to MinIO at `<outputFileName>/<index>.<ext>` and fed to the streaming GIF encoder (`util/gif.js`) in parallel. The encoder buffers out-of-order frames and drains them in index order.
4. On success, the encoded GIF Buffer is uploaded to `<outputFileName>/<outputFileName>.gif`. The result manifest (`{ images, gif, count }`) is cached under `_cache/<sha256>.json`.
5. All image URLs in responses are built via `storage.buildPublicUrl()` using `MINIO_PUBLIC_URL`; the bucket is expected to allow anonymous `GetObject` on its contents.

### Client
- Single-page app: `App.tsx` → `WebsiteEvolutionViewer.tsx`.
- Form uses `react-hook-form` + `zod` (schema: url, startYear, endYear, outputFileName).
- API base URL: `import.meta.env.VITE_API_BASE_URL` (empty → same-origin via Vite proxy).
- Error states from the server (including structured `details`) are surfaced in a red alert banner.
- 3D scene via `@react-three/fiber` / `drei`.
- Path alias `@/*` → `apps/client/src/*` (see `vite.config.ts`, `tsconfig.json`).
- Vite dev proxy (see `vite.config.ts`) forwards `/screenshots`, `/health`, `/docs` to `VITE_API_PROXY_TARGET` (defaults to `http://localhost:3200`). Images are NOT proxied — they load directly from MinIO (`MINIO_PUBLIC_URL`, default `http://localhost:9000`).

### CORS
Server reads `CLIENT_ORIGIN` (default `http://localhost:5173`) and allows `GET`/`POST` only.

## Conventions

- Use the dedicated tools (`Read`, `Edit`, `Glob`, `Grep`) rather than shell equivalents.
- Server code is CommonJS (`require`). Client is ESM + TypeScript.
- Workspace names are scoped (`@webrewind/*`) — use the scoped name when invoking `yarn workspace …`.
- UI components follow the shadcn/ui pattern (see `components.json`). Keep new ones consistent: Radix primitive + `cn()` from `lib/utils.ts` + class-variance-authority variants.

## Known quirks / watch out for

- Puppeteer 19.x uses `page.waitForXPath`, which was removed in later versions. Any Puppeteer upgrade requires migration to `waitForSelector` with an XPath locator.
- `outputFileName` is strictly validated server-side (`[A-Za-z0-9_-]{1,64}`). Spaces, slashes, and Unicode are rejected with HTTP 400.
- GIF encoding uses `canvas` which needs native Cairo/Pango — `yarn install` compiles it. On Apple Silicon you may need `brew install pkg-config cairo pango libpng jpeg giflib librsvg`.

## Environment variables

### Server (`apps/server/.env`)
- `PORT` — default `3200`
- `CLIENT_ORIGIN` — CORS origin, default `http://localhost:5173`
- `PUBLIC_BASE_URL` — base URL used when constructing `/screenshots` and `/screenshots/events/<id>` URLs in responses. Default `http://localhost:${PORT}`. Image URLs are built from `MINIO_PUBLIC_URL` instead.
- `MINIO_ENDPOINT` — internal URL the server uses to PUT/DELETE objects (e.g. `http://minio:9000` in compose, `http://localhost:9000` standalone).
- `MINIO_PUBLIC_URL` — public URL the BROWSER uses to GET objects. Defaults to `MINIO_ENDPOINT`. **Set this in production to the publicly reachable MinIO/S3 hostname.**
- `MINIO_BUCKET` — default `webrewind`. Expected to allow anonymous `GetObject`.
- `MINIO_REGION` — default `us-east-1`.
- `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` — credentials.
- `CACHE_ENABLED` — set to `false` to disable the result cache entirely.
- `EXTRA_CA_CERT_PATH` — absolute path to a PEM cert to trust for outbound HTTPS (corporate proxies / MITM). `util/wayback.js` reads this and attaches a custom `https.Agent` to axios. Preferred over `NODE_EXTRA_CA_CERTS` because dotenv loads after Node already read that var.
- `INSECURE_TLS` — set to `true` to disable cert verification for the Wayback axios client. Dev escape hatch only.
- `CAPTURE_CONCURRENCY` — parallel Puppeteer pages per job. Default `4`. Each page is ~120MB RAM.
- `CAPTURE_NAV_TIMEOUT_MS` — per-page navigation timeout. Default `25000`.
- `CAPTURE_NETWORK_IDLE_MS` / `CAPTURE_NETWORK_IDLE_TIMEOUT_MS` — how long to wait for the archived page to go quiet after DOMContentLoaded (default `400` / `5000`). If the page never idles we screenshot anyway.

### Client (`apps/client/.env`)
- `VITE_API_BASE_URL` — base URL for API calls. Empty in dev (uses Vite proxy). Set to public API hostname in prod.
- `VITE_API_PROXY_TARGET` — dev-only proxy target, default `http://localhost:3200`.

`.env.example` files are checked in for both workspaces; `.env` is gitignored.
