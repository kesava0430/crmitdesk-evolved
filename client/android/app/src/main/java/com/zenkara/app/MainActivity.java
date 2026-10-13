package com.zenkara.app;

import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.View;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    /** Brand slate (#0f172a) — the PWA theme_color, splash and launcher background. */
    private static final int SYSTEM_BAR_COLOR = 0xFF0F172A;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Edge-to-edge, handled explicitly.
        //
        // targetSdk 35+ makes Android 15 draw every app edge-to-edge, and
        // Capacitor 6 has no inset handling of its own: the WebView ran under
        // the status bar and the gesture bar, so the app header sat beneath the
        // clock/notch and bottom sheets and last rows hid under the gesture
        // handle. Opting in on every API level and applying the insets
        // ourselves gives one behaviour everywhere: the WebView is padded clear
        // of the system bars (and of the keyboard — the IME inset — so focused
        // inputs are never covered), and the padding shows the brand colour.
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        if (Build.VERSION.SDK_INT < 35) {
            // Below Android 15 these still paint over the content; make them
            // transparent so the padded area's colour shows through.
            getWindow().setStatusBarColor(Color.TRANSPARENT);
            getWindow().setNavigationBarColor(Color.TRANSPARENT);
        }
        WindowInsetsControllerCompat bars =
                WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        // Light icons on the dark bar, in both of the app's themes.
        bars.setAppearanceLightStatusBars(false);
        bars.setAppearanceLightNavigationBars(false);

        if (getBridge() == null || getBridge().getWebView() == null) return;
        View container = (View) getBridge().getWebView().getParent();
        if (container == null) return;
        container.setBackgroundColor(SYSTEM_BAR_COLOR);
        ViewCompat.setOnApplyWindowInsetsListener(container, (v, insets) -> {
            Insets safe = insets.getInsets(
                    WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            Insets ime = insets.getInsets(WindowInsetsCompat.Type.ime());
            v.setPadding(safe.left, safe.top, safe.right, Math.max(safe.bottom, ime.bottom));
            return WindowInsetsCompat.CONSUMED;
        });
        ViewCompat.requestApplyInsets(container);
    }
}
