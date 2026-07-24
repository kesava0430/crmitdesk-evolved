interface PageHeaderProps {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  breadcrumb?: string;
}

export function PageHeader({ title, subtitle, actions, breadcrumb }: PageHeaderProps) {
  return (
    <div className="px-6 py-5 border-b border-gray-100/80 bg-white/90 backdrop-blur-sm">
      {breadcrumb && (
        <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-widest mb-1.5">
          {breadcrumb}
        </p>
      )}
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-[18px] font-semibold text-gray-900 leading-tight tracking-tight truncate">
            {title}
          </h1>
          {subtitle && (
            <p className="text-[13px] text-gray-500 mt-0.5 leading-relaxed">{subtitle}</p>
          )}
        </div>
        {actions && (
          <div className="flex items-center gap-2 shrink-0">{actions}</div>
        )}
      </div>
    </div>
  );
}
