import assert from "node:assert/strict";
import test from "node:test";
import { createGmailClient } from "../src/integrations/google/gmail-client.js";
import { GOOGLE_GMAIL_READONLY_SCOPE } from "../src/integrations/google/google-oauth.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function metadataMessage(id, overrides = {}) {
  return {
    id,
    threadId: `thread-${id}`,
    labelIds: ["INBOX", "UNREAD"],
    snippet: `Snippet for ${id}`,
    payload: {
      headers: [
        { name: "From", value: "Alice <alice@example.com>" },
        { name: "To", value: "Greg <greg@example.com>" },
        { name: "Subject", value: `Subject ${id}` },
        { name: "Date", value: "Fri, 7 Aug 2026 10:00:00 -0400" },
      ],
    },
    ...overrides,
  };
}

test("searches Gmail then returns bounded message metadata", async () => {
  const requests = [];
  const accessRequests = [];
  const client = createGmailClient({
    getAccessToken: async (options) => {
      accessRequests.push(options);
      return "access-token";
    },
    fetchImpl: async (url, options) => {
      requests.push({ url: new URL(url), options });
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("/messages")) {
        return jsonResponse({
          messages: [{ id: "m1", threadId: "t1" }],
          nextPageToken: "next",
          resultSizeEstimate: 3,
        });
      }
      return jsonResponse(metadataMessage("m1"));
    },
  });

  const result = await client.searchMessages({
    query: "from:alice@example.com is:unread",
    maxResults: 5,
  });

  assert.equal(requests.length, 2);
  assert.equal(requests[0].url.searchParams.get("q"), "from:alice@example.com is:unread");
  assert.equal(requests[0].url.searchParams.get("maxResults"), "5");
  assert.equal(requests[1].url.searchParams.get("format"), "metadata");
  assert.equal(requests[0].options.headers.Authorization, "Bearer access-token");
  assert.equal(accessRequests[0].requiredScope, GOOGLE_GMAIL_READONLY_SCOPE);
  assert.deepEqual(result, {
    messages: [
      {
        id: "m1",
        threadId: "thread-m1",
        from: "Alice <alice@example.com>",
        to: "Greg <greg@example.com>",
        cc: "",
        subject: "Subject m1",
        date: "Fri, 7 Aug 2026 10:00:00 -0400",
        snippet: "Snippet for m1",
        labelIds: ["INBOX", "UNREAD"],
      },
    ],
    nextPageToken: "next",
    resultSizeEstimate: 3,
  });
});

test("gets a message and decodes its nested plain-text body", async () => {
  const client = createGmailClient({
    getAccessToken: async () => "access-token",
    fetchImpl: async (url) => {
      assert.equal(new URL(url).searchParams.get("format"), "full");
      return jsonResponse(
        metadataMessage("m2", {
          payload: {
            headers: [{ name: "Subject", value: "Body test" }],
            mimeType: "multipart/alternative",
            parts: [
              {
                mimeType: "text/plain",
                body: { data: Buffer.from("Hello from Gmail.\n").toString("base64url") },
              },
            ],
          },
        }),
      );
    },
  });

  const message = await client.getMessage("m2");
  assert.equal(message.subject, "Body test");
  assert.equal(message.body, "Hello from Gmail.\n");
});

test("fetches a large text body stored as a Gmail attachment", async () => {
  const requests = [];
  const client = createGmailClient({
    getAccessToken: async () => "access-token",
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      requests.push(parsed);
      if (parsed.pathname.endsWith("/attachments/body-attachment")) {
        return jsonResponse({
          data: Buffer.from("Large Gmail body.\n").toString("base64url"),
        });
      }
      return jsonResponse(
        metadataMessage("m-large", {
          payload: {
            headers: [{ name: "Subject", value: "Large body" }],
            mimeType: "multipart/alternative",
            parts: [
              {
                mimeType: "text/plain",
                body: { attachmentId: "body-attachment", size: 18 },
              },
            ],
          },
        }),
      );
    },
  });

  const message = await client.getMessage("m-large");

  assert.equal(message.body, "Large Gmail body.\n");
  assert.equal(requests.length, 2);
  assert.equal(
    requests[1].pathname,
    "/gmail/v1/users/me/messages/m-large/attachments/body-attachment",
  );
});

test("retries one unauthorized Gmail request with a forced token refresh", async () => {
  const accessRequests = [];
  let calls = 0;
  const client = createGmailClient({
    getAccessToken: async (options) => {
      accessRequests.push(options);
      return "access-token";
    },
    fetchImpl: async () => {
      calls += 1;
      return calls === 1 ? jsonResponse({}, 401) : jsonResponse(metadataMessage("m3"));
    },
  });

  assert.equal((await client.getMessage("m3")).id, "m3");
  assert.equal(accessRequests[0].forceRefresh, false);
  assert.equal(accessRequests[1].forceRefresh, true);
});
