# Budokan SDK — Development Guide

## Package Manager

**CRITICAL: Always use `bun`, never `npm`, `yarn`, or `pnpm`.** This project uses `bun.lock` as the single lockfile. Do not run `npm install`, `npm ci`, or any npm commands that manage dependencies. Do not generate `package-lock.json`.

## Commands

```bash
bun install          # Install dependencies
bun run build        # Build ESM + CJS to dist/
bun run typecheck    # TypeScript type checking (tsc --noEmit)
bun run dev          # Build in watch mode
bun run clean        # Remove dist/
```
