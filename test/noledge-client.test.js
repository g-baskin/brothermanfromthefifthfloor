import assert from "node:assert/strict";
import test from "node:test";
import { summarizeToolResult } from "../src/diagnostics/summarize-tool-result.js";
import {
  checkKnowledgeBase,
  defaultRagBaseUrl,
  parseRagBaseUrl,
  searchKnowledgeBase,
} from "../src/integrations/noledge/noledge-client.js";
import { executeKnowledgeTool } from "../src/realtime/tools/knowledge-tools.js";
import { getRealtimeToolDefinitions } from "../src/realtime/tools/tool-schemas.js";

function knowledgeSearchSchema() {
  const schema = getRealtimeToolDefinitions().find((tool) => tool.name === "knowledge_search");
  assert.ok(schema, "knowledge_search must be a registered tool");
  return schema;
}

function jsonResponse(payload, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => payload,
  };
}

/**
 * Swap globalThis.fetch so executeKnowledgeTool exercises the real client path.
 * Returns a restore function.
 */
function stubFetch(handler) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

function stubSemanticChunk(content) {
  return stubFetch(async (url) => {
    if (new URL(url).pathname !== "/api/search") {
      throw new Error(`unexpected request to ${url}`);
    }
    return jsonResponse({
      chunks: [{ documentTitle: "Statute", content, score: 0.9 }],
    });
  });
}

test("parseRagBaseUrl keeps the origin and rejects bad input", () => {
  assert.deepEqual(parseRagBaseUrl("http://127.0.0.1:3009/some/path"), {
    ok: true,
    value: "http://127.0.0.1:3009",
  });
  assert.equal(parseRagBaseUrl("file:///etc/passwd").ok, false);
  assert.equal(parseRagBaseUrl("not a url").ok, false);
  assert.equal(parseRagBaseUrl("").ok, false);
});

test("searchKnowledgeBase prefers /api/search and returns passages", async () => {
  let requestedUrl = "";
  const result = await searchKnowledgeBase({
    baseUrl: defaultRagBaseUrl,
    query: "  vector search  ",
    topK: 999,
    fetchImpl: async (url) => {
      requestedUrl = url;
      return jsonResponse({
        chunks: [{ documentTitle: "Notes", content: "a passage", score: 0.91 }],
      });
    },
  });

  const parsed = new URL(requestedUrl);
  assert.equal(parsed.pathname, "/api/search");
  assert.equal(parsed.searchParams.get("q"), "vector search");
  assert.equal(parsed.searchParams.get("topK"), "20");
  assert.equal(parsed.searchParams.get("spaceId"), "all-spaces");
  assert.equal(result.ok, true);
  assert.equal(result.mode, "semantic");
  assert.equal(result.chunks[0].content, "a passage");
});

test("searchKnowledgeBase falls back to /api/documents when /api/search is absent", async () => {
  const requested = [];
  const result = await searchKnowledgeBase({
    baseUrl: defaultRagBaseUrl,
    query: "vector search",
    topK: 999,
    fetchImpl: async (url) => {
      requested.push(new URL(url).pathname);
      if (new URL(url).pathname === "/api/search") {
        return { ok: false, status: 404, json: async () => ({}) };
      }
      return jsonResponse({ documents: [{ title: "Notes" }], total: 1 });
    },
  });

  assert.deepEqual(requested, ["/api/search", "/api/documents"]);
  assert.equal(result.ok, true);
  assert.equal(result.mode, "titles");
  assert.equal(result.documents.length, 1);
});

test("checkKnowledgeBase reports the indexed document count", async () => {
  let requestedUrl = "";
  const status = await checkKnowledgeBase({
    baseUrl: defaultRagBaseUrl,
    fetchImpl: async (url) => {
      requestedUrl = url;
      return jsonResponse({ documents: [{ title: "Notes" }], total: 42 });
    },
  });

  assert.equal(new URL(requestedUrl).pathname, "/api/documents");
  assert.equal(status.ok, true);
  assert.match(status.message, /42 documents indexed/);
});

test("checkKnowledgeBase reports an offline service", async () => {
  const status = await checkKnowledgeBase({
    baseUrl: defaultRagBaseUrl,
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED");
    },
  });

  assert.equal(status.ok, false);
  assert.equal(status.code, "unreachable");
});

test("searchKnowledgeBase reports an unreachable service instead of throwing", async () => {
  const result = await searchKnowledgeBase({
    baseUrl: defaultRagBaseUrl,
    query: "anything",
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED");
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "unreachable");
  assert.match(result.message, /not reachable/);
});

test("searchKnowledgeBase surfaces the server error message", async () => {
  const result = await searchKnowledgeBase({
    baseUrl: defaultRagBaseUrl,
    query: "anything",
    fetchImpl: async () => jsonResponse({ error: "Embedder offline" }, { ok: false, status: 502 }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.message, "Embedder offline");
});

// Regression: the cap was once 1200 while indexed chunks run to ~1460 chars,
// which silently cut the tail off every passage and made verbatim quoting of
// legal text impossible.
test("executeKnowledgeTool passes a full ~1460-char chunk through untruncated", async () => {
  const content = "A".repeat(1460);
  const restore = stubSemanticChunk(content);
  try {
    const result = await executeKnowledgeTool(
      "knowledge_search",
      { query: "exact wording" },
      { baseUrl: defaultRagBaseUrl },
    );

    assert.equal(result.status, "ok");
    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0].content.length, 1460);
    assert.equal(result.matches[0].content, content);
    assert.equal(result.matches[0].truncated, false);
  } finally {
    restore();
  }
});

test("executeKnowledgeTool caps and flags a chunk beyond the 2000-char limit", async () => {
  const content = "B".repeat(2500);
  const restore = stubSemanticChunk(content);
  try {
    const result = await executeKnowledgeTool(
      "knowledge_search",
      { query: "very long passage" },
      { baseUrl: defaultRagBaseUrl },
    );

    assert.equal(result.matches[0].content.length, 2000);
    assert.equal(result.matches[0].truncated, true);
    // The model must be told the stored text is quotable verbatim.
    assert.match(result.note, /verbatim/);
  } finally {
    restore();
  }
});

// Regression: diagnostics once logged only {"status":"ok"} for knowledge_search,
// so a search returning zero passages was indistinguishable from one returning
// eight. That blindness hid a live retrieval failure from the transcripts.
test("summarizeToolResult records match count and top titles for a retrieval result", () => {
  const passage = "CORPORATION. An artificial person or legal entity...".repeat(20);
  const summary = summarizeToolResult({
    status: "ok",
    query: "corporation",
    matches: [
      { title: "Black's Law Dictionary 8th Edition (1).pdf", score: 0.791, content: passage },
      { title: "EXHIBIT 029 - Affidavit of Sovereignty.rtf", score: 0.63, content: passage },
      { title: "Third.pdf", score: 0.51, content: passage },
      { title: "Fourth.pdf", score: 0.4, content: passage },
    ],
  });

  assert.equal(summary.status, "ok");
  assert.equal(summary.matchCount, 4);
  // Only the top few are logged, and only title plus score.
  assert.equal(summary.topMatches.length, 3);
  assert.equal(summary.topMatches[0].title, "Black's Law Dictionary 8th Edition (1).pdf");
  assert.equal(summary.topMatches[0].score, 0.791);

  // Passage text must never reach the diagnostics log.
  const serialized = JSON.stringify(summary);
  assert.ok(!serialized.includes("artificial person"), "passage text must not be logged");
  assert.ok(!serialized.includes("content"), "content field must not be logged");
});

test("summarizeToolResult leaves non-retrieval results without match fields", () => {
  const summary = summarizeToolResult({ status: "ok", resultCount: 2, source: "duckduckgo" });

  assert.equal(summary.resultCount, 2);
  assert.equal("matchCount" in summary, false);
  assert.equal("topMatches" in summary, false);
});

// Regression: the description still claimed the tool returned "titles only, not
// full passages" after it had been switched to semantic /api/search. The model
// believed it could not quote, disclaimed, and fell back to web_search.
test("knowledge_search schema advertises passages, not titles-only", () => {
  const description = knowledgeSearchSchema().description;

  assert.doesNotMatch(description, /titles only/i);
  assert.doesNotMatch(description, /not full passages/i);
  assert.match(description, /passages/i);
  assert.match(description, /verbatim/i);
});

test("knowledge_search topK default matches the client's actual default of 8", async () => {
  const schema = knowledgeSearchSchema();
  assert.match(schema.parameters.properties.topK.description, /default 8\b/);

  // Assert the real outgoing request, not an exported constant, so the schema
  // cannot drift away from what the client actually sends.
  let requestedUrl = "";
  await searchKnowledgeBase({
    baseUrl: defaultRagBaseUrl,
    query: "corporation",
    fetchImpl: async (url) => {
      requestedUrl = url;
      return jsonResponse({ chunks: [] });
    },
  });

  assert.equal(new URL(requestedUrl).searchParams.get("topK"), "8");
});

test("executeKnowledgeTool ignores unrelated tool names", async () => {
  assert.equal(await executeKnowledgeTool("web_search", { query: "x" }), null);
});

test("executeKnowledgeTool degrades to a non-fatal result when the service is down", async () => {
  const result = await executeKnowledgeTool(
    "knowledge_search",
    { query: "nothing here" },
    { baseUrl: "http://127.0.0.1:1" },
  );

  // Never "error": the model should keep answering without the knowledge base.
  assert.equal(result.status, "unavailable");
  assert.equal(result.code, "unreachable");
  assert.match(result.guidance, /optional/);
});
