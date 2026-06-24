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
# Built and deployed by Railway. The .env file is NOT copied — Railway injects
# variables at runtime. Filesystem session state is persisted via a Railway
# volume mounted at /data (set BOT_DATA_DIR=/data).

FROM oven/bun:1.3-slim AS deps

WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

# --- Runtime stage: Node, not Bun. ---
FROM node:22-slim AS runtime

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src

# Railway injects PORT; the app reads it via process.env.PORT (config.ts).
EXPOSE 8787

# `tsx` runs TypeScript directly without a build step. The
# --experimental-wasm-modules flag enables ESM WASM imports the wbg shim
# relies on. The npx prefix uses tsx from node_modules (installed via Bun).
CMD ["node", "--experimental-wasm-modules", "--import", "tsx", "src/index.ts"]
