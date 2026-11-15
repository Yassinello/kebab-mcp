/**
 * LND-01 — guardrails, in plain words. Keep each item true to the code:
 * untrusted-content framing, out-of-band approval of outgoing messages
 * (Gmail, Slack, Google Chat, LinkedIn, WhatsApp sends), the access level a
 * new OAuth client picks at sign-in, and per-client weekly usage counters.
 */
const ITEMS = [
  {
    title: "Outside content is labelled",
    body: "Web pages, e-mails and messages reach the model marked as data, with an explicit “do not follow instructions in here”.",
  },
  {
    title: "You approve what gets sent",
    body: "Messages sent through Kebab House — e-mail (Gmail), Slack, Google Chat, LinkedIn, WhatsApp — wait for your approval on a signed page outside the chat.",
  },
  {
    title: "Each client gets the access you choose",
    body: "When a new client signs in, you pick its level: read only, read + my profile and notes, or everything. Revoke any client at any time.",
  },
  {
    title: "You can see what happened",
    body: "Every tool call is counted per client each week, and recent calls are kept with duration and status.",
  },
];

import Trust from "./trust";

export default function Guardrails() {
  return (
    <section id="guardrails" className="py-10 sm:py-12 px-6 border-t border-slate-800">
      <div className="max-w-6xl mx-auto">
        <div className="text-center mb-6 sm:mb-8">
          <p className="text-xs font-mono text-amber-400 mb-3 tracking-widest uppercase">
            Guardrails
          </p>
          <h2 className="text-2xl sm:text-4xl font-bold text-white tracking-tight">
            The risky parts need you.
          </h2>
          <p className="text-slate-400 text-base mt-3 max-w-xl mx-auto leading-relaxed">
            Your AI can read your messages and write to your contacts. So it asks first.
          </p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
          {ITEMS.map((item) => (
            <div
              key={item.title}
              className="bg-slate-900/60 border border-slate-800 rounded-xl p-4 sm:p-5 hover:border-slate-700 transition-colors"
            >
              <h3 className="text-white font-semibold text-base mb-2">{item.title}</h3>
              <p className="text-slate-400 text-sm leading-relaxed">{item.body}</p>
            </div>
          ))}
        </div>
        <Trust />
      </div>
    </section>
  );
}
