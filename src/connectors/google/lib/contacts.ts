import { googleFetchJSON } from "./google-fetch";

const PEOPLE = "https://people.googleapis.com/v1";

// --- Google API response types ---

interface PeopleSearchResponse {
  results?: {
    person?: {
      names?: { displayName?: string }[];
      emailAddresses?: { value: string }[];
      phoneNumbers?: { value: string }[];
      organizations?: { name?: string; title?: string }[];
    };
  }[];
}

interface DirectorySearchResponse {
  people?: {
    names?: { displayName?: string }[];
    emailAddresses?: { value: string }[];
    phoneNumbers?: { value: string }[];
    organizations?: { name?: string; title?: string }[];
  }[];
}

export interface Contact {
  name: string;
  emails: string[];
  phones: string[];
  organization: string;
  title: string;
}

export async function searchContacts(query: string, maxResults?: number): Promise<Contact[]> {
  const limit = Math.min(maxResults || 10, 30);
  const contacts: Contact[] = [];
  const seenEmails = new Set<string>();

  // 1. Search personal contacts
  try {
    const data = await googleFetchJSON<PeopleSearchResponse>(
      `${PEOPLE}/people:searchContacts?query=${encodeURIComponent(query)}&readMask=names,emailAddresses,phoneNumbers,organizations&pageSize=${limit}`
    );
    for (const r of data.results || []) {
      const person = r.person || {};
      const org = (person.organizations || [])[0] || {};
      const emails = (person.emailAddresses || []).map((e) => e.value);
      const contact: Contact = {
        name: (person.names || [])[0]?.displayName || "",
        emails,
        phones: (person.phoneNumbers || []).map((p) => p.value),
        organization: org.name || "",
        title: org.title || "",
      };
      contacts.push(contact);
      emails.forEach((email) => seenEmails.add(email.toLowerCase()));
    }
  } catch (err) {
    console.error("Personal contacts search failed:", err);
  }

  // 2. Search domain directory profiles (Google Workspace)
  try {
    const dirData = await googleFetchJSON<DirectorySearchResponse>(
      `${PEOPLE}/people:searchDirectoryPeople?query=${encodeURIComponent(query)}&readMask=names,emailAddresses,phoneNumbers,organizations&sources=DIRECTORY_SOURCE_TYPE_DOMAIN_CONTACT&sources=DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE&pageSize=${limit}`
    );
    for (const person of dirData.people || []) {
      const org = (person.organizations || [])[0] || {};
      const emails = (person.emailAddresses || []).map((e) => e.value);
      
      // Avoid duplicates if email already found in personal contacts
      const hasOverlap = emails.some((email) => seenEmails.has(email.toLowerCase()));
      if (hasOverlap && contacts.length > 0) continue;

      const contact: Contact = {
        name: (person.names || [])[0]?.displayName || "",
        emails,
        phones: (person.phoneNumbers || []).map((p) => p.value),
        organization: org.name || "",
        title: org.title || "",
      };
      contacts.push(contact);
    }
  } catch (err) {
    // Gracefully ignore if directory search is not supported/authorized (e.g. personal accounts)
    console.log("Directory search not available or failed:", err);
  }

  return contacts.slice(0, limit);
}
