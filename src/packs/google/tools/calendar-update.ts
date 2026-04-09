import { z } from "zod";
import { updateEvent } from "../lib/calendar";

export const calendarUpdateSchema = {
  event_id: z.string().describe("Event ID (from calendar_events results)"),
  calendar_id: z.string().optional().describe('Calendar ID (default: "primary")'),
  summary: z.string().optional().describe("New event title"),
  start: z.string().optional().describe("New start time (ISO 8601 datetime or date)"),
  end: z.string().optional().describe("New end time (ISO 8601 datetime or date)"),
  description: z.string().optional().describe("New description"),
  location: z.string().optional().describe("New location"),
};

export async function handleCalendarUpdate(params: {
  event_id: string;
  calendar_id?: string;
  summary?: string;
  start?: string;
  end?: string;
  description?: string;
  location?: string;
}) {
  const event = await updateEvent({
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
