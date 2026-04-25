interface KebabLogoProps {
  size?: number;
  className?: string;
  /** When true, renders with an internal amber→orange gradient and a flame */
  hot?: boolean;
}

/**
 * Kebab skewer logo — horizontal pique with three chunky pieces (round /
 * square / round). The rod has a flat handle on the left and a sharpened
 * tip on the right. At small sizes (16-26px) the silhouette reads as
 * "kebab on a stick" rather than the abstract diagonal it used to be.
 *
 * Two modes:
 * - default: monochrome via `currentColor` — drop into any header
 * - hot: amber→orange→red gradient + tiny flame underneath, for hero/OG
 */
export function KebabLogo({ size = 24, className = "", hot = false }: KebabLogoProps) {
  const gradId = `kebab-grad-${hot ? "hot" : "mono"}`;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      {hot && (
        <defs>
          <linearGradient id={gradId} x1="6" y1="16" x2="26" y2="16" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#fbbf24" />
            <stop offset="55%" stopColor="#f97316" />
            <stop offset="100%" stopColor="#dc2626" />
          </linearGradient>
        </defs>
      )}

      {/* Skewer rod — horizontal, slight upward angle, thick */}
      <line
        x1="3"
        y1="17.5"
        x2="29"
        y2="14.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />

      {/* Handle: short cross-bar on the left = grip */}
      <line
        x1="3"
        y1="15"
        x2="3"
        y2="20"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
      />

      {/* Piece 1 (left): round — onion */}
      <circle
        cx="9.5"
        cy="16.7"
        r="3.2"
        fill={hot ? `url(#${gradId})` : "currentColor"}
      />

      {/* Piece 2 (middle): square with rounded corners — meat cube */}
      <rect
        x="13.2"
        y="12.4"
        width="6"
        height="6"
        rx="1"
        fill={hot ? `url(#${gradId})` : "currentColor"}
      />

      {/* Piece 3 (right): round — tomato */}
      <circle
        cx="22.5"
        cy="14.7"
        r="3"
        fill={hot ? `url(#${gradId})` : "currentColor"}
      />

      {/* Sharpened tip beyond the last piece */}
      <path
        d="M26 14.2 L29 14.5 L26.5 16 Z"
        fill="currentColor"
      />

      {hot && (
        // Flame underneath — only in hot mode
        <path
          d="M14 24 Q15 21 16 23 Q17 20 18 23 Q18.5 25 16 26 Q13.5 25 14 24 Z"
          fill="#f59e0b"
          opacity="0.85"
        />
      )}
    </svg>
  );
}
