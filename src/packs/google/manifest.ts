import type { PackManifest } from "@/core/types";
import { gmailInboxSchema, handleGmailInbox } from "./tools/gmail-inbox";
import { gmailReadSchema, handleGmailRead } from "./tools/gmail-read";
import { gmailSendSchema, handleGmailSend } from "./tools/gmail-send";
import { gmailReplySchema, handleGmailReply } from "./tools/gmail-reply";
import { gmailTrashSchema, handleGmailTrash } from "./tools/gmail-trash";
import { gmailLabelSchema, handleGmailLabel } from "./tools/gmail-label";
import { gmailSearchSchema, handleGmailSearch } from "./tools/gmail-search";
import { gmailDraftSchema, handleGmailDraft } from "./tools/gmail-draft";
import { gmailAttachmentSchema, handleGmailAttachment } from "./tools/gmail-attachment";
import { calendarEventsSchema, handleCalendarEvents } from "./tools/calendar-events";
import { calendarCreateSchema, handleCalendarCreate } from "./tools/calendar-create";
import { calendarDeleteSchema, handleCalendarDelete } from "./tools/calendar-delete";
import { calendarUpdateSchema, handleCalendarUpdate } from "./tools/calendar-update";
import { calendarFindFreeSchema, handleCalendarFindFree } from "./tools/calendar-find-free";
import { calendarRsvpSchema, handleCalendarRsvp } from "./tools/calendar-rsvp";
import { contactsSearchSchema, handleContactsSearch } from "./tools/contacts-search";
import { driveSearchSchema, handleDriveSearch } from "./tools/drive-search";
import { driveReadSchema, handleDriveRead } from "./tools/drive-read";

export const googlePack: PackManifest = {
  id: "google",
  label: "Google Workspace",
  description: "Gmail, Calendar, Contacts, Drive",
  requiredEnvVars: [
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "GOOGLE_REFRESH_TOKEN",
  ],
  tools: [
    {
      name: "gmail_inbox",
      description:
        "List recent emails from Gmail. Supports Gmail search queries (is:unread, from:xxx, subject:xxx, newer_than:7d). Returns sender, subject, date, read/unread status, snippet, and message ID.",
      schema: gmailInboxSchema,
      handler: async (params) =>
        handleGmailInbox(params as { max_results?: number; query?: string }),
    },
    {
      name: "gmail_read",
      description:
        "Read the full content of an email (body, headers, attachments list). Use the message ID from gmail_inbox.",
      schema: gmailReadSchema,
      handler: async (params) =>
        handleGmailRead(params as { message_id: string }),
    },
    {
      name: "gmail_send",
      description:
        "Send a new email. Supports To, CC, BCC. Plain text body. Always show the draft to the user for approval before calling this tool.",
      schema: gmailSendSchema,
      handler: async (params) =>
        handleGmailSend(
          params as {
            to: string;
            subject: string;
            body: string;
            cc?: string;
            bcc?: string;
          }
        ),
    },
    {
      name: "gmail_reply",
      description:
        "Reply to an existing email thread. Automatically sets In-Reply-To, References, and thread ID. Always show the reply to the user for approval before calling this tool.",
      schema: gmailReplySchema,
      handler: async (params) =>
        handleGmailReply(
          params as { message_id: string; body: string; cc?: string }
        ),
    },
    {
      name: "gmail_trash",
      description:
        "Move an email to trash. Requires the message ID from gmail_inbox.",
      schema: gmailTrashSchema,
      handler: async (params) =>
        handleGmailTrash(params as { message_id: string }),
    },
    {
      name: "gmail_label",
      description:
        "Add or remove labels on an email. Use to archive (remove INBOX), mark read (remove UNREAD), star (add STARRED), etc.",
      schema: gmailLabelSchema,
      handler: async (params) =>
        handleGmailLabel(
          params as { message_id: string; add?: string; remove?: string }
        ),
    },
    {
      name: "gmail_search",
      description:
        "Search emails with full body content. Supports all Gmail operators (from:, subject:, has:attachment, after:, label:, etc.). Returns up to 10 results with full message body.",
      schema: gmailSearchSchema,
      handler: async (params) =>
        handleGmailSearch(params as { query: string; max_results?: number }),
    },
    {
      name: "gmail_draft",
      description:
        "Create a draft email in Gmail without sending it. The user can review and send from Gmail. Safer than gmail_send for important emails.",
      schema: gmailDraftSchema,
      handler: async (params) =>
        handleGmailDraft(
          params as {
            to: string;
            subject: string;
            body: string;
            cc?: string;
            bcc?: string;
          }
        ),
    },
    {
      name: "gmail_attachment",
      description:
        "Download and read an email attachment. Returns text content for text files, or metadata for binary files. Get attachment IDs from gmail_read.",
      schema: gmailAttachmentSchema,
      handler: async (params) =>
        handleGmailAttachment(
          params as { message_id: string; attachment_id?: string }
        ),
    },
    {
      name: "calendar_events",
      description:
        "List upcoming events from all Google Calendars (personal, shared, etc.). Returns event title, time, calendar name, location, and Meet link.",
      schema: calendarEventsSchema,
      handler: async (params) =>
        handleCalendarEvents(params as { days?: number }),
    },
    {
      name: "calendar_create",
      description:
        "Create a new event on Google Calendar. Supports datetime or all-day events, location, and description. Default calendar is primary.",
      schema: calendarCreateSchema,
      handler: async (params) =>
        handleCalendarCreate(
          params as {
            summary: string;
            start: string;
            end: string;
            description?: string;
            location?: string;
            calendar_id?: string;
          }
        ),
    },
    {
      name: "calendar_delete",
      description:
        "Delete/cancel an event from Google Calendar. Requires event ID from calendar_events.",
      schema: calendarDeleteSchema,
      handler: async (params) =>
        handleCalendarDelete(
          params as { event_id: string; calendar_id?: string }
        ),
    },
    {
      name: "calendar_update",
      description:
        "Update an existing calendar event (reschedule, rename, change location). Only pass the fields you want to change.",
      schema: calendarUpdateSchema,
      handler: async (params) =>
        handleCalendarUpdate(
          params as {
            event_id: string;
            calendar_id?: string;
            summary?: string;
            start?: string;
            end?: string;
            description?: string;
            location?: string;
          }
        ),
    },
    {
      name: "calendar_find_free",
      description:
        "Find free time slots across all calendars. Checks busy times via FreeBusy API and returns available slots during configured working hours.",
      schema: calendarFindFreeSchema,
      handler: async (params) =>
        handleCalendarFindFree(
          params as {
            duration_minutes: number;
            days?: number;
            start_date?: string;
          }
        ),
    },
    {
      name: "calendar_rsvp",
      description:
        "Accept, decline, or tentatively accept a calendar invitation. Sends update to organizer.",
      schema: calendarRsvpSchema,
      handler: async (params) =>
        handleCalendarRsvp(
          params as {
            event_id: string;
            response: "accepted" | "declined" | "tentative";
            calendar_id?: string;
          }
        ),
    },
    {
      name: "contacts_search",
      description:
        "Search Google Contacts by name, email, phone, or company. Returns name, email, phone, organization, and job title. Use to find someone's email before sending.",
      schema: contactsSearchSchema,
      handler: async (params) =>
        handleContactsSearch(
          params as { query: string; max_results?: number }
        ),
    },
    {
      name: "drive_search",
      description:
        "Search Google Drive for files by name or content. Returns file name, type (Doc/Sheet/Slides/PDF), last modified date, and link. Searches across all shared drives.",
      schema: driveSearchSchema,
      handler: async (params) =>
        handleDriveSearch(params as { query: string; max_results?: number }),
    },
    {
      name: "drive_read",
      description:
        "Read the content of a Google Drive file. Exports Google Docs as plain text, Sheets as CSV, Slides as text. For binary files (PDF, images), returns metadata with a link.",
      schema: driveReadSchema,
      handler: async (params) =>
        handleDriveRead(params as { file_id: string }),
    },
  ],
};
