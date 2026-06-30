import { z } from "zod";
import { deleteEvent } from "../lib/calendar";
import { resolveGoogleTokens } from "../lib/resolve-account";

export const calendarDeleteSchema = {
  event_id: z.string().describe("Event ID (from calendar_events results)"),
  calendar_id: z.string().optional().describe('Calendar ID (default: "primary")'),
  account: z
    .string()
    .optional()
    .describe(
      "Which connected account to use (name or slug). Omit to use the pinned default / your only account."
    ),
};

export async function handleCalendarDelete(params: {
  event_id: string;
  calendar_id?: string | undefined;
  account?: string | undefined;
}) {
  const r = await resolveGoogleTokens(params.account);
  if (!r.ok) return r.result;

  const ok = await deleteEvent(r.ctx, params.event_id, params.calendar_id);
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
