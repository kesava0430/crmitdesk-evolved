import { useState, useRef, useEffect, useCallback } from 'react';
import { ChevronDown, Search, Check } from 'lucide-react';

export interface SelectOption {
  value: string;
  label: string;
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  /** Shown when nothing is selected. Also renders as the empty option. */
  placeholder?: string;
  /** aria-label forwarded to the hidden native <select> for Playwright compatibility */
  ariaLabel?: string;
  disabled?: boolean;
  className?: string;
  /** If true, no empty/"clear" option is shown (use for required fields with a guaranteed default) */
  required?: boolean;
}

export function SearchableSelect({
  value,
  onChange,
  options,
  placeholder = '— select —',
  ariaLabel,
  disabled = false,
  className = '',
  required = false,
}: Props) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const selected = options.find(o => o.value === value);

  const filtered = search
    ? options.filter(o => o.label.toLowerCase().includes(search.toLowerCase()))
    : options;

  // Auto-focus search when dropdown opens
  useEffect(() => {
    if (open) {
      const t = setTimeout(() => searchRef.current?.focus(), 30);
      return () => clearTimeout(t);
    } else {
      setSearch('');
    }
  }, [open]);

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  const select = useCallback((val: string) => {
    onChange(val);
    setOpen(false);
    setSearch('');
  }, [onChange]);

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      {/*
        Hidden native <select> — kept for Playwright test compatibility.
        Tests using getByLabel + selectOption() still work via this element.
      */}
      <select
        aria-label={ariaLabel}
        tabIndex={-1}
        value={value}
        onChange={e => onChange(e.target.value)}
        style={{ position: 'absolute', opacity: 0, pointerEvents: 'none', width: '1px', height: '1px', overflow: 'hidden' }}
      >
        {!required && <option value="">{placeholder}</option>}
        {options.map(o => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>

      {/* Trigger */}
      <button
        type="button"
        disabled={disabled}
        onClick={() => !disabled && setOpen(o => !o)}
        className={`ui-input w-full flex items-center justify-between gap-2 text-left ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
      >
        <span className={`truncate ${selected ? 'text-fg' : 'text-fg-subtle'}`}>
          {selected ? selected.label : placeholder}
        </span>
        <ChevronDown
          size={14}
          className={`text-fg-subtle flex-shrink-0 transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {/* Dropdown panel */}
      {open && (
        <div className="absolute z-[200] mt-1 w-full min-w-[180px] ui-popover overflow-hidden">
          {/* Search input */}
          <div className="p-2 border-b border-line-subtle">
            <div className="flex items-center gap-1.5 px-2.5 py-1.5 bg-surface-sunken rounded-lg border border-line-subtle focus-within:border-brand-300 focus-within:ring-2 focus-within:ring-brand-100 dark:focus-within:ring-brand-500/20 transition-all">
              <Search size={12} className="text-fg-subtle flex-shrink-0" />
              <input
                ref={searchRef}
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Type to search…"
                className="text-sm bg-transparent outline-none flex-1 text-fg placeholder:text-fg-subtle min-w-0"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch('')}
                  className="text-fg-subtle hover:text-gray-500 dark:hover:text-gray-400 text-xs leading-none flex-shrink-0"
                >
                  ✕
                </button>
              )}
            </div>
          </div>

          {/* Options list */}
          <div className="max-h-52 overflow-y-auto py-1">
            {/* Empty/clear option */}
            {!required && (
              <button
                type="button"
                onClick={() => select('')}
                className={`w-full text-left px-3 py-2 text-sm flex items-center justify-between hover:bg-surface-hover transition-colors ${!value ? 'text-brand-600 dark:text-brand-400 font-medium bg-brand-50 dark:bg-brand-500/10' : 'text-fg-subtle'}`}
              >
                {placeholder}
                {!value && <Check size={12} className="flex-shrink-0 ml-2" />}
              </button>
            )}

            {/* Filtered options */}
            {filtered.length === 0 ? (
              <p className="px-3 py-3 text-sm text-fg-subtle italic text-center">
                No results for "{search}"
              </p>
            ) : (
              filtered.map(opt => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => select(opt.value)}
                  className={`w-full text-left px-3 py-2 text-sm flex items-center justify-between hover:bg-surface-hover transition-colors ${value === opt.value ? 'text-brand-600 dark:text-brand-400 bg-brand-50 dark:bg-brand-500/10 font-medium' : 'text-fg'}`}
                >
                  <span className="truncate">{opt.label}</span>
                  {value === opt.value && <Check size={12} className="flex-shrink-0 ml-2 text-brand-500" />}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
