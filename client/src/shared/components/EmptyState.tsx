import { Button } from './Button';

interface EmptyStateProps {
  icon: React.ReactNode;
  title: string;
  description: string;
  action?: { label: string; onClick: () => void };
}

export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-20 px-4 gap-5 text-center">
      <div
        className="w-16 h-16 flex items-center justify-center text-gray-300 bg-gray-50 border border-gray-100"
        style={{ borderRadius: 'var(--ui-card-radius, 16px)' }}
      >
        <span className="[&>svg]:w-7 [&>svg]:h-7">{icon}</span>
      </div>
      <div className="max-w-[260px]">
        <p className="font-semibold text-gray-800 text-[14px] tracking-tight">{title}</p>
        <p className="text-[13px] text-gray-400 mt-1.5 leading-relaxed">{description}</p>
      </div>
      {action && (
        <Button size="sm" onClick={action.onClick}>{action.label}</Button>
      )}
    </div>
  );
}
