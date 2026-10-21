import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { AlertTriangle, Braces, RotateCcw, Search, ShieldAlert } from 'lucide-react';
import { Alert, Button, Input } from '../../../shared/components';
import type { PlaceholderInfo, TemplateIssue, CustomHtmlInfo } from '../../../api/payslipTemplates';

// Editor for CUSTOM_HTML payslip templates: a plain monospace code area with
// line numbers (no editor dependency — the client has none, and HR edits a
// few hundred lines at most), a click-to-insert placeholder reference and
// inline problems. The live preview stays in the template modal's right
// column, rendered by the server in a sandboxed iframe.

const LINE_H = 19; // px — the textarea and the gutter must share it exactly

function CodeArea({ value, onChange, areaRef, errorLines, label, placeholder, onSelection }: {
  value: string; onChange: (v: string) => void; areaRef: RefObject<HTMLTextAreaElement>; errorLines: Set<number>; label: string; placeholder?: string;
  onSelection: (start: number, end: number) => void;
}) {
  const gutterRef = useRef<HTMLDivElement>(null);
  const lines = Math.max(1, value.split('\n').length);
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Tab indents instead of leaving the field (Esc then Tab still moves focus out — keyboard users aren't trapped).
    if (e.key === 'Tab' && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      const t = e.currentTarget; const { selectionStart: s, selectionEnd: en } = t;
      const next = value.slice(0, s) + '  ' + value.slice(en);
      onChange(next);
      requestAnimationFrame(() => { t.selectionStart = t.selectionEnd = s + 2; });
    }
  };
  return (
    <div className="flex rounded-input border border-line bg-surface overflow-hidden focus-within:ring-2 focus-within:ring-accent/40" style={{ height: 380 }}>
      <div ref={gutterRef} aria-hidden className="shrink-0 overflow-hidden select-none bg-surface-sunken border-r border-line-subtle text-right font-mono text-[11px] text-fg-subtle py-2" style={{ width: lines > 999 ? 44 : 36, lineHeight: `${LINE_H}px` }}>
        {Array.from({ length: lines }, (_, i) => (
          <div key={i} className={`pr-1.5 ${errorLines.has(i + 1) ? 'bg-danger-soft text-danger font-semibold' : ''}`}>{i + 1}</div>
        ))}
      </div>
      <textarea
        ref={areaRef} value={value} onChange={e => onChange(e.target.value)} onKeyDown={onKeyDown}
        onSelect={e => onSelection(e.currentTarget.selectionStart, e.currentTarget.selectionEnd)}
        onScroll={e => { if (gutterRef.current) gutterRef.current.scrollTop = e.currentTarget.scrollTop; }}
        aria-label={label} placeholder={placeholder} spellCheck={false} autoCapitalize="off" autoCorrect="off" wrap="off"
        className="flex-1 min-w-0 resize-none bg-transparent font-mono text-[12px] text-fg py-2 px-2.5 outline-none whitespace-pre overflow-auto"
        style={{ lineHeight: `${LINE_H}px`, tabSize: 2 }}
      />
    </div>
  );
}

/** Snippet inserted for a placeholder — loops and conditions come as a ready block. */
function snippetFor(p: PlaceholderInfo, placeholders: PlaceholderInfo[]): string {
  if (p.type === 'list') {
    const fields = placeholders.filter(x => x.list === p.path).map(x => x.path);
    const body = p.path === 'revisionLines' ? '{{this}}<br>' : fields.includes('amount') ? '<tr><td>{{name}}</td><td>{{amount}}</td></tr>' : fields.includes('label') ? '<div>{{label}}: {{value}}</div>' : fields.slice(0, 3).map(f => `{{${f}}}`).join(' ');
    return `{{#each ${p.path}}}\n  ${body}\n{{/each}}`;
  }
  if (p.type === 'flag' || p.type === 'object') return `{{#if ${p.path}}}\n  \n{{/if}}`;
  if (p.type === 'image') return `<img src="{{${p.path}}}" alt="">`;
  return `{{${p.path}}}`;
}

function PlaceholderPanel({ placeholders, onInsert }: { placeholders: PlaceholderInfo[]; onInsert: (snippet: string) => void }) {
  const [q, setQ] = useState('');
  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const match = (p: PlaceholderInfo) => !needle || p.path.toLowerCase().includes(needle) || p.label.toLowerCase().includes(needle) || (p.list ?? '').toLowerCase().includes(needle);
    const out = new Map<string, PlaceholderInfo[]>();
    for (const p of placeholders) {
      if (!match(p)) continue;
      const g = p.list && p.list !== '*' ? `Inside {{#each ${p.list}}}` : p.group;
      if (!out.has(g)) out.set(g, []);
      out.get(g)!.push(p);
    }
    return [...out.entries()];
  }, [placeholders, q]);
  return (
    <div className="rounded-lg border border-line-subtle">
      <div className="flex items-center gap-2 px-2.5 py-2 border-b border-line-subtle">
        <Braces size={13} className="text-fg-subtle shrink-0" />
        <span className="text-xs font-medium text-fg">Placeholders</span>
        <span className="text-[11px] text-fg-subtle hidden sm:inline">click to insert at the cursor</span>
        <div className="ml-auto w-32 sm:w-40 relative">
          <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-fg-subtle pointer-events-none" />
          <Input value={q} onChange={e => setQ(e.target.value)} placeholder="Filter" aria-label="Filter placeholders" className="!h-7 !pl-6 !text-xs" />
        </div>
      </div>
      <div className="max-h-56 overflow-y-auto p-2 space-y-2.5">
        {groups.length === 0 && <p className="text-xs text-fg-subtle px-1">No placeholder matches “{q}”.</p>}
        {groups.map(([g, items]) => (
          <div key={g}>
            <div className="text-[10.5px] font-semibold uppercase tracking-wide text-fg-subtle px-1 mb-1">{g}</div>
            <div className="grid grid-cols-1 gap-0.5">
              {items.map(p => (
                <button key={`${p.list ?? ''}:${p.path}`} type="button" onClick={() => onInsert(snippetFor(p, placeholders))}
                  className="text-left flex items-baseline gap-2 rounded px-1.5 py-1 hover:bg-surface-sunken focus:bg-surface-sunken focus:outline-none min-w-0">
                  <code className="font-mono text-[11.5px] text-accent shrink-0">{p.type === 'list' ? `#each ${p.path}` : `{{${p.path}}}`}</code>
                  <span className="text-[11px] text-fg-subtle truncate">{p.label}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function HtmlTemplateTab({ info, html, css, onHtml, onCss, issues, removed, onIssueLine }: {
  info: CustomHtmlInfo; html: string; css: string; onHtml: (v: string) => void; onCss: (v: string) => void;
  issues: TemplateIssue[]; removed: string[]; onIssueLine?: (l: number) => void;
}) {
  const [part, setPart] = useState<'html' | 'css'>('html');
  const htmlRef = useRef<HTMLTextAreaElement>(null);
  const cssRef = useRef<HTMLTextAreaElement>(null);
  // Where the cursor was when the author last touched each editor — the
  // textarea loses focus (and on re-render its selection) when they click a
  // placeholder or type in the filter, so insertion can't read it live.
  const sel = useRef<{ html: [number, number] | null; css: [number, number] | null }>({ html: null, css: null });
  const pendingCaret = useRef<{ part: 'html' | 'css'; pos: number } | null>(null);
  useEffect(() => {
    const p = pendingCaret.current; if (!p) return;
    pendingCaret.current = null;
    const t = (p.part === 'html' ? htmlRef : cssRef).current; if (!t) return;
    t.focus({ preventScroll: true }); t.selectionStart = t.selectionEnd = p.pos;
    const line = t.value.slice(0, p.pos).split('\n').length;
    t.scrollTop = Math.max(0, (line - 6) * LINE_H);
    sel.current[p.part] = [p.pos, p.pos];
  }, [html, css]);
  const cssIssues = issues.filter(i => i.message.startsWith('CSS: '));
  const htmlIssues = issues.filter(i => !i.message.startsWith('CSS: '));
  const errorLines = new Set((part === 'html' ? htmlIssues : cssIssues).map(i => i.line));
  const bytes = new Blob([html, css]).size;

  const insert = (snippet: string) => {
    const value = part === 'html' ? html : css;
    const set = part === 'html' ? onHtml : onCss;
    const [s, e] = (sel.current[part] ?? [value.length, value.length]).map(x => Math.min(x, value.length));
    pendingCaret.current = { part, pos: s + snippet.length };
    set(value.slice(0, s) + snippet + value.slice(e));
  };
  const goToLine = (i: TemplateIssue) => {
    const isCss = i.message.startsWith('CSS: ');
    setPart(isCss ? 'css' : 'html');
    onIssueLine?.(i.line);
    requestAnimationFrame(() => {
      const t = (isCss ? cssRef : htmlRef).current; if (!t) return;
      const v = t.value; let pos = 0;
      for (let n = 1; n < i.line && pos >= 0; n++) pos = v.indexOf('\n', pos) + 1;
      t.focus(); t.selectionStart = t.selectionEnd = Math.max(0, pos);
      t.scrollTop = Math.max(0, (i.line - 4) * LINE_H);
    });
  };
  const resetToStarter = () => {
    if ((html.trim() || css.trim()) && !confirm('Replace your HTML and CSS with the starter template?')) return;
    onHtml(info.starter.html); onCss(info.starter.css);
  };

  return (
    <div className="space-y-3">
      {!info.pdf.available && (
        <Alert tone="warning" title="PDFs can't be made from HTML templates on this server yet">
          The preview and print view work, but downloads, run bundles and e-mailed payslips for employees on this template will fail until an administrator installs the PDF engine.
          <span className="block mt-1 font-mono text-[11px] break-all">{info.pdf.detail}</span>
        </Alert>
      )}
      <div className="flex items-center gap-2 flex-wrap">
        <div role="tablist" aria-label="Template code" className="inline-flex gap-1 p-0.5 rounded-input bg-surface-sunken">
          {(['html', 'css'] as const).map(k => (
            <button key={k} type="button" role="tab" aria-selected={part === k} onClick={() => setPart(k)}
              className={`px-3 py-1 text-xs font-medium rounded-[6px] transition ${part === k ? 'bg-surface text-fg shadow-sm' : 'text-fg-subtle hover:text-fg'}`}>
              {k === 'html' ? 'HTML' : 'CSS'}{(k === 'html' ? htmlIssues : cssIssues).length ? <span className="ml-1 text-danger">•</span> : null}
            </button>
          ))}
        </div>
        <span className={`text-[11px] tabular-nums ${bytes > info.maxBytes ? 'text-danger font-medium' : 'text-fg-subtle'}`}>{(bytes / 1024).toFixed(1)} / {info.maxBytes / 1024} KB</span>
        <Button size="xs" variant="ghost" icon={<RotateCcw size={12} />} onClick={resetToStarter} className="ml-auto">Starter template</Button>
      </div>

      <div className={part === 'html' ? '' : 'hidden'}>
        <CodeArea value={html} onChange={onHtml} areaRef={htmlRef} onSelection={(a, b) => { sel.current.html = [a, b]; }} errorLines={part === 'html' ? errorLines : new Set()} label="Template HTML" placeholder={'<h1>{{org.name}}</h1>\n<p>{{employee.name}} — {{period.label}}</p>'} />
      </div>
      <div className={part === 'css' ? '' : 'hidden'}>
        <CodeArea value={css} onChange={onCss} areaRef={cssRef} onSelection={(a, b) => { sel.current.css = [a, b]; }} errorLines={part === 'css' ? errorLines : new Set()} label="Template CSS" placeholder={'.net { color: {{brand.primaryColor}}; }'} />
      </div>

      {issues.length > 0 && (
        <div role="alert" className="rounded-lg border border-danger/25 bg-danger-soft p-2.5">
          <div className="flex items-center gap-1.5 text-xs font-medium text-danger mb-1"><AlertTriangle size={13} />{issues.length === 1 ? '1 problem' : `${issues.length} problems`} — fix before saving</div>
          <ul className="space-y-0.5">
            {issues.slice(0, 12).map((i, n) => (
              <li key={n}>
                <button type="button" onClick={() => goToLine(i)} className="text-left text-[12px] text-fg hover:underline">
                  <span className="font-mono text-fg-subtle mr-1.5">{i.message.startsWith('CSS: ') ? 'CSS ' : ''}line {i.line}</span>{i.message.replace(/^CSS: /, '')}
                </button>
              </li>
            ))}
            {issues.length > 12 && <li className="text-[11px] text-fg-subtle">…and {issues.length - 12} more</li>}
          </ul>
        </div>
      )}
      {removed.length > 0 && (
        <Alert tone="warning" icon={<ShieldAlert size={14} />} title="Removed for safety when saved">
          <span className="text-[12px]">{removed.slice(0, 8).join(' · ')}{removed.length > 8 ? ` · +${removed.length - 8} more` : ''}. Scripts, event handlers, forms, embedded frames and images or styles from other websites are not allowed — use data: images or the Logo / Signature fields.</span>
        </Alert>
      )}

      <PlaceholderPanel placeholders={info.placeholders} onInsert={insert} />
      <p className="text-[11px] text-fg-subtle leading-relaxed">
        Values are always escaped. Loops: <code className="font-mono">{'{{#each earnings}}…{{/each}}'}</code> (with <code className="font-mono">{'{{else}}'}</code> for “none”), conditions: <code className="font-mono">{'{{#if loans}}…{{/if}}'}</code> / <code className="font-mono">{'{{#unless …}}'}</code>. Images: <code className="font-mono">{'<img src="{{org.logo}}">'}</code> or a data: URI. Fields switched off in the Fields tab print blank.
      </p>
    </div>
  );
}
