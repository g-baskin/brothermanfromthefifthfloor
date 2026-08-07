const CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const DEFAULT_MAX_RESULTS = 20;
const MAX_RESULTS = 50;

export function createGoogleCalendarClient({ getAccessToken, fetchImpl = globalThis.fetch }) {
  async function request(url, options = {}, retry401 = true) {
    const token = await getAccessToken({ forceRefresh: !retry401 });
    let response;
    try {
      response = await fetchImpl(url, {
        ...options,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          ...(options.body ? { "Content-Type": "application/json" } : {}),
          ...options.headers,
        },
      });
    } catch {
      throw calendarError(
        "calendar_network_error",
        "Google Calendar could not be reached. Try again.",
      );
    }

    if (response.status === 401 && retry401) {
      return request(url, options, false);
    }
    if (!response.ok) {
      throw mapCalendarError(response.status);
    }
    if (response.status === 204) {
      return null;
    }
    try {
      return await response.json();
    } catch {
      throw calendarError(
        "calendar_invalid_response",
        "Google Calendar returned an invalid response.",
      );
    }
  }

  return {
    async listEvents({ timeMin, timeMax, query, maxResults = DEFAULT_MAX_RESULTS }) {
      const boundedMaxResults = Math.min(
        MAX_RESULTS,
        Math.max(1, Number.isInteger(maxResults) ? maxResults : DEFAULT_MAX_RESULTS),
      );
      const url = new URL(CALENDAR_API_BASE);
      url.search = new URLSearchParams({
        maxResults: String(boundedMaxResults),
        orderBy: "startTime",
        singleEvents: "true",
        timeMax,
        timeMin,
        ...(query ? { q: query } : {}),
      }).toString();
      const payload = await request(url);
      if (!Array.isArray(payload?.items)) {
        throw calendarError(
          "calendar_invalid_response",
          "Google Calendar returned an invalid event list.",
        );
      }
      return {
        events: payload.items.slice(0, boundedMaxResults).map(mapGoogleEvent),
        nextPageToken: boundedString(payload.nextPageToken, 2048) || null,
      };
    },

    async createEvent(event) {
      const url = new URL(CALENDAR_API_BASE);
      url.searchParams.set("sendUpdates", "none");
      const payload = await request(url, {
        method: "POST",
        body: JSON.stringify(toGoogleEventResource(event)),
      });
      return mapGoogleEvent(payload);
    },

    async updateEvent(eventId, patch) {
      const url = new URL(`${CALENDAR_API_BASE}/${encodeURIComponent(eventId)}`);
      url.searchParams.set("sendUpdates", "none");
      const payload = await request(url, {
        method: "PATCH",
        body: JSON.stringify(toGoogleEventResource(patch)),
      });
      return mapGoogleEvent(payload);
    },

    async deleteEvent(eventId) {
      const url = new URL(`${CALENDAR_API_BASE}/${encodeURIComponent(eventId)}`);
      url.searchParams.set("sendUpdates", "none");
      await request(url, { method: "DELETE" });
      return { deleted: true, eventId };
    },
  };
}

export function toGoogleEventResource(event) {
  const resource = {};
  for (const field of ["summary", "description", "location"]) {
    if (Object.hasOwn(event, field)) {
      resource[field] = event[field];
    }
  }
  if (Object.hasOwn(event, "start")) {
    resource.start = toGoogleDate(event.start, event.timeZone);
  }
  if (Object.hasOwn(event, "end")) {
    resource.end = toGoogleDate(event.end, event.timeZone);
  }
  return resource;
}

function toGoogleDate(value, timeZone) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return { date: value };
  }
  return { dateTime: value, ...(timeZone ? { timeZone } : {}) };
}

function mapGoogleEvent(event) {
  if (!event || typeof event !== "object" || typeof event.id !== "string") {
    throw calendarError("calendar_invalid_response", "Google Calendar returned an invalid event.");
  }
  return {
    id: event.id,
    summary: boundedString(event.summary, 1024),
    description: boundedString(event.description, 8192),
    location: boundedString(event.location, 1024),
    status: boundedString(event.status, 32),
    htmlLink: boundedString(event.htmlLink, 2048),
    start: mapGoogleDate(event.start),
    end: mapGoogleDate(event.end),
  };
}

function mapGoogleDate(value) {
  if (typeof value?.date === "string") {
    return { value: value.date, allDay: true };
  }
  if (typeof value?.dateTime === "string") {
    return {
      value: value.dateTime,
      allDay: false,
      ...(typeof value.timeZone === "string"
        ? { timeZone: boundedString(value.timeZone, 100) }
        : {}),
    };
  }
  return null;
}

function boundedString(value, maxLength) {
  return typeof value === "string" ? value.slice(0, maxLength) : "";
}

function mapCalendarError(status) {
  if (status === 401) {
    return calendarError(
      "integration_not_connected",
      "Google Calendar authorization expired or was revoked. Reconnect in Settings.",
    );
  }
  if (status === 403) {
    return calendarError(
      "calendar_permission_denied",
      "Google denied Calendar access. Reconnect and approve the requested access.",
    );
  }
  if (status === 404) {
    return calendarError("calendar_event_not_found", "That Google Calendar event was not found.");
  }
  if (status === 429) {
    return calendarError("calendar_rate_limited", "Google Calendar is busy. Try again shortly.");
  }
  if (status >= 500) {
    return calendarError(
      "calendar_service_unavailable",
      "Google Calendar is temporarily unavailable. Try again shortly.",
    );
  }
  return calendarError(
    "calendar_request_failed",
    "Google Calendar could not complete the request.",
  );
}

function calendarError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
