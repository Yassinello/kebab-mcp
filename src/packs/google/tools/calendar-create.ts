import { getInstanceConfig } from "@/core/config";
import { z } from "zod";
import { createEvent } from "../lib/calendar";

export const calendarCreateSchema = {
  summary: z.string().describe("Event title"),
  start: z
    .string()
    .describe(
      'Start time — ISO 8601 datetime (2026-04-07T09:00:00+02:00) or date (2026-04-07) for all-day events'
    ),
  end: z
    .string()
    .describe(
      'End time — ISO 8601 datetime (2026-04-07T10:00:00+02:00) or date (2026-04-08) for all-day events'
    ),
  description: z.string().optional().describe("Event description"),
  location: z.string().optional().describe("Event location"),
  calendar_id: z
    .string()
    .optional()
    .describe('Calendar ID (default: "primary"). Use calendar_events to list available calendars.'),
};

export async function handleCalendarCreate(params: {
  summary: string;
  start: string;
  end: string;
  description?: string;
  location?: string;
  calendar_id?: string;
}) {
  const event = await createEvent({
    summary: params.summary,
    start: params.start,
    end: params.end,
    description: params.description,
    location: params.location,
    calendarId: params.calendar_id,
  });

  const time = event.start.includes("T")
    ? new Date(event.start).toLocaleString(getInstanceConfig().locale, {
        weekday: "short",
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: getInstanceConfig().timezone,
      })
    : event.start;

  return {
    content: [
      {
        type: "text" as const,
        text: `Event created: "${event.summary}" — ${time} (id: ${event.id})`,
      },
    ],
  };
}
