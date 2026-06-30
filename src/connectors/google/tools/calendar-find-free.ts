import { getInstanceConfig } from "@/core/config";
import { z } from "zod";
import { findFreeTime } from "../lib/calendar";
import { resolveGoogleTokens } from "../lib/resolve-account";

export const calendarFindFreeSchema = {
  duration_minutes: z.number().describe("Duration of the slot needed in minutes (e.g. 30, 60)"),
  days: z.number().optional().describe("Number of days to look ahead (default: 5, max: 14)"),
  start_date: z
    .string()
    .optional()
    .describe("Start date (ISO 8601, default: now). Example: 2026-04-07T08:00:00+02:00"),
  account: z
    .string()
    .optional()
    .describe(
      "Which connected account to use (name or slug). Omit to use the pinned default / your only account."
    ),
};

export async function handleCalendarFindFree(params: {
  duration_minutes: number;
  days?: number | undefined;
  start_date?: string | undefined;
  account?: string | undefined;
}) {
  const r = await resolveGoogleTokens(params.account);
  if (!r.ok) return r.result;

  const now = new Date();
  const timeMin = params.start_date || now.toISOString();
  const days = Math.min(params.days || 5, 14);
  const timeMax = new Date(new Date(timeMin).getTime() + days * 86400000).toISOString();

  const slots = await findFreeTime(r.ctx, {
    timeMin,
    timeMax,
    durationMinutes: params.duration_minutes,
  });

  if (slots.length === 0) {
    return {
      content: [
        {
          type: "text" as const,
          text: `No free ${params.duration_minutes}-minute slots found in the next ${days} days.`,
        },
      ],
    };
  }

  const lines = slots.map((s) => {
    const start = new Date(s.start);
    const end = new Date(s.end);
    const day = start.toLocaleDateString(getInstanceConfig().locale, {
      weekday: "short",
      day: "numeric",
      month: "short",
      timeZone: getInstanceConfig().timezone,
    });
    const from = start.toLocaleTimeString(getInstanceConfig().locale, {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: getInstanceConfig().timezone,
    });
    const to = end.toLocaleTimeString(getInstanceConfig().locale, {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: getInstanceConfig().timezone,
    });
    return `${day} ${from}–${to}`;
  });

  return {
    content: [
      {
        type: "text" as const,
        text: `Free ${params.duration_minutes}-min slots (next ${days} days):\n\n${lines.join("\n")}`,
      },
    ],
  };
}
