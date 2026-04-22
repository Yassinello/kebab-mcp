import { McpToolError, ErrorCode } from "@/core/errors";
import { getConfig } from "@/core/config-facade";
import { toMsg } from "@/core/error-utils";

const AIRTABLE_BASE_URL = "https://api.airtable.com/v0";

export async function airtableRequest<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const apiKey = getConfig("AIRTABLE_API_KEY");
  if (!apiKey) {
    throw new McpToolError({
      code: ErrorCode.CONFIGURATION_ERROR,
      toolName: "airtable",
      message: "AIRTABLE_API_KEY not configured",
      userMessage:
        "Airtable pack is not configured. Add AIRTABLE_API_KEY to your environment variables.",
      retryable: false,
    });
  }

  const url = endpoint.startsWith("http") ? endpoint : `${AIRTABLE_BASE_URL}${endpoint}`;

  let res: Response;
  try {
    res = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...(options.headers ?? {}),
      },
    });
  } catch (err) {
    throw new McpToolError({
      code: ErrorCode.EXTERNAL_API_ERROR,
      toolName: "airtable",
      message: `Network error reaching Airtable API: ${toMsg(err)}`,
      userMessage: "Could not reach the Airtable API. Check your network connection.",
      retryable: true,
      cause: err instanceof Error ? err : undefined,
    });
  }

  if (res.status === 401) {
    throw new McpToolError({
      code: ErrorCode.AUTH_FAILED,
      toolName: "airtable",
      message: "Airtable API key is invalid or expired",
      userMessage: "Airtable authentication failed. Check your AIRTABLE_API_KEY.",
      retryable: false,
    });
  }

  if (res.status === 403) {
    throw new McpToolError({
      code: ErrorCode.PERMISSION_DENIED,
      toolName: "airtable",
      message: "Airtable API permission denied",
      userMessage: "You don't have permission to access this Airtable resource.",
      retryable: false,
    });
  }

  if (res.status === 404) {
    throw new McpToolError({
      code: ErrorCode.NOT_FOUND,
      toolName: "airtable",
      message: "Airtable resource not found",
      userMessage: "The requested Airtable base, table, or record was not found.",
      retryable: false,
    });
  }

  if (res.status === 422) {
    const body = await res.text();
    throw new McpToolError({
      code: ErrorCode.INVALID_INPUT,
      toolName: "airtable",
      message: `Airtable invalid input: ${body}`,
      userMessage: `Airtable rejected the request: ${body}`,
      retryable: false,
    });
  }

  if (res.status === 429) {
    throw new McpToolError({
      code: ErrorCode.RATE_LIMITED,
      toolName: "airtable",
      message: "Airtable API rate limit exceeded",
      userMessage: "Airtable API rate limit hit. Try again shortly.",
      retryable: true,
    });
  }

  if (res.status >= 500) {
    throw new McpToolError({
      code: ErrorCode.EXTERNAL_API_ERROR,
      toolName: "airtable",
      message: `Airtable API server error ${res.status}`,
      userMessage: "Airtable API returned a server error. Try again later.",
      retryable: true,
    });
  }

  if (!res.ok) {
    throw new McpToolError({
      code: ErrorCode.EXTERNAL_API_ERROR,
      toolName: "airtable",
      message: `Airtable API HTTP error ${res.status}`,
      userMessage: `Airtable API returned an error (${res.status}). Try again later.`,
      retryable: false,
    });
  }

  return res.json() as Promise<T>;
}

/**
 * Render an Airtable field value as human-readable text.
 * Handles strings, arrays, linked records, attachments, and other types.
 */
export function formatFieldValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object") {
          // Linked record: { id, name }
          const rec = item as Record<string, unknown>;
          if ("name" in rec) return String(rec.name);
          // Attachment: { url, filename }
          if ("filename" in rec) return String(rec.filename);
          return JSON.stringify(item);
        }
        return String(item);
      })
      .join(", ");
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if ("name" in obj) return String(obj.name);
    if ("url" in obj) return String(obj.url);
    return JSON.stringify(value);
  }
  return String(value);
}
