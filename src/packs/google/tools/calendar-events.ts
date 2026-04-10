import { getInstanceConfig } from "@/core/config";
import { z } from "zod";
import { listEventsAllCalendars } from "../lib/calendar";

export const calendarEventsSchema = {
  days: z.number().optional().describe("Number of days to look ahead (default: 7)"),
};

export async function handleCalendarEvents(params: { days?: number }) {
  const now = new Date();
  const timeMax = new Date(now.getTime() + (params.days || 7) * 86400000).toISOString();

  const events = await listEventsAllCalendars({
    timeMin: now.toISOString(),
    timeMax,
  });

  if (events.length === 0) {
    return { content: [{ type: "text" as const, text: "No events found." }] };
  }

  const lines = events.map((e) => {
    const start = new Date(e.start);
    const day = start.toLocaleDateString(getInstanceConfig().locale, {
      weekday: "short",
      day: "numeric",
      month: "short",
      timeZone: getInstanceConfig().timezone,
    });
    const time = e.start.includes("T")
      ? start.toLocaleTimeString(getInstanceConfig().locale, {
          hour: "2-digit",
          minute: "2-digit",
          timeZone: getInstanceConfig().timezone,
        })
      : "Journee";
    const meet = e.hangoutLink ? " [Meet]" : "";
    const loc = e.location ? ` @ ${e.location}` : "";
    return `${day} ${time} — ${e.summary} (${e.calendar})${loc}${meet}`;
  });

  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
  };
}
