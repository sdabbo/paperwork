// Shared UI primitives. Screens compose these instead of styling buttons, cards and dialogs ad hoc,
// so the app looks and behaves consistently. Colors come from the tokens in index.css.
import React, { useEffect, useId, useRef } from 'react';
import { Check, X, Loader2 } from 'lucide-react';

function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ');
}
export { cx };

// ---------- Button ----------

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'accent';
type ButtonSize = 'sm' | 'md';

const buttonVariants: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-primary-fg hover:bg-primary-hover',
  secondary: 'bg-surface text-ink border border-line hover:bg-surface-2 hover:border-line-strong',
  ghost: 'text-ink-2 hover:text-ink hover:bg-surface-2',
  danger: 'bg-surface text-danger border border-line hover:border-danger/40 hover:bg-danger/5',
  accent: 'bg-accent text-white hover:brightness-95 dark:text-canvas',
};

const buttonSizes: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-[13px] gap-1.5 rounded-lg',
  md: 'h-9 px-3.5 text-sm gap-2 rounded-lg',
};

// A label that may run onto a second line on a narrow screen (e.g. one naming a folder)
const wrappingSizes: Record<ButtonSize, string> = {
  sm: 'min-h-8 py-1 px-3 text-[13px] gap-1.5 rounded-lg',
  md: 'min-h-9 py-1.5 px-3.5 text-sm gap-2 rounded-lg',
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: React.ReactNode;
  loading?: boolean;
  wrap?: boolean;
}

export const Button: React.FC<ButtonProps> = ({
  variant = 'secondary',
  size = 'md',
  icon,
  loading,
  wrap,
  disabled,
  className,
  children,
  type = 'button',
  ...rest
}) => (
  <button
    type={type}
    disabled={disabled || loading}
    className={cx(
      'inline-flex items-center justify-center font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none',
      wrap ? 'text-left leading-snug [&>svg]:shrink-0' : 'whitespace-nowrap',
      buttonVariants[variant],
      wrap ? wrappingSizes[size] : buttonSizes[size],
      className
    )}
    {...rest}
  >
    {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : icon}
    {children}
  </button>
);

export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  size?: ButtonSize;
}

export const IconButton: React.FC<IconButtonProps> = ({ label, size = 'md', className, children, type = 'button', ...rest }) => (
  <button
    type={type}
    aria-label={label}
    title={label}
    className={cx(
      'inline-flex items-center justify-center rounded-lg text-ink-2 hover:text-ink hover:bg-surface-2 transition-colors disabled:opacity-50 disabled:pointer-events-none',
      size === 'sm' ? 'w-8 h-8' : 'w-9 h-9',
      className
    )}
    {...rest}
  >
    {children}
  </button>
);

// ---------- Surfaces ----------

export const Card: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({ className, ...rest }) => (
  <div className={cx('bg-surface border border-line rounded-xl', className)} {...rest} />
);

type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

const badgeTones: Record<BadgeTone, string> = {
  neutral: 'bg-surface-2 text-ink-2',
  accent: 'bg-accent-soft text-accent-ink',
  success: 'bg-success/12 text-success',
  warning: 'bg-warning/12 text-warning',
  danger: 'bg-danger/12 text-danger',
};

export const Badge: React.FC<{ tone?: BadgeTone; className?: string; children: React.ReactNode }> = ({
  tone = 'neutral',
  className,
  children,
}) => (
  <span className={cx('inline-flex items-center gap-1 px-2 h-5 rounded-md text-xs font-medium whitespace-nowrap', badgeTones[tone], className)}>
    {children}
  </span>
);

export const PageHeader: React.FC<{ title: string; description?: React.ReactNode; actions?: React.ReactNode }> = ({
  title,
  description,
  actions,
}) => (
  <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3 mb-6">
    <div className="min-w-0">
      <h1 className="text-2xl font-semibold tracking-tight text-ink">{title}</h1>
      {description && <p className="text-sm text-ink-2 mt-1">{description}</p>}
    </div>
    {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
  </div>
);

export const SectionTitle: React.FC<{ children: React.ReactNode; aside?: React.ReactNode; className?: string }> = ({
  children,
  aside,
  className,
}) => (
  <div className={cx('flex items-center justify-between gap-3 mb-3', className)}>
    <h2 className="text-[15px] font-semibold text-ink">{children}</h2>
    {aside && <div className="text-sm text-ink-2">{aside}</div>}
  </div>
);

export const EmptyState: React.FC<{
  icon?: React.ReactNode;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}> = ({ icon, title, description, action, className }) => (
  <div className={cx('flex flex-col items-center text-center px-6 py-12', className)}>
    {icon && <div className="w-10 h-10 rounded-full bg-surface-2 text-ink-2 flex items-center justify-center mb-3">{icon}</div>}
    <h3 className="text-[15px] font-semibold text-ink">{title}</h3>
    {description && <p className="text-sm text-ink-2 mt-1 max-w-sm">{description}</p>}
    {action && <div className="mt-4">{action}</div>}
  </div>
);

export const Stat: React.FC<{ label: string; value: React.ReactNode; hint?: React.ReactNode; className?: string }> = ({
  label,
  value,
  hint,
  className,
}) => (
  <div className={className}>
    <div className="text-xs text-ink-3">{label}</div>
    <div className="text-[15px] font-semibold text-ink tabular-nums mt-0.5">{value}</div>
    {hint && <div className="text-xs text-ink-3 mt-0.5">{hint}</div>}
  </div>
);

export const Spinner: React.FC<{ className?: string }> = ({ className }) => (
  <Loader2 className={cx('w-4 h-4 animate-spin text-ink-3', className)} />
);

// ---------- Segmented control ----------

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: { value: T; label: React.ReactNode }[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
}) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className="inline-flex p-0.5 rounded-lg bg-surface-2 border border-line">
      {options.map(opt => (
        <button
          key={opt.value}
          type="button"
          role="radio"
          aria-checked={value === opt.value}
          onClick={() => onChange(opt.value)}
          className={cx(
            'h-7 px-3 rounded-md text-[13px] font-medium transition-colors',
            value === opt.value ? 'bg-surface text-ink shadow-sm' : 'text-ink-2 hover:text-ink'
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

// ---------- Forms ----------

export const inputClass =
  'w-full h-9 px-3 rounded-lg bg-surface border border-line text-sm text-ink placeholder:text-ink-3 ' +
  'hover:border-line-strong focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20 transition-colors';

export const textareaClass = inputClass.replace('h-9', 'min-h-20 py-2');

export const Field: React.FC<{ label: string; hint?: string; children: React.ReactElement; className?: string }> = ({
  label,
  hint,
  children,
  className,
}) => {
  const id = useId();
  return (
    <div className={className}>
      <label htmlFor={id} className="block text-[13px] font-medium text-ink mb-1.5">
        {label}
      </label>
      {React.cloneElement(children as React.ReactElement<{ id?: string }>, { id })}
      {hint && <p className="text-xs text-ink-3 mt-1">{hint}</p>}
    </div>
  );
};

// ---------- Modal ----------

export const Modal: React.FC<{
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  size?: 'sm' | 'md' | 'lg';
}> = ({ open, onClose, title, description, children, footer, size = 'md' }) => {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // Kept in a ref so a new onClose function on each render doesn't re-run the focus handling below
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCloseRef.current();
    window.addEventListener('keydown', onKey);
    const previouslyFocused = document.activeElement as HTMLElement | null;
    // Focus the element marked data-autofocus (e.g. a form's first field), otherwise the dialog itself
    const target = dialogRef.current?.querySelector<HTMLElement>('[data-autofocus]') ?? dialogRef.current;
    target?.focus();
    return () => {
      window.removeEventListener('keydown', onKey);
      previouslyFocused?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4 bg-black/40" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={e => e.stopPropagation()}
        className={cx(
          'w-full bg-surface border border-line shadow-xl flex flex-col max-h-[92vh] rounded-t-2xl sm:rounded-2xl focus:outline-none',
          size === 'sm' ? 'sm:max-w-md' : size === 'lg' ? 'sm:max-w-2xl' : 'sm:max-w-lg'
        )}
      >
        <div className="flex items-start justify-between gap-4 px-5 pt-5 pb-3">
          <div className="min-w-0">
            <h2 id={titleId} className="text-lg font-semibold text-ink leading-snug">
              {title}
            </h2>
            {description && <div className="text-sm text-ink-2 mt-1">{description}</div>}
          </div>
          <IconButton label="Close" size="sm" onClick={onClose} className="-mr-1.5 -mt-1">
            <X className="w-4 h-4" />
          </IconButton>
        </div>
        <div className="px-5 pb-5 overflow-y-auto">{children}</div>
        {footer && (
          <div className="flex flex-wrap items-center justify-end gap-2 px-5 py-3.5 border-t border-line bg-surface-2/50 rounded-b-2xl">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
};

// ---------- Paperwork additions ----------


// A native select, styled like the inputs (native keeps it fast and accessible on phones)
export const Select: React.FC<React.SelectHTMLAttributes<HTMLSelectElement>> = ({ className, children, ...rest }) => (
  <div className={cx('relative', className)}>
    <select className={cx(inputClass, 'appearance-none pr-8')} {...rest}>
      {children}
    </select>
    <svg aria-hidden viewBox="0 0 20 20" className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-3">
      <path d="M5.5 8l4.5 4.5L14.5 8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  </div>
);

// A filter chip: a toggle, or a small select that looks like one
export const Chip: React.FC<{
  active?: boolean;
  onClick?: () => void;
  icon?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  title?: string;
}> = ({ active, onClick, icon, children, className, title }) => (
  <button
    type="button"
    aria-pressed={active}
    title={title}
    onClick={onClick}
    className={cx(
      'inline-flex items-center gap-1.5 h-8 px-3 rounded-full border text-[13px] font-medium whitespace-nowrap transition-colors',
      active ? 'bg-accent-soft border-accent/40 text-accent-ink' : 'bg-surface border-line text-ink-2 hover:text-ink hover:border-line-strong',
      className
    )}
  >
    {icon}
    {children}
  </button>
);

export function ChipSelect<T extends string>({
  label,
  value,
  options,
  onChange,
  icon,
}: {
  label: string;
  value: T | undefined;
  options: { value: T; label: string; count?: number }[];
  onChange: (value: T | undefined) => void;
  icon?: React.ReactNode;
}) {
  const current = options.find(o => o.value === value);
  return (
    <label
      className={cx(
        'relative inline-flex items-center gap-1.5 h-8 pl-3 pr-7 rounded-full border text-[13px] font-medium whitespace-nowrap transition-colors cursor-pointer',
        value ? 'bg-accent-soft border-accent/40 text-accent-ink' : 'bg-surface border-line text-ink-2 hover:text-ink hover:border-line-strong'
      )}
    >
      {icon}
      <span className="max-w-[11rem] truncate">{current ? current.label : label}</span>
      <svg aria-hidden viewBox="0 0 20 20" className="pointer-events-none absolute right-2 w-3.5 h-3.5">
        <path d="M5.5 8l4.5 4.5L14.5 8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <select
        aria-label={label}
        className="absolute inset-0 opacity-0 cursor-pointer"
        value={value ?? ''}
        onChange={e => onChange((e.target.value || undefined) as T | undefined)}
      >
        <option value="">{`Any ${label.toLowerCase()}`}</option>
        {options.map(o => (
          <option key={o.value} value={o.value}>
            {o.label}
            {o.count !== undefined ? ` (${o.count})` : ''}
          </option>
        ))}
      </select>
    </label>
  );
}

export const Notice: React.FC<{ tone?: 'warning' | 'danger' | 'accent' | 'neutral'; icon?: React.ReactNode; children: React.ReactNode; action?: React.ReactNode; className?: string }> = ({
  tone = 'neutral',
  icon,
  children,
  action,
  className,
}) => (
  <div
    className={cx(
      'flex items-start gap-3 rounded-xl border px-4 py-3 text-sm',
      tone === 'warning' && 'border-warning/30 bg-warning/8 text-ink',
      tone === 'danger' && 'border-danger/30 bg-danger/8 text-ink',
      tone === 'accent' && 'border-accent/30 bg-accent-soft text-ink',
      tone === 'neutral' && 'border-line bg-surface text-ink',
      className
    )}
  >
    {icon && <div className={cx('mt-0.5 shrink-0', tone === 'warning' && 'text-warning', tone === 'danger' && 'text-danger', tone === 'accent' && 'text-accent')}>{icon}</div>}
    <div className="min-w-0 flex-1">{children}</div>
    {action && <div className="shrink-0">{action}</div>}
  </div>
);

// A link that looks like a Button (a <button> inside an <a> is invalid HTML)
export const LinkButton: React.FC<React.AnchorHTMLAttributes<HTMLAnchorElement> & { variant?: ButtonVariant; size?: ButtonSize; icon?: React.ReactNode }> = ({
  variant = 'secondary',
  size = 'md',
  icon,
  className,
  children,
  ...rest
}) => (
  <a
    className={cx('inline-flex items-center justify-center font-medium whitespace-nowrap transition-colors', buttonVariants[variant], buttonSizes[size], className)}
    {...rest}
  >
    {icon}
    {children}
  </a>
);

// A round checkbox for ticking something off, with a touch target larger than the circle it draws
export const CheckToggle: React.FC<{ checked: boolean; onChange: (checked: boolean) => void; label: string; disabled?: boolean; className?: string }> = ({
  checked,
  onChange,
  label,
  disabled,
  className,
}) => (
  <button
    type="button"
    role="checkbox"
    aria-checked={checked}
    aria-label={label}
    title={label}
    disabled={disabled}
    onClick={() => onChange(!checked)}
    className={cx(
      'relative shrink-0 inline-flex items-center justify-center w-5 h-5 rounded-full border-[1.5px] transition-colors disabled:opacity-50',
      'before:absolute before:-inset-2.5',
      checked ? 'bg-success border-success text-white dark:text-canvas' : 'border-line-strong text-transparent hover:border-success hover:text-success',
      className
    )}
  >
    <Check className="w-3 h-3" strokeWidth={3.5} />
  </button>
);
