'use client';

/**
 * UI primitives.
 *
 * A small, deliberate set rather than a component library. Everything here is
 * used at least three times; anything used once lives with its feature. The
 * styling comes from the `.btn` / `.card` / `.input` component classes in
 * globals.css, so visual changes happen in one file.
 */
import { clsx } from 'clsx';
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { forwardRef, useEffect, useId, useRef } from 'react';

/* -------------------------------------------------------------------------- */
/* Button                                                                     */
/* -------------------------------------------------------------------------- */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  loading?: boolean;
  icon?: ReactNode;
}

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: 'btn-primary',
  secondary: 'btn-secondary',
  ghost: 'btn-ghost',
  danger: 'btn-danger',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', loading = false, icon, children, className, disabled, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      className={clsx(VARIANT_CLASS[variant], className)}
      disabled={disabled || loading}
      // Announce the busy state to assistive tech, not just visually.
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? <Spinner className="h-4 w-4" /> : icon}
      {children}
    </button>
  );
});

export const Spinner = ({ className }: { className?: string }) => (
  <svg className={clsx('animate-spin', className)} viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <circle className="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
    <path
      className="opacity-90"
      fill="currentColor"
      d="M12 2a10 10 0 0 1 10 10h-3a7 7 0 0 0-7-7V2Z"
    />
  </svg>
);

/* -------------------------------------------------------------------------- */
/* Form fields                                                                */
/* -------------------------------------------------------------------------- */

interface FieldProps {
  label?: string;
  hint?: string;
  error?: string | string[] | undefined;
  required?: boolean;
  children: (id: string, describedBy: string | undefined) => ReactNode;
}

/**
 * Wires up label/description/error associations properly: `htmlFor`,
 * `aria-describedby` and `aria-invalid`. Doing this by hand at each call site
 * is where accessibility quietly rots.
 */
export const Field = ({ label, hint, error, required, children }: FieldProps) => {
  const id = useId();
  const message = Array.isArray(error) ? error[0] : error;
  const describedBy = message ? `${id}-error` : hint ? `${id}-hint` : undefined;

  return (
    <div>
      {label && (
        <label className="label" htmlFor={id}>
          {label}
          {required && <span className="ml-0.5 text-danger" aria-hidden="true">*</span>}
        </label>
      )}
      {children(id, describedBy)}
      {message ? (
        <p id={`${id}-error`} className="mt-1.5 text-xs text-danger" role="alert">
          {message}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="mt-1.5 text-xs text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
};

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>(
  function Input({ className, invalid, ...props }, ref) {
    return (
      <input
        ref={ref}
        className={clsx('input', invalid && 'border-danger focus:border-danger focus:ring-danger/25', className)}
        aria-invalid={invalid || undefined}
        {...props}
      />
    );
  },
);

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...props }, ref) {
    return <textarea ref={ref} className={clsx('input resize-y', className)} {...props} />;
  },
);

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, children, ...props }, ref) {
    return (
      <select ref={ref} className={clsx('input cursor-pointer appearance-none pr-8', className)} {...props}>
        {children}
      </select>
    );
  },
);

/* -------------------------------------------------------------------------- */
/* Display                                                                    */
/* -------------------------------------------------------------------------- */

export const Badge = ({ className, children }: { className?: string; children: ReactNode }) => (
  <span className={clsx('badge', className)}>{children}</span>
);

export const Card = ({ className, children }: { className?: string; children: ReactNode }) => (
  <div className={clsx('card', className)}>{children}</div>
);

export const Skeleton = ({ className }: { className?: string }) => (
  <div className={clsx('skeleton', className)} aria-hidden="true" />
);

/**
 * Empty state. Always offers the next action — a dead end with no way forward
 * is the most common UX failure in data-heavy apps.
 */
export const EmptyState = ({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  icon?: ReactNode;
}) => (
  <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
    {icon && <div className="mb-4 text-muted">{icon}</div>}
    <h3 className="text-base font-semibold text-fg">{title}</h3>
    {description && <p className="mt-1.5 max-w-sm text-sm text-muted">{description}</p>}
    {action && <div className="mt-5">{action}</div>}
  </div>
);

export const ErrorState = ({ message, onRetry }: { message: string; onRetry?: () => void }) => (
  <div className="flex flex-col items-center justify-center px-6 py-12 text-center" role="alert">
    <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-danger/10 text-danger">
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M12 9v4m0 4h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
      </svg>
    </div>
    <p className="text-sm font-medium text-fg">Something went wrong</p>
    <p className="mt-1 max-w-md text-sm text-muted">{message}</p>
    {onRetry && (
      <Button variant="secondary" className="mt-4" onClick={onRetry}>
        Try again
      </Button>
    )}
  </div>
);

/* -------------------------------------------------------------------------- */
/* Modal                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Built on <dialog>, which gives focus trapping, Escape-to-close and inertness
 * of the background for free — all things hand-rolled modals routinely get
 * wrong.
 */
export const Modal = ({
  open,
  onClose,
  title,
  description,
  children,
  size = 'md',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  size?: 'sm' | 'md' | 'lg';
}) => {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const width = { sm: 'max-w-md', md: 'max-w-2xl', lg: 'max-w-4xl' }[size];

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      // Clicking the backdrop closes; clicking the panel does not.
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
      className={clsx(
        'w-[calc(100vw-2rem)] rounded-xl border border-border bg-surface p-0 text-fg shadow-pop backdrop:bg-black/50',
        width,
      )}
    >
      <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
        <div>
          <h2 className="text-base font-semibold">{title}</h2>
          {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="-m-1 rounded-md p-1 text-muted hover:bg-surface-2 hover:text-fg"
          aria-label="Close dialog"
        >
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
      <div className="max-h-[70vh] overflow-y-auto scroll-thin px-5 py-4">{children}</div>
    </dialog>
  );
};

/* -------------------------------------------------------------------------- */
/* Feedback                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Inline banner used for AI provenance ("this is a fallback, not the model")
 * and for non-blocking warnings.
 */
export const Banner = ({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'warning' | 'danger' | 'success';
  children: ReactNode;
}) => {
  const tones = {
    info: 'bg-info/10 text-info border-info/20',
    warning: 'bg-warning/10 text-warning border-warning/20',
    danger: 'bg-danger/10 text-danger border-danger/20',
    success: 'bg-success/10 text-success border-success/20',
  };
  return (
    <div className={clsx('flex items-start gap-2 rounded-lg border px-3 py-2 text-xs', tones[tone])} role="status">
      {children}
    </div>
  );
};

export const ProgressBar = ({ value, className }: { value: number; className?: string }) => (
  <div
    className={clsx('h-2 w-full overflow-hidden rounded-full bg-surface-2', className)}
    role="progressbar"
    aria-valuenow={Math.round(value)}
    aria-valuemin={0}
    aria-valuemax={100}
  >
    <div
      className="h-full rounded-full bg-brand transition-[width] duration-500 ease-out"
      style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
    />
  </div>
);
