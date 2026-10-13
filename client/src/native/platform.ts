import { Capacitor } from '@capacitor/core';

/**
 * True only inside the Capacitor Android/iOS shell. Every native-only code
 * path checks this first, so the web build behaves exactly as before.
 */
export const isNative: boolean = Capacitor.isNativePlatform();

/** 'android' | 'ios' | 'web' */
export const nativePlatform: string = Capacitor.getPlatform();

/**
 * Sent as X-Client on API calls from the app. The server gives native
 * clients a longer refresh-token lifetime (REFRESH_TTL_DAYS_NATIVE, default
 * 90 days — see server refreshPolicy.ts); browsers keep the 7-day window.
 */
export const clientHeader: string | null = isNative ? `native-${nativePlatform}` : null;
