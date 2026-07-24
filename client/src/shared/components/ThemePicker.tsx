import { useState, useRef, useEffect } from 'react';
import { Palette, Check, Type, X } from 'lucide-react';
import { useTheme, THEME_LABELS, FONT_LABELS, type ThemeStyle, type ThemeFont } from '../../contexts/ThemeContext';

/* ── Visual previews for each theme ── */
const THEME_PREVIEWS: Record<ThemeStyle, { radius: string; accent: string; shadow: string }> = {
  minimal:  { radius: '10px', accent: '#6366f1', shadow: '0 4px 12px rgba(0,0,0,0.08)' },
  modern:   { radius: '6px',  accent: '#4f46e5', shadow: '0 8px 20px rgba(0,0,0,0.18)' },
  classic:  { radius: '3px',  accent: '#475569', shadow: '0 2px 6px rgba(0,0,0,0.12)' },
  friendly: { radius: '16px', accent: '#f97316', shadow: '0 6px 18px rgba(0,0,0,0.08)' },
};

const FONT_SAMPLES: Record<ThemeFont, string> = {
  inter:   'Inter',
  jakarta: 'Plus Jakarta Sans',
  dm:      'DM Sans',
  nunito:  'Nunito Sans',
};

export function ThemePicker() {
  const { style, font, setStyle, setFont } = useTheme();
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div className="relative" ref={panelRef}>
      {/* Trigger button */}
      <button
        onClick={() => setOpen(v => !v)}
        title="Appearance"
        className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-400 hover:text-slate-200 hover:bg-white/10 transition-all"
      >
        <Palette size={16} />
      </button>

      {/* Panel */}
      {open && (
        <div
          className="absolute bottom-10 left-0 z-[200] w-72 animate-slide-down"
          style={{
            background: '#ffffff',
            borderRadius: '16px',
            boxShadow: '0 20px 40px -8px rgba(0,0,0,0.22), 0 0 0 1px rgba(0,0,0,0.06)',
            padding: '0',
            overflow: 'hidden',
          }}
        >
          {/* Panel header */}
          <div className="flex items-center justify-between px-4 py-3.5 border-b border-gray-100">
            <div className="flex items-center gap-2">
              <Palette size={14} className="text-brand-500" />
              <span className="text-[13px] font-semibold text-gray-800">Appearance</span>
            </div>
            <button
              onClick={() => setOpen(false)}
              className="w-6 h-6 flex items-center justify-center rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-all"
            >
              <X size={13} />
            </button>
          </div>

          <div className="p-4 space-y-5">
            {/* ── Theme style ── */}
            <div>
              <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-widest mb-3">
                Visual Style
              </p>
              <div className="grid grid-cols-2 gap-2">
                {(Object.keys(THEME_LABELS) as ThemeStyle[]).map(s => {
                  const preview = THEME_PREVIEWS[s];
                  const active  = style === s;
                  return (
                    <button
                      key={s}
                      onClick={() => setStyle(s)}
                      className={`theme-swatch relative text-left p-3 border transition-all ${
                        active
                          ? 'border-brand-500 bg-brand-50/60'
                          : 'border-gray-100 bg-gray-50/60 hover:border-gray-200 hover:bg-white'
                      }`}
                      style={{ borderRadius: '10px' }}
                    >
                      {/* Mini UI preview */}
                      <div className="mb-2.5 space-y-1.5">
                        {/* Fake modal shape */}
                        <div
                          className="w-full h-7 bg-white border border-gray-200 overflow-hidden"
                          style={{ borderRadius: preview.radius, boxShadow: preview.shadow }}
                        >
                          <div
                            className="h-1.5 w-full"
                            style={{
                              background: s === 'modern'   ? 'linear-gradient(90deg,#4f46e5,#8b5cf6)' :
                                          s === 'friendly' ? 'linear-gradient(90deg,#f97316,#fbbf24)' :
                                          'transparent',
                            }}
                          />
                          <div className="px-2 pt-1 flex items-center justify-between">
                            <div className="h-1.5 w-10 bg-gray-200 rounded-full" />
                            <div
                              className="h-1.5 w-4"
                              style={{
                                background: preview.accent,
                                borderRadius: preview.radius,
                                opacity: 0.9,
                              }}
                            />
                          </div>
                        </div>
                        {/* Fake button row */}
                        <div className="flex gap-1">
                          <div
                            className="h-2 flex-1"
                            style={{ background: preview.accent, borderRadius: preview.radius, opacity: 0.85 }}
                          />
                          <div
                            className="h-2 flex-1 bg-gray-200"
                            style={{ borderRadius: preview.radius }}
                          />
                        </div>
                      </div>

                      <p className="text-[11.5px] font-semibold text-gray-800 leading-none">
                        {THEME_LABELS[s].name}
                      </p>
                      <p className="text-[10.5px] text-gray-400 mt-0.5 leading-snug">
                        {THEME_LABELS[s].desc}
                      </p>

                      {active && (
                        <div className="absolute top-2 right-2 w-4 h-4 rounded-full bg-brand-500 flex items-center justify-center">
                          <Check size={9} strokeWidth={3} className="text-white" />
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* ── Font choice ── */}
            <div>
              <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-widest mb-3 flex items-center gap-1.5">
                <Type size={10} /> Font
              </p>
              <div className="space-y-1">
                {(Object.keys(FONT_LABELS) as ThemeFont[]).map(f => {
                  const active = font === f;
                  return (
                    <button
                      key={f}
                      onClick={() => setFont(f)}
                      className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-left transition-all ${
                        active
                          ? 'bg-brand-50 border border-brand-200'
                          : 'hover:bg-gray-50 border border-transparent'
                      }`}
                    >
                      <span
                        className="text-[13px] font-medium text-gray-800"
                        style={{ fontFamily: FONT_LABELS[f].family }}
                      >
                        {FONT_SAMPLES[f]}
                      </span>
                      <span className="text-[11px] text-gray-400">
                        {active
                          ? <Check size={12} className="text-brand-500" />
                          : <span className="italic opacity-50">Aa</span>
                        }
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
