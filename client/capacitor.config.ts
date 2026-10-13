import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor turns this same React app into the native Android build
 * ("Zenkara 360", com.zenkara.app). The web deployment is untouched:
 * `npm run build` still produces the exact `dist/` nginx serves. A native
 * build is a `dist/` built for the app, copied into android/ by
 * `npx cap sync` — .github/workflows/android.yml does both.
 *
 * ── What a native build does differently ───────────────────────────────
 *
 * 1. ABSOLUTE API URL, ROOT BASE PATH.
 *    The WebView serves the bundle from http://localhost, so a relative
 *    "/zenkara/api" would resolve to the phone itself. Build with:
 *
 *      VITE_API_URL=https://app.zenkara.in/zenkara/api npm run build
 *
 *    and WITHOUT VITE_BASE_PATH (the app lives at the WebView root).
 *
 * 2. THE BUNDLE SHIPS INSIDE THE APP.
 *    A web deploy never changes an installed app; users only get new client
 *    code with a new APK/AAB (tag vX.Y.Z to build a Play bundle).
 *
 * 3. NATIVE-ONLY CODE lives in src/native/ and is always guarded by
 *    Capacitor.isNativePlatform() (native/platform.ts) — session storage
 *    mirror, resume handling, Back button, downloads, Microsoft sign-in, push.
 */
const config: CapacitorConfig = {
  appId: 'com.zenkara.app',
  appName: 'Zenkara 360',
  webDir: 'dist',

  plugins: {
    // Routes fetch/XMLHttpRequest (so the axios client) through the native
    // HTTP stack. Originally this was the way around CORS; the server now
    // also allows the app's WebView origins (server utils/corsOrigins.ts),
    // which EventSource (live updates) needs since CapacitorHttp doesn't
    // patch it. Kept on because it has been what every installed build uses
    // — turning it off now would change how every request (cookies, headers,
    // uploads) is made at once. When touching uploads/downloads, test
    // multipart and blob responses on a device: those are where the native
    // bridge has historically differed from the browser.
    CapacitorHttp: {
      enabled: true,
    },
  },

  android: {
    // Keep 'http'. The WebView origin (http://localhost) is also the
    // localStorage bucket that holds existing sessions; switching to
    // 'https' changes the origin and would sign every installed user out.
    // Sessions are now mirrored to native Preferences (api/authStorage.ts)
    // and restored on launch, so a future switch is possible — but only
    // after a release with that mirror has been out long enough for users
    // to have opened it at least once.
    androidScheme: 'http',
  },
};

export default config;
