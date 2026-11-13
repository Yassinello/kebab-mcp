import { KebabLogo } from "../components/kebab-logo";
import { PRODUCT } from "@/core/constants/brand";
import OpenInstanceButton from "./open-instance-button";

export default function LandingHeader() {
  return (
    <header className="border-b border-slate-800 bg-slate-950/80 backdrop-blur-sm sticky top-0 z-50">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-4">
        <a
          href="/"
          className="flex items-center gap-2.5 shrink-0 text-white hover:opacity-90 transition-opacity"
        >
          <KebabLogo size={26} className="text-amber-400" />
          <span className="font-mono text-lg font-bold tracking-tight whitespace-nowrap">
            {PRODUCT.name}
          </span>
        </a>
        <nav className="flex items-center gap-4 sm:gap-6">
          <a
            href="https://github.com/Yassinello/kebab-mcp"
            target="_blank"
            rel="noopener noreferrer"
            className="hidden sm:inline text-sm text-slate-400 hover:text-white transition-colors"
          >
            GitHub
          </a>
          <OpenInstanceButton />
        </nav>
      </div>
    </header>
  );
}
