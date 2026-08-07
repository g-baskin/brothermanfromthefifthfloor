import assert from "node:assert/strict";
import test from "node:test";
import { createGoogleCalendarClient } from "../src/integrations/google/google-calendar-client.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const googleEvent = {
  id: "event/opaque",
  summary: "Standup",
  description: "Daily sync",
  location: "Room 5",
  status: "confirmed",
  htmlLink: "https://calendar.google.com/event",
  start: { dateTime: "2026-08-07T09:00:00-04:00", timeZone: "America/New_York" },
  end: { dateTime: "2026-08-07T09:30:00-04:00", timeZone: "America/New_York" },
};

function createHarness(responses) {
  const requests = [];
  const tokenCalls = [];
  const client = createGoogleCalendarClient({
    getAccessToken: async (options) => {
      tokenCalls.push(options);
      return options.forceRefresh ? "refreshed-token" : "access-token";
    },
    fetchImpl: async (url, options) => {
      requests.push({ url: new URL(url), options });
      const response = responses.shift();
      return typeof response === "function" ? response(url, options) : response;
    },
  });
  return { client, requests, tokenCalls };
}

test("list events uses primary calendar, bounded query, expansion, and start ordering", async () => {
  const { client, requests } = createHarness([
    jsonResponse({ items: [googleEvent], nextPageToken: "next-page" }),
  ]);
  const result = await client.listEvents({
    timeMin: "2026-08-07T00:00:00Z",
    timeMax: "2026-08-08T00:00:00Z",
    query: "standup",
    maxResults: 500,
  });

  assert.equal(requests[0].url.pathname, "/calendar/v3/calendars/primary/events");
  assert.equal(requests[0].url.searchParams.get("singleEvents"), "true");
  assert.equal(requests[0].url.searchParams.get("orderBy"), "startTime");
  assert.equal(requests[0].url.searchParams.get("maxResults"), "50");
  assert.equal(requests[0].url.searchParams.get("q"), "standup");
  assert.equal(result.events[0].id, "event/opaque");
  assert.deepEqual(result.events[0].start, {
    value: "2026-08-07T09:00:00-04:00",
    allDay: false,
    timeZone: "America/New_York",
  });
  assert.equal(result.nextPageToken, "next-page");
});

test("list mapping bounds remote event text and pagination tokens", async () => {
  const { client } = createHarness([
    jsonResponse({
      items: [{ ...googleEvent, description: "x".repeat(20_000) }],
      nextPageToken: "p".repeat(5_000),
    }),
  ]);
  const result = await client.listEvents({
    timeMin: "2026-08-07T00:00:00Z",
    timeMax: "2026-08-08T00:00:00Z",
  });
  assert.equal(result.events[0].description.length, 8192);
  assert.equal(result.nextPageToken.length, 2048);
});

test("create timed event sends only supported fields and disables updates", async () => {
  const { client, requests } = createHarness([jsonResponse(googleEvent)]);
  await client.createEvent({
    summary: "Standup",
    description: "Daily sync",
    location: "Room 5",
    start: "2026-08-07T09:00:00-04:00",
    end: "2026-08-07T09:30:00-04:00",
    timeZone: "America/New_York",
  });

  assert.equal(requests[0].options.method, "POST");
  assert.equal(requests[0].url.searchParams.get("sendUpdates"), "none");
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    summary: "Standup",
    description: "Daily sync",
    location: "Room 5",
    start: { dateTime: "2026-08-07T09:00:00-04:00", timeZone: "America/New_York" },
    end: { dateTime: "2026-08-07T09:30:00-04:00", timeZone: "America/New_York" },
  });
});

test("create all-day event uses exclusive date end without a time zone", async () => {
  const allDayEvent = {
    ...googleEvent,
    start: { date: "2026-08-07" },
    end: { date: "2026-08-08" },
  };
  const { client, requests } = createHarness([jsonResponse(allDayEvent)]);
  const result = await client.createEvent({
    summary: "Holiday",
    start: "2026-08-07",
    end: "2026-08-08",
    timeZone: "America/New_York",
  });
  assert.deepEqual(JSON.parse(requests[0].options.body).start, { date: "2026-08-07" });
  assert.deepEqual(JSON.parse(requests[0].options.body).end, { date: "2026-08-08" });
  assert.equal(result.start.allDay, true);
});

test("update patches supplied fields and URL-encodes opaque event ID", async () => {
  const { client, requests } = createHarness([
    jsonResponse({ ...googleEvent, summary: "Renamed" }),
  ]);
  await client.updateEvent("event/opaque", { summary: "Renamed", location: "" });
  assert.equal(requests[0].options.method, "PATCH");
  assert.equal(requests[0].url.pathname.endsWith("/event%2Fopaque"), true);
  assert.deepEqual(JSON.parse(requests[0].options.body), { summary: "Renamed", location: "" });
});

test("delete disables updates and handles empty 204 response", async () => {
  const { client, requests } = createHarness([new Response(null, { status: 204 })]);
  assert.deepEqual(await client.deleteEvent("opaque-id"), {
    deleted: true,
    eventId: "opaque-id",
  });
  assert.equal(requests[0].options.method, "DELETE");
  assert.equal(requests[0].url.searchParams.get("sendUpdates"), "none");
});

test("401 forces one token refresh and retries once", async () => {
  const { client, requests, tokenCalls } = createHarness([
    jsonResponse({ error: "expired" }, 401),
    jsonResponse({ items: [] }),
  ]);
  await client.listEvents({
    timeMin: "2026-08-07T00:00:00Z",
    timeMax: "2026-08-08T00:00:00Z",
  });
  assert.equal(requests.length, 2);
  assert.deepEqual(tokenCalls, [{ forceRefresh: false }, { forceRefresh: true }]);
  assert.equal(requests[1].options.headers.Authorization, "Bearer refreshed-token");
});

test("Calendar API errors are normalized without exposing raw response bodies", async () => {
  for (const [status, code] of [
    [403, "calendar_permission_denied"],
    [429, "calendar_rate_limited"],
    [503, "calendar_service_unavailable"],
  ]) {
    const { client } = createHarness([
      jsonResponse({ error: { message: "secret raw detail" } }, status),
    ]);
    await assert.rejects(
      client.deleteEvent("opaque-id"),
      (error) => error.code === code && !error.message.includes("secret raw detail"),
    );
  }
});
