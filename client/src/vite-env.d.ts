/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_BASE_PATH?: string;
  readonly VITE_GOOGLE_CLIENT_ID?: string;
  /** 'true' only for Android builds that include google-services.json (see native/push.ts). */
  readonly VITE_FCM_ENABLED?: string;
  /**
   * Optional absolute URL of the web app (e.g. https://app.zenkara.in/zenkara)
   * for shareable links (shared/appUrl.ts). Unset = derived: the page's own
   * origin + base on the web, VITE_API_URL minus /api in the Android app.
   */
  readonly VITE_PUBLIC_APP_URL?: string;
}
