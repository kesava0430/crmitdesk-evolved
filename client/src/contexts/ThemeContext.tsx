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
  setStyle: (s: ThemeStyle) => void;
  setFont:  (f: ThemeFont)  => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  style: 'minimal', font: 'inter',
  setStyle: () => {}, setFont: () => {},
});

function applyTheme(style: ThemeStyle, font: ThemeFont) {
  const html = document.documentElement;
  html.setAttribute('data-theme', style);
  html.setAttribute('data-font', font);
  html.style.setProperty('--font-sans', FONT_LABELS[font].family);
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [style, setStyleState] = useState<ThemeStyle>(
    () => (localStorage.getItem('ui-theme') as ThemeStyle) || 'minimal'
  );
  const [font, setFontState] = useState<ThemeFont>(
    () => (localStorage.getItem('ui-font') as ThemeFont) || 'inter'
  );

  // Apply immediately on mount
  useEffect(() => { applyTheme(style, font); }, []);

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

  return (
    <ThemeContext.Provider value={{ style, font, setStyle, setFont }}>
      {children}
    </ThemeContext.Provider>
  );
}

export const useTheme = () => useContext(ThemeContext);
