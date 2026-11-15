/**
 * FAQ — the questions a visitor asks before deploying. Native <details> so
 * it works without JavaScript and stays collapsed (short page).
 */
const QUESTIONS: { q: string; a: string }[] = [
  {
    q: "How is this different from Claude's or ChatGPT's memory?",
    a: "Their memory lives inside one app. Kebab House keeps your profile, skills and notes in one place you own, and every connected client reads the same copy: what you tell Claude, Cursor knows too. You can keep using both.",
  },
  {
    q: "Do I need to code?",
    a: "No. Deploying is one click on Vercel, and setting up is a conversation: say “Set up my Kebab House” in your AI client. Code only comes in if you want to write your own connector.",
  },
  {
    q: "What does it cost?",
    a: "Kebab House is free and open source (AGPL-3.0). It runs on your own Vercel and Upstash accounts, and a personal hub fits their free plans. A few optional tools use paid services with your own key.",
  },
  {
    q: "Where is my data?",
    a: "In your accounts: your profile, skills and settings in your own database (Upstash, or a folder on your machine with Docker), your notes there or in your own GitHub repository. There is no server of ours in the middle.",
  },
  {
    q: "What happens if my AI client is tricked by a web page?",
    a: "Outside content reaches the model marked as data, not instructions. Messages sent through Kebab House wait for your approval on a separate page, and a client with read-only access cannot change anything. This lowers the risk; no tool can remove it entirely.",
  },
  {
    q: "Can I use it with only one client?",
    a: "Yes: you still get the rituals, your notes and the extra tools. But the point is sharing one context across clients. If you only ever use one AI app, its own memory may be enough.",
  },
];

export default function Faq() {
  return (
    <section id="faq" className="py-10 sm:py-12 px-6 border-t border-slate-800">
      <div className="max-w-5xl mx-auto">
        <h2 className="text-2xl sm:text-4xl font-bold text-white tracking-tight text-center mb-6">
          Questions
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 items-start">
          {QUESTIONS.map(({ q, a }) => (
            <details
              key={q}
              className="group bg-slate-900/60 border border-slate-800 rounded-lg px-4 py-3 open:border-slate-700"
            >
              <summary className="cursor-pointer list-none flex items-start justify-between gap-3 text-sm font-semibold text-white">
                {q}
                <span
                  aria-hidden
                  className="text-amber-400 shrink-0 transition-transform group-open:rotate-45"
                >
                  +
                </span>
              </summary>
              <p className="text-sm text-slate-400 leading-relaxed mt-2">{a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
