import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";

// Telegram Mini Apps allow http://localhost during dev, otherwise require HTTPS.
// In prod, deploy the build output to any static host.
//
// `vite-plugin-wasm` + `vite-plugin-top-level-await` are required because
// `@cartridge/controller-wasm` uses ESM-native WASM imports that Vite can't
// otherwise process. Cartridge's own React example uses the same pair.
export default defineConfig({
  plugins: [wasm(), topLevelAwait(), react()],
  server: {
    port: 5173,
    host: true,
  },
  build: {
    target: "esnext",
  },
});
