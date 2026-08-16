import { createContext, useContext, useEffect, useState } from 'react';

export type ThemeStyle = 'minimal' | 'modern' | 'classic' | 'friendly';
export type ThemeFont  = 'inter' | 'jakarta' | 'dm' | 'nunito';

export const THEME_LABELS: Record<ThemeStyle, { name: string; desc: string }> = {
  minimal:  { name: 'Minimal',    desc: 'Clean & airy — lots of space, soft shadows' },
  modern:   { name: 'Modern',     desc: 'Bold & sharp — strong presence, vivid depth' },
  classic:  { name: 'Classic',    desc: 'Enterprise grade — structured, dense, formal' },
  friendly: { name: 'Friendly',   desc: 'Warm & rounded — approachable and inviting' },
};

export const FONT_LABELS: Record<ThemeFont, { name: string; family: string }> = {
  inter:   { name: 'Inter',             family: "'Inter', system-ui, sans-serif" },
  jakarta: { name: 'Plus Jakarta Sans', family: "'Plus Jakarta Sans', system-ui, sans-serif" },
  dm:      { name: 'DM Sans',           family: "'DM Sans', system-ui, sans-serif" },
  nunito:  { name: 'Nunito Sans',       family: "'Nunito Sans', system-ui, sans-serif" },
};

interface ThemeContextValue {
  style: ThemeStyle;
  font:  ThemeFont;
  dark:  boolean;
  setStyle: (s: ThemeStyle) => void;
  setFont:  (f: ThemeFont)  => void;
  setDark:  (d: boolean)    => void;
  toggleDark: () => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  style: 'minimal', font: 'inter', dark: false,
  setStyle: () => {}, setFont: () => {}, setDark: () => {}, toggleDark: () => {},
});

function applyTheme(style: ThemeStyle, font: ThemeFont) {
  const html = document.documentElement;
  html.setAttribute('data-theme', style);
  html.setAttribute('data-font', font);
  html.style.setProperty('--font-sans', FONT_LABELS[font].family);
}

// Previously nothing in the codebase ever toggled a `dark` class onto
// <html>/<body> despite Tailwind `dark:` classes being present throughout —
// dark mode simply didn't work (see Technical Docs 14.1). This, plus setting
// `darkMode: 'class'` in tailwind.config.js, is what actually wires it up.
function applyDark(dark: boolean) {
  document.documentElement.classList.toggle('dark', dark);
}

function initialDark(): boolean {
  const stored = localStorage.getItem('ui-dark');
  if (stored !== null) return stored === 'true';
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [style, setStyleState] = useState<ThemeStyle>(
    () => (localStorage.getItem('ui-theme') as ThemeStyle) || 'minimal'
  );
  const [font, setFontState] = useState<ThemeFont>(
    () => (localStorage.getItem('ui-font') as ThemeFont) || 'inter'
  );
  const [dark, setDarkState] = useState<boolean>(initialDark);

  // Apply immediately on mount
  useEffect(() => { applyTheme(style, font); applyDark(dark); }, []);

  function setStyle(s: ThemeStyle) {
    setStyleState(s);
    localStorage.setItem('ui-theme', s);
    applyTheme(s, font);
  }

  function setFont(f: ThemeFont) {
    setFontState(f);
    localStorage.setItem('ui-font', f);
    applyTheme(style, f);
  }

  function setDark(d: boolean) {
    setDarkState(d);
    localStorage.setItem('ui-dark', String(d));
    applyDark(d);
  }

  function toggleDark() {
    setDark(!dark);
  }

  return (
    <ThemeContext.Provider value={{ style, font, dark, setStyle, setFont, setDark, toggleDark }}>
      {children}
    </ThemeContext.Provider>
  );
}

export const useTheme = () => useContext(ThemeContext);
