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
│       └── util/cloudflare.js               # (commented out) R2 storage helpers
```

## Tech stack

- **Client:** React 18, TypeScript, Vite, Tailwind CSS, Radix UI, react-hook-form + zod, framer-motion, react-three-fiber/drei (Three.js), date-fns
- **Server:** Node.js, Express, Puppeteer (headless Chromium), canvas + gif-encoder-2, axios, swagger-jsdoc/ui-express, aws-sdk (for Cloudflare R2, currently disabled)
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

### Screenshot pipeline (`apps/server/index.js`)
1. `getURLs()` in `util/wayback.js` hits the Wayback CDX API (`https://web.archive.org/cdx/search/cdx/`) and returns public archive URLs filtered by year range and `collapse=timestamp:6`.
2. `run()` launches Puppeteer, visits each archive URL, removes the Wayback toolbar (`#wm-ipp-base`) via `page.evaluate`, and writes PNGs to `screenshots-<outputFileName>/`.
3. `createGifFromScreenshots()` stitches PNGs into a GIF using `canvas` + `gif-encoder-2`.
4. `POST /screenshots` — currently short-circuits: the `run()`/GIF path is commented out and it only returns existing PNG paths from a preexisting `screenshots-<outputFileName>/` folder. Be aware when editing.
5. Swagger UI is mounted at `/` (server root); spec is regenerated to `apps/server/docs/openapi.json` on boot.

### Client
- Single-page app: `App.tsx` → `WebsiteEvolutionViewer.tsx`.
- Form uses `react-hook-form` + `zod` (schema: url, startYear, endYear, outputFileName).
- 3D scene via `@react-three/fiber` / `drei`.
- Path alias `@/*` → `apps/client/src/*` (see `vite.config.ts`, `tsconfig.json`).

### CORS
Server allows origin `http://localhost:5173` with `GET`/`POST` only.

## Conventions

- Use the dedicated tools (`Read`, `Edit`, `Glob`, `Grep`) rather than shell equivalents.
- Server code is CommonJS (`require`). Client is ESM + TypeScript.
- Workspace names are scoped (`@webrewind/*`) — use the scoped name when invoking `yarn workspace …`.
- UI components follow the shadcn/ui pattern (see `components.json`). Keep new ones consistent: Radix primitive + `cn()` from `lib/utils.ts` + class-variance-authority variants.
- Generated artifacts under `apps/server/screenshots-*/` are committed to the repo — don't delete them unless asked.

## Known quirks / watch out for

- `apps/server/util/cloudflare.js` is entirely commented out; `index.js` still imports it and references `cloudflarestorage.listFolders` in `GET /folders`, which will throw at runtime. Flag before using that route.
- `require("inspector").console` is imported in `apps/server/index.js` — shadows the global `console`; unusual but intentional-looking. Leave alone unless fixing.
- Puppeteer 19.x uses `page.waitForXPath`, which was removed in later versions. Any Puppeteer upgrade requires migration to `waitForSelector` with an XPath locator.
- `POST /screenshots` does not actually run the capture pipeline in the current code — it only lists preexisting PNGs. If a user expects capture, confirm which behavior they want.
- The client had a CRA-style `"proxy"` field which has been removed during the monorepo migration (Vite ignores it). If you need the client to proxy `/api` to the server, add `server.proxy` in `vite.config.ts`.

## Environment variables

Only referenced in the commented-out `cloudflare.js`: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`. Server port overridable via `port` (note: lowercase, not `PORT`).
