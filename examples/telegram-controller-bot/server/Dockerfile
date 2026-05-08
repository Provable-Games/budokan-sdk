# Bot server image. Bun runs TypeScript directly, no separate build step.
#
# Built and deployed by Railway. The .env file is NOT copied — Railway injects
# variables at runtime. Filesystem session state is persisted via a Railway
# volume mounted at /data (set BOT_DATA_DIR=/data).

FROM oven/bun:1.3-slim

WORKDIR /app

# Install deps first so layer caching survives source edits.
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production

# Copy source last for fast incremental rebuilds.
COPY src ./src
COPY tsconfig.json ./

# Railway injects PORT; the app reads it via process.env.PORT (config.ts).
EXPOSE 8787

# `bun run start` reads --env-file=../.env (local-dev convention). On Railway
# we run src/index.ts directly so the runtime relies on injected env vars only.
CMD ["bun", "src/index.ts"]
