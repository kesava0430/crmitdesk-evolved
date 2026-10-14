/**
 * Card — the single panel primitive.
 *
 * The audit found ~60 hand-rolled card wrappers across the app in at least
 * eight spellings of the same visual ("bg-white dark:bg-gray-900 rounded-xl
 * border border-gray-100 dark:border-gray-800 shadow-sm p-5" and friends,
 * plus variants that differ only in token order or in gray-100 vs gray-200).
 * Everything panel-shaped should come through here.
 *
 * Colours are semantic tokens, so there are no `dark:` variants to forget and
 * radius/padding follow the active theme.
 */

type Padding = 'none' | 'sm' | 'md' | 'lg';
type Tone = 'default' | 'sunken' | 'raised';

const paddings: Record<Padding, string> = {
  none: '',
  sm: 'p-3.5',
  md: 'p-card',
  lg: 'p-card sm:p-7',
};

const tones: Record<Tone, string> = {
  default: 'bg-surface border-line',
  sunken: 'bg-surface-sunken border-line-subtle',
  raised: 'bg-surface-raised border-line shadow-ui-md',
};

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  padding?: Padding;
  tone?: Tone;
  /** Lift and deepen the shadow on hover. Use for cards that are links. */
  interactive?: boolean;
  /** Drop the shadow entirely — for cards nested inside another surface. */
  flat?: boolean;
}

export function Card({
  padding = 'md',
  tone = 'default',
  interactive = false,
  flat = false,
  className = '',
  children,
  ...props
}: CardProps) {
  return (
    <div
      {...props}
      className={[
        'rounded-card border',
        tones[tone],
        paddings[padding],
        flat ? '' : tone === 'raised' ? '' : 'shadow-ui-sm',
        interactive ? 'card-hover cursor-pointer' : '',
        className,
      ].filter(Boolean).join(' ')}
    >
      {children}
    </div>
  );
}

/**
 * Header strip inside a Card — title on the left, actions on the right.
 *
 * Wraps instead of squeezing: the title block has a ~16rem flex-basis, so
 * when title + actions don't fit side by side (phones, or a long action
 * row) the actions drop onto their own line below the title and the
 * description keeps the full width. Small actions (an icon button) still
 * sit beside the title. Desktop layout is unchanged.
 */
export function CardHeader({
  title,
  subtitle,
  icon,
  actions,
  className = '',
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  icon?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex flex-wrap items-start justify-between gap-x-3 gap-y-2.5 ${className}`}>
      <div className="flex items-start gap-2.5 min-w-0 grow basis-[16rem]">
        {icon && <span className="shrink-0 text-fg-muted mt-0.5">{icon}</span>}
        <div className="min-w-0">
          <h3 className="text-[13.5px] font-semibold text-fg tracking-tight break-words sm:truncate">{title}</h3>
          {subtitle && <p className="text-[12px] text-fg-muted mt-0.5 leading-relaxed">{subtitle}</p>}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2 max-w-full sm:shrink-0">{actions}</div>}
    </div>
  );
}

/**
 * A labelled metric. Replaces the `bg-gray-50 dark:bg-gray-800 rounded-xl p-3`
 * tile and the `bg-white … p-3.5` stat card, which were the same idea written
 * two ways in nine files.
 */
export function StatTile({
  label,
  value,
  icon,
  hint,
  tone = 'default',
  onClick,
  className = '',
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  icon?: React.ReactNode;
  hint?: React.ReactNode;
  tone?: Tone;
  onClick?: () => void;
  className?: string;
}) {
  const body = (
    <>
      {icon && (
        <div className="shrink-0 w-8 h-8 sm:w-9 sm:h-9 rounded-card bg-accent-soft text-accent-soft-fg flex items-center justify-center">
          {icon}
        </div>
      )}
      {/* Labels wrap to two lines and values wrap rather than truncate: a
          clipped "$294,…" or "OPEN DEA…" is worse than a taller tile. */}
      <div className="min-w-0 w-full sm:w-auto">
        <p className="text-[10.5px] sm:text-[11px] font-semibold uppercase tracking-wider text-fg-subtle leading-snug line-clamp-2 break-words">
          {label}
        </p>
        <p className="text-[17px] sm:text-[19px] font-semibold text-fg leading-tight tracking-tight mt-1 tabular-nums [overflow-wrap:anywhere]">
          {value}
        </p>
        {hint && <p className="text-[11.5px] text-fg-muted mt-0.5 truncate">{hint}</p>}
      </div>
    </>
  );

  return (
    <Card
      padding="sm"
      tone={tone}
      interactive={!!onClick}
      onClick={onClick}
      className={`flex ${icon ? 'flex-col items-start sm:flex-row sm:items-center' : 'items-center'} gap-2 sm:gap-3 ${className}`}
    >
      {body}
    </Card>
  );
}

/**
 * A section divider with a title, for grouping content inside a Card.
 * Replaces the repeated `border-t border-gray-100 dark:border-gray-800 pt-4`
 * + `text-sm font-medium …` pairing.
 */
export function CardSection({
  title,
  icon,
  actions,
  children,
  className = '',
}: {
  title?: React.ReactNode;
  icon?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`border-t border-line-subtle pt-4 mt-4 first:border-0 first:pt-0 first:mt-0 ${className}`}>
      {title && (
        <div className="flex flex-wrap items-center justify-between gap-2 mb-2.5">
          <h4 className="text-[12.5px] font-semibold text-fg flex items-center gap-1.5">
            {icon}
            {title}
          </h4>
          {actions}
        </div>
      )}
      {children}
    </div>
  );
}
