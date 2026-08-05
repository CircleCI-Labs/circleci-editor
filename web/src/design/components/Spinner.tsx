interface SpinnerProps {
  size?: number;
  className?: string;
  label?: string;
}

/** A small accessible loading spinner. */
export function Spinner({
  size = 16,
  className = '',
  label = 'Loading',
}: SpinnerProps) {
  return (
    <span
      role="status"
      aria-label={label}
      className={`inline-block animate-spin rounded-full border-2 border-cc-border-strong border-t-cc-accent ${className}`}
      style={{ width: size, height: size }}
    >
      <span className="sr-only">{label}</span>
    </span>
  );
}
