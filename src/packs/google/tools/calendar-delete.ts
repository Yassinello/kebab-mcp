import { z } from "zod";
import { deleteEvent } from "../lib/calendar";

export const calendarDeleteSchema = {
  event_id: z.string().describe("Event ID (from calendar_events results)"),
  calendar_id: z.string().optional().describe('Calendar ID (default: "primary")'),
};

export async function handleCalendarDelete(params: { event_id: string; calendar_id?: string }) {
  const ok = await deleteEvent(params.event_id, params.calendar_id);
  return {
    content: [
      {
        type: "text" as const,
        text: ok
          ? `Event ${params.event_id} deleted.`
          : `Failed to delete event ${params.event_id}. It may be on a different calendar — try specifying calendar_id.`,
      },
    ],
  };
}
