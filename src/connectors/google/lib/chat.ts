import { googleFetchJSON } from "./google-fetch";

const CHAT = "https://chat.googleapis.com/v1";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

// --- Google Chat API response types ---

interface ChatSenderResponse {
  name: string;
  displayName?: string;
}

interface ChatSpaceResponse {
  name: string;
  type?: string;
  spaceType?: string;
  displayName?: string;
}

interface ChatMessageResponse {
  name: string;
  sender?: ChatSenderResponse;
  text?: string;
  createTime?: string;
}

interface ListSpacesResponse {
  spaces?: ChatSpaceResponse[];
  nextPageToken?: string;
}

interface ListMessagesResponse {
  messages?: ChatMessageResponse[];
  nextPageToken?: string;
}

// --- Normalized shapes consumed by the tools ---

export interface ChatSender {
  name: string;
  displayName?: string | undefined;
}

export interface ChatSpace {
  name: string;
  type: string;
  displayName?: string | undefined;
}

export interface ChatMessage {
  name: string;
  sender: ChatSender;
  text: string;
  createTime: string;
}

export interface ListSpacesResult {
  spaces: ChatSpace[];
  nextPageToken?: string | undefined;
}

export interface ListMessagesResult {
  messages: ChatMessage[];
  nextPageToken?: string | undefined;
}

function clampPageSize(pageSize?: number): number {
  if (!pageSize || pageSize < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(pageSize, MAX_PAGE_SIZE);
}

function normalizeSpace(s: ChatSpaceResponse): ChatSpace {
  // The Chat API uses `spaceType` (SPACE | DIRECT_MESSAGE | GROUP_CHAT) on
  // newer responses and the legacy `type` (ROOM | DM) on older ones.
  const raw = s.spaceType || s.type || "";
  const type = raw === "DM" || raw === "DIRECT_MESSAGE" ? "DM" : "SPACE";
  return {
    name: s.name,
    type,
    displayName: s.displayName,
  };
}

function normalizeMessage(m: ChatMessageResponse): ChatMessage {
  return {
    name: m.name,
    sender: {
      name: m.sender?.name || "",
      displayName: m.sender?.displayName,
    },
    text: m.text || "",
    createTime: m.createTime || "",
  };
}

// --- List spaces ---

export async function listSpaces(
  opts: {
    pageSize?: number | undefined;
    pageToken?: string | undefined;
  } = {}
): Promise<ListSpacesResult> {
  const params = new URLSearchParams({ pageSize: String(clampPageSize(opts.pageSize)) });
  if (opts.pageToken) params.set("pageToken", opts.pageToken);

  const data = await googleFetchJSON<ListSpacesResponse>(`${CHAT}/spaces?${params.toString()}`);

  return {
    spaces: (data.spaces || []).map(normalizeSpace),
    nextPageToken: data.nextPageToken,
  };
}

// --- List messages in a space ---

export async function listMessages(
  spaceName: string,
  opts: {
    pageSize?: number | undefined;
    pageToken?: string | undefined;
  } = {}
): Promise<ListMessagesResult> {
  const params = new URLSearchParams({
    pageSize: String(clampPageSize(opts.pageSize)),
    // Newest first so the tool surfaces recent activity.
    orderBy: "createTime desc",
  });
  if (opts.pageToken) params.set("pageToken", opts.pageToken);

  const data = await googleFetchJSON<ListMessagesResponse>(
    `${CHAT}/${spaceName}/messages?${params.toString()}`
  );

  return {
    messages: (data.messages || []).map(normalizeMessage),
    nextPageToken: data.nextPageToken,
  };
}

// --- Create (send) a message ---

export async function createMessage(spaceName: string, text: string): Promise<ChatMessage> {
  const data = await googleFetchJSON<ChatMessageResponse>(`${CHAT}/${spaceName}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });

  return normalizeMessage(data);
}
