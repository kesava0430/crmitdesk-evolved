import { Sparkles } from 'lucide-react';

interface AIConfidenceBadgeProps {
  score?: number;        // 0-100
  label?: string;        // override text
  size?: 'sm' | 'md';
  className?: string;
}

export function AIConfidenceBadge({ score, label, size = 'sm', className = '' }: AIConfidenceBadgeProps) {
  const pct = score ?? 0;
  const color = pct >= 80 ? 'text-green-600 bg-green-50 border-green-200 dark:text-green-300 dark:bg-green-500/10 dark:border-green-800/50'
    : pct >= 60 ? 'text-yellow-600 bg-yellow-50 border-yellow-200 dark:text-yellow-300 dark:bg-yellow-500/10 dark:border-yellow-800/50'
    : 'text-red-500 bg-red-50 border-red-200 dark:text-red-300 dark:bg-red-500/10 dark:border-red-800/50';
  const text = label ?? (pct >= 80 ? 'High confidence' : pct >= 60 ? 'Medium confidence' : 'Low confidence');
  const sizeClass = size === 'sm' ? 'text-xs px-1.5 py-0.5' : 'text-sm px-2 py-1';

  return (
    <span className={`inline-flex items-center gap-1 rounded-full border font-medium ${color} ${sizeClass} ${className}`}>
      <Sparkles size={size === 'sm' ? 10 : 12} />
      {text}
      {score !== undefined && <span className="opacity-70">({score}%)</span>}
    </span>
  );
}

interface AIRiskBadgeProps {
  risk: 'LOW' | 'MEDIUM' | 'HIGH';
  label?: string;
  className?: string;
}

export function AIRiskBadge({ risk, label, className = '' }: AIRiskBadgeProps) {
  const styles = {
    LOW: 'text-green-600 bg-green-50 border-green-200 dark:text-green-300 dark:bg-green-500/10 dark:border-green-800/50',
    MEDIUM: 'text-yellow-600 bg-yellow-50 border-yellow-200 dark:text-yellow-300 dark:bg-yellow-500/10 dark:border-yellow-800/50',
    HIGH: 'text-red-600 bg-red-50 border-red-200 dark:text-red-300 dark:bg-red-500/10 dark:border-red-800/50',
  };
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border text-xs font-medium px-2 py-0.5 ${styles[risk]} ${className}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${risk === 'LOW' ? 'bg-green-500' : risk === 'MEDIUM' ? 'bg-yellow-500' : 'bg-red-500'}`} />
      {label ?? `${risk} Risk`}
    </span>
  );
}
