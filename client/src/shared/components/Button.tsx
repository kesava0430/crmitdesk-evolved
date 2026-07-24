import { Loader2 } from 'lucide-react';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost' | 'outline';
  size?: 'xs' | 'sm' | 'md' | 'lg';
  loading?: boolean;
  icon?: React.ReactNode;
  iconRight?: React.ReactNode;
}

const base =
  'inline-flex items-center justify-center font-medium transition-all duration-150 ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 ' +
  'disabled:opacity-50 disabled:cursor-not-allowed select-none';

const variants: Record<string, string> = {
  primary:
    'bg-brand-600 text-white shadow-sm ' +
    'hover:bg-brand-700 active:bg-brand-800 active:scale-[0.98] ' +
    'focus-visible:ring-brand-400',
  secondary:
    'bg-white text-gray-700 border border-gray-200 shadow-sm ' +
    'hover:bg-gray-50 hover:border-gray-300 active:bg-gray-100 active:scale-[0.98] ' +
    'focus-visible:ring-gray-300',
  danger:
    'bg-red-600 text-white shadow-sm ' +
    'hover:bg-red-700 active:bg-red-800 active:scale-[0.98] ' +
    'focus-visible:ring-red-400',
  ghost:
    'text-gray-600 ' +
    'hover:bg-gray-100 active:bg-gray-200 active:scale-[0.98] ' +
    'focus-visible:ring-gray-300',
  outline:
    'border border-brand-300 text-brand-700 ' +
    'hover:bg-brand-50 active:bg-brand-100 active:scale-[0.98] ' +
    'focus-visible:ring-brand-400',
};

const sizes: Record<string, string> = {
  xs: 'px-2.5 py-1   text-[11.5px] gap-1   h-[26px]',
  sm: 'px-3   py-1.5 text-[12.5px] gap-1.5 h-[30px]',
  md: 'px-4   py-2   text-[13.5px] gap-2   h-[34px]',
  lg: 'px-5   py-2.5 text-sm       gap-2   h-[38px]',
};

export function Button({
  variant = 'primary',
  size = 'md',
  loading,
  icon,
  iconRight,
  children,
  disabled,
  className = '',
  style,
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      disabled={disabled || loading}
      style={{
        borderRadius: 'var(--ui-btn-radius, 8px)',
        ...style,
      }}
      className={`${base} ${variants[variant]} ${sizes[size]} ${className}`}
    >
      {loading
        ? <Loader2 size={13} className="animate-spin shrink-0" />
        : icon && <span className="shrink-0">{icon}</span>
      }
      {children}
      {iconRight && !loading && <span className="shrink-0">{iconRight}</span>}
    </button>
  );
}
