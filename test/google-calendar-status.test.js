import assert from "node:assert/strict";
import test from "node:test";
import {
  connectAndRefreshGoogleCalendar,
  createGoogleCalendarStatusView,
} from "../src/renderer/google-calendar-status.js";

test("OAuth completion refreshes persisted status and renders visible confirmation", async () => {
  const rendered = [];
  let statusReads = 0;
  const status = await connectAndRefreshGoogleCalendar(
    {
      connectGoogleCalendar: async () => ({ state: "connected" }),
      getGoogleCalendarStatus: async () => {
        statusReads += 1;
        return { state: "connected", connectedAt: "2026-08-07T05:00:00.000Z" };
      },
    },
    (nextStatus) => rendered.push(nextStatus),
  );

  assert.equal(statusReads, 1);
  assert.deepEqual(rendered, [
    { state: "connecting" },
    { state: "connected", connectedAt: "2026-08-07T05:00:00.000Z" },
  ]);
  assert.deepEqual(status, rendered[1]);
  assert.deepEqual(
    createGoogleCalendarStatusView(status, () => "August 7, 2026"),
    {
      state: "connected",
      label: "Connected",
      message: "Connected since August 7, 2026. Brah can manage owned-calendar events.",
      connectDisabled: false,
      connectLabel: "Reconnect",
      disconnectHidden: false,
      disconnectDisabled: false,
    },
  );
});

test("failed OAuth completion remains visible without a false connected state", async () => {
  let statusReads = 0;
  const rendered = [];
  const errorStatus = { state: "error", message: "Google authorization failed." };
  await connectAndRefreshGoogleCalendar(
    {
      connectGoogleCalendar: async () => errorStatus,
      getGoogleCalendarStatus: async () => {
        statusReads += 1;
        return { state: "connected" };
      },
    },
    (status) => rendered.push(status),
  );
  assert.equal(statusReads, 0);
  assert.deepEqual(rendered, [{ state: "connecting" }, errorStatus]);
});
