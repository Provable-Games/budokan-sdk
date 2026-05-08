# Mini App image. Two-stage build: Bun compiles, a tiny static server hosts.
#
# VITE_BOT_PUBLIC_URL must be available at BUILD time because Vite inlines it
# into the bundle. On Railway, set it via service variables so it's exposed
# during the docker build (Railway forwards build-time variables).

FROM oven/bun:1.3-slim AS build

WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

COPY index.html tsconfig.json vite.config.ts ./
COPY src ./src

# Vite reads import.meta.env.VITE_BOT_PUBLIC_URL at build time.
ARG VITE_BOT_PUBLIC_URL
ENV VITE_BOT_PUBLIC_URL=${VITE_BOT_PUBLIC_URL}

RUN bun run build

# --- Runtime stage: tiny static server ---
FROM oven/bun:1.3-slim AS runtime

WORKDIR /app

# `serve` is a small, well-trodden static server. We install it as a one-off
# rather than baking it into deps so the dev image stays minimal.
RUN bun add -g serve@14

COPY --from=build /app/dist ./dist

# Railway injects PORT; serve respects it.
EXPOSE 5173
CMD ["sh", "-c", "serve -s dist -l ${PORT:-5173}"]
