# Morning brief

**Say:** “morning brief”, “what's on today?”, “what should I focus on?”.

**What it does:** a brief you can read in two minutes, built from:

1. your profile (`my_context`): role, projects, priorities, working hours;
2. today's calendar, when the client has a calendar connector;
3. emails from the last 24 hours that need you (72 hours on Monday), when the client has a mail connector;
4. your recent notes (`vault_recent`), including notes due to resurface.

It ends with **Today**, **Needs you**, **Top 3** and **Heads-up**, then asks whether to adjust the Top 3. Once you agree, it can append the plan to `Journal/YYYY-MM-DD.md`.

**Needs:** the profile. Calendar and mail are best taken from your client's native connectors (Google, Microsoft); the brief says which sources it could not reach.

**Template:** [`content/skill-templates/morning-brief/SKILL.md`](../../content/skill-templates/morning-brief/SKILL.md)
