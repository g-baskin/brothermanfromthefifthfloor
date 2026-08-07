import assert from "node:assert/strict";
import test from "node:test";
import {
  executeGoogleCalendarTool,
  isGoogleCalendarTool,
} from "../src/realtime/tools/google-calendar-tools.js";
import { executeRealtimeTool } from "../src/realtime/tools/index.js";

const timedEvent = {
  summary: "Standup",
  start: "2026-08-07T09:00:00-04:00",
  end: "2026-08-07T09:30:00-04:00",
  timeZone: "America/New_York",
};

test("detects only Google Calendar tools", async () => {
  assert.equal(isGoogleCalendarTool("google_calendar_list_events"), true);
  assert.equal(isGoogleCalendarTool("list_calendar_items"), false);
  assert.equal(await executeGoogleCalendarTool("list_calendar_items", {}, null), null);
});

test("returns integration_not_connected when no adapter is injected", async () => {
  assert.deepEqual(
    await executeGoogleCalendarTool(
      "google_calendar_list_events",
      { timeMin: "2026-08-01T00:00:00Z", timeMax: "2026-08-02T00:00:00Z" },
      null,
    ),
    {
      status: "integration_not_connected",
      message: "Google Calendar is not connected. Connect it in Settings.",
    },
  );
});

test("rejects malformed, mixed, reversed, and unbounded date ranges before network calls", async () => {
  let calls = 0;
  const adapter = {
    createEvent: async () => {
      calls += 1;
    },
    listEvents: async () => {
      calls += 1;
    },
  };
  const invalidCalls = [
    ["google_calendar_create_event", { ...timedEvent, start: "tomorrow" }],
    [
      "google_calendar_create_event",
      { summary: "Bad date", start: "2026-99-99", end: "2027-01-01" },
    ],
    ["google_calendar_create_event", { ...timedEvent, start: "2026-08-07" }],
    ["google_calendar_create_event", { ...timedEvent, end: "2026-08-07T08:00:00-04:00" }],
    ["google_calendar_update_event", { eventId: "event-1", start: "2026-08-07T10:00:00-04:00" }],
    ["google_calendar_update_event", { eventId: "event-1", end: "2026-08-07T10:30:00-04:00" }],
    [
      "google_calendar_list_events",
      { timeMin: "2026-01-01T00:00:00Z", timeMax: "2028-01-01T00:00:00Z" },
    ],
  ];
  for (const [name, args] of invalidCalls) {
    const result = await executeGoogleCalendarTool(name, args, adapter);
    assert.equal(result.status, "invalid_arguments");
  }
  assert.equal(calls, 0);
});

test("executes list, create, update, and delete through the injected adapter", async () => {
  const calls = [];
  const adapter = {
    listEvents: async (args) => {
      calls.push(["list", args]);
      return { events: [{ id: "event-1" }], nextPageToken: null };
    },
    createEvent: async (args) => {
      calls.push(["create", args]);
      return { id: "event-2" };
    },
    updateEvent: async (id, patch) => {
      calls.push(["update", id, patch]);
      return { id, ...patch };
    },
    deleteEvent: async (id) => {
      calls.push(["delete", id]);
      return { deleted: true, eventId: id };
    },
  };

  const list = await executeGoogleCalendarTool(
    "google_calendar_list_events",
    { timeMin: "2026-08-01T00:00:00Z", timeMax: "2026-08-02T00:00:00Z" },
    adapter,
  );
  const create = await executeGoogleCalendarTool(
    "google_calendar_create_event",
    timedEvent,
    adapter,
  );
  const update = await executeGoogleCalendarTool(
    "google_calendar_update_event",
    { eventId: "event-2", summary: "Renamed" },
    adapter,
  );
  const remove = await executeGoogleCalendarTool(
    "google_calendar_delete_event",
    { eventId: "event-2" },
    adapter,
  );

  assert.equal(list.status, "listed");
  assert.equal(create.status, "created");
  assert.equal(update.status, "updated");
  assert.equal(remove.status, "deleted");
  assert.deepEqual(calls[2], ["update", "event-2", { summary: "Renamed" }]);
});

test("central realtime dispatcher forwards the injected Google Calendar adapter", async () => {
  const result = await executeRealtimeTool(
    "google_calendar_delete_event",
    { eventId: "event-1" },
    {
      googleCalendar: {
        deleteEvent: async (eventId) => ({ deleted: true, eventId }),
      },
    },
  );
  assert.equal(result.status, "deleted");
  assert.equal(result.eventId, "event-1");
});

test("normalizes adapter failures for model-visible reconnect instructions", async () => {
  const error = new Error("Google Calendar authorization expired. Reconnect in Settings.");
  error.code = "integration_not_connected";
  const result = await executeGoogleCalendarTool(
    "google_calendar_delete_event",
    { eventId: "event-1" },
    { deleteEvent: async () => Promise.reject(error) },
  );
  assert.deepEqual(result, {
    status: "integration_not_connected",
    message: "Google Calendar authorization expired. Reconnect in Settings.",
  });
});
