import { googleFetch, googleFetchJSON } from "./google-fetch";

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

// --- Types ---

export interface EmailSummary {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  unread: boolean;
  snippet: string;
}

export interface EmailFull extends EmailSummary {
  body: string;
  cc: string;
  bcc: string;
  messageId: string;
  labels: string[];
  attachments: { id: string; filename: string; mimeType: string; size: number }[];
}

// --- Google API response types ---

interface GmailMessageList {
  messages?: { id: string; threadId: string }[];
  nextPageToken?: string;
}

interface GmailMessagePart {
  mimeType?: string;
  filename?: string;
  body?: { data?: string; attachmentId?: string; size?: number };
  headers?: { name: string; value: string }[];
  parts?: GmailMessagePart[];
}

interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  payload?: GmailMessagePart;
}

interface GmailDraftResponse {
  id: string;
  message?: { id: string };
}

// --- Helpers ---

function buildEmailHeaders(opts: {
  to: string;
  subject: string;
  cc?: string;
  bcc?: string;
  inReplyTo?: string;
  references?: string;
}): string[] {
  const hdrs = [
    `To: ${opts.to}`,
    `Subject: ${opts.subject}`,
    `Content-Type: text/plain; charset=utf-8`,
  ];
  if (opts.cc) hdrs.push(`Cc: ${opts.cc}`);
  if (opts.bcc) hdrs.push(`Bcc: ${opts.bcc}`);
  if (opts.inReplyTo) hdrs.push(`In-Reply-To: ${opts.inReplyTo}`);
  if (opts.references) hdrs.push(`References: ${opts.references}`);
  return hdrs;
}

function getHeader(headers: { name: string; value: string }[], name: string): string {
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || "";
}

function extractBody(payload: GmailMessagePart | undefined): string {
  if (!payload) return "";
  if (payload.body?.data) {
    return Buffer.from(payload.body.data, "base64url").toString("utf-8");
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === "text/plain" && part.body?.data)
        return Buffer.from(part.body.data, "base64url").toString("utf-8");
    }
    for (const part of payload.parts) {
      if (part.mimeType === "text/html" && part.body?.data) {
        const html = Buffer.from(part.body.data, "base64url").toString("utf-8");
        return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      }
    }
    for (const part of payload.parts) {
      if (part.parts) {
        const nested = extractBody(part);
        if (nested) return nested;
      }
    }
  }
  return "";
}

function extractAttachments(payload: GmailMessagePart | undefined): EmailFull["attachments"] {
  const attachments: EmailFull["attachments"] = [];
  function walk(parts: GmailMessagePart[]) {
    for (const part of parts || []) {
      if (part.filename && part.body?.attachmentId) {
        attachments.push({
          id: part.body.attachmentId,
          filename: part.filename,
          mimeType: part.mimeType || "application/octet-stream",
          size: part.body.size || 0,
        });
      }
      if (part.parts) walk(part.parts);
    }
  }
  walk(payload?.parts || []);
  return attachments;
}

// --- List emails (metadata only) ---

export async function listEmails(opts: {
  maxResults?: number;
  query?: string;
}): Promise<EmailSummary[]> {
  const maxResults = opts.maxResults || 10;
  const q = opts.query || "";

  const listData = await googleFetchJSON<GmailMessageList>(
    `${GMAIL}/messages?maxResults=${maxResults}&q=${encodeURIComponent(q)}`
  );
  if (!listData.messages || listData.messages.length === 0) return [];

  return Promise.all(
    listData.messages.map(async (msg) => {
      const m = await googleFetchJSON<GmailMessage>(
        `${GMAIL}/messages/${msg.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`
      );
      const headers = m.payload?.headers || [];
      return {
        id: m.id,
        threadId: m.threadId,
        from: getHeader(headers, "From"),
        to: getHeader(headers, "To"),
        subject: getHeader(headers, "Subject"),
        date: getHeader(headers, "Date"),
        unread: (m.labelIds || []).includes("UNREAD"),
        snippet: m.snippet || "",
      };
    })
  );
}

// --- Read full email ---

export async function readEmail(messageId: string): Promise<EmailFull> {
  const m = await googleFetchJSON<GmailMessage>(`${GMAIL}/messages/${messageId}?format=full`);
  const headers = m.payload?.headers || [];

  return {
    id: m.id,
    threadId: m.threadId,
    from: getHeader(headers, "From"),
    to: getHeader(headers, "To"),
    cc: getHeader(headers, "Cc"),
    bcc: getHeader(headers, "Bcc"),
    subject: getHeader(headers, "Subject"),
    date: getHeader(headers, "Date"),
    messageId: getHeader(headers, "Message-ID"),
    unread: (m.labelIds || []).includes("UNREAD"),
    snippet: m.snippet || "",
    body: extractBody(m.payload),
    labels: m.labelIds || [],
    attachments: extractAttachments(m.payload),
  };
}

// --- Search emails (with full body) ---

export async function searchEmails(opts: {
  query: string;
  maxResults?: number;
}): Promise<EmailFull[]> {
  const maxResults = Math.min(opts.maxResults || 5, 10);
  const listData = await googleFetchJSON<any>(
    `${GMAIL}/messages?maxResults=${maxResults}&q=${encodeURIComponent(opts.query)}`
  );
  if (!listData.messages || listData.messages.length === 0) return [];

  return Promise.all(
    listData.messages.map(async (msg: { id: string }) => readEmail(msg.id))
  );
}

// --- Trash email ---

export async function trashEmail(messageId: string): Promise<boolean> {
  const res = await googleFetch(`${GMAIL}/messages/${messageId}/trash`, {
    method: "POST",
  });
  return res.ok;
}

// --- Send email ---

export async function sendEmail(opts: {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
  threadId?: string;
  inReplyTo?: string;
  references?: string;
}): Promise<{ id: string; threadId: string }> {
  const hdrs = buildEmailHeaders(opts);
  const raw = Buffer.from(hdrs.join("\r\n") + "\r\n\r\n" + opts.body).toString("base64url");

  const payload: { raw: string; threadId?: string } = { raw };
  if (opts.threadId) payload.threadId = opts.threadId;

  return googleFetchJSON(`${GMAIL}/messages/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

// --- Reply to email ---

export async function replyToEmail(opts: {
  messageId: string;
  body: string;
  cc?: string;
}): Promise<{ id: string; threadId: string }> {
  const original = await readEmail(opts.messageId);
  const subject = original.subject.startsWith("Re:")
    ? original.subject
    : `Re: ${original.subject}`;

  return sendEmail({
    to: original.from,
    subject,
    body: opts.body,
    cc: opts.cc,
    threadId: original.threadId,
    inReplyTo: original.messageId,
    references: original.messageId,
  });
}

// --- Modify labels ---

export async function modifyLabels(
  messageId: string,
  addLabels: string[],
  removeLabels: string[]
): Promise<boolean> {
  const res = await googleFetch(`${GMAIL}/messages/${messageId}/modify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      addLabelIds: addLabels,
      removeLabelIds: removeLabels,
    }),
  });
  return res.ok;
}

// --- Create draft ---

export async function createDraft(opts: {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
}): Promise<{ id: string; messageId: string }> {
  const hdrs = buildEmailHeaders(opts);
  const raw = Buffer.from(hdrs.join("\r\n") + "\r\n\r\n" + opts.body).toString("base64url");

  const data = await googleFetchJSON<GmailDraftResponse>(`${GMAIL}/drafts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: { raw } }),
  });
  return { id: data.id, messageId: data.message?.id || "" };
}

// --- Get attachment ---

export async function getAttachment(
  messageId: string,
  attachmentId: string
): Promise<{ data: string; size: number }> {
  return googleFetchJSON(
    `${GMAIL}/messages/${messageId}/attachments/${attachmentId}`
  );
}
