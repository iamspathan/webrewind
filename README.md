# Webrewind

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen.svg)
![Turborepo](https://img.shields.io/badge/monorepo-turborepo-0f0f23.svg)
![React](https://img.shields.io/badge/react-18-61dafb.svg)
![Express](https://img.shields.io/badge/express-4-000.svg)
![PRs welcome](https://img.shields.io/badge/PRs-welcome-ff69b4.svg)

> Git history, but for websites.

Webrewind pulls a site's snapshots from the Wayback Machine, deduplicates unchanged captures, and stitches them into a scroll-driven timeline with AI-written captions and a looping GIF reel.

![Preview](apps/client/public/screely-1736442296819.png)

## How it works

1. **Query** the Wayback CDX API for captures in a given year range.
2. **Dedupe** consecutive snapshots by HTML digest — no ten copies of the same page.
3. **Capture** each unique snapshot in parallel with headless Chrome.
4. **Store** frames and an encoded GIF in MinIO/S3.
5. **Caption** each frame on demand with Gemma 3n (NVIDIA).
6. **Stream** progress over SSE; render a vertical timeline in React.

## Stack

- **Client** — React 18, TypeScript, Vite, Tailwind, Radix, Framer Motion
- **Server** — Node, Express, Puppeteer, `gif-encoder-2`, axios
- **Storage** — MinIO (S3-compatible)
- **AI** — NVIDIA Gemma 3n (`google/gemma-3n-e4b-it`)
- **Monorepo** — Turborepo + Yarn workspaces

## Layout

```
webrewind/
├── apps/
│   ├── client/   # Vite + React    (@webrewind/client)
│   └── server/   # Express + Puppeteer  (@webrewind/server)
├── turbo.json
└── package.json
```

## Quick start

```bash
git clone https://github.com/iamspathan/webrewind.git
cd webrewind
yarn install
yarn dev
```

Client on `http://localhost:5173`, server on `http://localhost:3200`.

You need MinIO reachable on `:9000` with a public `webrewind` bucket. The simplest path is `docker compose up -d` if a compose file ships with your checkout; otherwise point `MINIO_ENDPOINT` at your own instance.

## Configuration

Copy `.env.example` to `.env` in each app.

**Server** — the essentials:

| Variable | Purpose |
|---|---|
| `PORT` | server port (default `3200`) |
| `MINIO_ENDPOINT` | S3 endpoint the server writes to |
| `MINIO_PUBLIC_URL` | S3 endpoint the browser reads from |
| `MINIO_BUCKET` | bucket name (default `webrewind`) |
| `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` | credentials |
| `NVIDIA_API_KEY` | enables AI captions (optional) |
| `CAPTURE_CONCURRENCY` | parallel Puppeteer pages (default `4`) |

**Client**:

| Variable | Purpose |
|---|---|
| `VITE_API_BASE_URL` | API base (empty in dev — Vite proxy) |
| `VITE_API_PROXY_TARGET` | dev proxy target (default `http://localhost:3200`) |

## Scripts

```bash
yarn dev                              # run client + server (turbo)
yarn build                            # build everything
yarn lint                             # lint everything
yarn workspace @webrewind/client dev  # client only
yarn workspace @webrewind/server dev  # server only
```

## API

- `POST /screenshots` — start a capture job; returns `{ jobId, streamUrl }`
- `GET /screenshots/events/:jobId` — SSE progress stream
- `DELETE /screenshots/:jobId` — cancel a job
- `POST /summaries` — caption a single frame
- `GET /health` · `GET /metrics` · `GET /docs` — ops

Full OpenAPI at `/docs`.

## Contributing

PRs and issues welcome. Open one and we'll take a look.

## License

MIT.
