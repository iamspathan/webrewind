# Client image: Vite build served by nginx. Two stages — Node just long
# enough to produce dist/, then nginx serves the static output.

FROM node:20-bookworm-slim AS build

WORKDIR /app

# Install workspace deps. --ignore-scripts skips native postinstalls
# (notably canvas from the server workspace, which needs Cairo/Pango
# toolchains we don't want in this slim builder). The client build
# never imports those modules, so skipping their build is safe.
COPY package.json yarn.lock ./
COPY apps/client/package.json apps/client/
COPY apps/server/package.json apps/server/
RUN yarn install --frozen-lockfile --ignore-scripts

COPY apps/client apps/client

# VITE_API_BASE_URL is baked in at build time. Compose sets it via build
# args; defaulting to empty makes the client use same-origin, which works
# when an upstream reverse proxy fronts both services.
ARG VITE_API_BASE_URL=""
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}

# VITE_IMAGES_BASE_URL points at the MinIO bucket the browser loads
# images from for preview/demo URLs. Defaults to the compose-stack value.
ARG VITE_IMAGES_BASE_URL="http://localhost:9000/webrewind"
ENV VITE_IMAGES_BASE_URL=${VITE_IMAGES_BASE_URL}

RUN yarn workspace @webrewind/client build

# ---------- Runtime ----------
FROM nginx:1.27-alpine

COPY --from=build /app/apps/client/dist /usr/share/nginx/html
COPY apps/client/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
