import { googleFetchJSON } from "./google-fetch";

const PEOPLE = "https://people.googleapis.com/v1";

export interface Contact {
  name: string;
  emails: string[];
  phones: string[];
  organization: string;
  title: string;
}

export async function searchContacts(query: string, maxResults?: number): Promise<Contact[]> {
  const limit = Math.min(maxResults || 10, 30);

  const data = await googleFetchJSON<any>(
    `${PEOPLE}/people:searchContacts?query=${encodeURIComponent(query)}&readMask=names,emailAddresses,phoneNumbers,organizations&pageSize=${limit}`
  );

  return (data.results || []).map((r: any) => {
    const person = r.person || {};
    const org = (person.organizations || [])[0] || {};
    return {
      name: (person.names || [])[0]?.displayName || "",
      emails: (person.emailAddresses || []).map((e: any) => e.value),
      phones: (person.phoneNumbers || []).map((p: any) => p.value),
      organization: org.name || "",
      title: org.title || "",
    };
  });
}
