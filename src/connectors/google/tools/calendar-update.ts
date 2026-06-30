import { z } from "zod";
import { updateEvent } from "../lib/calendar";
import { resolveGoogleTokens } from "../lib/resolve-account";

export const calendarUpdateSchema = {
  event_id: z.string().describe("Event ID (from calendar_events results)"),
  calendar_id: z.string().optional().describe('Calendar ID (default: "primary")'),
  summary: z.string().optional().describe("New event title"),
  start: z.string().optional().describe("New start time (ISO 8601 datetime or date)"),
  end: z.string().optional().describe("New end time (ISO 8601 datetime or date)"),
  description: z.string().optional().describe("New description"),
  location: z.string().optional().describe("New location"),
  account: z
    .string()
    .optional()
    .describe(
      "Which connected account to use (name or slug). Omit to use the pinned default / your only account."
    ),
};

export async function handleCalendarUpdate(params: {
  event_id: string;
  calendar_id?: string | undefined;
  summary?: string | undefined;
  start?: string | undefined;
  end?: string | undefined;
  description?: string | undefined;
  location?: string | undefined;
  account?: string | undefined;
}) {
  const r = await resolveGoogleTokens(params.account);
  if (!r.ok) return r.result;

  const event = await updateEvent(r.ctx, {
    eventId: params.event_id,
    calendarId: params.calendar_id,
    summary: params.summary,
    start: params.start,
    end: params.end,
    description: params.description,
    location: params.location,
  });

  return {
    content: [
      {
        type: "text" as const,
        text: `Event updated: "${event.summary}" — ${event.start} → ${event.end}`,
      },
    ],
  };
}
