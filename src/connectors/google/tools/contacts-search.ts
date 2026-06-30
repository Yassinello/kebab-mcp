import { z } from "zod";
import { searchContacts } from "../lib/contacts";
import { resolveGoogleTokens } from "../lib/resolve-account";

export const contactsSearchSchema = {
  query: z.string().describe("Search query — name, email, company, or phone number"),
  max_results: z.number().optional().describe("Max results (default: 10, max: 30)"),
  account: z
    .string()
    .optional()
    .describe(
      "Which connected account to use (name or slug). Omit to use the pinned default / your only account."
    ),
};

export async function handleContactsSearch(params: {
  query: string;
  max_results?: number | undefined;
  account?: string | undefined;
}) {
  const r = await resolveGoogleTokens(params.account);
  if (!r.ok) return r.result;

  const contacts = await searchContacts(r.ctx, params.query, params.max_results);

  if (contacts.length === 0) {
    return {
      content: [{ type: "text" as const, text: `No contacts found for "${params.query}".` }],
    };
  }

  const lines = contacts.map((c) => {
    const parts = [c.name];
    if (c.emails.length) parts.push(`email: ${c.emails.join(", ")}`);
    if (c.phones.length) parts.push(`tel: ${c.phones.join(", ")}`);
    if (c.organization) parts.push(`org: ${c.organization}`);
    if (c.title) parts.push(`role: ${c.title}`);
    return parts.join(" | ");
  });

  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
  };
}
