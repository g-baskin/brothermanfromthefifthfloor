import assert from "node:assert/strict";
import test from "node:test";
import {
  createPermissionDeniedResult,
  formatPermissionPrompt,
  getToolPermissionRequest,
} from "../src/realtime/tool-permissions.js";

test("getToolPermissionRequest classifies every active tool with a summary", () => {
  assert.deepEqual(
    getToolPermissionRequest("computer_use_task", {
      task: "Open example",
      url: "https://example.com",
    }),
    {
      toolName: "computer_use_task",
      label: "Use computer",
      level: "sensitive",
      description:
        "Let OpenAI operate a browser harness or, in OS mode, control the real machine's mouse and keyboard from screenshots.",
      summary: "task: Open example, url: https://example.com",
    },
  );
  assert.equal(
    getToolPermissionRequest("computer_use_task", { task: "Open Settings", target: "computer" })
      .level,
    "destructive",
  );
  assert.deepEqual(getToolPermissionRequest("delete_task", { query: "Old task" }), {
    toolName: "delete_task",
    label: "Delete task",
    level: "destructive",
    description: "Delete a task from your local Tasks list.",
    summary: "query: Old task",
  });
  assert.deepEqual(
    getToolPermissionRequest("google_calendar_list_events", {
      timeMin: "2026-08-07T00:00:00Z",
      timeMax: "2026-08-08T00:00:00Z",
      query: "standup",
    }),
    {
      toolName: "google_calendar_list_events",
      label: "Read Google Calendar",
      level: "network",
      description: "Read events from your connected Google primary calendar.",
      summary: "timeMin: 2026-08-07T00:00:00Z, timeMax: 2026-08-08T00:00:00Z, query: standup",
    },
  );
  assert.equal(
    getToolPermissionRequest("google_calendar_create_event", { summary: "Standup" }).level,
    "write",
  );
  assert.equal(
    getToolPermissionRequest("google_calendar_update_event", { eventId: "event-1" }).level,
    "write",
  );
  assert.deepEqual(
    getToolPermissionRequest("google_calendar_delete_event", { eventId: "event-1" }),
    {
      toolName: "google_calendar_delete_event",
      label: "Delete Google Calendar event",
      level: "destructive",
      description: "Permanently delete an event from your connected Google primary calendar.",
      summary: "eventId: event-1",
    },
  );
  assert.deepEqual(getToolPermissionRequest("web_search", { query: "weather" }), {
    toolName: "web_search",
    label: "Search web",
    level: "network",
    description: "Send a search query to DuckDuckGo.",
    summary: "query: weather",
  });
});

test("formatPermissionPrompt includes label, description, details, and risk", () => {
  assert.equal(
    formatPermissionPrompt(getToolPermissionRequest("web_fetch", { url: "https://example.com" })),
    "Read web page?\n\nFetch and read a public web page.\n\nDetails: url: https://example.com\n\nRisk: network",
  );
});

test("createPermissionDeniedResult returns a model-visible denial", () => {
  assert.deepEqual(createPermissionDeniedResult(getToolPermissionRequest("analyze_screen", {})), {
    status: "permission_denied",
    message: "Greg did not approve Analyze screen. Ask before trying this tool again.",
    tool: "analyze_screen",
  });
});
