import assert from "node:assert/strict";
import test from "node:test";
import { executeGmailTool } from "../src/realtime/tools/gmail-tools.js";

const adapter = {
  searchMessages: async () => ({
    messages: [{ id: "m1", subject: "Hello" }],
    nextPageToken: null,
    resultSizeEstimate: 1,
  }),
  getMessage: async (messageId) => ({ id: messageId, subject: "Hello", body: "Hi" }),
};

test("executes Gmail search and message retrieval", async () => {
  const search = await executeGmailTool(
    "gmail_search_messages",
    { query: "is:unread", maxResults: 5 },
    adapter,
  );
  assert.equal(search.status, "listed");
  assert.equal(search.messages[0].id, "m1");

  const get = await executeGmailTool("gmail_get_message", { messageId: "m1" }, adapter);
  assert.equal(get.status, "retrieved");
  assert.equal(get.email.body, "Hi");
});

test("validates Gmail tool arguments before calling the adapter", async () => {
  assert.deepEqual(await executeGmailTool("gmail_search_messages", { maxResults: 26 }, adapter), {
    status: "invalid_arguments",
    message: "maxResults must be an integer from 1 to 25.",
  });
  assert.deepEqual(await executeGmailTool("gmail_get_message", { messageId: "" }, adapter), {
    status: "invalid_arguments",
    message: "messageId must be between 1 and 1024 characters.",
  });
});

test("reports a disconnected Gmail adapter", async () => {
  const result = await executeGmailTool("gmail_search_messages", {}, null);
  assert.equal(result.status, "integration_not_connected");
});
