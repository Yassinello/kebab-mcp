"use client";

import { useEffect, useRef, useState } from "react";

const STORAGE_KEY = "mymcp:instance-url";

function normalizeUrl(raw: string): string | null {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

export default function OpenInstanceButton() {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [savedUrl, setSavedUrl] = useState<string | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        setSavedUrl(stored);
        setValue(stored);
      }
    } catch {
      // localStorage may be unavailable (Safari private mode, etc.)
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const go = (url: string) => {
    const normalized = normalizeUrl(url);
    if (!normalized) {
      setError("Enter a valid URL like https://my-mcp.vercel.app");
      return;
    }
    try {
      localStorage.setItem(STORAGE_KEY, normalized);
    } catch {
      // ignore
    }
    window.location.href = `${normalized}/config`;
  };

  const forget = () => {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
    setSavedUrl(null);
    setValue("");
  };

  return (
    <div className="relative" ref={popoverRef}>
      <button
        type="button"
        onClick={() => {
          if (savedUrl) {
            go(savedUrl);
          } else {
            setOpen((v) => !v);
          }
        }}
        className="text-sm whitespace-nowrap text-slate-900 bg-white hover:bg-slate-100 transition-colors px-3 py-1.5 rounded-md font-medium"
      >
        {savedUrl ? "Open my instance" : "Open my instance"}
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-lg border border-slate-700 bg-slate-900 shadow-xl p-4 text-left">
          <p className="text-xs text-slate-400 mb-2">
            Enter the URL of your deployed Kebab House instance.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setError(null);
              go(value);
            }}
            className="space-y-2"
          >
            <input
              type="text"
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="https://my-mcp.vercel.app"
              className="w-full bg-slate-950 border border-slate-700 rounded-md px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-blue-500"
            />
            {error && <p className="text-xs text-red-400">{error}</p>}
            <button
              type="submit"
              className="w-full bg-white text-slate-900 hover:bg-slate-100 transition-colors px-3 py-2 rounded-md font-medium text-sm"
            >
              Open
            </button>
          </form>
          <div className="mt-3 pt-3 border-t border-slate-800 text-xs text-slate-500">
            Don't have one yet?{" "}
            <a
              href="#deploy"
              className="text-blue-400 hover:text-blue-300"
              onClick={() => setOpen(false)}
            >
              Deploy in 5 min →
            </a>
          </div>
          {savedUrl && (
            <button
              type="button"
              onClick={forget}
              className="mt-2 text-[11px] text-slate-500 hover:text-slate-300"
            >
              Forget saved instance
            </button>
          )}
        </div>
      )}
    </div>
  );
}
