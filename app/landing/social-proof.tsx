import { REPO_URL } from "./deploy-url";

/**
 * Compact social-proof strip placed just under the hero. Uses live
 * shields.io badges (cached server-side) so the stars/forks counts stay
 * fresh without us baking numbers into the source.
 *
 * No fake testimonials — just verifiable signals: GitHub stars, license,
 * build status, npm-style version. If a badge endpoint is down,
 * shields.io serves a stale fallback automatically.
 */
const REPO_PATH = REPO_URL.replace(/^https?:\/\/github\.com\//, "").replace(/\/$/, "");

const BADGES = [
  {
    label: "GitHub stars",
    src: `https://img.shields.io/github/stars/${REPO_PATH}?style=flat-square&color=f59e0b&labelColor=1e293b&label=stars`,
    href: REPO_URL,
  },
  {
    label: "License",
    src: `https://img.shields.io/github/license/${REPO_PATH}?style=flat-square&color=f59e0b&labelColor=1e293b`,
    href: `${REPO_URL}/blob/main/LICENSE`,
  },
  {
    label: "Last commit",
    src: `https://img.shields.io/github/last-commit/${REPO_PATH}?style=flat-square&color=64748b&labelColor=1e293b`,
    href: `${REPO_URL}/commits/main`,
  },
];

export default function SocialProof() {
  return (
    <div className="flex items-center justify-center gap-3 flex-wrap">
      {BADGES.map((badge) => (
        <a
          key={badge.label}
          href={badge.href}
          target="_blank"
          rel="noopener noreferrer"
          className="hover:opacity-80 transition-opacity"
          aria-label={badge.label}
        >
          <img src={badge.src} alt={badge.label} height={20} loading="lazy" />
        </a>
      ))}
    </div>
  );
}
