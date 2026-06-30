import { z } from "zod";
import { rsvpEvent } from "../lib/calendar";
import { resolveGoogleTokens } from "../lib/resolve-account";

export const calendarRsvpSchema = {
  event_id: z.string().describe("Event ID (from calendar_events results)"),
  response: z
    .enum(["accepted", "declined", "tentative"])
    .describe("RSVP response: accepted, declined, or tentative"),
  calendar_id: z.string().optional().describe('Calendar ID (default: "primary")'),
  account: z
    .string()
    .optional()
    .describe(
      "Which connected account to use (name or slug). Omit to use the pinned default / your only account."
    ),
};

export async function handleCalendarRsvp(params: {
  event_id: string;
  response: "accepted" | "declined" | "tentative";
  calendar_id?: string | undefined;
  account?: string | undefined;
}) {
  const r = await resolveGoogleTokens(params.account);
  if (!r.ok) return r.result;

  const ok = await rsvpEvent(r.ctx, {
    eventId: params.event_id,
    calendarId: params.calendar_id,
    response: params.response,
  });

  const emoji = { accepted: "accepted", declined: "declined", tentative: "maybe" };
  return {
    content: [
      {
        type: "text" as const,
        text: ok
          ? `RSVP sent: ${emoji[params.response]} for event ${params.event_id}`
          : `Failed to RSVP. The event may not have attendees or may be on a different calendar.`,
      },
    ],
  };
}
