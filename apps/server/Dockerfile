# Server image: Express + Puppeteer (bundled Chromium) + canvas (Cairo/Pango).
#
# We use bookworm-slim rather than alpine because Puppeteer's bundled
# Chromium and the `canvas` native module rely on libraries (glibc, Cairo,
# Pango, etc.) that alpine ships in incompatible musl variants. The apt
# package list below is the intersection of canvas + Chromium runtime deps.
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

# Install workspace dependencies. Copy all workspace manifests so yarn can
# resolve the workspace graph; actual source is copied in the next stage.
COPY package.json yarn.lock ./
COPY apps/server/package.json apps/server/
COPY apps/client/package.json apps/client/

# --frozen-lockfile ensures reproducibility. We intentionally let Puppeteer
# download its bundled Chromium here so index.js can stay unchanged.
RUN yarn install --frozen-lockfile

COPY apps/server apps/server

# ---------- Runtime stage ----------
FROM node:20-bookworm-slim AS runtime

# Only runtime shared libs — no build-essential, no -dev headers. Saves
# ~250 MB versus the deps stage.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    fonts-liberation \
    libatk-bridge2.0-0 libatk1.0-0 libasound2 libc6 libcairo2 libcups2 \
    libdbus-1-3 libexpat1 libfontconfig1 libgbm1 libgcc-s1 libglib2.0-0 \
    libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 libpangocairo-1.0-0 \
    libstdc++6 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 \
    libxdamage1 libxext6 libxfixes3 libxi6 libxkbcommon0 libxrandr2 \
    libxrender1 libxss1 libxtst6 \
    libjpeg62-turbo libgif7 librsvg2-2 \
    tini \
    && rm -rf /var/lib/apt/lists/*

# Non-root user — Puppeteer still needs --no-sandbox but otherwise runs fine.
RUN groupadd -r app && useradd -r -g app -G audio,video app \
    && mkdir -p /home/app && chown -R app:app /home/app

WORKDIR /app
# Puppeteer 19.x downloads Chromium into node_modules/puppeteer/.local-chromium/,
# so copying the /app tree brings the browser along — no separate cache copy.
COPY --from=deps --chown=app:app /app ./

USER app
ENV NODE_ENV=production
ENV PORT=3200

EXPOSE 3200

# tini handles PID 1 signal forwarding properly so SIGTERM reaches node.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/server/index.js"]
