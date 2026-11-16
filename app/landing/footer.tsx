import { KebabLogo } from "../components/kebab-logo";
import { PRODUCT } from "@/core/constants/brand";
import { REPO_URL } from "./deploy-url";
import packageJson from "../../package.json";

/** Sections of the landing, linked from the footer's "Product" column. */
const LANDING_SECTIONS = [
  { label: "How it works", id: "how-it-works" },
  { label: "Ingredients", id: "ingredients" },
  { label: "Clients", id: "clients" },
  { label: "Dashboard", id: "product" },
  { label: "Guardrails", id: "guardrails" },
  { label: "FAQ", id: "faq" },
];

const OTHER_COLUMNS = [
  {
    heading: "Resources",
    links: [
      { label: "Documentation", href: `${REPO_URL}#readme` },
      { label: "Connect your clients", href: `${REPO_URL}/blob/main/docs/CLIENTS.md` },
      { label: "Rituals", href: `${REPO_URL}/blob/main/docs/rituals/README.md` },
      { label: "Adding a connector", href: `${REPO_URL}/blob/main/docs/CONNECTOR-AUTHORING.md` },
      { label: "Troubleshooting", href: `${REPO_URL}/blob/main/docs/TROUBLESHOOTING.md` },
      { label: "Changelog", href: `${REPO_URL}/releases` },
    ],
  },
  {
    heading: "Community",
    links: [
      { label: "GitHub", href: REPO_URL },
      { label: "Issues", href: `${REPO_URL}/issues` },
      { label: "Discussions", href: `${REPO_URL}/discussions` },
    ],
  },
];

/**
 * `landingUrl` is where the section anchors live: empty on the landing
 * itself (plain `#id` links), the showcase URL on other pages such as
 * /deploy, so the links never point at a section that is not on the page.
 */
export default function LandingFooter({ landingUrl = "" }: { landingUrl?: string }) {
  const columns = [
    {
      heading: "Product",
      links: [
        { label: "Deploy", href: "/deploy" },
        ...LANDING_SECTIONS.map((s) => ({ label: s.label, href: `${landingUrl}#${s.id}` })),
      ],
    },
    ...OTHER_COLUMNS,
  ];
  return (
    <footer className="border-t border-slate-800 py-10 px-6">
      <div className="max-w-6xl mx-auto">
        <div className="grid grid-cols-3 sm:grid-cols-4 gap-x-4 gap-y-8 sm:gap-10 mb-8">
          <div className="col-span-3 sm:col-span-1">
            <div className="flex items-center gap-2 mb-3">
              <KebabLogo size={22} className="text-amber-400" />
              <p className="font-mono text-white font-semibold">{PRODUCT.name}</p>
            </div>
            <p className="text-xs text-slate-500 leading-relaxed max-w-xs">{PRODUCT.tagline}</p>
            <p className="text-xs text-slate-600 leading-relaxed max-w-xs mt-2">
              Self-hosted, AGPL-3.0, open source.
            </p>
          </div>

          {columns.map((col) => (
            <div key={col.heading}>
              <p className="text-xs font-mono uppercase tracking-widest text-slate-500 mb-4">
                {col.heading}
              </p>
              <ul className="space-y-1.5 sm:space-y-2">
                {col.links.map((link) => (
                  <li key={link.label}>
                    <a
                      href={link.href}
                      target={isInternal(link.href) ? undefined : "_blank"}
                      rel={isInternal(link.href) ? undefined : "noopener noreferrer"}
                      className="text-xs sm:text-sm text-slate-400 hover:text-white transition-colors"
                    >
                      {link.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="pt-5 border-t border-slate-800/60 flex flex-row justify-between items-center gap-3">
          <p className="text-xs text-slate-600">
            © {new Date().getFullYear()} {PRODUCT.name} contributors · AGPL-3.0 License
          </p>
          <p className="text-xs text-slate-600 font-mono">v{packageJson.version}</p>
        </div>
      </div>
    </footer>
  );
}

function isInternal(href: string): boolean {
  return href.startsWith("#") || href.startsWith("/");
}
