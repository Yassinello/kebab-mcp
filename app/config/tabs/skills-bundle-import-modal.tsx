"use client";

import { useState } from "react";

/**
 * Skills v2 — import Agent Skills bundles: a pasted SKILL.md, or a .zip
 * (one skill folder exported from Claude / ChatGPT / a git repo, or a whole
 * library). Preview first (create vs update, files, warnings), then save.
 */

interface PreviewItem {
  name: string;
  title: string;
  description: string;
  action: "create" | "update";
  tags: string[];
  files: string[];
  bodyChars: number;
  warnings: string[];
}

interface ResultItem {
  name: string;
  action: "created" | "updated";
  error?: string;
}

const MAX_ZIP_BYTES = 2 * 1024 * 1024;

async function fileToBase64(file: File): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) {
    bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export function BundleImportModal({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: (summary: string) => void | Promise<void>;
}) {
  const [mode, setMode] = useState<"zip" | "paste">("zip");
  const [skillMd, setSkillMd] = useState("");
  const [zipName, setZipName] = useState<string | null>(null);
  const [zipBase64, setZipBase64] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<ResultItem[] | null>(null);

  const payload = () => (mode === "zip" ? { zipBase64: zipBase64 ?? "" } : { skillMd });

  const onFile = async (file: File | undefined) => {
    setError(null);
    setPreview(null);
    if (!file) return;
    if (file.size > MAX_ZIP_BYTES) {
      setError("Zip is larger than 2 MB.");
      return;
    }
    if (/\.md$/i.test(file.name)) {
      setMode("paste");
      setSkillMd(await file.text());
      return;
    }
    setZipName(file.name);
    setZipBase64(await fileToBase64(file));
  };

  const call = async (action: "preview" | "save") => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/config/skills/bundle-import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ action, ...payload() }),
      });
      const data = (await res.json()) as {
        error?: string;
        items?: PreviewItem[];
        results?: ResultItem[];
      };
      if (data.error) {
        setError(data.error);
      } else if (action === "preview") {
        setPreview(data.items ?? []);
      } else {
        const r = data.results ?? [];
        setResults(r);
        const ok = r.filter((x) => !x.error);
        if (ok.length === r.length) {
          await onImported(
            `${ok.filter((x) => x.action === "created").length} created, ${ok.filter((x) => x.action === "updated").length} updated`
          );
        }
      }
    } catch {
      setError("Network error");
    }
    setBusy(false);
  };

  const canPreview = mode === "zip" ? !!zipBase64 : skillMd.trim().length > 0;

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/60 px-4">
      <div className="w-full max-w-2xl rounded-lg border border-border bg-bg-sidebar shadow-2xl p-6 max-h-[90vh] overflow-auto">
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-base font-semibold">Import skills</h3>
          <button
            type="button"
            onClick={onClose}
            className="text-text-muted hover:text-text"
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <p className="text-xs text-text-dim mb-4">
          Agent Skills format — the same <code>SKILL.md</code> folders Claude, ChatGPT, Codex and
          Claude Code use. A skill with the same name is <strong>updated</strong> (new version),
          never duplicated.
        </p>

        <div className="flex gap-1 mb-3 text-xs">
          {(["zip", "paste"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => {
                setMode(m);
                setPreview(null);
              }}
              className={`px-3 py-1.5 rounded-md border ${
                mode === m
                  ? "border-accent text-accent bg-accent/10"
                  : "border-border text-text-dim"
              }`}
            >
              {m === "zip" ? "Upload .zip / SKILL.md file" : "Paste SKILL.md"}
            </button>
          ))}
        </div>

        {mode === "zip" ? (
          <label
            className="block border border-dashed border-border rounded-md p-6 text-center text-sm text-text-dim cursor-pointer hover:border-accent"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              void onFile(e.dataTransfer.files[0]);
            }}
          >
            <input
              type="file"
              accept=".zip,.skill,.md"
              className="hidden"
              onChange={(e) => void onFile(e.target.files?.[0])}
            />
            {zipName ? (
              <span className="text-text">{zipName}</span>
            ) : (
              <>
                Drop a <code>.zip</code> here or click to choose
                <br />
                <span className="text-xs text-text-muted">
                  One skill folder, or a library of folders (≤ 2 MB)
                </span>
              </>
            )}
          </label>
        ) : (
          <textarea
            value={skillMd}
            onChange={(e) => {
              setSkillMd(e.target.value);
              setPreview(null);
            }}
            placeholder={
              "---\nname: weekly-review\ndescription: Run my weekly review…\n---\n\n# Steps\n1. …"
            }
            className="w-full h-56 bg-bg-muted border border-border rounded-md px-3 py-2 text-xs font-mono focus:border-accent focus:outline-none"
          />
        )}

        {error && <p className="text-xs text-red mt-3">{error}</p>}

        {preview && !results && (
          <div className="mt-4 space-y-2">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-text-muted">
              Preview — {preview.length} skill{preview.length === 1 ? "" : "s"}
            </h4>
            {preview.map((p) => (
              <div key={p.name} className="border border-border rounded-md p-3 text-xs space-y-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold text-sm text-text">{p.title}</span>
                  <code className="text-text-muted">{p.name}</code>
                  <span
                    className={`px-2 py-0.5 rounded-full font-medium ${
                      p.action === "create" ? "text-green bg-green-bg" : "text-orange bg-orange-bg"
                    }`}
                  >
                    {p.action === "create" ? "new" : "update"}
                  </span>
                  {p.tags.map((t) => (
                    <span key={t} className="px-1.5 py-0.5 rounded bg-bg-muted text-text-dim">
                      #{t}
                    </span>
                  ))}
                </div>
                <p className="text-text-dim">{p.description || <em>no description</em>}</p>
                <p className="text-text-muted">
                  {p.bodyChars} chars · {p.files.length} file{p.files.length === 1 ? "" : "s"}
                  {p.files.length ? `: ${p.files.join(", ")}` : ""}
                </p>
                {p.warnings.map((w) => (
                  <p key={w} className="text-orange">
                    ⚠ {w}
                  </p>
                ))}
              </div>
            ))}
          </div>
        )}

        {results && (
          <div className="mt-4 space-y-1 text-xs">
            {results.map((r) => (
              <p key={r.name} className={r.error ? "text-red" : "text-green"}>
                {r.error ? `✗ ${r.name}: ${r.error}` : `✓ ${r.name} ${r.action}`}
              </p>
            ))}
          </div>
        )}

        <div className="flex justify-end gap-2 mt-5">
          <button
            type="button"
            onClick={onClose}
            className="text-xs px-3 py-1.5 border border-border rounded-md text-text-dim hover:text-text"
          >
            {results ? "Close" : "Cancel"}
          </button>
          {!results && (
            <>
              <button
                type="button"
                onClick={() => void call("preview")}
                disabled={!canPreview || busy}
                className="text-xs px-3 py-1.5 border border-border rounded-md text-text disabled:opacity-50"
              >
                {busy && !preview ? "Reading..." : "Preview"}
              </button>
              <button
                type="button"
                onClick={() => void call("save")}
                disabled={!preview || busy}
                className="text-xs px-3 py-1.5 rounded-md bg-accent text-white disabled:opacity-50"
              >
                {busy && preview ? "Importing..." : `Import ${preview?.length ?? ""}`.trim()}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
