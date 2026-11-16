/**
 * Kebab House phase 3 views, run in a DOM (audit C2.3): the bridge only
 * listens to its parent frame, and the approve card renders object fields,
 * the account name and the instance origin, and only offers same-origin
 * approval links.
 */
import { describe, it, expect } from "vitest";
// @ts-expect-error -- jsdom ships without type declarations in this repo (no @types/jsdom)
import { JSDOM as UntypedJSDOM } from "jsdom";
import { approveView } from "@/connectors/house/views/approve";

type DomWindow = Window & typeof globalThis;
const JSDOM = UntypedJSDOM as new (
  html: string,
  opts?: { runScripts?: "dangerously"; beforeParse?: (window: DomWindow) => void }
) => { window: DomWindow };

const ORIGIN = "https://house.example.org";

function load(html: string) {
  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    beforeParse(window) {
      (window as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
        observe() {}
      };
      // The host never answers ui/initialize in this test.
      window.parent.postMessage = () => {};
    },
  });
  const win = dom.window;
  const push = (result: unknown, source: unknown = win.parent) => {
    const ev = new win.MessageEvent("message", {
      data: { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: result },
      source: source as Window,
    });
    win.dispatchEvent(ev);
  };
  return { win, doc: win.document, push };
}

function sendResult(approvalUrl: string, extra: Record<string, unknown> = {}) {
  return {
    structuredContent: {
      approval_url: approvalUrl,
      preview: {
        recipient: { name: "Ada Example", provider_id: "ACoAAB" },
        chat: { attendees: [{ display_name: "Grace" }, { display_name: "Linus" }] },
        text: "Hello there",
        ...extra,
      },
      account_display_name: "Work LinkedIn",
    },
  };
}

describe("MCP Apps bridge", () => {
  it("ignores postMessage events that do not come from the parent frame", () => {
    const { doc, push } = load(approveView([ORIGIN]));
    const other = new JSDOM("").window;
    push(sendResult(`${ORIGIN}/approve/abc?sig=1`), other);
    expect(doc.getElementById("root")!.textContent).toBe("Waiting for the preview…");
    push(sendResult(`${ORIGIN}/approve/abc?sig=1`));
    expect(doc.getElementById("root")!.textContent).toContain("Hello there");
  });
});

describe("approve view", () => {
  it("renders object and array fields as readable text, with the account and the origin", () => {
    const { doc, push } = load(approveView([ORIGIN]));
    push(sendResult(`${ORIGIN}/approve/abc?sig=1`));
    const text = doc.getElementById("root")!.textContent!;
    expect(text).toContain("Ada Example (ACoAAB)");
    expect(text).toContain("Grace, Linus");
    expect(text).toContain("FromWork LinkedIn");
    expect(text).not.toContain("[object Object]");
    expect(text).toContain(`approve it on your Kebab House: ${ORIGIN}`);
    expect(doc.querySelector("button.primary")?.textContent).toBe("Open the approval page");
  });

  it("does not offer an approval link on another origin", () => {
    const { doc, push } = load(approveView([ORIGIN]));
    push(sendResult("https://evil.example.net/approve/abc?sig=1"));
    const text = doc.getElementById("root")!.textContent!;
    expect(text).toContain("does not point to your Kebab House (https://evil.example.net)");
    expect(doc.querySelector("button.primary")).toBeNull();
  });

  it("embeds the allowed origins safely", () => {
    const html = approveView([ORIGIN, "</script><script>alert(1)</script>"]);
    expect(html).not.toContain("</script><script>alert(1)");
  });
});
