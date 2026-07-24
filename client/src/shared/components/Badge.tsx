type Variant = 'gray' | 'blue' | 'green' | 'yellow' | 'red' | 'purple' | 'orange' | 'indigo' | 'teal';

const styles: Record<Variant, string> = {
  gray:   'bg-gray-100   text-gray-600   ring-gray-200/80',
  blue:   'bg-blue-50    text-blue-700   ring-blue-200/80',
  green:  'bg-emerald-50 text-emerald-700 ring-emerald-200/80',
  yellow: 'bg-amber-50   text-amber-700  ring-amber-200/80',
  red:    'bg-red-50     text-red-700    ring-red-200/80',
  purple: 'bg-violet-50  text-violet-700 ring-violet-200/80',
  orange: 'bg-orange-50  text-orange-700 ring-orange-200/80',
  indigo: 'bg-indigo-50  text-indigo-700 ring-indigo-200/80',
  teal:   'bg-teal-50    text-teal-700   ring-teal-200/80',
};

const dots: Record<Variant, string> = {
  gray:   'bg-gray-400',
  blue:   'bg-blue-500',
  green:  'bg-emerald-500',
  yellow: 'bg-amber-500',
  red:    'bg-red-500',
  purple: 'bg-violet-500',
  orange: 'bg-orange-500',
  indigo: 'bg-indigo-500',
  teal:   'bg-teal-500',
};

interface BadgeProps {
  children: React.ReactNode;
  variant?: Variant;
  dot?: boolean;
  className?: string;
}

export function Badge({ children, variant = 'gray', dot = false, className = '' }: BadgeProps) {
  return (
    <span
      className={`badge inline-flex items-center gap-1.5 px-2 py-0.5 text-[11.5px] font-medium ring-1 ring-inset ${styles[variant]} ${className}`}
      style={{ borderRadius: 'var(--ui-badge-radius, 9999px)' }}
    >
      {dot && (
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dots[variant]}`} />
      )}
      {children}
    </span>
  );
}

// Semantic helpers
export const leadStatusVariant: Record<string, Variant> = {
  NEW: 'blue', CONTACTED: 'yellow', QUALIFIED: 'green', UNQUALIFIED: 'red', CONVERTED: 'purple',
};
export const dealStatusVariant: Record<string, Variant> = {
  OPEN: 'blue', WON: 'green', LOST: 'red',
};
export const ticketStatusVariant: Record<string, Variant> = {
  OPEN: 'blue', IN_PROGRESS: 'yellow', PENDING: 'orange', RESOLVED: 'green', CLOSED: 'gray',
};
export const priorityVariant: Record<string, Variant> = {
  LOW: 'gray', MEDIUM: 'blue', HIGH: 'orange', CRITICAL: 'red',
};
export const articleStatusVariant: Record<string, Variant> = {
  DRAFT: 'gray', PUBLISHED: 'green', ARCHIVED: 'yellow',
};
