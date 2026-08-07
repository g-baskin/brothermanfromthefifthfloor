const GOOGLE_CALENDAR_TOOL_NAMES = new Set([
  "google_calendar_list_events",
  "google_calendar_create_event",
  "google_calendar_update_event",
  "google_calendar_delete_event",
]);
const RFC3339_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_MS = 366 * 24 * 60 * 60 * 1000;

export function isGoogleCalendarTool(name) {
  return GOOGLE_CALENDAR_TOOL_NAMES.has(name);
}

export async function executeGoogleCalendarTool(name, args, adapter) {
  if (!isGoogleCalendarTool(name)) {
    return null;
  }
  if (!adapter) {
    return integrationNotConnected();
  }

  const validation = validateArguments(name, args);
  if (!validation.ok) {
    return { status: "invalid_arguments", message: validation.message };
  }

  try {
    switch (name) {
      case "google_calendar_list_events": {
        const result = await adapter.listEvents(args);
        return {
          status: "listed",
          message: `Found ${result.events.length} Google Calendar event${result.events.length === 1 ? "" : "s"}.`,
          ...result,
        };
      }
      case "google_calendar_create_event":
        return {
          status: "created",
          message: "Google Calendar event created.",
          event: await adapter.createEvent(args),
        };
      case "google_calendar_update_event": {
        const { eventId, ...patch } = args;
        return {
          status: "updated",
          message: "Google Calendar event updated.",
          event: await adapter.updateEvent(eventId, patch),
        };
      }
      case "google_calendar_delete_event":
        return {
          status: "deleted",
          message: "Google Calendar event deleted.",
          ...(await adapter.deleteEvent(args.eventId)),
        };
    }
  } catch (error) {
    return {
      status: error?.code || "error",
      message:
        error instanceof Error ? error.message : "Google Calendar could not complete the request.",
    };
  }
}

function validateArguments(name, args) {
  if (!isRecord(args)) {
    return invalid("Arguments must be an object.");
  }
  const shapes = {
    google_calendar_list_events: ["timeMin", "timeMax", "query", "maxResults"],
    google_calendar_create_event: [
      "summary",
      "start",
      "end",
      "description",
      "location",
      "timeZone",
    ],
    google_calendar_update_event: [
      "eventId",
      "summary",
      "start",
      "end",
      "description",
      "location",
      "timeZone",
    ],
    google_calendar_delete_event: ["eventId"],
  };
  const unknown = Object.keys(args).find((key) => !shapes[name].includes(key));
  if (unknown) {
    return invalid(`Unknown argument: ${unknown}.`);
  }

  if (name === "google_calendar_list_events") {
    const min = validateDateTime(args.timeMin, "timeMin");
    if (!min.ok) return min;
    const max = validateDateTime(args.timeMax, "timeMax");
    if (!max.ok) return max;
    const range = Date.parse(args.timeMax) - Date.parse(args.timeMin);
    if (range <= 0) return invalid("timeMax must be later than timeMin.");
    if (range > MAX_RANGE_MS) return invalid("Google Calendar searches are limited to 366 days.");
    if (args.query !== undefined && !validString(args.query, 1, 200)) {
      return invalid("query must be between 1 and 200 characters.");
    }
    if (
      args.maxResults !== undefined &&
      (!Number.isInteger(args.maxResults) || args.maxResults < 1 || args.maxResults > 50)
    ) {
      return invalid("maxResults must be an integer from 1 to 50.");
    }
    return { ok: true };
  }

  const eventIdRequired = name.includes("update") || name.includes("delete");
  if (eventIdRequired && !validString(args.eventId, 1, 1024)) {
    return invalid("eventId must be between 1 and 1024 characters.");
  }
  if (name === "google_calendar_delete_event") {
    return { ok: true };
  }

  if (name === "google_calendar_create_event" && !validString(args.summary, 1, 1024)) {
    return invalid("summary must be between 1 and 1024 characters.");
  }
  if (
    name === "google_calendar_update_event" &&
    !["summary", "start", "end", "description", "location"].some((key) => Object.hasOwn(args, key))
  ) {
    return invalid("Provide at least one event field to update.");
  }
  if (args.summary !== undefined && !validString(args.summary, 1, 1024)) {
    return invalid("summary must be between 1 and 1024 characters.");
  }
  if (args.description !== undefined && !validString(args.description, 0, 8192)) {
    return invalid("description must be no more than 8192 characters.");
  }
  if (args.location !== undefined && !validString(args.location, 0, 1024)) {
    return invalid("location must be no more than 1024 characters.");
  }
  if (args.timeZone !== undefined && !validString(args.timeZone, 1, 100)) {
    return invalid("timeZone must be between 1 and 100 characters.");
  }

  const requiresDates = name === "google_calendar_create_event";
  if (
    name === "google_calendar_update_event" &&
    Object.hasOwn(args, "start") !== Object.hasOwn(args, "end")
  ) {
    return invalid("Provide both start and end when changing an event time.");
  }
  if (requiresDates || args.start !== undefined) {
    const start = validateEventDate(args.start, "start");
    if (!start.ok) return start;
  }
  if (requiresDates || args.end !== undefined) {
    const end = validateEventDate(args.end, "end");
    if (!end.ok) return end;
  }
  if (args.start !== undefined && args.end !== undefined) {
    const startAllDay = DATE_ONLY.test(args.start);
    const endAllDay = DATE_ONLY.test(args.end);
    if (startAllDay !== endAllDay) {
      return invalid("start and end must both be dates or both be RFC3339 date-times.");
    }
    const startValue = startAllDay ? args.start : Date.parse(args.start);
    const endValue = endAllDay ? args.end : Date.parse(args.end);
    if (endValue <= startValue) {
      return invalid("end must be later than start.");
    }
  }
  return { ok: true };
}

function validateDateTime(value, field) {
  if (
    typeof value !== "string" ||
    !RFC3339_DATE_TIME.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    return invalid(`${field} must be an RFC3339 date-time with a time zone offset.`);
  }
  return { ok: true };
}

function validateEventDate(value, field) {
  if (typeof value !== "string") {
    return invalid(`${field} must be a date or RFC3339 date-time.`);
  }
  if (DATE_ONLY.test(value)) {
    const date = new Date(`${value}T00:00:00Z`);
    if (Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value) {
      return { ok: true };
    }
  }
  if (RFC3339_DATE_TIME.test(value) && Number.isFinite(Date.parse(value))) {
    return { ok: true };
  }
  return invalid(`${field} must be YYYY-MM-DD or an RFC3339 date-time with a time zone offset.`);
}

function validString(value, min, max) {
  return typeof value === "string" && value.trim().length >= min && value.length <= max;
}

function integrationNotConnected() {
  return {
    status: "integration_not_connected",
    message: "Google Calendar is not connected. Connect it in Settings.",
  };
}

function invalid(message) {
  return { ok: false, message };
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
