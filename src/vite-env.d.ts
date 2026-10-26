/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/preact" />

declare const __APP_VERSION__: string;
declare const __BUILD_DATE__: string;

interface ImportMetaEnv {
  /** Адрес посредника обмена с партнёром; без него обмен выключен. */
  readonly VITE_SYNC_URL?: string;
}
