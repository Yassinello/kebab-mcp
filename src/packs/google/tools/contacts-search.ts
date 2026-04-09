import { z } from "zod";
import { searchContacts } from "../lib/contacts";

export const contactsSearchSchema = {
  query: z.string().describe("Search query — name, email, company, or phone number"),
  max_results: z.number().optional().describe("Max results (default: 10, max: 30)"),
};

export async function handleContactsSearch(params: {
  query: string;
  max_results?: number;
}) {
  const contacts = await searchContacts(params.query, params.max_results);

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
