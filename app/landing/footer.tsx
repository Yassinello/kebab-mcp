import { KebabLogo } from "../components/kebab-logo";
import { REPO_URL } from "./deploy-url";

const COLUMNS = [
  {
    heading: "Product",
    links: [
      { label: "Deploy", href: "#deploy" },
      { label: "Dashboard", href: "#product" },
      { label: "Compatibility", href: "#whats-inside" },
    ],
  },
  {
    heading: "Resources",
    links: [
      { label: "Documentation", href: `${REPO_URL}#readme` },
      { label: "Adding a connector", href: `${REPO_URL}#adding-a-connector` },
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

export default function LandingFooter() {
  return (
    <footer className="border-t border-slate-800 py-14 px-6">
      <div className="max-w-6xl mx-auto">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-10 mb-10">
          <div className="col-span-2 sm:col-span-1">
            <div className="flex items-center gap-2 mb-3">
              <KebabLogo size={22} className="text-amber-400" />
              <p className="font-mono text-white font-semibold">Kebab MCP</p>
            </div>
            <p className="text-xs text-slate-500 leading-relaxed max-w-xs">
              One self-hosted backend for every AI client. MIT licensed, open source, built with the
              community.
            </p>
          </div>

          {COLUMNS.map((col) => (
            <div key={col.heading}>
              <p className="text-xs font-mono uppercase tracking-widest text-slate-500 mb-4">
                {col.heading}
              </p>
              <ul className="space-y-2">
                {col.links.map((link) => (
                  <li key={link.label}>
                    <a
                      href={link.href}
                      target={link.href.startsWith("#") ? undefined : "_blank"}
                      rel={link.href.startsWith("#") ? undefined : "noopener noreferrer"}
                      className="text-sm text-slate-400 hover:text-white transition-colors"
                    >
                      {link.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="pt-6 border-t border-slate-800/60 flex flex-col sm:flex-row justify-between items-center gap-3">
          <p className="text-xs text-slate-600">
            © {new Date().getFullYear()} Kebab MCP contributors · MIT License
          </p>
          <p className="text-xs text-slate-600 font-mono">v0.15</p>
        </div>
      </div>
    </footer>
  );
}
