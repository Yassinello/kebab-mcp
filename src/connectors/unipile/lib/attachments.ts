/**
 * Attachment decoding shared by the spec-v2 send tools.
 *
 * Pre-flight only (no side effects): size is estimated from the base64 length
 * BEFORE decoding so an oversized payload is rejected without allocating it.
 */

import { z } from "zod";
import type { Attachment } from "../provider";

export const ATTACHMENT_MAX_BYTES = 15 * 1024 * 1024; // 15 MB

export const LINKEDIN_ATTACHMENT_MIMETYPES = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
] as const;

export const WHATSAPP_ATTACHMENT_MIMETYPES = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "video/mp4",
  "audio/mpeg",
  "audio/ogg",
  "text/plain",
  "text/csv",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
] as const;

export function attachmentsSchema(mimetypes: readonly [string, ...string[]]) {
  return z
    .array(
      z.object({
        filename: z.string().min(1).max(255),
        mimetype: z.enum(mimetypes),
        base64: z.string().min(1),
      })
    )
    .max(5)
    .optional()
    .describe("Optional files, base64-encoded. Max 5 files, ≤15 MB each.");
}

export interface AttachmentInput {
  filename: string;
  mimetype: string;
  base64: string;
}

export type DecodeResult =
  | { ok: true; attachments: Attachment[] }
  | { ok: false; error: "error_attachment_too_large"; detail: string };

export function decodeAttachments(list: AttachmentInput[] | undefined): DecodeResult {
  const out: Attachment[] = [];
  for (const a of list ?? []) {
    const estimated = Math.floor((a.base64.length * 3) / 4);
    if (estimated > ATTACHMENT_MAX_BYTES + 3) {
      return {
        ok: false,
        error: "error_attachment_too_large",
        detail: `${a.filename} is ~${estimated} bytes (limit ${ATTACHMENT_MAX_BYTES}).`,
      };
    }
    const buf = Buffer.from(a.base64, "base64");
    if (buf.byteLength > ATTACHMENT_MAX_BYTES) {
      return {
        ok: false,
        error: "error_attachment_too_large",
        detail: `${a.filename} is ${buf.byteLength} bytes (limit ${ATTACHMENT_MAX_BYTES}).`,
      };
    }
    out.push([a.filename, buf]);
  }
  return { ok: true, attachments: out };
}
