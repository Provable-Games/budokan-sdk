/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_BOT_PUBLIC_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
