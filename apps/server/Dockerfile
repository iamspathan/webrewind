# Server image: Express + Puppeteer (system Chromium from apt) + canvas
# (Cairo/Pango).
#
# We use bookworm-slim rather than alpine because Puppeteer's Chromium and
# the `canvas` native module rely on libraries (glibc, Cairo, Pango, etc.)
# that alpine ships in incompatible musl variants. We use Debian's own
# `chromium` package instead of Puppeteer's bundled one so the same image
# runs on both linux/amd64 (Oracle Intel/AMD) and linux/arm64 (Oracle
# Ampere A1, Apple Silicon). Puppeteer's v19 bundle is x86_64-only.
FROM node:20-bookworm-slim AS deps

# Build toolchain + native libraries. The -dev packages are only required
# during `yarn install` (canvas rebuild); the runtime stage strips them.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    build-essential python3 pkg-config \
    libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev \
    fonts-liberation \
    libatk-bridge2.0-0 libatk1.0-0 libasound2 libc6 libcairo2 libcups2 \
    libdbus-1-3 libexpat1 libfontconfig1 libgbm1 libgcc-s1 libglib2.0-0 \
    libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 libpangocairo-1.0-0 \
    libstdc++6 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 \
    libxdamage1 libxext6 libxfixes3 libxi6 libxkbcommon0 libxrandr2 \
    libxrender1 libxss1 libxtst6 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Skip Puppeteer's Chromium download — we install the system chromium
# package in the runtime stage and point Puppeteer at it via
# PUPPETEER_EXECUTABLE_PATH. Avoids a ~280MB x86_64-only download.
ENV PUPPETEER_SKIP_DOWNLOAD=true

# Install workspace dependencies. Copy all workspace manifests so yarn can
# resolve the workspace graph; actual source is copied in the next stage.
COPY package.json yarn.lock ./
COPY apps/server/package.json apps/server/
COPY apps/client/package.json apps/client/

# --frozen-lockfile ensures reproducibility.
RUN yarn install --frozen-lockfile

COPY apps/server apps/server

# ---------- Runtime stage ----------
FROM node:20-bookworm-slim AS runtime

# Runtime shared libs — no build-essential, no -dev headers. `chromium`
# pulls in most of the X/GTK stack as deps; we list the canvas runtime
# libs (libjpeg62-turbo, libgif7, librsvg2-2) and fonts explicitly.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    chromium \
    fonts-liberation \
    libjpeg62-turbo libgif7 librsvg2-2 libcairo2 libpango-1.0-0 libpangocairo-1.0-0 \
    tini \
    && rm -rf /var/lib/apt/lists/*

# Non-root user — Puppeteer still needs --no-sandbox but otherwise runs fine.
RUN groupadd -r app && useradd -r -g app -G audio,video app \
    && mkdir -p /home/app && chown -R app:app /home/app

WORKDIR /app
COPY --from=deps --chown=app:app /app ./

USER app
ENV NODE_ENV=production
ENV PORT=3200
# Point Puppeteer at the system chromium installed above. Works on both
# amd64 and arm64 — apt resolves the right arch automatically.
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_DOWNLOAD=true

EXPOSE 3200

# tini handles PID 1 signal forwarding properly so SIGTERM reaches node.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/server/index.js"]
