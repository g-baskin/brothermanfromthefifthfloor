import assert from "node:assert/strict";
import test from "node:test";
import { getRealtimeToolDefinitions } from "../src/realtime/tools/tool-schemas.js";

const expectedToolNames = [
  "remember",
  "forget",
  "list_facts",
  "memory_search",
  "daily_log",
  "soul_set",
  "soul_get",
  "soul_list",
  "soul_delete",
  "add_task",
  "list_tasks",
  "delete_task",
  "update_task_status",
  "add_calendar_item",
  "list_calendar_items",
  "delete_calendar_item",
  "google_calendar_list_events",
  "google_calendar_create_event",
  "google_calendar_update_event",
  "google_calendar_delete_event",
  "web_search",
  "web_fetch",
  "read_file",
  "write_file",
  "edit_file",
  "list_screenshot_sources",
  "take_screenshot",
  "analyze_screen",
  "computer_use_task",
  "cancel_computer_use",
  "end_call",
];

test("Realtime tool definitions expose every active function exactly once", () => {
  const tools = getRealtimeToolDefinitions();
  assert.deepEqual(
    tools.map((tool) => tool.name),
    expectedToolNames,
  );
  assert.equal(new Set(tools.map((tool) => tool.name)).size, expectedToolNames.length);
});

test("tool definitions are function schemas with object parameters", () => {
  for (const tool of getRealtimeToolDefinitions()) {
    assert.equal(tool.type, "function", tool.name);
    assert.equal(typeof tool.description, "string", tool.name);
    assert.equal(tool.parameters.type, "object", tool.name);
    assert.equal(tool.parameters.additionalProperties, false, tool.name);
    assert.ok(Array.isArray(tool.parameters.required), tool.name);
  }
});

test("computer_use_task target enum offers browser and computer modes", () => {
  const tool = getRealtimeToolDefinitions().find((item) => item.name === "computer_use_task");
  assert.deepEqual(tool.parameters.properties.target.enum, ["browser", "computer"]);
});

test("Google Calendar schemas enforce bounded ranges and strict event contracts", () => {
  const tools = getRealtimeToolDefinitions();
  const list = tools.find((tool) => tool.name === "google_calendar_list_events");
  const create = tools.find((tool) => tool.name === "google_calendar_create_event");
  const update = tools.find((tool) => tool.name === "google_calendar_update_event");
  const remove = tools.find((tool) => tool.name === "google_calendar_delete_event");

  assert.deepEqual(list.parameters.required, ["timeMin", "timeMax"]);
  assert.equal(list.parameters.properties.maxResults.maximum, 50);
  assert.equal(list.parameters.additionalProperties, false);
  assert.deepEqual(create.parameters.required, ["summary", "start", "end"]);
  assert.deepEqual(update.parameters.required, ["eventId"]);
  assert.deepEqual(remove.parameters.required, ["eventId"]);
  assert.equal(create.parameters.properties.summary.maxLength, 1024);
  assert.equal(create.parameters.properties.description.maxLength, 8192);
});

test("returned tool definitions are cloned to prevent caller mutation", () => {
  const first = getRealtimeToolDefinitions();
  const taskTool = first.find((tool) => tool.name === "add_task");
  taskTool.name = "mutated";
  taskTool.parameters.properties.name.type = "number";

  const secondTaskTool = getRealtimeToolDefinitions().find((tool) => tool.name === "add_task");
  assert.equal(secondTaskTool.name, "add_task");
  assert.equal(secondTaskTool.parameters.properties.name.type, "string");
});
