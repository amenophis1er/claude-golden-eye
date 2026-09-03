/**
 * The golden-eye mark: an eye inside a dark tile. The tile is what makes it
 * findable at 16px in a crowded browser tab strip — a bare outline disappears
 * there. Hand-written SVG so the same geometry serves the favicon (inlined as
 * a data URI in index.html) and the app; keep the two in sync when editing.
 */
export default function Logo({ size = 22, className = '' }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      className={`shrink-0 ${className}`}
      role="img"
      aria-label="golden-eye"
    >
      <rect width="64" height="64" rx="14" fill="#18181b" />
      {/* faint edge so the tile still reads against a near-black sidebar */}
      <rect x="0.5" y="0.5" width="63" height="63" rx="13.5" fill="none" stroke="#ffffff" strokeOpacity="0.08" />
      <path
        d="M11 32c6-9.5 12.6-14.5 21-14.5S47 22.5 53 32c-6 9.5-12.6 14.5-21 14.5S17 41.5 11 32z"
        fill="none"
        stroke="#f59e0b"
        strokeWidth="4"
        strokeLinejoin="round"
      />
      <circle cx="32" cy="32" r="6.5" fill="#f59e0b" />
    </svg>
  );
}

/** Wordmark: "golden" recedes, "eye" carries the accent — matches the mark. */
export function Wordmark({ className = '' }: { className?: string }) {
  return (
    <span className={`select-none text-[15px] tracking-tight ${className}`}>
      <span className="font-medium text-zinc-600 dark:text-zinc-300">golden</span>
      <span className="font-semibold text-amber-500">eye</span>
    </span>
  );
}
