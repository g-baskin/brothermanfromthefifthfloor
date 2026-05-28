import assert from "node:assert/strict";
import test from "node:test";
import { executeSessionTool } from "../src/realtime/tools/session-tools.js";

test("executeSessionTool ends the call and passes through a reason", async () => {
  assert.deepEqual(await executeSessionTool("end_call", { reason: "Ken said goodbye" }), {
    status: "call_ended",
    message: "Ending the call. Goodbye.",
    reason: "Ken said goodbye",
  });
});

test("executeSessionTool ends the call without a reason", async () => {
  assert.deepEqual(await executeSessionTool("end_call", {}), {
    status: "call_ended",
    message: "Ending the call. Goodbye.",
  });
});

test("executeSessionTool cancels active computer use", async () => {
  assert.deepEqual(
    await executeSessionTool(
      "cancel_computer_use",
      {},
      { cancelComputerUse: () => ({ cancelled: true }) },
    ),
    {
      status: "cancelled",
      message: "Computer use stopped.",
    },
  );
});

test("executeSessionTool reports idle when there is no computer use to cancel", async () => {
  assert.deepEqual(
    await executeSessionTool(
      "cancel_computer_use",
      {},
      { cancelComputerUse: () => ({ cancelled: false }) },
    ),
    {
      status: "idle",
      message: "No computer-use task is running.",
    },
  );
});

test("executeSessionTool ignores unrelated tools", async () => {
  assert.equal(await executeSessionTool("web_search", { query: "x" }), null);
});
