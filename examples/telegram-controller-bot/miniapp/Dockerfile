# Mini App image. Three stages:
#  - deps: install via Bun (matches the bun.lock shipped in the repo).
#  - build: run Vite via Node, because vite-plugin-top-level-await uses a
#    CommonJS require() shim that Bun's runtime doesn't fully support
#    (TypeError: virtualModule.require is not a function on Bun 1.3 + Vite 6).
#  - runtime: Node + `serve` for static hosting.
#
# VITE_BOT_PUBLIC_URL must be available at BUILD time because Vite inlines it
# into the bundle. On Railway, set it via service variables so it's exposed
# during the docker build (Railway forwards build-time variables).

FROM oven/bun:1.3-slim AS deps

WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

# --- Build stage: Node, not Bun. ---
FROM node:22-slim AS build

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json vite.config.ts index.html ./
COPY src ./src

ARG VITE_BOT_PUBLIC_URL
ENV VITE_BOT_PUBLIC_URL=${VITE_BOT_PUBLIC_URL}

RUN npx vite build

# --- Runtime stage: tiny static server. ---
FROM node:22-slim AS runtime

WORKDIR /app
RUN npm install -g serve@14

COPY --from=build /app/dist ./dist

# Railway injects PORT; serve respects it.
EXPOSE 5173
CMD ["sh", "-c", "serve -s dist -l ${PORT:-5173}"]
