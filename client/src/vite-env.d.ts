/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_BASE_PATH?: string;
  readonly VITE_GOOGLE_CLIENT_ID?: string;
  /** 'true' only for Android builds that include google-services.json (see native/push.ts). */
  readonly VITE_FCM_ENABLED?: string;
}
