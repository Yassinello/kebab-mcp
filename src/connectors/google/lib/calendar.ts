import { getInstanceConfig } from "@/core/config";
import type { GoogleAuthContext } from "./google-auth";
import { googleFetch, googleFetchJSON } from "./google-fetch";

const CAL = "https://www.googleapis.com/calendar/v3";

// --- Google API response types ---

interface CalendarListResponse {
  items?: { id: string; summary?: string }[];
}

interface CalendarEventsResponse {
  items?: {
    id: string;
    summary?: string;
    start?: { dateTime?: string; date?: string };
    end?: { dateTime?: string; date?: string };
    location?: string;
    hangoutLink?: string;
    status?: string;
  }[];
}

interface CalendarEventResponse {
  id: string;
  summary?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  location?: string;
  hangoutLink?: string;
  htmlLink?: string;
  attendees?: { email: string; self?: boolean; responseStatus?: string }[];
}

interface FreeBusyResponse {
  calendars?: Record<string, { busy?: { start: string; end: string }[] }>;
}

export interface CalendarEvent {
  id: string;
  summary: string;
  start: string;
  end: string;
  calendar: string;
  location?: string | undefined;
  hangoutLink?: string | undefined;
}

export interface CalendarInfo {
  id: string;
  summary: string;
}

// --- List calendars ---

export async function listAllCalendars(ctx: GoogleAuthContext): Promise<CalendarInfo[]> {
  const data = await googleFetchJSON<CalendarListResponse>(ctx, `${CAL}/users/me/calendarList`);
  return (data.items || []).map((c: { id: string; summary?: string }) => ({
    id: c.id,
    summary: c.summary || c.id,
  }));
}

// --- List events ---

export async function listEventsAllCalendars(
  ctx: GoogleAuthContext,
  opts: {
    timeMin?: string | undefined;
    timeMax?: string | undefined;
  }
): Promise<CalendarEvent[]> {
  const now = new Date();
  const timeMin = opts.timeMin || now.toISOString();
  const timeMax = opts.timeMax || new Date(now.getTime() + 7 * 86400000).toISOString();

  const calendars = await listAllCalendars(ctx);

  const allEvents = await Promise.all(
    calendars.map(async (cal) => {
      const url =
        `${CAL}/calendars/${encodeURIComponent(cal.id)}/events?` +
        `timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}` +
        `&singleEvents=true&orderBy=startTime&maxResults=50`;

      const data = await googleFetchJSON<CalendarEventsResponse>(ctx, url);

      return (data.items || []).map(
        (e: {
          id: string;
          summary?: string;
          start?: { dateTime?: string; date?: string };
          end?: { dateTime?: string; date?: string };
          location?: string;
          hangoutLink?: string;
        }) => ({
          id: e.id,
          summary: e.summary || "(untitled)",
          start: e.start?.dateTime || e.start?.date || "",
          end: e.end?.dateTime || e.end?.date || "",
          calendar: cal.summary,
          location: e.location,
          hangoutLink: e.hangoutLink,
        })
      );
    })
  );

  return allEvents.flat().sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
}

// --- Create event ---

export async function createEvent(
  ctx: GoogleAuthContext,
  opts: {
    summary: string;
    start: string;
    end: string;
    calendarId?: string | undefined;
    description?: string | undefined;
    location?: string | undefined;
  }
): Promise<CalendarEvent> {
  const calId = opts.calendarId || "primary";
  const isAllDay = !opts.start.includes("T");

  const startField = isAllDay
    ? { date: opts.start }
    : { dateTime: opts.start, timeZone: getInstanceConfig().timezone };
  const endField = isAllDay
    ? { date: opts.end }
    : { dateTime: opts.end, timeZone: getInstanceConfig().timezone };

  const e = await googleFetchJSON<CalendarEventResponse>(
    ctx,
    `${CAL}/calendars/${encodeURIComponent(calId)}/events`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: opts.summary,
        description: opts.description,
        location: opts.location,
        start: startField,
        end: endField,
      }),
    }
  );

  return {
    id: e.id,
    summary: e.summary || opts.summary,
    start: e.start?.dateTime || e.start?.date || opts.start,
    end: e.end?.dateTime || e.end?.date || opts.end,
    calendar: calId,
    location: e.location,
    hangoutLink: e.hangoutLink,
  };
}

// --- Delete event ---

export async function deleteEvent(
  ctx: GoogleAuthContext,
  eventId: string,
  calendarId?: string
): Promise<boolean> {
  const calId = calendarId || "primary";
  const res = await googleFetch(
    ctx,
    `${CAL}/calendars/${encodeURIComponent(calId)}/events/${encodeURIComponent(eventId)}`,
    { method: "DELETE" }
  );
  return res.ok;
}

// --- Update event ---

export async function updateEvent(
  ctx: GoogleAuthContext,
  opts: {
    eventId: string;
    calendarId?: string | undefined;
    summary?: string | undefined;
    start?: string | undefined;
    end?: string | undefined;
    description?: string | undefined;
    location?: string | undefined;
  }
): Promise<CalendarEvent> {
  const calId = opts.calendarId || "primary";

  const patch: Record<string, unknown> = {};
  if (opts.summary) patch.summary = opts.summary;
  if (opts.description !== undefined) patch.description = opts.description;
  if (opts.location !== undefined) patch.location = opts.location;
  if (opts.start) {
    patch.start = !opts.start.includes("T")
      ? { date: opts.start }
      : { dateTime: opts.start, timeZone: getInstanceConfig().timezone };
  }
  if (opts.end) {
    patch.end = !opts.end.includes("T")
      ? { date: opts.end }
      : { dateTime: opts.end, timeZone: getInstanceConfig().timezone };
  }

  const e = await googleFetchJSON<CalendarEventResponse>(
    ctx,
    `${CAL}/calendars/${encodeURIComponent(calId)}/events/${encodeURIComponent(opts.eventId)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }
  );

  return {
    id: e.id,
    summary: e.summary || "(untitled)",
    start: e.start?.dateTime || e.start?.date || "",
    end: e.end?.dateTime || e.end?.date || "",
    calendar: calId,
    location: e.location,
    hangoutLink: e.hangoutLink,
  };
}

// --- Find free time ---

export async function findFreeTime(
  ctx: GoogleAuthContext,
  opts: {
    timeMin: string;
    timeMax: string;
    durationMinutes: number;
  }
): Promise<{ start: string; end: string }[]> {
  const calendars = await listAllCalendars(ctx);

  const data = await googleFetchJSON<FreeBusyResponse>(ctx, `${CAL}/freeBusy`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      timeMin: opts.timeMin,
      timeMax: opts.timeMax,
      items: calendars.map((c) => ({ id: c.id })),
    }),
  });

  // Merge all busy periods
  const busy: { start: number; end: number }[] = [];
  for (const cal of Object.values(data.calendars || {})) {
    for (const b of cal.busy || []) {
      busy.push({ start: new Date(b.start).getTime(), end: new Date(b.end).getTime() });
    }
  }
  busy.sort((a, b) => a.start - b.start);

  const merged: { start: number; end: number }[] = [];
  for (const b of busy) {
    const last = merged[merged.length - 1];
    if (merged.length > 0 && last && b.start <= last.end) {
      last.end = Math.max(last.end, b.end);
    } else {
      merged.push({ ...b });
    }
  }

  // Get hour in Europe/Paris using Intl (handles DST correctly)
  function getParisHour(ts: number): number {
    const s = new Date(ts).toLocaleString("en-US", {
      hour: "numeric",
      hour12: false,
      timeZone: getInstanceConfig().timezone,
    });
    return parseInt(s, 10);
  }
  function getParisDay(ts: number): number {
    const s = new Date(ts).toLocaleDateString("en-US", {
      weekday: "short",
      timeZone: getInstanceConfig().timezone,
    });
    return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(s);
  }

  const durationMs = opts.durationMinutes * 60 * 1000;
  const rangeStart = new Date(opts.timeMin).getTime();
  const rangeEnd = new Date(opts.timeMax).getTime();

  const slots: { start: string; end: string }[] = [];
  let cursor = rangeStart;

  while (cursor + durationMs <= rangeEnd && slots.length < 20) {
    const hour = getParisHour(cursor);

    if (hour < 8 || hour >= 19) {
      cursor += 30 * 60 * 1000;
      continue;
    }
    const day = getParisDay(cursor);
    if (day === 0 || day === 6) {
      cursor += 30 * 60 * 1000;
      continue;
    }

    const slotEnd = cursor + durationMs;
    const isBusy = merged.some((b) => cursor < b.end && slotEnd > b.start);

    if (!isBusy) {
      slots.push({
        start: new Date(cursor).toISOString(),
        end: new Date(slotEnd).toISOString(),
      });
      cursor = slotEnd;
    } else {
      const blocker = merged.find((b) => cursor < b.end && slotEnd > b.start);
      cursor = blocker ? blocker.end : cursor + 30 * 60 * 1000;
    }
  }

  return slots;
}

// --- RSVP to event ---

export async function rsvpEvent(
  ctx: GoogleAuthContext,
  opts: {
    eventId: string;
    calendarId?: string | undefined;
    response: "accepted" | "declined" | "tentative";
  }
): Promise<boolean> {
  const calId = opts.calendarId || "primary";

  const event = await googleFetchJSON<CalendarEventResponse>(
    ctx,
    `${CAL}/calendars/${encodeURIComponent(calId)}/events/${encodeURIComponent(opts.eventId)}`
  );

  const attendees = (event.attendees || []).map(
    (a: { email: string; self?: boolean; responseStatus?: string }) => {
      if (a.self) return { ...a, responseStatus: opts.response };
      return a;
    }
  );

  const res = await googleFetch(
    ctx,
    `${CAL}/calendars/${encodeURIComponent(calId)}/events/${encodeURIComponent(opts.eventId)}?sendUpdates=all`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ attendees }),
    }
  );
  return res.ok;
}
