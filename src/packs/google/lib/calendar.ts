import { getInstanceConfig } from "@/core/config";
import { googleFetch, googleFetchJSON } from "./google-fetch";

const CAL = "https://www.googleapis.com/calendar/v3";

export interface CalendarEvent {
  id: string;
  summary: string;
  start: string;
  end: string;
  calendar: string;
  location?: string;
  hangoutLink?: string;
}

export interface CalendarInfo {
  id: string;
  summary: string;
}

// --- List calendars ---

export async function listAllCalendars(): Promise<CalendarInfo[]> {
  const data = await googleFetchJSON<any>(`${CAL}/users/me/calendarList`);
  return (data.items || []).map((c: { id: string; summary?: string }) => ({
    id: c.id,
    summary: c.summary || c.id,
  }));
}

// --- List events ---

export async function listEventsAllCalendars(opts: {
  timeMin?: string;
  timeMax?: string;
}): Promise<CalendarEvent[]> {
  const now = new Date();
  const timeMin = opts.timeMin || now.toISOString();
  const timeMax = opts.timeMax || new Date(now.getTime() + 7 * 86400000).toISOString();

  const calendars = await listAllCalendars();

  const allEvents = await Promise.all(
    calendars.map(async (cal) => {
      const url =
        `${CAL}/calendars/${encodeURIComponent(cal.id)}/events?` +
        `timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}` +
        `&singleEvents=true&orderBy=startTime&maxResults=50`;

      const data = await googleFetchJSON<any>(url);

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
          summary: e.summary || "(sans titre)",
          start: e.start?.dateTime || e.start?.date || "",
          end: e.end?.dateTime || e.end?.date || "",
          calendar: cal.summary,
          location: e.location,
          hangoutLink: e.hangoutLink,
        })
      );
    })
  );

  return allEvents
    .flat()
    .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
}

// --- Create event ---

export async function createEvent(opts: {
  summary: string;
  start: string;
  end: string;
  calendarId?: string;
  description?: string;
  location?: string;
}): Promise<CalendarEvent> {
  const calId = opts.calendarId || "primary";
  const isAllDay = !opts.start.includes("T");

  const startField = isAllDay
    ? { date: opts.start }
    : { dateTime: opts.start, timeZone: getInstanceConfig().timezone };
  const endField = isAllDay
    ? { date: opts.end }
    : { dateTime: opts.end, timeZone: getInstanceConfig().timezone };

  const e = await googleFetchJSON<any>(
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
  eventId: string,
  calendarId?: string
): Promise<boolean> {
  const calId = calendarId || "primary";
  const res = await googleFetch(
    `${CAL}/calendars/${encodeURIComponent(calId)}/events/${encodeURIComponent(eventId)}`,
    { method: "DELETE" }
  );
  return res.ok;
}

// --- Update event ---

export async function updateEvent(opts: {
  eventId: string;
  calendarId?: string;
  summary?: string;
  start?: string;
  end?: string;
  description?: string;
  location?: string;
}): Promise<CalendarEvent> {
  const calId = opts.calendarId || "primary";

  const patch: any = {};
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

  const e = await googleFetchJSON<any>(
    `${CAL}/calendars/${encodeURIComponent(calId)}/events/${encodeURIComponent(opts.eventId)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }
  );

  return {
    id: e.id,
    summary: e.summary,
    start: e.start?.dateTime || e.start?.date || "",
    end: e.end?.dateTime || e.end?.date || "",
    calendar: calId,
    location: e.location,
    hangoutLink: e.hangoutLink,
  };
}

// --- Find free time ---

export async function findFreeTime(opts: {
  timeMin: string;
  timeMax: string;
  durationMinutes: number;
}): Promise<{ start: string; end: string }[]> {
  const calendars = await listAllCalendars();

  const data = await googleFetchJSON<any>(`${CAL}/freeBusy`, {
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
  for (const cal of Object.values(data.calendars || {}) as any[]) {
    for (const b of cal.busy || []) {
      busy.push({ start: new Date(b.start).getTime(), end: new Date(b.end).getTime() });
    }
  }
  busy.sort((a, b) => a.start - b.start);

  const merged: { start: number; end: number }[] = [];
  for (const b of busy) {
    if (merged.length > 0 && b.start <= merged[merged.length - 1].end) {
      merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, b.end);
    } else {
      merged.push({ ...b });
    }
  }

  // Get hour in Europe/Paris using Intl (handles DST correctly)
  function getParisHour(ts: number): number {
    const s = new Date(ts).toLocaleString("en-US", { hour: "numeric", hour12: false, timeZone: getInstanceConfig().timezone });
    return parseInt(s, 10);
  }
  function getParisDay(ts: number): number {
    const s = new Date(ts).toLocaleDateString("en-US", { weekday: "short", timeZone: getInstanceConfig().timezone });
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

export async function rsvpEvent(opts: {
  eventId: string;
  calendarId?: string;
  response: "accepted" | "declined" | "tentative";
}): Promise<boolean> {
  const calId = opts.calendarId || "primary";

  const event = await googleFetchJSON<any>(
    `${CAL}/calendars/${encodeURIComponent(calId)}/events/${encodeURIComponent(opts.eventId)}`
  );

  const attendees = (event.attendees || []).map((a: any) => {
    if (a.self) return { ...a, responseStatus: opts.response };
    return a;
  });

  const res = await googleFetch(
    `${CAL}/calendars/${encodeURIComponent(calId)}/events/${encodeURIComponent(opts.eventId)}?sendUpdates=all`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ attendees }),
    }
  );
  return res.ok;
}
