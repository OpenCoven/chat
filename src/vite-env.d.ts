/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Demo surface a demo build opens on when no `?demo=` flag is given. */
  readonly VITE_DEFAULT_DEMO?: 'chat' | 'messages' | 'minimal';
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
