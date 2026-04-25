import { REPO_URL } from "./deploy-url";

const LINKS = [
  { label: "GitHub", href: REPO_URL },
  { label: "Documentation", href: `${REPO_URL}#readme` },
];

export default function LandingFooter() {
  return (
    <footer className="border-t border-slate-800 py-10 px-6">
      <div className="max-w-6xl mx-auto">
        <div className="flex flex-col sm:flex-row items-center justify-between gap-6">
          <div>
            <p className="text-sm font-mono text-white font-semibold mb-1">Kebab MCP</p>
            <p className="text-xs text-slate-500">
              One backend for every AI client. MIT License · Open source · Built with the community
            </p>
          </div>
          <nav className="flex gap-6">
            {LINKS.map((link) => (
              <a
                key={link.label}
                href={link.href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-slate-400 hover:text-white transition-colors"
              >
                {link.label}
              </a>
            ))}
          </nav>
        </div>
        <div className="mt-8 pt-6 border-t border-slate-800/50">
          <p className="text-xs text-slate-600 text-center">
            © {new Date().getFullYear()} Kebab MCP contributors · MIT License
          </p>
        </div>
      </div>
    </footer>
  );
}
