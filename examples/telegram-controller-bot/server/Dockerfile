# Bot server image. Two stages:
#  - deps: install via Bun (matches the bun.lock shipped in the repo).
#  - runtime: Node 22 + tsx, because @cartridge/controller-wasm uses the
#    wasm-bindgen `import * as wasm from "./file.wasm"; __wbg_set_wasm(wasm)`
#    pattern. Bun's WASM-namespace shape doesn't include the wbg shim's
#    expected underscore exports, so signerToGuid throws
#    "__wbindgen_add_to_stack_pointer is not a function" at runtime.
#    Node with --experimental-wasm-modules handles it correctly; this is
#    the same combination the upstream cartridge-gg/slot Node example uses.
#
# Build from the repository root, so file:../../.. resolves to the SDK:
# docker build -f examples/telegram-controller-bot/server/Dockerfile .
# Built and deployed by Railway. The .env file is NOT copied — Railway injects
# variables at runtime. Filesystem session state is persisted via a Railway
# volume mounted at /data (set BOT_DATA_DIR=/data).

FROM oven/bun:1.3.6-slim AS deps

WORKDIR /app
COPY package.json bun.lock tsconfig.json tsup.config.ts ./
COPY src ./src
RUN bun install --frozen-lockfile && bun run build

WORKDIR /app/examples/telegram-controller-bot/server
COPY examples/telegram-controller-bot/server/package.json examples/telegram-controller-bot/server/bun.lock ./
RUN bun install --frozen-lockfile

# --- Runtime stage: Node, not Bun. ---
FROM node:22-slim AS runtime

WORKDIR /app
COPY --from=deps /app/package.json ./package.json
COPY --from=deps /app/dist ./dist
COPY --from=deps /app/node_modules ./node_modules
WORKDIR /app/examples/telegram-controller-bot/server
COPY --from=deps /app/examples/telegram-controller-bot/server/node_modules ./node_modules
COPY examples/telegram-controller-bot/server/package.json examples/telegram-controller-bot/server/tsconfig.json ./
COPY examples/telegram-controller-bot/server/src ./src

# Railway injects PORT; the app reads it via process.env.PORT (config.ts).
EXPOSE 8787

# `tsx` runs TypeScript directly without a build step. The
# --experimental-wasm-modules flag enables ESM WASM imports the wbg shim
# relies on. The npx prefix uses tsx from node_modules (installed via Bun).
CMD ["node", "--experimental-wasm-modules", "--import", "tsx", "src/index.ts"]
