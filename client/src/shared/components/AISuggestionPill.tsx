import { Sparkles, Check } from 'lucide-react';
import { useState } from 'react';

interface AISuggestionPillProps {
  suggestion: string;
  onApply: (value: string) => void;
  className?: string;
}

export function AISuggestionPill({ suggestion, onApply, className = '' }: AISuggestionPillProps) {
  const [applied, setApplied] = useState(false);

  function handleApply() {
    setApplied(true);
    onApply(suggestion);
    setTimeout(() => setApplied(false), 2000);
  }

  return (
    <button
      onClick={handleApply}
      className={`inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full border transition-all
        ${applied
          ? 'bg-green-50 border-green-200 text-green-700 dark:bg-green-500/10 dark:border-green-800/50 dark:text-green-300'
          : 'bg-indigo-50 border-indigo-200 text-indigo-700 hover:bg-indigo-100 hover:shadow-sm active:scale-95 dark:bg-indigo-500/10 dark:border-indigo-800/50 dark:text-indigo-300 dark:hover:bg-indigo-500/20'
        } ${className}`}
    >
      {applied ? <Check size={11} /> : <Sparkles size={11} />}
      <span className="max-w-[200px] truncate">{suggestion}</span>
    </button>
  );
}

interface AISuggestionListProps {
  suggestions: string[];
  onApply: (value: string) => void;
  label?: string;
  className?: string;
}

export function AISuggestionList({ suggestions, onApply, label = 'AI suggestions', className = '' }: AISuggestionListProps) {
  if (!suggestions.length) return null;
  return (
    <div className={`mt-2 ${className}`}>
      <p className="text-xs text-gray-400 dark:text-gray-500 mb-1.5 flex items-center gap-1">
        <Sparkles size={10} className="text-indigo-400 dark:text-indigo-300" /> {label}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {suggestions.map((s, i) => (
          <AISuggestionPill key={i} suggestion={s} onApply={onApply} />
        ))}
      </div>
    </div>
  );
}
